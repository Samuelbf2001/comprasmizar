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

export type NfmReplyRejectionReason = "invalid_response_json" | FlowTokenRejectionReason | "invalid_fields" | "invalid_item" | "no_items" | "unauthorized_requester";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function asString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function isHttpsUrl(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }

interface CompactedItem { itemId?: string; proposedDescription?: string; quantity: number; unit: string; possibleSupplier?: string; productLink?: string; attachmentUrl?: string; }

/**
 * Número de franjas de artículo que puede traer el Flow de captura.
 *
 * Debe coincidir con `MAX_ITEMS` de `scripts/build-flow-captura.ts`. El archivo que nombraba este
 * comentario, `integrations/whatsapp-flow/build-requisicion-flow.mjs`, NO existe. Lo ata la prueba
 * "el tope de franjas del adaptador es el mismo que el del generador" en tests/integration/nfm-reply.test.ts, que es
 * quien genera las pantallas. Subió de 3 a 8 en el Flow v2: Ernesto, probando desde su celular,
 * avisó de que tres se le quedaban cortos («me preocupa querer agregar más y no poder»). Las ocho
 * pantallas existen siempre pero solo se visitan bajo demanda, así que lo normal es que lleguen
 * casi todas vacías — y vacías se descartan aquí mismo, sin ruido.
 *
 * Leer de más es inocuo con el Flow v1 (las claves 4..8 sencillamente no vienen), así que el
 * adaptador sirve a los dos mientras convivan.
 */
export const MAX_ITEM_SLOTS = 8;

/**
 * Los sufijos de `item_N_*` que este adaptador LEE de verdad.
 *
 * Se exporta para poder cruzarlo con el `complete` del Flow generado
 * (`tests/unit/flow-captura-v2.test.ts`). Ese cruce existe por un fallo real: al reconstruir el
 * Flow para el v2 se perdió `item_N_foto` del `complete` mientras las ocho pantallas seguían
 * mostrando el `PhotoPicker`. Nadie se enteró porque falla en silencio — la requisición se crea, la
 * foto simplemente no está. Son dos artefactos que TIENEN que coincidir y no había nada
 * comprobándolo.
 */
export const CAMPOS_ITEM_LEIDOS = ["catalogo", "descripcion", "cantidad", "unidad", "proveedor", "link", "foto"] as const;

/**
 * Compacta las franjas fijas del Flow (`item_N_*`, N=1..MAX_ITEM_SLOTS) en un arreglo de ítems,
 * aplicando las reglas del ticket: una franja sin descripción NI itemId de catálogo se ignora en
 * silencio; una franja presente con cantidad inválida (no numérica o <=0) o sin unidad invalida el
 * evento completo — no se envía una requisición a medias.
 */
function compactItems(fields: Record<string, unknown>): { ok: true; items: CompactedItem[]; fotoMediaIds: (string | null)[] } | { ok: false; reason: "invalid_item" | "no_items" } {
  const items: CompactedItem[] = [];
  // Media id de la foto de CADA ítem presente, en el mismo orden que `items` (tras compactar las
  // franjas vacías). Cada foto se adjunta a SU ítem, no una sola evidencia al primero.
  const fotoMediaIds: (string | null)[] = [];
  for (let n = 1; n <= MAX_ITEM_SLOTS; n += 1) {
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
    fotoMediaIds.push(firstEvidenceMediaId(fields[`item_${n}_foto`]));
  }
  if (items.length === 0) return { ok: false, reason: "no_items" };
  return { ok: true, items, fotoMediaIds };
}

