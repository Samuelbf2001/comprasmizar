import { DomainError, type Actor, type AttachmentEntity, type PrivateAttachment, type RequisitionStatus } from "../domain";

export const PRIVATE_ATTACHMENT_BUCKET = "requisicion-adjuntos";
export const PRIVATE_ATTACHMENT_TYPES = ["soporte", "cotizacion", "foto"] as const;
export const MAX_PRIVATE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const PREFIX: Record<AttachmentEntity, string> = { requisicion: "requisiciones", requisicion_item: "requisicion-items", caja_menor: "caja-menor" };

export interface PrivateAttachmentUpload { type: (typeof PRIVATE_ATTACHMENT_TYPES)[number]; name: string; mimeType: string; sizeBytes: number; }
// `approverId` es el aprobador de CABECERA (requisiciones.aprobador_id) e `itemApproverIds` los
// aprobadores POR ÍTEM (requisicion_items.aprobador_id, 11-sep-2026). Los dos importan para leer:
// un aprobador por ítem tiene que poder abrir el detalle de la requisición que le toca decidir, y
// sin la segunda lista `assertRead` lo rechazaba con 403 — el mismo hueco que la visibilidad del
// repositorio, en la ACL de soportes. Es la MISMA regla que la consulta de visibilidad (cabecera O
// un ítem suyo).
export interface AttachmentParent { entity: AttachmentEntity; id: string; requesterId?: string; requisitionStatus?: RequisitionStatus; approverId?: string; itemApproverIds?: string[]; }
export interface PrivateAttachmentRepository {
  getParent(entity: AttachmentEntity, entityId: string): Promise<AttachmentParent | null>;
  list(entity: AttachmentEntity, entityId: string): Promise<PrivateAttachment[]>;
  get(entity: AttachmentEntity, entityId: string, attachmentId: string): Promise<PrivateAttachment | null>;
  insert(value: PrivateAttachment): Promise<PrivateAttachment>;
  /** H2 (docs/plan-rendimiento.md): adjuntos de la requisición Y de todos sus ítems en una sola
   *  consulta — antes el cliente pedía `/api/attachments/requisicion/:id` y luego UNA llamada más por
   *  cada ítem (N+1). */
  listForRequisition(requisitionId: string): Promise<PrivateAttachment[]>;
  /** H2: adjuntos de varias entidades del MISMO tipo en una sola consulta (`entidad_id = any(...)`) —
   *  reemplaza el N+1 de pedir un adjunto por fila de caja menor. */
  listMany(entity: AttachmentEntity, entityIds: string[]): Promise<PrivateAttachment[]>;
}
export interface PrivateAttachmentTransaction { attachments: PrivateAttachmentRepository; audit: { append(event: { entity: string; entityId: string; event: string; actorId?: string; at: Date; origin: "web"; data?: Record<string, unknown> }): Promise<void> }; }
export interface PrivateAttachmentTransactionManager { transaction<T>(entity: AttachmentEntity, entityId: string, work: (tx: PrivateAttachmentTransaction) => Promise<T>): Promise<T>; }
export interface PrivateAttachmentStorage { createUploadUrl(path: string): Promise<{ url: string }>; info(path: string): Promise<{ sizeBytes: number; mimeType: string } | null>; createDownloadUrl(path: string, expiresInSeconds: number): Promise<string>; }
export interface PrivateAttachmentServiceDependencies { transactions: PrivateAttachmentTransactionManager; storage: PrivateAttachmentStorage; clock: { now(): Date }; ids: { next(): string }; }
type AttachmentView = Omit<PrivateAttachment, "entity" | "entityId" | "storagePath" | "uploadedBy">;
/** listForRequisition/listMany mezclan entidades (requisicion + requisicion_item, o varias filas de
 *  caja_menor): a diferencia de `list()` (una sola entidad+id ya conocida por el llamador), el cliente
 *  necesita saber a qué fila pertenece cada adjunto devuelto. */
type AttachmentBatchView = AttachmentView & { entity: AttachmentEntity; entityId: string };
const MAX_BATCH_IDS = 100;

function filename(value: string): string {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized) || normalized.includes("..")) throw new DomainError("INVALID_DOCUMENT", "Nombre de archivo inválido");
  return normalized;
}
function publicView(value: PrivateAttachment): AttachmentView { return { id: value.id, type: value.type, name: value.name, mimeType: value.mimeType, sizeBytes: value.sizeBytes, uploadedAt: value.uploadedAt }; }

