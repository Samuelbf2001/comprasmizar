import { type Sql } from "postgres";
import type { AttachmentEntity, PrivateAttachment, RequisitionStatus } from "../domain";
import type { PrivateAttachmentRepository, PrivateAttachmentServiceDependencies, PrivateAttachmentTransaction, PrivateAttachmentTransactionManager } from "../services/attachment-service";
import { PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";
import { createSupabaseServiceClient } from "./supabase";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { asJsonb } from "./jsonb";

type Row = Record<string, unknown>;
const number = (value: unknown) => Number(value ?? 0);
/** Lock all state used for authorization before signing an upload URL. Item uploads depend on the parent requisition state. */
export function attachmentLockStatement(entity: AttachmentEntity): string {
  if (entity === "requisicion") return "select id from requisiciones where id = $1 for update";
  if (entity === "requisicion_item") return "select r.id as requisicion_id, ri.id from requisiciones r join requisicion_items ri on ri.requisicion_id=r.id where ri.id = $1 for update of r, ri";
  return "select id from caja_menor where id = $1 for update";
}
function attachment(row: Row): PrivateAttachment { return { id: String(row.id), entity: row.entidad as AttachmentEntity, entityId: String(row.entidad_id), type: String(row.tipo), name: String(row.nombre_original), mimeType: String(row.mime_type), sizeBytes: number(row.tamano_bytes), ...(row.subido_por ? { uploadedBy: String(row.subido_por) } : {}), uploadedAt: new Date(String(row.fecha)).toISOString(), storagePath: String(row.url_storage) }; }

class PostgresAttachmentRepository implements PrivateAttachmentRepository {
  constructor(private readonly sql: Sql) {}
  async getParent(entity: AttachmentEntity, entityId: string) {
    if (entity === "requisicion") { const rows = await this.sql<Row[]>`select r.id, r.solicitante_id, r.estado, e.aprobador_id from requisiciones r left join etiquetas e on e.id=r.etiqueta_id where r.id=${entityId}`; const row = rows[0]; return row ? { entity, id: String(row.id), requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, requisitionStatus: row.estado as RequisitionStatus, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined } : null; }
    if (entity === "requisicion_item") { const rows = await this.sql<Row[]>`select ri.id, r.solicitante_id, r.estado, e.aprobador_id from requisicion_items ri join requisiciones r on r.id=ri.requisicion_id left join etiquetas e on e.id=r.etiqueta_id where ri.id=${entityId}`; const row = rows[0]; return row ? { entity, id: String(row.id), requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, requisitionStatus: row.estado as RequisitionStatus, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined } : null; }
    const rows = await this.sql<Row[]>`select id from caja_menor where id=${entityId}`; return rows[0] ? { entity, id: String(rows[0].id) } : null;
  }
  async list(entity: AttachmentEntity, entityId: string): Promise<PrivateAttachment[]> { return (await this.sql<Row[]>`select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage from adjuntos where entidad=${entity} and entidad_id=${entityId} and storage_bucket=${PRIVATE_ATTACHMENT_BUCKET} order by fecha desc`).map(attachment); }
  async get(entity: AttachmentEntity, entityId: string, attachmentId: string): Promise<PrivateAttachment | null> { const rows = await this.sql<Row[]>`select id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage from adjuntos where id=${attachmentId} and entidad=${entity} and entidad_id=${entityId} and storage_bucket=${PRIVATE_ATTACHMENT_BUCKET}`; return rows[0] ? attachment(rows[0]) : null; }
  async insert(value: PrivateAttachment): Promise<PrivateAttachment> { const rows = await this.sql<Row[]>`insert into adjuntos (id, entidad, entidad_id, storage_bucket, url_storage, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha) values (${value.id}, ${value.entity}, ${value.entityId}, ${PRIVATE_ATTACHMENT_BUCKET}, ${value.storagePath}, ${value.type}, ${value.name}, ${value.mimeType}, ${value.sizeBytes}, ${value.uploadedBy ?? null}, ${value.uploadedAt}) returning id, entidad, entidad_id, tipo, nombre_original, mime_type, tamano_bytes, subido_por, fecha, url_storage`; return attachment(rows[0]); }
}
class PostgresAttachmentTransactions implements PrivateAttachmentTransactionManager {
  constructor(private readonly sql: Sql) {}
  async transaction<T>(entity: AttachmentEntity, entityId: string, work: (tx: PrivateAttachmentTransaction) => Promise<T>): Promise<T> { return this.sql.begin(async (sql) => { await sql.unsafe(attachmentLockStatement(entity), [entityId]); const repository = new PostgresAttachmentRepository(sql as unknown as Sql); return work({ attachments: repository, audit: { append: async (event) => { await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values (${event.entity}, ${event.entityId}, ${event.event.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}, ${event.origin}, ${event.actorId ?? null}, ${event.at.toISOString()}, ${asJsonb(sql, event.data ?? {})})`; } } }); }) as Promise<T>; }
}
class SupabaseAttachmentStorage {
  private readonly client = createSupabaseServiceClient();
  async createUploadUrl(path: string): Promise<{ url: string }> { const result = await this.client.storage.from(PRIVATE_ATTACHMENT_BUCKET).createSignedUploadUrl(path, { upsert: false }); if (result.error || !result.data?.signedUrl) throw new Error("ATTACHMENT_STORAGE_UPLOAD_URL_FAILED"); return { url: result.data.signedUrl }; }
  async info(path: string): Promise<{ sizeBytes: number; mimeType: string } | null> { const bucket = this.client.storage.from(PRIVATE_ATTACHMENT_BUCKET) as unknown as { info(path: string): Promise<{ data: { metadata?: { size?: number | string; mimetype?: string; contentType?: string }; size?: number | string; mimetype?: string; content_type?: string } | null; error: unknown }> }; const result = await bucket.info(path); if (result.error || !result.data) return null; const metadata = result.data.metadata ?? {}, size = Number(metadata.size ?? result.data.size), mimeType = String(metadata.mimetype ?? metadata.contentType ?? result.data.mimetype ?? result.data.content_type ?? ""); return Number.isInteger(size) && size >= 0 && mimeType ? { sizeBytes: size, mimeType } : null; }
  async createDownloadUrl(path: string, expiresInSeconds: number): Promise<string> { const result = await this.client.storage.from(PRIVATE_ATTACHMENT_BUCKET).createSignedUrl(path, expiresInSeconds); if (result.error || !result.data?.signedUrl) throw new Error("ATTACHMENT_STORAGE_DOWNLOAD_URL_FAILED"); return result.data.signedUrl; }
}
export function createPrivateAttachmentServiceDependencies(databaseUrl = runtimeEnv().DATABASE_URL): PrivateAttachmentServiceDependencies { return { transactions: new PostgresAttachmentTransactions(sharedPostgres(databaseUrl)), storage: new SupabaseAttachmentStorage(), clock: { now: () => new Date() }, ids: { next: () => crypto.randomUUID() } }; }
