import { DomainError, hasPermission, normalizeIdentification, type Actor, type BeneficiaryInput, type Supplier, type SupplierBankDetails, type SupplierContact, type SupplierDocument, type SupplierDocumentType, type SupplierIdentificationType, type SupplierOrderHistory } from "../domain";

export const SUPPLIER_DOCUMENT_BUCKET = "proveedor-documentos-privados";
export const SUPPLIER_DOCUMENT_TYPES = ["rut", "camara_comercio", "certificacion_bancaria", "certificado_calidad"] as const;
export const SUPPLIER_IDENTIFICATION_TYPES = ["NIT", "CC", "CE", "PAS"] as const;
export const MAX_SUPPLIER_DOCUMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/**
 * RF-601 (adenda de pagos): `identificationType` + `identification` son la identidad del tercero; `nit`
 * sigue aceptándose como camino legado (equivale a `{ identificationType: "NIT", identification }`). El
 * servicio deja ambos coherentes antes de escribir (y el trigger `proveedores_identificacion` lo
 * garantiza en la base, incluido lo que entre por SQL directo).
 */
export interface SupplierWrite { name?: string; nit?: string | null; identificationType?: SupplierIdentificationType; identification?: string | null; pendingNormalization?: boolean; contact?: SupplierContact; bankDetails?: SupplierBankDetails; active?: boolean; }
export interface SupplierDocumentUpload { type: SupplierDocumentType; name: string; mimeType: string; sizeBytes: number; }
export interface SupplierRepository { list(): Promise<Supplier[]>; get(id: string): Promise<Supplier | null>; create(value: Required<Pick<SupplierWrite, "name" | "contact" | "bankDetails" | "active">> & Pick<SupplierWrite, "nit" | "identificationType" | "identification" | "pendingNormalization">): Promise<Supplier>; update(id: string, value: SupplierWrite): Promise<Supplier | null>; /** RF-606: por (tipo, identificación normalizada), activo o no. */ findByIdentification(type: SupplierIdentificationType, identification: string): Promise<Supplier | null>; listOrders(supplierId: string): Promise<SupplierOrderHistory[]>; listDocuments(supplierId: string): Promise<SupplierDocument[]>; getDocument(supplierId: string, documentId: string): Promise<SupplierDocument | null>; insertDocument(value: SupplierDocument): Promise<SupplierDocument>; }
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
/** La cédula de una persona es dato personal: la auditoría solo dice tipo y si hay identificación, nunca el número. */
function identitySnapshot(value: Pick<Supplier, "nit" | "identificationType" | "identification" | "pendingNormalization">): Record<string, unknown> { return { identificationType: value.identificationType ?? "NIT", identificationConfigured: Boolean(value.identification ?? value.nit), pendingNormalization: value.pendingNormalization ?? false }; }
/**
 * RF-601: deja `identificationType`/`identification`/`nit` coherentes ANTES de escribir — misma regla que
 * el trigger `proveedores_identificacion` (202609150002), aquí para que el objeto devuelto (y los dobles
 * en memoria) no dependan de la base: NIT espeja `identification` en `nit`; una persona no lleva NIT.
 * Lanza INVALID_INPUT si la identificación queda vacía tras normalizar.
 */
export function resolveSupplierIdentity(value: Pick<SupplierWrite, "nit" | "identificationType" | "identification">, previous?: Pick<Supplier, "nit" | "identificationType" | "identification">): { identificationType: SupplierIdentificationType; identification: string | null; nit: string | null } {
  const identificationType = value.identificationType ?? previous?.identificationType ?? "NIT";
  const explicit = value.identification !== undefined ? value.identification?.trim() || null : undefined;
  const legacyNit = value.nit !== undefined ? value.nit?.trim() || null : undefined;
  const identification = explicit !== undefined ? explicit : legacyNit !== undefined && identificationType === "NIT" ? legacyNit : previous?.identification ?? (identificationType === "NIT" ? previous?.nit ?? null : null);
  if (identification !== null && !normalizeIdentification(identification)) throw new DomainError("INVALID_INPUT", "La identificación debe tener al menos un dígito o letra");
  return { identificationType, identification, nit: identificationType === "NIT" ? identification : null };
}

