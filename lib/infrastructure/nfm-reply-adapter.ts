import { hmacSha256, safeEqual } from "../security/crypto";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { asJsonb } from "./jsonb";
import type { KapsoWebhookEvent } from "../services";

/**
 * Traduce la respuesta cruda de un WhatsApp Flow (`interactive.type=nfm_reply`), tal como Kapso la
 * reenvía desde Meta, hacia el contrato interno `KapsoWebhookEvent` que ya consume el webhook
 * idempotente (`app/api/kapso/route.ts` -> `kapso-processor.ts`). Ver
 * `integrations/whatsapp-flow/README.md` ("Mapeo requerido hacia el contrato del webhook") para el
 * mapeo campo a campo que este archivo implementa.
 *
 * Hallazgo de investigación (fuentes citadas en cada sección): Kapso NO reemplaza el mensaje de
 * Meta por uno propio — lo reenvía tal cual bajo `message.interactive.nfm_reply.response_json`
 * (un string JSON) y además añade, como conveniencia, la misma información ya parseada en
 * `message.kapso.flow_response` (`docs/whatsapp/flows/sending-flows.mdx:225-262` del corpus de
 * Kapso). Este adaptador parsea el string original de Meta (`response_json`) como fuente de verdad
 * — no depende de que el parseo de conveniencia de Kapso exista o sea correcto — exactamente el
 * mismo string que describe Meta en
 * `whatsapp/flows/guides/receiveflowresponse.md` ("Flow response message webhook").
 */

// ---------------------------------------------------------------------------------------------
// Forma cruda de entrada (lo que realmente entrega el webhook de Kapso para un mensaje nfm_reply)
// ---------------------------------------------------------------------------------------------

export interface RawNfmReplyMessage {
  id: string;
  from: string;
  timestamp?: string;
  type: string;
  interactive?: { type: string; nfm_reply?: { name?: string; body?: string; response_json: string } };
  // Conveniencia de Kapso (ya parseada), anidada bajo `message` — no bajo el payload raíz — según
  // `docs/whatsapp/flows/sending-flows.mdx` y `docs/platform/webhooks/message-events.mdx` del
  // corpus de Kapso. No se lee en este adaptador (ver comentario del módulo): se declara solo para
  // que el tipo del fixture sea fiel al webhook real.
  kapso?: { flow_response?: Record<string, unknown>; flow_token?: string; flow_name?: string };
}
export interface RawKapsoWebhookPayload {
  message: RawNfmReplyMessage;
  // Presentes en el envío real (`whatsapp.message.received`, formato v2) pero irrelevantes para
  // este adaptador — declarados solo por fidelidad con el webhook real.
  conversation?: Record<string, unknown>;
  is_new_conversation?: boolean;
  phone_number_id?: string;
}

/**
 * Distingue el payload real de Kapso (envoltura `{ message: {...} }`) del contrato ya normalizado
 * `{eventId, type, receivedAt, submission}` que usan los fixtures/pruebas existentes
 * (`fixtures/kapso-flow.json`) y cualquier otro `type` de evento (p. ej. `message_status`) que hoy
 * ya se maneja sin pasar por este adaptador. Solo cuando esto es `true` el webhook debe invocar
 * `adaptNfmReply`; en cualquier otro caso el payload sigue el camino existente sin cambios.
 */
export function isNfmReplyWebhookPayload(payload: unknown): payload is RawKapsoWebhookPayload {
  if (!payload || typeof payload !== "object") return false;
  const message = (payload as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.trim() === "" || typeof m.from !== "string" || m.from.trim() === "" || m.type !== "interactive") return false;
  const interactive = m.interactive as Record<string, unknown> | undefined;
  if (!interactive || interactive.type !== "nfm_reply") return false;
  const nfmReply = interactive.nfm_reply as Record<string, unknown> | undefined;
  return Boolean(nfmReply && typeof nfmReply.response_json === "string");
}

