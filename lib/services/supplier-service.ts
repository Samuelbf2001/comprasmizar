import { DomainError, type Actor, type Supplier, type SupplierBankDetails, type SupplierContact, type SupplierDocument, type SupplierDocumentType, type SupplierOrderHistory } from "../domain";

export const SUPPLIER_DOCUMENT_BUCKET = "proveedor-documentos-privados";
export const SUPPLIER_DOCUMENT_TYPES = ["rut", "camara_comercio", "certificacion_bancaria", "certificado_calidad"] as const;
export const MAX_SUPPLIER_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

export interface SupplierWrite { name?: string; nit?: string | null; contact?: SupplierContact; bankDetails?: SupplierBankDetails; active?: boolean; }
export interface SupplierDocumentUpload { type: SupplierDocumentType; name: string; mimeType: string; sizeBytes: number; }
export interface SupplierRepository { list(): Promise<Supplier[]>; get(id: string): Promise<Supplier | null>; create(value: Required<Pick<SupplierWrite, "name" | "contact" | "bankDetails" | "active">> & Pick<SupplierWrite, "nit">): Promise<Supplier>; update(id: string, value: SupplierWrite): Promise<Supplier | null>; listOrders(supplierId: string): Promise<SupplierOrderHistory[]>; listDocuments(supplierId: string): Promise<SupplierDocument[]>; getDocument(supplierId: string, documentId: string): Promise<SupplierDocument | null>; insertDocument(value: SupplierDocument): Promise<SupplierDocument>; }
export interface SupplierFeatures { isEnabled(name: string): Promise<boolean>; }
export interface SupplierTransaction { suppliers: SupplierRepository; features: SupplierFeatures; audit: { append(event: { entity: string; entityId: string; event: string; actorId?: string; at: Date; origin: "web"; data?: Record<string, unknown> }): Promise<void> }; }
export interface SupplierTransactionManager { transaction<T>(supplierId: string | undefined, work: (tx: SupplierTransaction) => Promise<T>): Promise<T>; }
export interface SupplierStorage { createUploadUrl(path: string): Promise<{ url: string }>; info(path: string): Promise<{ sizeBytes: number; mimeType: string } | null>; createDownloadUrl(path: string, expiresInSeconds: number): Promise<string>; }
export interface SupplierServiceDependencies { transactions: SupplierTransactionManager; storage: SupplierStorage; clock: { now(): Date }; ids: { next(): string }; }

type SupplierView = Omit<Supplier, "bankDetails"> & { bankDetails?: SupplierBankDetails };
type PublicDocument = Omit<SupplierDocument, "storagePath" | "supplierId" | "uploadedBy">;
export interface SupplierAccess { canManage: boolean; canReadBank: boolean; }

function cleanFilename(name: string): string {
  const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized) || normalized.includes("..")) throw new DomainError("INVALID_DOCUMENT", "Nombre de archivo inválido");
  return normalized;
}

function safeDocument(document: SupplierDocument): PublicDocument { return { id: document.id, type: document.type, name: document.name, mimeType: document.mimeType, sizeBytes: document.sizeBytes, uploadedAt: document.uploadedAt }; }
function redactBankDetails(value: SupplierBankDetails | undefined): Record<string, boolean> { return { configured: Boolean(value && Object.values(value).some(Boolean)), accountNumberConfigured: Boolean(value?.accountNumber), bankConfigured: Boolean(value?.bankName) }; }

