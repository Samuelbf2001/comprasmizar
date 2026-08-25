import { createHash } from "node:crypto";
import type { KapsoEventStore, KapsoClaim, KapsoProcessingStore } from "./kapso";
import type { KapsoWebhookEvent } from "../services";
import { MAX_PRIVATE_ATTACHMENT_BYTES, PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { createSupabaseServiceClient } from "./supabase";
import { asJsonb } from "./jsonb";

export function createPostgresKapsoEventStore(databaseUrl = runtimeEnv().DATABASE_URL): KapsoEventStore {
  const sql = sharedPostgres(databaseUrl);
  return { seen: async (eventId) => (await sql`select 1 from whatsapp_eventos where kapso_message_id=${eventId} limit 1`).length > 0, record: async (event: KapsoWebhookEvent) => { await sql.begin(async (tx) => { await tx`select pg_advisory_xact_lock(hashtextextended(${event.eventId}, 0))`; if ((await tx`select 1 from whatsapp_eventos where kapso_message_id=${event.eventId} limit 1`).length) return; const phone = event.submission?.phone ?? "unknown"; await tx`insert into whatsapp_eventos (direccion, telefono, tipo, payload_json, kapso_message_id, estado_entrega, fecha) values ('entrada', ${phone}, ${event.type === "flow_submission" ? "flow" : "mensaje"}, ${asJsonb(tx, event)}, ${event.eventId}, ${event.deliveryStatus ?? null}, ${event.receivedAt})`; }); } };
}
/**
 * A five-minute lease recovers a process killed after its claim. The advisory lock avoids
 * two live claims; `requisiciones.kapso_event_id` is the durable idempotency backstop.
 */
export function createPostgresKapsoProcessingStore(databaseUrl = runtimeEnv().DATABASE_URL, leaseMs = 300_000): KapsoProcessingStore {
  const sql = sharedPostgres(databaseUrl);
  return { claim: async (event) => sql.begin(async (tx) => { await tx`select pg_advisory_xact_lock(hashtextextended(${event.eventId}, 0))`; const rows = await tx<{ estado: string; stale: boolean }[]>`select estado, updated_at <= now() - (${leaseMs} * interval '1 millisecond') as stale from kapso_procesamiento where event_id=${event.eventId} for update`; const row = rows[0]; if (row?.estado === "completed") return "completed" as KapsoClaim; if (row?.estado === "processing" && !row.stale) return "in_progress" as KapsoClaim; await tx`insert into kapso_procesamiento (event_id, tipo_evento, estado, payload, updated_at) values (${event.eventId}, ${event.type}, 'processing', ${asJsonb(tx, event)}, now()) on conflict (event_id) do update set tipo_evento=excluded.tipo_evento, estado='processing', payload=excluded.payload, updated_at=now()`; const phone = event.submission?.phone ?? "unknown"; await tx`insert into whatsapp_eventos (direccion, telefono, tipo, payload_json, kapso_message_id, estado_entrega, fecha) values ('entrada', ${phone}, ${event.type === "flow_submission" ? "flow" : "mensaje"}, ${asJsonb(tx, event)}, ${event.eventId}, ${event.deliveryStatus ?? null}, ${event.receivedAt}) on conflict (kapso_message_id) where kapso_message_id is not null do nothing`; return "claimed" as KapsoClaim; }), complete: async (eventId, requisitionId) => { await sql.begin(async (tx) => { await tx`update kapso_procesamiento set estado='completed', requisicion_id=${requisitionId ?? null}, updated_at=now() where event_id=${eventId}`; if (requisitionId) await tx`update whatsapp_eventos set requisicion_id=${requisitionId} where kapso_message_id=${eventId}`; }); }, release: async (eventId) => { await sql`update kapso_procesamiento set estado='retryable', updated_at=now() where event_id=${eventId}`; }, findRequisitionId: async (eventId) => { const rows = await sql<{ id: string }[]>`select id from requisiciones where kapso_event_id=${eventId} limit 1`; return rows[0]?.id ?? null; } };
}

const ATTACHMENT_SIGNATURES: ReadonlyArray<{ mimeType: string; extension: string; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: "application/pdf", extension: "pdf", matches: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "%PDF" },
  { mimeType: "image/jpeg", extension: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/png", extension: "png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/webp", extension: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];
/**
 * Same four-type allowlist enforced by `PrivateAttachmentService.validate` (attachment-service.ts) —
 * reused here, not redefined, via its exported `MAX_PRIVATE_ATTACHMENT_BYTES`/`PRIVATE_ATTACHMENT_BUCKET`.
 * Unlike the browser upload flow (which trusts a signed URL's declared Content-Type because the
 * server never sees the bytes directly), a Kapso download IS untrusted network input the server
 * holds in memory, so its real file signature is checked before anything is written to storage.
 */
export function sniffAttachmentMime(bytes: Buffer): { mimeType: string; extension: string } | null {
  return ATTACHMENT_SIGNATURES.find((signature) => signature.matches(bytes)) ?? null;
}

export interface KapsoAttachmentDownloader { download(url: string): Promise<{ bytes: Buffer; contentType?: string }>; }
function kapsoMediaConfig(): { apiKey: string; timeoutMs: number } | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, timeoutMs: Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000 };
}
/**
 * Real download path: like WhatsApp Cloud API media URLs, a Kapso Flow `attachmentUrl` is a
 * time-limited link that must be fetched with the account's own bearer token, never treated as a
 * public URL. Fails closed with `KAPSO_NOT_CONFIGURED` when no API key is set; the caller
 * (createKapsoAttachmentCopier) treats that, and any other rejection, as a lost-attachment trace to
 * log — never as a reason to drop the requisition already created.
 */