// ---------------------------------------------------------------------------------------------
// flow_token: cierre de procedencia (item 3 del ticket)
// ---------------------------------------------------------------------------------------------
//
// Contrato AUTORITATIVO, ya implementado por el emisor real (`issueFlowToken` en
// `lib/infrastructure/flow-sender.ts`) y documentado en
// `integrations/whatsapp-flow/README.md`, sección "Contrato de `flow_token`":
//
//   flow_token = "<timestampISO>.<hex>"
//   hex        = HMAC-SHA256(telefono + "." + timestampISO, KAPSO_WEBHOOK_SECRET)  // 64 hex
//
// `telefono` es el número normalizado a SOLO DÍGITOS (sin "+" ni separadores). `timestampISO`
// (`Date#toISOString()`) ya trae un punto propio (el separador de milisegundos): el hex son
// siempre los últimos 64 caracteres del token; todo lo anterior al ÚLTIMO punto es el timestamp
// — nunca partir por el primer punto. La validación de abajo implementa exactamente este
// contrato (no un esquema propio): `validateFlowToken` es la contraparte receptora de
// `issueFlowToken`, deliberadamente NO reimplementada aquí para evitar que ambos lados diverjan
// — se importa y se usa directamente en las pruebas de este archivo.
//
// Por qué es viable cerrar la procedencia con un token propio en vez de depender de Kapso: Kapso
// confirma que el valor de `flow_token` es enteramente definido por quien envía el Flow y se
// devuelve sin modificar — "Kapso links a flow response to its flow through the outbound message
// the reply replies to, not through the token value, so response collection keeps working with
// any flowToken" (`docs/whatsapp/flows/sending-flows.mdx`, sección "Flow token"). Nada en el
// camino Meta→Kapso reescribe ese valor.

const FLOW_TOKEN_PATTERN = /^(.+)\.([0-9a-f]{64})$/;
const FLOW_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const FLOW_TOKEN_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Normaliza un teléfono a solo dígitos (sin "+" ni separadores) — la forma exacta que
 * `issueFlowToken` firma como `telefono`. Úsese SOLO para el cómputo del HMAC del flow_token; el
 * `phone` que viaja en `KapsoFlowSubmission` es un formato de presentación aparte (E.164 con "+"). */