// Reunión 2026-08-31: el solicitante elige EMPRESA, no obra — la obra la asigna el revisor más
// adelante. `societyId` reemplaza a `workId` como campo de nivel superior del payload del Flow
// (ver integrations/whatsapp-flow/requisicion.flow.json, pantalla TIPO_Y_OBRA renombrada a
// TIPO_Y_EMPRESA). `destination` desaparece del contrato (su sentido se fusiona en
// `observaciones` desde el propio Flow — ver requisicion.flow.json, pantalla DETALLES).
//
// `workId` se conserva aquí como campo OPCIONAL de compatibilidad: `KapsoFlowSubmission.workId`
// (lib/services/kapso-contracts.ts) y `ProcurementService.create` (lib/services/procurement-service.ts)
// ya lo modelan/exigen como opcional para el canal whatsapp — un envío real del Flow, sin `workId`
// y con `societyId`, ya no es rechazado con `FORBIDDEN` (bloqueante cerrado).
//
// `societyId` llega aquí CRUDO (`societyIdRaw`), sin validar su forma todavía: desde que
// `buildSocietyOptions` (flow-sender.ts) puso el NOMBRE de la sociedad como valor del Dropdown (ver
// comentario ahí — el Flow publicado no se puede republicar y el RESUMEN pinta el valor crudo), este
// campo puede traer un uuid (envíos viejos o Flows ya en curso) O un nombre. Resolverlo a un uuid
// real necesita I/O (consultar el catálogo de sociedades), así que esta función sigue siendo pura y
// solo pasa el valor crudo hacia adelante; `adaptNfmReply` es quien lo resuelve.
interface TopLevelFields { type: "compra" | "pago"; societyIdRaw: string; workId?: string; requiredDate?: string; observations?: string; }

function extractTopLevelFields(fields: Record<string, unknown>): { ok: true; value: TopLevelFields } | { ok: false; reason: "invalid_fields" } {
  const type = asString(fields.type);
  if (type !== "compra" && type !== "pago") return { ok: false, reason: "invalid_fields" };
  const societyIdRaw = asString(fields.societyId);
  if (societyIdRaw === "") return { ok: false, reason: "invalid_fields" };
  // requiredDate opcional en los tres canales (reunión 2026-08-31): la validación de FORMATO solo
  // se aplica si viene un valor — un vacío ya no invalida el evento completo.
  const requiredDateRaw = asString(fields.requiredDate);
  if (requiredDateRaw !== "" && !DATE_RE.test(requiredDateRaw)) return { ok: false, reason: "invalid_fields" };
  // Ver comentario del módulo, arriba: workId de compatibilidad, no validado (un valor con formato
  // inválido simplemente se descarta en silencio, no invalida el evento — a diferencia de
  // societyId, que sí es la identidad real y obligatoria ahora).
  const workIdRaw = asString(fields.workId);
  const workId = UUID_RE.test(workIdRaw) ? workIdRaw : undefined;
  const observations = asString(fields.observations);
  return { ok: true, value: { type, societyIdRaw, workId, requiredDate: requiredDateRaw || undefined, observations: observations || undefined } };
}

/**
 * Resuelve `societyIdRaw` (uuid crudo o nombre de sociedad, ver comentario de `TopLevelFields`) al
 * uuid real. El camino uuid es puro y no toca la BD — es el caso de siempre y el más frecuente
 * mientras convivan Flows en curso emitidos antes de este cambio. El camino nombre delega en
 * `config.resolveSocietyId` (inyectable, mismo patrón que `resolveRequester`/`resolveAttachmentUrl`)
 * y nunca lanza: un fallo de la consulta o la ausencia del resolver (pruebas puras sin BD) se tratan
 * igual que "no resuelto" — fail-closed, `invalid_fields`, como ya ocurría con un uuid mal formado.
 */
async function resolveSocietyIdField(raw: string, resolveSocietyId?: (nameOrLabel: string) => Promise<string | null>): Promise<string | null> {
  if (UUID_RE.test(raw)) return raw;
  if (!resolveSocietyId) return null;
  try {
    return await resolveSocietyId(raw);
  } catch {
    return null;
  }
}