const defaultKapsoAttachmentDownloader: KapsoAttachmentDownloader = {
  async download(url) {
    const config = kapsoMediaConfig();
    if (!config) throw new Error("KAPSO_NOT_CONFIGURED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch(url, { headers: { authorization: `Bearer ${config.apiKey}` }, signal: controller.signal });
      if (!response.ok) throw new Error(`KAPSO_ATTACHMENT_FETCH_FAILED_${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_PRIVATE_ATTACHMENT_BYTES) throw new Error("KAPSO_ATTACHMENT_TOO_LARGE");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_PRIVATE_ATTACHMENT_BYTES) throw new Error("KAPSO_ATTACHMENT_TOO_LARGE");
      return { bytes, contentType: response.headers.get("content-type") ?? undefined };
    } finally { clearTimeout(timeout); }
  },
};

export interface KapsoAttachmentSource { itemId: string; attachmentUrl: string; }
export interface KapsoAttachmentCopier { copyAll(event: KapsoWebhookEvent, requisitionId: string, sources: readonly KapsoAttachmentSource[]): Promise<void>; }
// Mirrors PREFIX.requisicion_item in attachment-service.ts and the path convention fixed by the
// adjuntos_genericos_documento_valido DB constraint (migration 202608240003); kept as a local literal
// because that PREFIX map is private to attachment-service.ts and out of this module's ownership.
const KAPSO_ATTACHMENT_PATH_PREFIX = "requisicion-items";
/** Only our own coded errors are safe to persist — anything else (raw fetch/library errors) may embed the
 * attachment URL, host or bearer token and must collapse to a generic code before it reaches a log/audit row. */
function safeFailureReason(error: unknown): string { return error instanceof Error && /^KAPSO_/.test(error.message) ? error.message : "KAPSO_ATTACHMENT_COPY_FAILED"; }

/**
 * Copies Flow evidence photos into the private `requisicion-adjuntos` bucket, one item at a time.
 * Never throws: each source is isolated so one bad photo cannot stop the others or the requisition
 * that already exists, and any failure is recorded in whatsapp_eventos + auditoria for a manual retry.
 */
export function createKapsoAttachmentCopier(databaseUrl = runtimeEnv().DATABASE_URL, downloader: KapsoAttachmentDownloader = defaultKapsoAttachmentDownloader): KapsoAttachmentCopier {
  const sql = sharedPostgres(databaseUrl);
  const storage = createSupabaseServiceClient().storage.from(PRIVATE_ATTACHMENT_BUCKET);
  const audit = (entidadId: string, evento: string, data: Record<string, unknown>) => sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values ('requisicion_item', ${entidadId}, ${evento.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}, 'kapso', null, now(), ${asJsonb(sql, data)})`;
  const logFailure = async (event: KapsoWebhookEvent, requisitionId: string, itemId: string, reason: string) => {
    const phone = event.submission?.phone ?? "desconocido";
    await sql`insert into whatsapp_eventos (direccion, telefono, requisicion_id, tipo, payload_json, estado_entrega, kapso_message_id, fecha) values ('entrada', ${phone}, ${requisitionId}, 'flow', ${asJsonb(sql, { evento: "adjunto_fallido", itemId, reason })}, 'fallido', ${`${event.eventId}:adjunto:${itemId}`}, now()) on conflict (kapso_message_id) where kapso_message_id is not null do nothing`;
    await audit(itemId, "adjunto_kapso_fallido", { requisitionId, reason });
  };
  return {
    async copyAll(event, requisitionId, sources) {
      for (const source of sources) {
        try {
          const { bytes } = await downloader.download(source.attachmentUrl);
          const signature = sniffAttachmentMime(bytes);
          if (!signature) throw new Error("KAPSO_ATTACHMENT_MIME_UNRECOGNIZED");
          if (bytes.byteLength < 1 || bytes.byteLength > MAX_PRIVATE_ATTACHMENT_BYTES) throw new Error("KAPSO_ATTACHMENT_SIZE_INVALID");
          const adjuntoId = crypto.randomUUID();
          const nombre = `evidencia-kapso.${signature.extension}`;
          const path = `${KAPSO_ATTACHMENT_PATH_PREFIX}/${source.itemId}/${adjuntoId}/${nombre}`;
          const checksum = createHash("sha256").update(bytes).digest("hex");
          const upload = await storage.upload(path, bytes, { contentType: signature.mimeType, upsert: false });
          if (upload.error) throw new Error("KAPSO_ATTACHMENT_UPLOAD_FAILED");
          await sql`insert into adjuntos (id, entidad, entidad_id, storage_bucket, url_storage, tipo, nombre_original, mime_type, tamano_bytes, subido_por, checksum_sha256, fecha) values (${adjuntoId}, 'requisicion_item', ${source.itemId}, ${PRIVATE_ATTACHMENT_BUCKET}, ${path}, 'foto', ${nombre}, ${signature.mimeType}, ${bytes.byteLength}, null, ${checksum}, now())`;
          await audit(source.itemId, "adjunto_kapso_disponible", { requisitionId, sizeBytes: bytes.byteLength, mimeType: signature.mimeType });
        } catch (error) {
          await logFailure(event, requisitionId, source.itemId, safeFailureReason(error)).catch(() => {});
        }
      }
    },
  };
}