export function normalizePhoneForToken(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

export type FlowTokenRejectionReason = "invalid_flow_token_format" | "flow_token_expired" | "invalid_flow_token_signature";

/** Puro y síncrono: sin I/O, fácil de probar con relojes fijos. Contraparte receptora exacta de
 * `issueFlowToken` (`lib/infrastructure/flow-sender.ts`). */
export function validateFlowToken(flowToken: string, verifiedPhone: string, secret: string, now: Date): { ok: true } | { ok: false; reason: FlowTokenRejectionReason } {
  const match = FLOW_TOKEN_PATTERN.exec(flowToken.trim());
  if (!match) return { ok: false, reason: "invalid_flow_token_format" };
  const [, isoTimestamp, signatureHex] = match;
  const issuedAtMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, reason: "invalid_flow_token_format" };
  const ageMs = now.getTime() - issuedAtMs;
  if (ageMs > FLOW_TOKEN_MAX_AGE_MS || ageMs < -FLOW_TOKEN_MAX_CLOCK_SKEW_MS) return { ok: false, reason: "flow_token_expired" };
  const expected = hmacSha256(`${normalizePhoneForToken(verifiedPhone)}.${isoTimestamp}`, secret);
  if (!safeEqual(expected, signatureHex.toLowerCase())) return { ok: false, reason: "invalid_flow_token_signature" };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Traducción pura del `response_json` plano hacia KapsoFlowSubmission
// ---------------------------------------------------------------------------------------------

export type NfmReplyRejectionReason = "invalid_response_json" | FlowTokenRejectionReason | "invalid_fields" | "invalid_item" | "no_items";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function isHttpsUrl(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }

interface CompactedItem { itemId?: string; proposedDescription?: string; quantity: number; unit: string; possibleSupplier?: string; productLink?: string; attachmentUrl?: string; }

/**
 * Compacta las 3 franjas fijas del Flow (`item_N_*`, N=1..3) en un arreglo de ítems, aplicando las
 * reglas del ticket: una franja sin descripción NI itemId de catálogo se ignora en silencio; una
 * franja presente con cantidad inválida (no numérica o <=0) o sin unidad invalida el evento
 * completo — no se envía una requisición a medias.
 */
function compactItems(fields: Record<string, unknown>): { ok: true; items: CompactedItem[] } | { ok: false; reason: "invalid_item" | "no_items" } {
  const items: CompactedItem[] = [];
  for (const n of [1, 2, 3] as const) {
    const catalogo = asString(fields[`item_${n}_catalogo`]);
    const descripcion = asString(fields[`item_${n}_descripcion`]);
    const present = catalogo !== "" || descripcion !== "";
    if (!present) continue;
    if (catalogo !== "" && !UUID_RE.test(catalogo)) return { ok: false, reason: "invalid_item" };
    const cantidadRaw = asString(fields[`item_${n}_cantidad`]);
    const quantity = cantidadRaw === "" ? NaN : Number(cantidadRaw);
    if (!Number.isFinite(quantity) || quantity <= 0) return { ok: false, reason: "invalid_item" };
    const unidad = asString(fields[`item_${n}_unidad`]);
    if (unidad === "") return { ok: false, reason: "invalid_item" };
    const link = asString(fields[`item_${n}_link`]);
    if (link !== "" && !isHttpsUrl(link)) return { ok: false, reason: "invalid_item" };
    const item: CompactedItem = { quantity, unit: unidad };
    if (catalogo !== "") item.itemId = catalogo;
    if (descripcion !== "") item.proposedDescription = descripcion;
    const proveedor = asString(fields[`item_${n}_proveedor`]);
    if (proveedor !== "") item.possibleSupplier = proveedor;
    if (link !== "") item.productLink = link;
    items.push(item);
  }
  if (items.length === 0) return { ok: false, reason: "no_items" };
  return { ok: true, items };
}

interface TopLevelFields { type: "compra" | "pago"; workId: string; requiredDate: string; requesterName: string; destination?: string; observations?: string; }

function extractTopLevelFields(fields: Record<string, unknown>): { ok: true; value: TopLevelFields } | { ok: false; reason: "invalid_fields" } {
  const type = asString(fields.type);
  if (type !== "compra" && type !== "pago") return { ok: false, reason: "invalid_fields" };
  const workId = asString(fields.workId);
  if (!UUID_RE.test(workId)) return { ok: false, reason: "invalid_fields" };
  const requiredDate = asString(fields.requiredDate);
  if (!DATE_RE.test(requiredDate)) return { ok: false, reason: "invalid_fields" };
  const requesterName = asString(fields.requesterName);
  if (requesterName.length < 2 || requesterName.length > 160) return { ok: false, reason: "invalid_fields" };
  // Nota: las claves del payload `complete` del Flow son "destination"/"observations" (inglés),
  // aunque el campo de formulario subyacente se llama "destino"/"observaciones" — ver
  // integrations/whatsapp-flow/requisicion.flow.json, pantalla RESUMEN.
  const destination = asString(fields.destination);
  const observations = asString(fields.observations);
  return { ok: true, value: { type, workId, requiredDate, requesterName, destination: destination || undefined, observations: observations || undefined } };
}

/**
 * El DocumentPicker `evidencia` es un único campo a nivel de envío (no por ítem) que puede traer
 * hasta 3 documentos. El contrato `KapsoFlowSubmission` solo admite un `attachmentUrl` por ítem, así
 * que — a falta de una relación natural evidencia↔ítem — este adaptador adjunta únicamente el
 * PRIMER documento al PRIMER ítem (el único garantizado presente). Documentos adicionales se
 * descartan; es una limitación conocida y deliberada de este ticket, análoga a la de los "3 items
 * fijos" ya aceptada en el README del Flow.
 */
function firstEvidenceMediaId(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (!first || typeof first !== "object") return null;
  const id = (first as Record<string, unknown>).id;
  return typeof id === "string" && id.trim() !== "" ? id.trim() : null;
}

export interface AdaptNfmReplyConfig {
  /** Secreto HMAC del flow_token. Se reutiliza `KAPSO_WEBHOOK_SECRET` (mismo pepper que firma el
   * webhook completo) para no ampliar el esquema de env vars (`lib/security/env.ts`) fuera del
   * alcance de este ticket; ambos extremos (emisor y receptor del Flow) son el mismo backend, así
   * que compartir el secreto no cruza una frontera de confianza nueva. */
  secret: string;
  now?: Date;
  /** Resuelve un media id de WhatsApp (evidencia) a una URL HTTPS descargable. Ausente en pruebas
   * unitarias puras: en ese caso la evidencia simplemente no se adjunta. Nunca debe lanzar. */
  resolveAttachmentUrl?: (mediaId: string) => Promise<string | null>;
}

export type AdaptNfmReplyResult = { ok: true; event: KapsoWebhookEvent } | { ok: false; reason: NfmReplyRejectionReason; wamid?: string; phone?: string };

/**
 * Traduce y valida un webhook crudo de Kapso con `interactive.type=nfm_reply` hacia
 * `KapsoWebhookEvent`. No escribe nada — ni en Postgres ni en ningún lado — y no es responsable de
 * la idempotencia: el evento resultante entra por el mismo camino de `processKapsoEvent`/
 * `kapso-processor.ts` que ya existe. Un rechazo (`ok:false`) es "neutro": el llamador debe
 * registrar la entrada inválida (ver `createPostgresNfmReplyRejectionRecorder`) y responder sin
 * crear ninguna requisición, nunca como un error 5xx.
 */
export async function adaptNfmReply(payload: RawKapsoWebhookPayload, config: AdaptNfmReplyConfig): Promise<AdaptNfmReplyResult> {
  const now = config.now ?? new Date();
  const wamid = payload.message.id;
  const verifiedPhone = payload.message.from;
  const responseJsonRaw = payload.message.interactive?.nfm_reply?.response_json;
  if (typeof responseJsonRaw !== "string") return { ok: false, reason: "invalid_response_json", wamid, phone: verifiedPhone };

  let parsed: unknown;
  try { parsed = JSON.parse(responseJsonRaw); } catch { return { ok: false, reason: "invalid_response_json", wamid, phone: verifiedPhone }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "invalid_response_json", wamid, phone: verifiedPhone };
  const fields = parsed as Record<string, unknown>;

  const flowToken = asString(fields.flow_token);
  if (flowToken === "") return { ok: false, reason: "invalid_flow_token_format", wamid, phone: verifiedPhone };
  const tokenCheck = validateFlowToken(flowToken, verifiedPhone, config.secret, now);
  if (!tokenCheck.ok) return { ok: false, reason: tokenCheck.reason, wamid, phone: verifiedPhone };

  const topLevel = extractTopLevelFields(fields);
  if (!topLevel.ok) return { ok: false, reason: topLevel.reason, wamid, phone: verifiedPhone };

  const compacted = compactItems(fields);
  if (!compacted.ok) return { ok: false, reason: compacted.reason, wamid, phone: verifiedPhone };
  const items = compacted.items;

  const evidenceMediaId = firstEvidenceMediaId(fields.evidencia);
  if (evidenceMediaId && config.resolveAttachmentUrl && items[0]) {
    try {
      const url = await config.resolveAttachmentUrl(evidenceMediaId);
      if (url) items[0] = { ...items[0], attachmentUrl: url };
    } catch {
      // Un adjunto perdido nunca debe bloquear la requisición — mismo contrato que
      // `attachEvidence` en kapso-processor.ts / kapso-store.ts.
    }
  }

  // Identidad = remitente verificado por WhatsApp (message.from), no el campo `phone` editable del
  // Flow — decisión ya recomendada en integrations/whatsapp-flow/README.md, sección "phone".
  // Formato de presentación E.164 con "+" (convención ya usada por fixtures/kapso-flow.json);
  // distinto del formato solo-dígitos que exige el HMAC del flow_token (normalizePhoneForToken).
  const phone = `+${normalizePhoneForToken(verifiedPhone)}`;
  const event: KapsoWebhookEvent = {
    eventId: wamid,
    type: "flow_submission",
    receivedAt: now.toISOString(),
    submission: {
      eventId: wamid, phone, workId: topLevel.value.workId, requiredDate: topLevel.value.requiredDate,
      type: topLevel.value.type, requesterName: topLevel.value.requesterName,
      destination: topLevel.value.destination, observations: topLevel.value.observations,
      items,
    },
  };
  return { ok: true, event };
}

// ---------------------------------------------------------------------------------------------
// Resolución de evidencia: media id de WhatsApp -> URL HTTPS descargable de un solo GET
// ---------------------------------------------------------------------------------------------
//
// Hallazgo de investigación que corrige la advertencia del README del Flow: el arreglo cifrado
// (`media_id`/`cdn_url`/`encryption_metadata`, AES256-CBC+HMAC-SHA256+pkcs7) que describe
// `whatsapp/flows/guides/media_upload.md` bajo "Handling media" es el payload que recibe un
// **Data Endpoint** vía `data_exchange` — este Flow no tiene Data Endpoint (ver README, "sin Data
// Endpoint"). Lo que de verdad llega en `response_json` de un `complete` es la sección "Response
// message (Cloud API)" del MISMO archivo: `{"evidencia":[{"file_name":...,"mime_type":...,
// "sha256":...,"id":"<media-id>"}], "flow_token":"xyz", ...}` — un `id` de media normal de
// WhatsApp, sin cifrado a este nivel.
//
// Para bajarlo con un solo GET (el contrato que ya exige `kapso-store.ts`'s
// `defaultKapsoAttachmentDownloader`), se usa el endpoint de conveniencia del proxy de Kapso:
// `GET {KAPSO_META_PROXY_URL}/{media_id}` devuelve `download_url`, "a URL to download the media
// file without needing to pass auth headers — authentication is embedded in the token"
// (`api/meta/whatsapp/openapi-whatsapp.yaml`, operationId `getMediaUrl`). Eso reemplaza el flujo de
// dos llamadas de la Graph API estándar (`GET /{media-id}` -> metadata con `url` de 5 minutos,
// luego un segundo GET con bearer token) por una sola URL ya lista para el downloader existente.

interface KapsoMetaProxyConfig { apiKey: string; baseUrl: string; phoneNumberId: string; timeoutMs: number; }
function kapsoMetaProxyConfig(): KapsoMetaProxyConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const baseUrl = process.env.KAPSO_META_PROXY_URL?.trim().replace(/\/+$/, "");
  // El proxy de Kapso EXIGE phone_number_id en la query de /media; sin él responde 404
  // "WhatsApp configuration not found" y la evidencia se perdería en silencio (verificado en vivo).
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!apiKey || !baseUrl || !phoneNumberId) return null;
  const timeoutMs = Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000;
  return { apiKey, baseUrl, phoneNumberId, timeoutMs };
}