export class PrivateAttachmentService {
  constructor(private readonly deps: PrivateAttachmentServiceDependencies) {}
  private async assertRead(parent: AttachmentParent, actor: Actor): Promise<void> {
    if (actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam") || actor.roles.includes("contabilidad")) return;
    if ((parent.entity === "requisicion" || parent.entity === "requisicion_item") && parent.requesterId === actor.id && actor.roles.includes("solicitante")) return;
    if ((parent.entity === "requisicion" || parent.entity === "requisicion_item") && actor.roles.includes("aprobador") && (parent.approverId === actor.id || (parent.itemApproverIds?.includes(actor.id) ?? false))) return;
    throw new DomainError("FORBIDDEN", "No puede consultar estos soportes");
  }
  private async assertWrite(parent: AttachmentParent, actor: Actor): Promise<void> {
    if (actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam")) return;
    if ((parent.entity === "requisicion" || parent.entity === "requisicion_item") && actor.roles.includes("solicitante") && parent.requesterId === actor.id && parent.requisitionStatus === "enviada") return;
    throw new DomainError("FORBIDDEN", "No puede cargar soportes para esta entidad");
  }
  private validate(entity: AttachmentEntity, input: PrivateAttachmentUpload): { type: PrivateAttachmentUpload["type"]; name: string; mimeType: string; sizeBytes: number } {
    const name = filename(input.name), mimeType = input.mimeType.toLowerCase();
    if (!PRIVATE_ATTACHMENT_TYPES.includes(input.type)) throw new DomainError("INVALID_DOCUMENT", "Tipo de soporte no permitido");
    if (entity === "requisicion_item" && input.type !== "foto") throw new DomainError("INVALID_DOCUMENT", "Los soportes de ítem deben ser fotos");
    if (entity === "caja_menor" && input.type !== "soporte") throw new DomainError("INVALID_DOCUMENT", "Caja menor sólo admite soportes");
    if (!MIME_TYPES.has(mimeType)) throw new DomainError("INVALID_DOCUMENT", "MIME de soporte no permitido");
    if (input.type === "foto" && !mimeType.startsWith("image/")) throw new DomainError("INVALID_DOCUMENT", "Las fotos deben usar un MIME de imagen");
    const extension = name.slice(name.lastIndexOf(".") + 1), expected = mimeType === "application/pdf" ? ["pdf"] : mimeType === "image/jpeg" ? ["jpg", "jpeg"] : mimeType === "image/png" ? ["png"] : ["webp"];
    if (!expected.includes(extension)) throw new DomainError("INVALID_DOCUMENT", "La extensión no coincide con el MIME");
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_PRIVATE_ATTACHMENT_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "El soporte supera el tamaño permitido");
    return { type: input.type, name, mimeType, sizeBytes: input.sizeBytes };
  }
  private path(entity: AttachmentEntity, entityId: string, attachmentId: string, name: string): string { return `${PREFIX[entity]}/${entityId}/${attachmentId}/${name}`; }
  private async parent(tx: PrivateAttachmentTransaction, entity: AttachmentEntity, entityId: string): Promise<AttachmentParent> { const parent = await tx.attachments.getParent(entity, entityId); if (!parent) throw new DomainError("NOT_FOUND", "Entidad de soporte no encontrada"); return parent; }
  private async audit(tx: PrivateAttachmentTransaction, event: string, attachmentId: string, actor: Actor, entity: AttachmentEntity, entityId: string, data: Record<string, unknown> = {}): Promise<void> { await tx.audit.append({ entity: "adjunto", entityId: attachmentId, event, actorId: actor.id, at: this.deps.clock.now(), origin: "web", data: { parentEntity: entity, parentId: entityId, ...data } }); }

  async list(entity: AttachmentEntity, entityId: string, actor: Actor): Promise<{ attachments: AttachmentView[] }> {
    return this.deps.transactions.transaction(entity, entityId, async (tx) => { const parent = await this.parent(tx, entity, entityId); await this.assertRead(parent, actor); return { attachments: (await tx.attachments.list(entity, entityId)).map(publicView) }; });
  }
  /**
   * H2: respalda `GET /api/requisitions/:id/detail` — un solo `assertRead` sobre el padre "requisicion"
   * (misma regla que ya protege sus adjuntos propios) cubre también sus ítems: un actor que puede leer
   * los soportes de la requisición puede leer los de sus líneas, no hay un permiso más fino por ítem.
   */
  async listForRequisition(requisitionId: string, actor: Actor): Promise<{ attachments: AttachmentBatchView[] }> {
    return this.deps.transactions.transaction("requisicion", requisitionId, async (tx) => {
      const parent = await this.parent(tx, "requisicion", requisitionId);
      await this.assertRead(parent, actor);
      const rows = await tx.attachments.listForRequisition(requisitionId);
      return { attachments: rows.map((entry) => ({ ...publicView(entry), entity: entry.entity, entityId: entry.entityId })) };
    });
  }
  /**
   * H2: respalda `GET /api/attachments/:entity?ids=` — DELIBERADAMENTE restringido a "caja_menor".
   * `assertRead` para requisicion/requisicion_item depende del padre de CADA fila (requesterId/
   * approverId/estado, ver getParent); comprobarlo id por id reintroduciría el mismo N+1 que este lote
   * existe para eliminar. El caso real que dispara este endpoint (gastos con M filas de caja menor, ver
   * H2 en docs/plan-rendimiento.md) siempre es caja_menor, cuyo acceso de lectura es solo por rol
   * (revisor/admin_sixteam/contabilidad — ver assertRead), sin dueño por fila: un único chequeo basta.
   * Si algún día se necesita batching real de requisicion/requisicion_item, ese caso ya lo cubre
   * `listForRequisition` (agrupado por requisición padre, sin N+1).
   */
  async listMany(entity: AttachmentEntity, entityIds: string[], actor: Actor): Promise<{ attachments: AttachmentBatchView[] }> {
    if (!entityIds.length || entityIds.length > MAX_BATCH_IDS) throw new DomainError("INVALID_INPUT", `Se admiten entre 1 y ${MAX_BATCH_IDS} ids`);
    if (entity !== "caja_menor") throw new DomainError("FORBIDDEN", "La consulta por lote solo admite caja_menor");
    // entityIds[0] solo ancla la transacción (mismo mecanismo que usa el resto del servicio, ver
    // PrivateAttachmentTransactionManager): assertRead("caja_menor", ...) no depende de una fila
    // concreta, así que no hace falta bloquear cada id — es una lectura, no una escritura.
    return this.deps.transactions.transaction(entity, entityIds[0], async (tx) => {
      await this.assertRead({ entity: "caja_menor", id: entityIds[0] }, actor);
      const rows = await tx.attachments.listMany(entity, entityIds);
      return { attachments: rows.map((entry) => ({ ...publicView(entry), entity: entry.entity, entityId: entry.entityId })) };
    });
  }
  async prepare(entity: AttachmentEntity, entityId: string, input: PrivateAttachmentUpload, actor: Actor): Promise<{ attachment: AttachmentView; upload: { method: "PUT"; url: string; multipart: { cacheControl: "3600"; fileField: "" } } }> {
    const validated = this.validate(entity, input), attachmentId = this.deps.ids.next(), storagePath = this.path(entity, entityId, attachmentId, validated.name);
    return this.deps.transactions.transaction(entity, entityId, async (tx) => { const parent = await this.parent(tx, entity, entityId); await this.assertWrite(parent, actor); const upload = await this.deps.storage.createUploadUrl(storagePath); return { attachment: { id: attachmentId, type: validated.type, name: validated.name, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, uploadedAt: this.deps.clock.now().toISOString() }, upload: { method: "PUT", url: upload.url, multipart: { cacheControl: "3600", fileField: "" } } }; });
  }
  async complete(entity: AttachmentEntity, entityId: string, attachmentId: string, input: PrivateAttachmentUpload, actor: Actor): Promise<{ attachment: AttachmentView }> {
    const validated = this.validate(entity, input), storagePath = this.path(entity, entityId, attachmentId, validated.name);
    return this.deps.transactions.transaction(entity, entityId, async (tx) => {
      const parent = await this.parent(tx, entity, entityId); await this.assertWrite(parent, actor);
      const existing = await tx.attachments.get(entity, entityId, attachmentId);
      if (existing) {
        if (existing.type !== validated.type || existing.name !== validated.name || existing.mimeType !== validated.mimeType || existing.sizeBytes !== validated.sizeBytes) throw new DomainError("CONFLICT", "El soporte ya fue finalizado con otros metadatos");
        return { attachment: publicView(existing) };
      }
      const info = await this.deps.storage.info(storagePath);
      if (!info || info.sizeBytes !== validated.sizeBytes || info.mimeType.toLowerCase() !== validated.mimeType) throw new DomainError("INVALID_DOCUMENT", "El objeto cargado no coincide con los metadatos solicitados");
      const inserted = await tx.attachments.insert({ id: attachmentId, entity, entityId, type: validated.type, name: validated.name, mimeType: validated.mimeType, sizeBytes: validated.sizeBytes, uploadedBy: actor.id, uploadedAt: this.deps.clock.now().toISOString(), storagePath });
      await this.audit(tx, "soporte_disponible", attachmentId, actor, entity, entityId, { type: inserted.type, sizeBytes: inserted.sizeBytes });
      return { attachment: publicView(inserted) };
    });
  }
  async download(entity: AttachmentEntity, entityId: string, attachmentId: string, actor: Actor): Promise<string> {
    return this.deps.transactions.transaction(entity, entityId, async (tx) => { const parent = await this.parent(tx, entity, entityId); await this.assertRead(parent, actor); const attachment = await tx.attachments.get(entity, entityId, attachmentId); if (!attachment) throw new DomainError("NOT_FOUND", "Soporte no encontrado"); await this.audit(tx, "soporte_descargado", attachmentId, actor, entity, entityId, { type: attachment.type, sizeBytes: attachment.sizeBytes }); return this.deps.storage.createDownloadUrl(attachment.storagePath, 60); });
  }
}