/**
 * Cada artículo tiene su propio `PhotoPicker` (`item_N_foto`), que llega como un arreglo de objetos
 * de media. Se toma el `id` de la PRIMERA foto de ese ítem (max-uploaded-photos = 1 en el Flow, así
 * que en la práctica hay a lo sumo una). Devuelve `null` si el ítem no trae foto.
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
  /**
   * Identifica al solicitante por su número de WhatsApp contra la lista blanca GLOBAL
   * (`solicitantes_autorizados`, migración 202609010001) — reunión 2026-08-31: el solicitante
   * elige empresa, no obra, así que la lista deja de estar anclada a una obra que el Flow ni
   * siquiera pide. `obra_solicitantes_autorizados` se conserva intacta para el portal público
   * (Fase 6, anclado a la obra), que no pasa por este adaptador. El Flow ya NO pide nombre ni
   * teléfono: la identidad es el remitente verificado. Devuelve el nombre autorizado, o `null` si
   * el número no está permitido → la requisición se rechaza como `unauthorized_requester`. Nunca
   * debe lanzar.
   */
  resolveRequester: (phone: string) => Promise<{ name: string } | null>;
  /**
   * Resuelve el NOMBRE de una sociedad (o su forma desambiguada "Nombre (NIT)", ver
   * `buildSocietyOptions` en flow-sender.ts) al uuid real de `sociedades.id`. Solo se invoca cuando
   * `societyId` NO llega como uuid — el emisor puso el nombre como valor del Dropdown porque el
   * Flow PUBLICADO en Meta (v3, `875992355468043`) no se puede republicar: su RESUMEN pinta el
   * valor crudo del Dropdown (`${data.empresa}`) y no hay forma de que el propio Flow mapee
   * id→nombre sin encadenar un `If` por sociedad, inviable con un catálogo dinámico. Opcional, como
   * `resolveAttachmentUrl`: ausente en pruebas puras donde el `societyId` del fixture ya es un uuid
   * (el camino viejo). Nunca debe lanzar — ver `resolveSocietyIdField`, que ya lo envuelve en
   * try/catch. La implementación real es `createPostgresSocietyResolver`, más abajo.
   */
  resolveSocietyId?: (nameOrLabel: string) => Promise<string | null>;
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

  // Ver comentario de `resolveSocietyIdField`: uuid crudo (camino viejo) o nombre de sociedad
  // (camino nuevo, ver flow-sender.ts). Si no resuelve → invalid_fields, igual que un uuid mal
  // formado antes de este cambio.
  const societyId = await resolveSocietyIdField(topLevel.value.societyIdRaw, config.resolveSocietyId);
  if (!societyId) return { ok: false, reason: "invalid_fields", wamid, phone: verifiedPhone };

  // Identidad por lista blanca GLOBAL: el número de WhatsApp debe estar autorizado en la
  // plataforma (ya no por obra — reunión 2026-08-31). Sin esto cualquiera que consiga la línea
  // podría crear requisiciones a nombre de otra persona.
  let requester: { name: string } | null = null;
  try {
    requester = await config.resolveRequester(verifiedPhone);
  } catch {
    // Un fallo de la consulta no debe convertirse en 500: se trata como no autorizado (fail-closed).
    requester = null;
  }
  if (!requester) return { ok: false, reason: "unauthorized_requester", wamid, phone: verifiedPhone };

  const compacted = compactItems(fields);
  if (!compacted.ok) return { ok: false, reason: compacted.reason, wamid, phone: verifiedPhone };
  const items = compacted.items;

  // Foto POR ÍTEM: la foto de cada artículo se adjunta a ese artículo. Un adjunto perdido nunca
  // bloquea la requisición (mismo contrato que `attachEvidence` en kapso-store.ts); si falla la
  // resolución, el ítem se crea igual sin foto.
  if (config.resolveAttachmentUrl) {
    for (let i = 0; i < items.length; i++) {
      const mediaId = compacted.fotoMediaIds[i];
      if (!mediaId) continue;
      try {
        const url = await config.resolveAttachmentUrl(mediaId);
        if (url) items[i] = { ...items[i], attachmentUrl: url };
      } catch {
        // silencioso a propósito: la foto es opcional y nunca puede tumbar la solicitud.
      }
    }
  }

  // Identidad = remitente verificado por WhatsApp (message.from), no el campo `phone` editable del
  // Flow — decisión ya recomendada en integrations/whatsapp-flow/README.md, sección "phone".
  // Formato de presentación E.164 con "+" (convención ya usada por fixtures/kapso-flow.json);
  // distinto del formato solo-dígitos que exige el HMAC del flow_token (normalizePhoneForToken).
  const phone = `+${normalizePhoneForToken(verifiedPhone)}`;
  // `KapsoFlowSubmission` (lib/services/kapso-contracts.ts) ya declara `societyId` obligatorio,
  // `workId`/`requiredDate` opcionales y (MENOR, QA Postgres real) ya NO declara un `destination?:
  // string` heredado, así que el objeto construido aquí calza estructuralmente con ese contrato sin
  // necesitar ningún cast.
  const submission = {
    eventId: wamid, phone, workId: topLevel.value.workId, requiredDate: topLevel.value.requiredDate,
    type: topLevel.value.type, requesterName: requester.name, observations: topLevel.value.observations,
    items, societyId,
  };
  const event: KapsoWebhookEvent = { eventId: wamid, type: "flow_submission", receivedAt: now.toISOString(), submission };
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
// Resolución de sociedad: nombre del Dropdown (o "Nombre (NIT)" desambiguado) -> uuid real
// ---------------------------------------------------------------------------------------------
//
// Contraparte receptora de `buildSocietyOptions` (flow-sender.ts). Mismo patrón que
// `createPostgresApproverResolver` (approval-reply-adapter.ts): una función inyectable, no un
// objeto con métodos, porque `resolveSocietyId` es la única operación que necesita este adaptador.