/** Nunca lanza: un fallo al resolver evidencia jamás debe tumbar una requisición ya válida. */
export async function resolveKapsoMediaDownloadUrl(mediaId: string): Promise<string | null> {
  const config = kapsoMetaProxyConfig();
  if (!config) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(config.phoneNumberId)}`, { headers: { "X-API-Key": config.apiKey }, signal: controller.signal });
    if (!response.ok) return null;
    const data = (await response.json().catch(() => null)) as { download_url?: string } | null;
    const url = data?.download_url;
    return typeof url === "string" && isHttpsUrl(url) ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------------------------
// Auditoría de rechazos: "registrado en whatsapp_eventos como entrada inválida, sin crear
// requisición" (item 3 del ticket). El adaptador de arriba no escribe nada; esto sí.
// ---------------------------------------------------------------------------------------------

export interface NfmReplyRejectionRecorder {
  record(input: { wamid?: string; phone?: string; reason: NfmReplyRejectionReason; rawPayload: unknown }): Promise<void>;
}

export function createPostgresNfmReplyRejectionRecorder(databaseUrl = runtimeEnv().DATABASE_URL): NfmReplyRejectionRecorder {
  const sql = sharedPostgres(databaseUrl);
  return {
    async record({ wamid, phone, reason, rawPayload }) {
      // Sufijo ":rejected" deliberado: nunca debe colisionar con el `kapso_message_id` que usa el
      // camino de procesamiento real (kapso-store.ts) para el mismo wamid — son índices de
      // auditoría distintos aunque compartan la columna con índice único.
      const kapsoMessageId = wamid ? `${wamid}:rejected` : null;
      await sql`insert into whatsapp_eventos (direccion, telefono, tipo, payload_json, estado_entrega, kapso_message_id, fecha)
        values ('entrada', ${phone ?? "desconocido"}, 'flow', ${asJsonb(sql, { evento: "nfm_reply_rechazado", reason, rawPayload })}, 'fallido', ${kapsoMessageId}, now())
        on conflict (kapso_message_id) where kapso_message_id is not null do nothing`;
    },
  };
}