export class SupplierService {
  constructor(private readonly deps: SupplierServiceDependencies) {}
  // H11 (docs/qa/QA-pagos-y-caja.md): admin_mizar entraba por "catalogos_admin_mizar" (autoservicio de
  // TODO el catálogo, apagado por defecto) en vez de por su propio permiso — RF-605 dice que Mizar
  // administra proveedores sin depender de ese flag. `hasPermission(..., "supplier:manage")` cubre
  // admin_mizar (rules.ts) y también revisor/admin_sixteam, que ya la tenían por su propio camino;
  // `tx.features` se deja sin usar aquí a propósito (el flag sigue gobernando el resto del catálogo).
  private canManage(actor: Actor): void {
    if (actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam") || hasPermission(actor, "supplier:manage")) return;
    throw new DomainError("FORBIDDEN", "No puede administrar proveedores");
  }
  private canRead(actor: Actor): void {
    if (actor.roles.includes("revisor") || actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam") || hasPermission(actor, "supplier:manage")) return;
    throw new DomainError("FORBIDDEN", "No puede consultar proveedores");
  }
  private canReadBank(actor: Actor): boolean {
    return actor.roles.includes("revisor") || actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam") || hasPermission(actor, "supplier:manage");
  }
  private access(actor: Actor): SupplierAccess {
    const canManage = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam") || hasPermission(actor, "supplier:manage");
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
    return this.deps.transactions.transaction(undefined, async (tx) => { this.canRead(actor); return { suppliers: (await tx.suppliers.list()).map((supplier) => this.view(supplier, false)), access: this.access(actor) }; });
  }
  async get(supplierId: string, actor: Actor): Promise<{ supplier: SupplierView; orders: SupplierOrderHistory[]; documents: PublicDocument[]; access: SupplierAccess }> {
    return this.deps.transactions.transaction(supplierId, async (tx) => { this.canRead(actor); const supplier = await tx.suppliers.get(supplierId); if (!supplier) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const access = this.access(actor); const [orders, documents] = await Promise.all([tx.suppliers.listOrders(supplierId), tx.suppliers.listDocuments(supplierId)]); return { supplier: this.view(supplier, access.canReadBank), orders, documents: documents.map(safeDocument), access }; });
  }
  async create(value: SupplierWrite & { name: string }, actor: Actor): Promise<SupplierView> {
    const identity = resolveSupplierIdentity(value);
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { this.canManage(actor); const created = await tx.suppliers.create({ name: value.name, ...identity, pendingNormalization: value.pendingNormalization ?? false, contact: value.contact ?? {}, bankDetails: value.bankDetails ?? {}, active: value.active ?? true }); await this.audit(tx, "creado", created.id, actor, { nitConfigured: Boolean(created.nit), ...identitySnapshot(created), contactConfigured: Object.values(created.contact).some(Boolean), active: created.active }); return this.view(created, false); }); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o identificación"); throw error; }
  }
  async update(supplierId: string, value: SupplierWrite, actor: Actor): Promise<SupplierView> {
    try { return await this.deps.transactions.transaction(supplierId, async (tx) => { this.canManage(actor); const before = await tx.suppliers.get(supplierId); if (!before) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const touchesIdentity = value.nit !== undefined || value.identification !== undefined || value.identificationType !== undefined; const after = await tx.suppliers.update(supplierId, touchesIdentity ? { ...value, ...resolveSupplierIdentity(value, before) } : value); if (!after) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); await this.audit(tx, "actualizado", supplierId, actor, { before: { name: before.name, nitConfigured: Boolean(before.nit), ...identitySnapshot(before), contactConfigured: Object.values(before.contact).some(Boolean), bankDetails: redactBankDetails(before.bankDetails), active: before.active }, after: { name: after.name, nitConfigured: Boolean(after.nit), ...identitySnapshot(after), contactConfigured: Object.values(after.contact).some(Boolean), bankDetails: redactBankDetails(after.bankDetails), active: after.active } }); return this.view(after, this.canReadBank(actor)); }); } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o identificación"); throw error; }
  }
  /** RF-606: búsqueda por identificación en los formularios (interno, público, Flow) — `null` si no existe. Mismo permiso de lectura que `get`. */
  async findByIdentification(type: SupplierIdentificationType, identification: string, actor: Actor): Promise<SupplierView | null> {
    if (!normalizeIdentification(identification)) throw new DomainError("INVALID_INPUT", "La identificación debe tener al menos un dígito o letra");
    return this.deps.transactions.transaction(undefined, async (tx) => { this.canRead(actor); const found = await tx.suppliers.findByIdentification(type, identification.trim()); return found ? this.view(found, false) : null; });
  }
  /**
   * RF-606 (alta rápida desde la captura interna, S2): si la identificación ya existe se enlaza
   * (`created: false`), incluso si el nombre difiere — la identidad es la identificación, no el nombre; si
   * no, se crea con `pendingNormalization: true` para que Daniel complete la ficha. Mismo permiso que
   * `create` (compras): la versión SIN permiso, para portal/WhatsApp, vive en `ProcurementService.create`
   * (dentro de la misma transacción de la requisición).
   */
  async resolveOrCreateBeneficiary(input: BeneficiaryInput, actor: Actor): Promise<{ supplier: SupplierView; created: boolean }> {
    const identification = input.identification.trim(), name = input.name.trim();
    if (!normalizeIdentification(identification)) throw new DomainError("INVALID_INPUT", "La identificación del beneficiario es obligatoria");
    if (!name) throw new DomainError("INVALID_INPUT", "El nombre del beneficiario es obligatorio");
    try {
      return await this.deps.transactions.transaction(undefined, async (tx) => {
        this.canManage(actor);
        const existing = await tx.suppliers.findByIdentification(input.identificationType, identification);
        if (existing) return { supplier: this.view(existing, false), created: false };
        const created = await tx.suppliers.create({ name, ...resolveSupplierIdentity({ identificationType: input.identificationType, identification }), pendingNormalization: true, contact: input.phone?.trim() ? { phone: input.phone.trim() } : {}, bankDetails: {}, active: true });
        await this.audit(tx, "creado", created.id, actor, { nitConfigured: Boolean(created.nit), ...identitySnapshot(created), contactConfigured: Object.values(created.contact).some(Boolean), active: created.active, source: "beneficiario" });
        return { supplier: this.view(created, false), created: true };
      });
    } catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con ese nombre y otra identificación"); throw error; }
  }
  async prepareDocument(supplierId: string, value: SupplierDocumentUpload, actor: Actor): Promise<{ document: PublicDocument; upload: { url: string; method: "PUT"; multipart: { cacheControl: "3600"; fileField: "" } } }> {
    const validated = this.validateUpload(value), documentId = this.deps.ids.next(), path = this.path(supplierId, documentId, validated.name);
    return this.deps.transactions.transaction(supplierId, async (tx) => { this.canManage(actor); if (!await tx.suppliers.get(supplierId)) throw new DomainError("NOT_FOUND", "Proveedor no encontrado"); const url = await this.deps.storage.createUploadUrl(path); return { document: { id: documentId, type: value.type, name: validated.name, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, uploadedAt: this.deps.clock.now().toISOString() }, upload: { url: url.url, method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } }; });
  }
  async completeDocument(supplierId: string, documentId: string, value: SupplierDocumentUpload, actor: Actor): Promise<{ document: PublicDocument }> {
    const validated = this.validateUpload(value), path = this.path(supplierId, documentId, validated.name);
    return this.deps.transactions.transaction(supplierId, async (tx) => {
      this.canManage(actor);
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
    return this.deps.transactions.transaction(supplierId, async (tx) => { this.canRead(actor); const document = await tx.suppliers.getDocument(supplierId, documentId); if (!document) throw new DomainError("NOT_FOUND", "Documento no encontrado"); await this.audit(tx, "documento_descargado", supplierId, actor, { documentId, type: document.type }); return this.deps.storage.createDownloadUrl(document.storagePath, 60); });
  }
}