/**
 * Coincide por nombre exacto O por "nombre (nit)" — el sufijo que `buildSocietyOptions` agrega SOLO
 * cuando dos sociedades ACTIVAS comparten nombre. Hoy eso es imposible por la restricción `UNIQUE`
 * de `sociedades.nombre` (migración 202608240001), pero se soportan ambas formas de todos modos,
 * para no depender en silencio de una restricción que vive en otra capa. Si hay más de una
 * coincidencia (no debería, dado el `UNIQUE`) o ninguna, devuelve `null` — fail-closed, igual que
 * `createPostgresApproverResolver`. Mismo filtro `activa = true` que ya usa `listActiveSocieties`
 * (flow-sender.ts): no se resuelve el nombre de una sociedad desactivada después de enviado el Flow.
 */
export function createPostgresSocietyResolver(databaseUrl = runtimeEnv().DATABASE_URL): (nameOrLabel: string) => Promise<string | null> {
  const sql = sharedPostgres(databaseUrl);
  return async (nameOrLabel: string) => {
    const label = nameOrLabel.trim();
    if (!label) return null;
    const rows = await sql<{ id: string }[]>`
      select id from sociedades
      where activa = true
        and (nombre = ${label} or (nombre || ' (' || coalesce(nit, '') || ')') = ${label})
      limit 2`;
    return rows.length === 1 ? rows[0].id : null;
  };
}

// ---------------------------------------------------------------------------------------------
// Auditoría de rechazos: "registrado en whatsapp_eventos como entrada inválida, sin crear
// requisición" (item 3 del ticket). El adaptador de arriba no escribe nada; esto sí.
// ---------------------------------------------------------------------------------------------

export interface NfmReplyRejectionRecorder {
  /** `reason` es `string` y no `NfmReplyRejectionReason` porque el mismo registro sirve al Flow de
   * aprobación (`ApprovalRejectionReason` en approval-reply-adapter.ts), que tiene su propio
   * conjunto de motivos. Es una auditoría de entradas inválidas, no un enum de dominio. */
  record(input: { wamid?: string; phone?: string; reason: string; rawPayload: unknown }): Promise<void>;
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
