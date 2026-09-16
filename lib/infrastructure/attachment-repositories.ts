import { type Sql } from "postgres";
import type { AttachmentEntity, PrivateAttachment, RequisitionStatus } from "../domain";
import type { PrivateAttachmentRepository, PrivateAttachmentServiceDependencies, PrivateAttachmentTransaction, PrivateAttachmentTransactionManager } from "../services/attachment-service";
import { PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";
import { createLocalBucketStorage } from "./local-storage";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { asJsonb } from "./jsonb";

type Row = Record<string, unknown>;
const number = (value: unknown) => Number(value ?? 0);
/** Lock all state used for authorization before signing an upload URL. Item uploads depend on the parent requisition state. */
export function attachmentLockStatement(entity: AttachmentEntity): string {
  if (entity === "requisicion") return "select id from requisiciones where id = $1 for update";
  if (entity === "requisicion_item") return "select r.id as requisicion_id, ri.id from requisiciones r join requisicion_items ri on ri.requisicion_id=r.id where ri.id = $1 for update of r, ri";
  if (entity === "pago_orden") return "select id from pagos_orden where id = $1 for update";
  return "select id from caja_menor where id = $1 for update";
}
function attachment(row: Row): PrivateAttachment { return { id: String(row.id), entity: row.entidad as AttachmentEntity, entityId: String(row.entidad_id), type: String(row.tipo), name: String(row.nombre_original), mimeType: String(row.mime_type), sizeBytes: number(row.tamano_bytes), ...(row.subido_por ? { uploadedBy: String(row.subido_por) } : {}), uploadedAt: new Date(String(row.fecha)).toISOString(), storagePath: String(row.url_storage) }; }

class PostgresAttachmentRepository implements PrivateAttachmentRepository {
  constructor(private readonly sql: Sql) {}
  async getParent(entity: AttachmentEntity, entityId: string) {
    // `aprobador_id` sale de `requisiciones` (el aprobador REAL que eligió el revisor), no de
    // `etiquetas` (su sugerencia por defecto): al repartir por ítem —y ya al reasignar cabecera— los
    // dos divergen, y la ACL tiene que mirar quién decide de verdad. `item_aprobadores` son los
    // aprobadores por ítem de la requisición, para que cada uno pueda abrir su detalle.
    if (entity === "requisicion") { const rows = await this.sql<Row[]>`select r.id, r.solicitante_id, r.estado, r.aprobador_id, (select array_agg(distinct ri.aprobador_id) from requisicion_items ri where ri.requisicion_id=r.id and ri.aprobador_id is not null) as item_aprobadores from requisiciones r where r.id=${entityId}`; const row = rows[0]; return row ? { entity, id: String(row.id), requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, requisitionStatus: row.estado as RequisitionStatus, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, itemApproverIds: Array.isArray(row.item_aprobadores) ? row.item_aprobadores.map(String) : [] } : null; }
    if (entity === "requisicion_item") { const rows = await this.sql<Row[]>`select ri.id, r.solicitante_id, r.estado, r.aprobador_id, (select array_agg(distinct i.aprobador_id) from requisicion_items i where i.requisicion_id=r.id and i.aprobador_id is not null) as item_aprobadores from requisicion_items ri join requisiciones r on r.id=ri.requisicion_id where ri.id=${entityId}`; const row = rows[0]; return row ? { entity, id: String(row.id), requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, requisitionStatus: row.estado as RequisitionStatus, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, itemApproverIds: Array.isArray(row.item_aprobadores) ? row.item_aprobadores.map(String) : [] } : null; }
    if (entity === "pago_orden") { const rows = await this.sql<Row[]>`select id from pagos_orden where id=${entityId}`; return rows[0] ? { entity, id: String(rows[0].id) } : null; }
    const rows = await this.sql<Row[]>`select id from caja_menor where id=${entityId}`; return rows[0] ? { entity, id: String(rows[0].id) } : null;
  }
  async list(entity: AttachmentEntity, entityId: string): Promise<PrivateAttachment[]> { return (await this.sql<Row[]>`select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage from adjuntos where entidad=${entity} and entidad_id=${entityId} and storage_bucket=${PRIVATE_ATTACHMENT_BUCKET} order by fecha desc`).map(attachment); }
  async get(entity: AttachmentEntity, entityId: string, attachmentId: string): Promise<PrivateAttachment | null> { const rows = await this.sql<Row[]>`select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage from adjuntos where id=${attachmentId} and entidad=${entity} and entidad_id=${entityId} and storage_bucket=${PRIVATE_ATTACHMENT_BUCKET}`; return rows[0] ? attachment(rows[0]) : null; }
  // H2 (docs/plan-rendimiento.md): adjuntos de la requisición y de TODOS sus ítems en una sola
  // consulta (dos ramas del `or`, sin N+1 por ítem).
  async listForRequisition(requisitionId: string): Promise<PrivateAttachment[]> {
    return (await this.sql<Row[]>`
      select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage
      from adjuntos
      where storage_bucket=${PRIVATE_ATTACHMENT_BUCKET}
        and (
          (entidad='requisicion' and entidad_id=${requisitionId})
          or (entidad='requisicion_item' and entidad_id in (select id from requisicion_items where requisicion_id=${requisitionId}))
        )
      order by fecha desc`).map(attachment);
  }
  // H2: adjuntos de varias filas del MISMO tipo de entidad en una sola consulta (`any(...)`).
  async listMany(entity: AttachmentEntity, entityIds: string[]): Promise<PrivateAttachment[]> {
    return (await this.sql<Row[]>`select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage from adjuntos where storage_bucket=${PRIVATE_ATTACHMENT_BUCKET} and entidad=${entity} and entidad_id = any(${entityIds}::uuid[]) order by fecha desc`).map(attachment);
  }
  async insert(value: PrivateAttachment): Promise<PrivateAttachment> { const rows = await this.sql<Row[]>`insert into adjuntos (id, entidad, entidad_id, storage_bucket, url_storage, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha) values (${value.id}, ${value.entity}, ${value.entityId}, ${PRIVATE_ATTACHMENT_BUCKET}, ${value.storagePath}, ${value.type}, ${value.name}, ${value.mimeType}, ${value.sizeBytes}, ${value.uploadedBy ?? null}, ${value.uploadedAt}) returning id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage`; return attachment(rows[0]); }
}
class PostgresAttachmentTransactions implements PrivateAttachmentTransactionManager {
  constructor(private readonly sql: Sql) {}
  async transaction<T>(entity: AttachmentEntity, entityId: string, work: (tx: PrivateAttachmentTransaction) => Promise<T>): Promise<T> { return this.sql.begin(async (sql) => { await sql.unsafe(attachmentLockStatement(entity), [entityId]); const repository = new PostgresAttachmentRepository(sql as unknown as Sql); return work({ attachments: repository, audit: { append: async (event) => { await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values (${event.entity}, ${event.entityId}, ${event.event.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}, ${event.origin}, ${event.actorId ?? null}, ${event.at.toISOString()}, ${asJsonb(sql, event.data ?? {})})`; } } }); }) as Promise<T>; }
}
export function createPrivateAttachmentServiceDependencies(databaseUrl = runtimeEnv().DATABASE_URL): PrivateAttachmentServiceDependencies { return { transactions: new PostgresAttachmentTransactions(sharedPostgres(databaseUrl)), storage: createLocalBucketStorage(PRIVATE_ATTACHMENT_BUCKET), clock: { now: () => new Date() }, ids: { next: () => crypto.randomUUID() } }; }
