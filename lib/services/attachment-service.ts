import { DomainError, type Actor, type AttachmentEntity, type PrivateAttachment, type RequisitionStatus } from "../domain";

export const PRIVATE_ATTACHMENT_BUCKET = "requisicion-adjuntos";
export const PRIVATE_ATTACHMENT_TYPES = ["soporte", "cotizacion", "foto"] as const;
/**
 * 10 MB, un solo tope para toda la plataforma (2026-09-17). Antes había dos: el selector del
 * navegador cortaba en 10 MB y el esquema del endpoint aceptaba 20 MB, así que el número que veía
 * quien sube y el que defendía el servidor no eran el mismo. Se unifica en el más bajo de los dos —
 * el que ya se le prometía a la gente— y el esquema de `POST /api/attachments/...` lo IMPORTA de
 * aquí en vez de repetirlo. El CHECK de la base (`tamano_bytes <= 20971520`) se queda en 20 MB a
 * propósito: es la barrera exterior sobre filas históricas radicadas con el tope viejo, no el
 * límite del producto.
 */
export const MAX_PRIVATE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/**
 * Extensiones válidas por MIME y, a la vez, la lista blanca de MIME de la plataforma: quien decide
 * qué se acepta es esta tabla, no la extensión del archivo (el MIME sale SIEMPRE de husmear los
 * bytes, ver lib/infrastructure/attachment-mime.ts) — la extensión solo tiene que ser coherente con
 * lo que resultó ser. Ampliada el 2026-09-17 con Excel, Word, PowerPoint y CSV/texto por decisión
 * de Ernesto sobre el soporte del portal público.
 */
const ATTACHMENT_EXTENSIONS: Record<string, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
  "application/vnd.ms-excel": ["xls"],
  // Un CSV y un .txt son el MISMO hallazgo para el servidor («esto es texto»): no hay forma de
  // demostrar por contenido cuál de los dos es, así que comparten MIME y se sirven como texto.
  "text/plain": ["csv", "txt"],
};
export const ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set(Object.keys(ATTACHMENT_EXTENSIONS));
/** Subconjunto de `ATTACHMENT_MIME_TYPES` que son imágenes de verdad — lo usa también
 *  `lib/infrastructure/public-attachments.ts` (soporte opcional por artículo del portal público)
 *  para no redefinir qué cuenta como imagen en dos sitios distintos. */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/webp"]);
// `pago_orden` (adenda de pagos, A5): el comprobante de un pago es un adjunto más, bajo pagos-orden/<pago>/…
// — mismo bucket, misma ruta canónica y mismo contrato prepare/complete que caja_menor (202609150001).
const PREFIX: Record<AttachmentEntity, string> = { requisicion: "requisiciones", requisicion_item: "requisicion-items", caja_menor: "caja-menor", pago_orden: "pagos-orden" };
/** Entidades cuya lectura es SOLO por rol (sin dueño por fila): las únicas que admite `listMany`. */
const ROLE_ONLY_ENTITIES: readonly AttachmentEntity[] = ["caja_menor", "pago_orden"];
/**
 * Extensiones válidas para un MIME dado, exportada para que `public-attachments.ts` (soporte del
 * portal público) compruebe la extensión con el mismo criterio en vez de reinventarlo. Devuelve
 * `[]` para un MIME fuera de la lista blanca.
 */
export function expectedAttachmentExtensions(mimeType: string): readonly string[] {
  return ATTACHMENT_EXTENSIONS[mimeType] ?? [];
}

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

/** Exportado para que `public-attachments.ts` (portal público) sanee el nombre del archivo con el MISMO
 *  criterio — sin esto habría dos definiciones de "nombre de archivo válido" divergiendo con el tiempo. */
export function filename(value: string): string {
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
    // Contabilidad registra pagos (`payment:register`, lib/domain/rules.ts): quien registra el pago sube su comprobante.
    if (parent.entity === "pago_orden" && actor.roles.includes("contabilidad")) return;
    throw new DomainError("FORBIDDEN", "No puede cargar soportes para esta entidad");
  }
  private validate(entity: AttachmentEntity, input: PrivateAttachmentUpload): { type: PrivateAttachmentUpload["type"]; name: string; mimeType: string; sizeBytes: number } {
    const name = filename(input.name), mimeType = input.mimeType.toLowerCase();
    if (!PRIVATE_ATTACHMENT_TYPES.includes(input.type)) throw new DomainError("INVALID_DOCUMENT", "Tipo de soporte no permitido");
    // Un ítem admite `foto` (la de siempre, del Flow de WhatsApp o del portal) y, desde 2026-09-17,
    // `soporte`: por el portal público llega ahora la factura o la cotización del artículo, que es
    // un documento, no una foto. La regla que sí se mantiene intacta es la de abajo: lo que se
    // llame `foto` tiene que SER una imagen.
    if (entity === "requisicion_item" && input.type !== "foto" && input.type !== "soporte") throw new DomainError("INVALID_DOCUMENT", "Un ítem sólo admite fotos o soportes");
    if (entity === "caja_menor" && input.type !== "soporte") throw new DomainError("INVALID_DOCUMENT", "Caja menor sólo admite soportes");
    if (entity === "pago_orden" && input.type !== "soporte") throw new DomainError("INVALID_DOCUMENT", "El comprobante de un pago sólo admite soportes");
    if (!ATTACHMENT_MIME_TYPES.has(mimeType)) throw new DomainError("INVALID_DOCUMENT", "MIME de soporte no permitido");
    if (input.type === "foto" && !IMAGE_MIME_TYPES.has(mimeType)) throw new DomainError("INVALID_DOCUMENT", "Las fotos deben usar un MIME de imagen");
    const extension = name.slice(name.lastIndexOf(".") + 1), expected = expectedAttachmentExtensions(mimeType);
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
   * H2: respalda `GET /api/attachments/:entity?ids=` — DELIBERADAMENTE restringido a las entidades de
   * lectura SOLO por rol (`caja_menor` y, desde la adenda de pagos, `pago_orden`: los comprobantes de
   * los pagos de una orden o del cierre de caja en una sola consulta). `assertRead` para
   * requisicion/requisicion_item depende del padre de CADA fila (requesterId/approverId/estado, ver
   * getParent); comprobarlo id por id reintroduciría el mismo N+1 que este lote existe para eliminar.
   * Para las entidades admitidas el acceso de lectura es solo por rol (revisor/admin_sixteam/contabilidad
   * — ver assertRead), sin dueño por fila: un único chequeo basta. Si algún día se necesita batching
   * real de requisicion/requisicion_item, ese caso ya lo cubre `listForRequisition` (agrupado por
   * requisición padre, sin N+1).
   */
  async listMany(entity: AttachmentEntity, entityIds: string[], actor: Actor): Promise<{ attachments: AttachmentBatchView[] }> {
    if (!entityIds.length || entityIds.length > MAX_BATCH_IDS) throw new DomainError("INVALID_INPUT", `Se admiten entre 1 y ${MAX_BATCH_IDS} ids`);
    if (!ROLE_ONLY_ENTITIES.includes(entity)) throw new DomainError("FORBIDDEN", "La consulta por lote solo admite caja_menor y pago_orden");
    // entityIds[0] solo ancla la transacción (mismo mecanismo que usa el resto del servicio, ver
    // PrivateAttachmentTransactionManager): assertRead(entity, ...) no depende de una fila concreta,
    // así que no hace falta bloquear cada id — es una lectura, no una escritura.
    return this.deps.transactions.transaction(entity, entityIds[0], async (tx) => {
      await this.assertRead({ entity, id: entityIds[0] }, actor);
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