export class SupplierService {
  constructor(private readonly deps: SupplierServiceDependencies) {}
  private async canManage(actor: Actor, tx: SupplierTransaction): Promise<void> {
    if (actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam")) return;
    if (actor.roles.includes("admin_mizar") && await tx.features.isEnabled("catalogos_admin_mizar")) return;
    throw new DomainError("FORBIDDEN", "No puede administrar proveedores");
  }
  private async canRead(actor: Actor, tx: SupplierTransaction): Promise<void> {
    if (actor.roles.includes("revisor") || actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam")) return;
    if (actor.roles.includes("admin_mizar") && await tx.features.isEnabled("catalogos_admin_mizar")) return;
    throw new DomainError("FORBIDDEN", "No puede consultar proveedores");
  }
  private async canReadBank(actor: Actor, tx: SupplierTransaction): Promise<boolean> {
    if (actor.roles.includes("revisor") || actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam")) return true;
    return actor.roles.includes("admin_mizar") && await tx.features.isEnabled("catalogos_admin_mizar");
  }
  private async access(actor: Actor, tx: SupplierTransaction): Promise<SupplierAccess> {
    const mizarEnabled = actor.roles.includes("admin_mizar") && await tx.features.isEnabled("catalogos_admin_mizar");
    const canManage = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam") || mizarEnabled;
    return { canManage, canReadBank: canManage || actor.roles.includes("contabilidad") };
  }
  private async audit(tx: SupplierTransaction, event: string, supplierId: string, actor: Actor, data: Record<string, unknown>): Promise<void> {
    await tx.audit.append({ entity: "proveedor", entityId: supplierId, event, actorId: actor.id, at: this.deps.clock.now(), origin: "web", data });
  }
  private view(supplier: Supplier, includeBank: boolean): SupplierView { const { bankDetails, ...safe } = supplier; return includeBank ? { ...safe, bankDetails } : safe; }
  private validateUpload(value: SupplierDocumentUpload): { name: string; mimeType: string; sizeBytes: number } {
    const name = cleanFilename(value.name), mimeType = value.mimeType.toLowerCase();
    if (!SUPPLIER_DOCUMENT_TYPES.includes(value.type) || !ALLOWED_MIME_TYPES.has(mimeType)) throw new DomainError("INVALID_DOCUMENT", "Tipo de documento o archivo no permitido");
    const extension = name.slice(name.lastIndexOf(".") + 1), expected = mimeType === "application/pdf" ? ["pdf"] : mimeType === "image/jpeg" ? ["jpg", "jpeg"] : ["png"];
    if (!expected.includes(extension)) throw new DomainError("INVALID_DOCUMENT", "La extensión no coincide con el tipo de archivo");
    if (!Number.isInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_SUPPLIER_DOCUMENT_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "El documento supera el tamaño permitido");
    return { name, mimeType, sizeBytes: value.sizeBytes };
  }
  private path(supplierId: string, documentId: string, name: string): string { return `proveedores/${supplierId}/${documentId}/${name}`; }

  async list(actor: Actor): Promise<{ suppliers: SupplierView[]; access: SupplierAccess }> {
    return this.deps.transactions.transaction(undefined, async (tx) => { await this.canRead(actor, tx); return { suppliers: (await tx.suppliers.list()).map((supplier) => this.view(supplier, false)), access: await this.access(actor, tx) }; });
  }
  async get(supplierId: string, actor: Actor): Promise<{ supplier: SupplierView; orders: SupplierOrderHistory[]; documents: PublicDocument[]; access: SupplierAccess }> {
    return this.deps.transactions.transaction(supplierId, async (tx) => { await this.canRead(actor, tx); const supplier = await tx.suppliers.get(supplierId); if (!supplier) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const access = await this.access(actor, tx); const [orders, documents] = await Promise.all([tx.suppliers.listOrders(supplierId), tx.suppliers.listDocuments(supplierId)]); return { supplier: this.view(supplier, access.canReadBank), orders, documents: documents.map(safeDocument), access }; });
  }
  async create(value: SupplierWrite & { name: string }, actor: Actor): Promise<SupplierView> {
    const nit = value.nit?.trim() || null;
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.canManage(actor, tx); const created = await tx.suppliers.create({ name: value.name, nit, contact: value.contact ?? {}, bankDetails: value.bankDetails ?? {}, active: value.active ?? true }); await this.audit(tx, "creado", created.id, actor, { nitConfigured: Boolean(created.nit), contactConfigured: Object.values(created.contact).some(Boolean), active: created.active }); return this.view(created, false); }); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o NIT"); throw error; }
  }
  async update(supplierId: string, value: SupplierWrite, actor: Actor): Promise<SupplierView> {
    try { return await this.deps.transactions.transaction(supplierId, async (tx) => { await this.canManage(actor, tx); const before = await tx.suppliers.get(supplierId); if (!before) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const after = await tx.suppliers.update(supplierId, value); if (!after) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); await this.audit(tx, "actualizado", supplierId, actor, { before: { name: before.name, nitConfigured: Boolean(before.nit), contactConfigured: Object.values(before.contact).some(Boolean), bankDetails: redactBankDetails(before.bankDetails), active: before.active }, after: { name: after.name, nitConfigured: Boolean(after.nit), contactConfigured: Object.values(after.contact).some(Boolean), bankDetails: redactBankDetails(after.bankDetails), active: after.active } }); return this.view(after, await this.canReadBank(actor, tx)); }); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o NIT"); throw error; }
  }
  async prepareDocument(supplierId: string, value: SupplierDocumentUpload, actor: Actor): Promise<{ document: PublicDocument; upload: { url: string; method: "PUT"; multipart: { cacheControl: "3600"; fileField: "" } } }> {
    const validated = this.validateUpload(value), documentId = this.deps.ids.next(), path = this.path(supplierId, documentId, validated.name);
    return this.deps.transactions.transaction(supplierId, async (tx) => { await this.canManage(actor, tx); if (!await tx.suppliers.get(supplierId)) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const url = await this.deps.storage.createUploadUrl(path); return { document: { id: documentId, type: value.type, name: validated.name, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, uploadedAt: this.deps.clock.now().toISOString() }, upload: { url: url.url, method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } }; });
  }
  async completeDocument(supplierId: string, documentId: string, value: SupplierDocumentUpload, actor: Actor): Promise<{ document: PublicDocument }> {
    const validated = this.validateUpload(value), path = this.path(supplierId, documentId, validated.name);
    return this.deps.transactions.transaction(supplierId, async (tx) => {
      await this.canManage(actor, tx);
      if (!await tx.suppliers.get(supplierId)) throw new DomainError("NOT_FOUND", "Proveedor no encontrado");
      const existing = await tx.suppliers.getDocument(supplierId, documentId);
      if (existing) {
        if (existing.type !== value.type || existing.name !== validated.name || existing.mimeType !== validated.mimeType || existing.sizeBytes !== validated.sizeBytes) throw new DomainError("CONFLICT", "El documento ya fue finalizado con otros datos");
        return { document: safeDocument(existing) };
      }
      const info = await this.deps.storage.info(path);
      if (!info || info.sizeBytes !== validated.sizeBytes || info.mimeType.toLowerCase() !== validated.mimeType) throw new DomainError("INVALID_DOCUMENT", "El objeto cargado no coincide con los metadatos solicitados");
      const document: SupplierDocument = { id: documentId, supplierId, type: value.type, name: validated.name, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, uploadedBy: actor.id, uploadedAt: this.deps.clock.now().toISOString(), storagePath: path };
      const inserted = await tx.suppliers.insertDocument(document);
      await this.audit(tx, "documento_disponible", supplierId, actor, { documentId, type: document.type, sizeBytes: document.sizeBytes });
      return { document: safeDocument(inserted) };
    });
  }
  async downloadDocument(supplierId: string, documentId: string, actor: Actor): Promise<string> {
    return this.deps.transactions.transaction(supplierId, async (tx) => { await this.canRead(actor, tx); const document = await tx.suppliers.getDocument(supplierId, documentId); if (!document) throw new DomainError("NOT_FOUND", "Documento no encontrado"); await this.audit(tx, "documento_descargado", supplierId, actor, { documentId, type: document.type }); return this.deps.storage.createDownloadUrl(document.storagePath, 60); });
  }
}
