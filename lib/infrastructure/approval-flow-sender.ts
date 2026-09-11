import { hmacSha256, safeEqual } from "../security/crypto";
import { destinatarioWhatsApp } from "./phone";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";

/**
 * Emisor del WhatsApp Flow "Aprobación de requisición" (`integrations/whatsapp-flow/aprobacion.flow.json`).
 *
 * Es el gemelo de `flow-sender.ts` (Flow de captura) para el otro extremo del ciclo: en vez de pedirle
 * datos a un solicitante, le muestra al APROBADOR ASIGNADO los ítems ya cotizados de una requisición
 * concreta y recoge su decisión. Vive en su propio archivo, y no como una variante de `flow-sender.ts`,
 * porque casi nada es compartible: otro Flow ID, otro contrato de token (ver abajo), otra pantalla de
 * entrada y otra fuente de datos.
 *
 * Decisión propia, no respaldada por ningún RF del PRD (que llega hasta RF-1206 y no contempla este
 * canal): el alcance del Flow es aprobar/devolver la requisición y decidir qué ítems entran, que es
 * exactamente lo que el dominio ya sabe hacer (`decideItems` + `approve`/`returnForCorrection` en
 * lib/services/procurement-service.ts, reunión 2026-08-31). No introduce ningún concepto de negocio
 * nuevo: es un segundo frente para las mismas operaciones que ya existen en la app web.
 */

/**
 * Tope DURO de Meta, no una elección nuestra: `CheckboxGroup` admite un máximo de **20 opciones**
 * ("Max # of options: 20", tabla de límites de CheckboxGroup en
 * `whatsapp/flows/reference/components`, verificado 2026-09-10). Una requisición con más ítems
 * vigentes NO se puede aprobar por WhatsApp por más que se quiera: el llamador cae al aviso de
 * plantilla para que esa persona la apruebe en la web (ver el cableado en
 * app/api/internal/dispatch-notifications/route.ts).
 */
export const MAX_APPROVAL_ITEMS = 20;
/**
 * `title` de una opción: 30 caracteres es el tope documentado de Meta para CheckboxGroup (misma
 * tabla). `description` admite hasta 300 según esa tabla; 80 es una decisión propia de legibilidad
 * —la descripción es "400 bulto · $18.088.000", que cabe de sobra— para que la lista no se
 * convierta en un muro de texto en un teléfono. Subirlo hasta 300 es seguro; bajar el título de 30
 * no haría falta.
 */
const MAX_OPTION_TITLE_LENGTH = 30;
const MAX_OPTION_DESCRIPTION_LENGTH = 80;

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Pesos colombianos con separador de miles, sin decimales. Manual y determinista a propósito: el
 * texto viaja dentro del payload del Flow, así que no debe depender de que el proceso tenga ICU
 * completo (a diferencia de `colombiaDateParts`, que sí necesita Intl para la zona horaria). */
export function formatCop(value: number): string {
  const rounded = Math.round(Number.isFinite(value) ? value : 0);
  const digits = Math.abs(rounded).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${rounded < 0 ? "-" : ""}$${digits}`;
}

export interface ApprovalFlowOption { id: string; title: string; description: string; }
export interface ApprovalFlowContext {
  requisitionId: string;
  /** Teléfono del aprobador asignado, tal como está en `usuarios.telefono`. */
  approverPhone: string;
  /** Campos sueltos para las variables de la plantilla ({{1}}..{{4}}), que no admite saltos de
   * línea ni texto compuesto. `heading`/`summary` son la versión ya compuesta para las pantallas
   * del Flow; ambas salen de los mismos datos para que nunca se contradigan. */
  approverName: string;
  consecutive: string;
  work: string;
  totalText: string;
  /** "REQ-2026-0004 · Obra La Pradera" — cabecera de la pantalla. */
  heading: string;
  /** Bloque de contexto (solicitante, fecha requerida, total vigente). */
  summary: string;
  items: ApprovalFlowOption[];
}

/** Inyectable para pruebas; la BD real la da `createPostgresApprovalFlowSource`. */
export interface ApprovalFlowSource {
  /** `null` cuando la requisición no existe, no está `en_aprobacion`, no tiene aprobador asignado
   * o su aprobador no tiene teléfono cargado: en todos esos casos no hay nada que enviar. */
  loadApprovalContext(requisitionId: string): Promise<ApprovalFlowContext | null>;
}

interface ApprovalContextRow {
  requisicion_id: string; consecutivo: string; obra: string | null; solicitante: string | null;
  fecha_requerida: string | null; telefono: string | null; aprobador: string | null;
  items: Array<{ id: string; nombre: string | null; descripcion: string | null; cantidad: string; unidad: string; total: string }> | null;
}

/**
 * Solo líneas NO declinadas (`estado <> 'declinado'`), que son las que el dominio considera vigentes
 * (`approvedLines` en lib/domain/rules.ts): lo que el revisor ya descartó no vuelve a aparecerle al
 * aprobador. El total mostrado se calcula en SQL con la MISMA aritmética por línea que
 * `calculateLineAmounts` (bruto → descuento → base → IVA), para que la cifra del WhatsApp no
 * contradiga la de la ficha web.
 */
export function createPostgresApprovalFlowSource(databaseUrl = runtimeEnv().DATABASE_URL): ApprovalFlowSource {
  const sql = sharedPostgres(databaseUrl);
  return {
    async loadApprovalContext(requisitionId) {
      const rows = await sql<ApprovalContextRow[]>`
        select
          r.id as requisicion_id,
          r.consecutivo,
          o.nombre as obra,
          coalesce(u.nombre, r.solicitante_nombre_externo) as solicitante,
          to_char(r.fecha_requerida, 'YYYY-MM-DD') as fecha_requerida,
          ap.telefono,
          ap.nombre as aprobador,
          (
            select json_agg(json_build_object(
              'id', ri.id,
              'nombre', it.nombre,
              'descripcion', ri.descripcion_libre,
              'cantidad', ri.cantidad::text,
              'unidad', ri.unidad,
              'total', (
                round(round(ri.cantidad * ri.valor_base) - round(round(ri.cantidad * ri.valor_base) * coalesce(ri.descuento_tasa, 0)))
                + case when ri.iva_tasa is null then round(ri.cantidad * ri.iva)
                       else round((round(ri.cantidad * ri.valor_base) - round(round(ri.cantidad * ri.valor_base) * coalesce(ri.descuento_tasa, 0))) * ri.iva_tasa) end
              )::text
            ) order by ri.created_at)
            from requisicion_items ri
            left join items it on it.id = ri.item_id
            where ri.requisicion_id = r.id and ri.estado <> 'declinado'
          ) as items
        from requisiciones r
        left join obras o on o.id = r.obra_id
        left join usuarios u on u.id = r.solicitante_id
        left join usuarios ap on ap.id = r.aprobador_id
        where r.id = ${requisitionId} and r.estado = 'en_aprobacion'`;
      const row = rows[0];
      if (!row) return null;
      const phone = (row.telefono ?? "").trim();
      const rawItems = row.items ?? [];
      if (!phone || rawItems.length === 0) return null;

      const total = rawItems.reduce((sum, item) => sum + Number(item.total ?? 0), 0);
      const summaryLines = [
        row.solicitante ? `Solicita: ${row.solicitante}` : null,
        row.fecha_requerida ? `Requerido: ${row.fecha_requerida}` : null,
        `Total vigente: ${formatCop(total)}`,
      ].filter((line): line is string => line !== null);

      // Las variables de plantilla no admiten vacío: Meta rechaza el envío. Cuando un dato falta se
      // usa un texto honesto ("sin obra") en vez de "" — la requisición sí llega a su aprobador.
      const work = row.obra?.trim() || "sin obra asignada";
      return {
        requisitionId: row.requisicion_id,
        approverPhone: phone,
        approverName: row.aprobador?.trim() || "aprobador",
        consecutive: row.consecutivo,
        work,
        totalText: formatCop(total),
        heading: truncate([row.consecutivo, work].filter(Boolean).join(" · "), 80),
        summary: summaryLines.join("\n"),
        items: rawItems.map((item) => ({
          id: item.id,
          title: truncate(item.nombre ?? item.descripcion ?? "Ítem", MAX_OPTION_TITLE_LENGTH),
          description: truncate(`${Number(item.cantidad)} ${item.unidad} · ${formatCop(Number(item.total ?? 0))}`, MAX_OPTION_DESCRIPTION_LENGTH),
        })),
      };
    },
  };
}

/**
 * Contrato de `flow_token` de ESTE Flow — deliberadamente distinto del de captura
 * (`issueFlowToken` en flow-sender.ts, que firma `telefono + "." + timestampISO`):
 *
 *   flow_token = "<timestampISO>.<hex>"
 *   hex        = HMAC-SHA256(telefono + "." + timestampISO + "." + requisicionId, KAPSO_WEBHOOK_SECRET)
 *
 * El `requisicionId` entra en la firma porque este token no autoriza "responder un formulario"
 * sino "decidir sobre ESTA requisición": sin él, un token legítimo emitido para la requisición A
 * serviría para aprobar la B con solo cambiar el campo del payload. Como efecto colateral buscado,
 * los dos contratos son mutuamente excluyentes — un token de captura nunca valida como token de
 * aprobación ni al revés, aunque compartan formato y secreto.
 *
 * Mismo secreto (`KAPSO_WEBHOOK_SECRET`) y mismo razonamiento que el Flow de captura: quien pueda
 * falsificar este HMAC ya podría falsificar la firma del webhook entero, así que no se introduce un
 * secreto nuevo. Mismo formato de dos partes, así que el hex son siempre los últimos 64 caracteres
 * y el timestamp es todo lo anterior al ÚLTIMO punto (el ISO trae su propio punto de milisegundos).
 */
export function issueApprovalFlowToken(phone: string, requisitionId: string, secret: string, now: Date = new Date()): string {
  const timestampISO = now.toISOString();
  return `${timestampISO}.${hmacSha256(`${normalizeApprovalPhone(phone)}.${timestampISO}.${requisitionId}`, secret)}`;
}

/**
 * La forma canónica del teléfono del aprobador: la que se ENVÍA y la que se FIRMA.
 *
 * Antes era solo `phone.replace(/[^0-9]/g, "")`, y eso rompía dos cosas a la vez:
 *
 *   1. El envío. `usuarios.telefono` guarda el número local ("3002408743"), así que el mensaje salía
 *      sin indicativo y Meta lo descartaba con `failed` — aunque Kapso hubiera devuelto un `wamid` y
 *      la cola lo diera por enviado.
 *   2. La respuesta. El token se firmaba sobre ese número local, pero cuando el aprobador contesta,
 *      Meta entrega `message.from` en E.164 ("573002408743"). `validateApprovalFlowToken` normaliza
 *      el `from` con esta misma función y comparaba "573002408743" contra una firma hecha sobre
 *      "3002408743": **firma inválida**. Es decir, aunque el mensaje hubiera llegado, la aprobación
 *      del aprobador habría sido rechazada.
 *
 * Delegar en `destinatarioWhatsApp` arregla las dos, y por construcción: enviar y firmar usan el
 * mismo valor porque son la misma función. Los tokens emitidos antes dejan de validar, y está bien —
 * corresponden a mensajes que nunca llegaron.
 */
export function normalizeApprovalPhone(phone: string): string { return destinatarioWhatsApp(phone); }

const APPROVAL_TOKEN_PATTERN = /^(.+)\.([0-9a-f]{64})$/;
/** Una decisión de aprobación es una tarea humana con plazo laboral: 7 días es tolerante con un fin
 * de semana largo y sigue muy por debajo de "para siempre". Más largo que el token de captura
 * (24 h) a propósito: allí el usuario responde en la misma conversación; aquí puede tardar. */
const APPROVAL_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const APPROVAL_TOKEN_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export type ApprovalTokenRejectionReason = "invalid_flow_token_format" | "flow_token_expired" | "invalid_flow_token_signature";

/** Puro y síncrono: contraparte exacta de `issueApprovalFlowToken`. */
export function validateApprovalFlowToken(flowToken: string, verifiedPhone: string, requisitionId: string, secret: string, now: Date): { ok: true } | { ok: false; reason: ApprovalTokenRejectionReason } {
  const match = APPROVAL_TOKEN_PATTERN.exec(flowToken.trim());
  if (!match) return { ok: false, reason: "invalid_flow_token_format" };
  const [, isoTimestamp, signatureHex] = match;
  const issuedAtMs = Date.parse(isoTimestamp);
  if (!Number.isFinite(issuedAtMs)) return { ok: false, reason: "invalid_flow_token_format" };
  const ageMs = now.getTime() - issuedAtMs;
  if (ageMs > APPROVAL_TOKEN_MAX_AGE_MS || ageMs < -APPROVAL_TOKEN_MAX_CLOCK_SKEW_MS) return { ok: false, reason: "flow_token_expired" };
  const expected = hmacSha256(`${normalizeApprovalPhone(verifiedPhone)}.${isoTimestamp}.${requisitionId}`, secret);
  return safeEqual(expected, signatureHex.toLowerCase()) ? { ok: true } : { ok: false, reason: "invalid_flow_token_signature" };
}

export interface ApprovalFlowMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "flow";
    // Obligatorio para Meta en todo mensaje interactivo salvo location_request_message — ver la
    // cita completa en FlowMessagePayload (flow-sender.ts).
    body: { text: string };
    action: {
      name: "flow";
      parameters: {
        flow_message_version: "3";
        flow_id: string;
        flow_cta: string;
        flow_action: "navigate";
        flow_token: string;
        mode?: "draft" | "published";
        flow_action_payload: {
          screen: "REVISION";
          data: { requisitionId: string; encabezado: string; resumen: string; items: ApprovalFlowOption[]; preseleccion: string[] };
        };
      };
    };
  };
}

/**
 * Pura, sin I/O. `preseleccion` son TODOS los ítems: el Flow llega con todo marcado y el aprobador
 * solo desmarca lo que no aprueba — el camino frecuente ("apruebo todo") queda en dos toques, que es
 * el criterio de fricción con el que el cliente justificó este proyecto.
 */
export function buildApprovalFlowSendPayload(input: {
  to: string; flowId: string; flowCta: string; flowToken: string; mode?: "draft" | "published";
  bodyText: string; context: ApprovalFlowContext;
}): ApprovalFlowMessagePayload {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "interactive",
    interactive: {
      type: "flow",
      body: { text: input.bodyText },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_id: input.flowId,
          flow_cta: input.flowCta,
          flow_action: "navigate",
          flow_token: input.flowToken,
          ...(input.mode ? { mode: input.mode } : {}),
          flow_action_payload: {
            screen: "REVISION",
            data: {
              requisitionId: input.context.requisitionId,
              encabezado: input.context.heading,
              resumen: input.context.summary,
              items: input.context.items,
              preseleccion: input.context.items.map((item) => item.id),
            },
          },
        },
      },
    },
  };
}

interface ApprovalSendConfig { apiKey: string; baseUrl: string; phoneNumberId: string; flowId: string; flowCta: string; bodyText: string; mode?: "draft" | "published"; tokenSecret: string; timeoutMs: number; }

/**
 * Mismo criterio que `flowSendConfig` en flow-sender.ts: variables operativas leídas de
 * `process.env` (puerta externa documentada en docs/gates-externos.md, no algo que valide un
 * esquema zod) y `null` — nunca una excepción — cuando falta cualquier requisito para enviar de
 * verdad. `WHATSAPP_APPROVAL_FLOW_ID` es propio: es OTRO Flow publicado en Meta, no el de captura.
 */
function approvalSendConfig(): ApprovalSendConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const flowId = process.env.WHATSAPP_APPROVAL_FLOW_ID?.trim();
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  const tokenSecret = process.env.KAPSO_WEBHOOK_SECRET?.trim();
  if (!apiKey || !flowId || !phoneNumberId || !tokenSecret) return null;
  const baseUrl = (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
  const flowCta = process.env.WHATSAPP_APPROVAL_FLOW_CTA?.trim() || "Revisar";
  const bodyText = process.env.WHATSAPP_APPROVAL_FLOW_BODY?.trim() || "Tienes una requisición esperando tu aprobación.";
  const modeRaw = process.env.WHATSAPP_APPROVAL_FLOW_MODE?.trim().toLowerCase();
  const mode = modeRaw === "draft" || modeRaw === "published" ? modeRaw : undefined;
  return { apiKey, baseUrl, phoneNumberId, flowId, flowCta, bodyText, mode, tokenSecret, timeoutMs: Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000 };
}

/** Permite al llamador decidir ANTES de encolar si este canal está disponible, sin provocar un
 * error ni gastar un intento de la cola de notificaciones. */
export function isApprovalFlowConfigured(): boolean { return approvalSendConfig() !== null; }

export interface ApprovalFlowSenderDeps { source?: ApprovalFlowSource; fetchImpl?: typeof fetch; now?: () => Date; }

/**
 * Envía el Flow de aprobación al aprobador asignado de `requisitionId`. El destinatario NUNCA lo
 * elige el llamador: sale de `aprobador_id` en la BD. Eso es deliberado y es la diferencia de radio
 * de impacto con `sendRequisitionFlow(to)` (que sí acepta cualquier número): aquí un llamador
 * interno comprometido no puede dirigir una aprobación a un tercero.
 *
 * Falla cerrado y con códigos propios, sin interpolar nunca el teléfono en el mensaje de error
 * (mismo criterio que `sendRequisitionFlow`: cualquier rechazo puede terminar en un log):
 *  - `APPROVAL_FLOW_NOT_CONFIGURED`: falta alguna variable; no se toca la BD.
 *  - `APPROVAL_FLOW_NO_CONTEXT`: la requisición no está en aprobación, no tiene aprobador con
 *    teléfono, o no le queda ningún ítem vigente.
 *  - `APPROVAL_FLOW_TOO_MANY_ITEMS`: supera MAX_APPROVAL_ITEMS (ver su nota).
 */
export async function sendApprovalFlow(requisitionId: string, deps: ApprovalFlowSenderDeps = {}): Promise<{ messageId: string; to: string }> {
  const config = approvalSendConfig();
  if (!config) throw new Error("APPROVAL_FLOW_NOT_CONFIGURED");

  const source = deps.source ?? createPostgresApprovalFlowSource();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const context = await source.loadApprovalContext(requisitionId);
  if (!context) throw new Error("APPROVAL_FLOW_NO_CONTEXT");
  if (context.items.length > MAX_APPROVAL_ITEMS) throw new Error("APPROVAL_FLOW_TOO_MANY_ITEMS");

  const to = normalizeApprovalPhone(context.approverPhone);
  if (!to) throw new Error("APPROVAL_FLOW_NO_CONTEXT");

  const payload = buildApprovalFlowSendPayload({
    to, flowId: config.flowId, flowCta: config.flowCta,
    flowToken: issueApprovalFlowToken(to, context.requisitionId, config.tokenSecret, now()),
    mode: config.mode, bodyText: config.bodyText, context,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // 422 = "Cannot send non-template messages outside the 24-hour window. Send a WhatsApp
    // template message to reopen the session." (respuesta literal del proxy de Kapso, verificada en
    // vivo el 2026-09-10). Un Flow es un mensaje INTERACTIVO, no una plantilla: WhatsApp solo lo
    // admite si esa persona le escribió al negocio en las últimas 24 h. Es la condición NORMAL de
    // un aprobador que no ha usado el chat hoy, no una avería — por eso lleva código propio y no
    // se mezcla con los fallos de red: el llamador debe caer a la plantilla, que es exactamente el
    // remedio que indica Meta (reabre la sesión y avisa igual a la persona).
    if (response.status === 422) throw new Error("APPROVAL_FLOW_SESSION_CLOSED");
    if (!response.ok) throw new Error(`APPROVAL_FLOW_SEND_FAILED_${response.status}`);
    const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) throw new Error("APPROVAL_FLOW_RESPONSE_INVALID");
    return { messageId, to };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------------------------
// El mismo Flow, pero dentro de una PLANTILLA: el único camino que atraviesa la ventana de 24 h
// ---------------------------------------------------------------------------------------------
//
// Una plantilla puede llevar un botón de tipo FLOW, y ese sí se puede enviar fuera de la ventana
// de servicio (es para lo que existen las plantillas). Los datos dinámicos viajan igual que en el
// mensaje interactivo, pero bajo otro nombre: `flow_action_data` en lugar de
// `flow_action_payload.data` — por eso este Flow sigue sin necesitar Data Endpoint.
//
// La plantilla se crea UNA vez contra la WABA (no desde este código) y Meta la revisa; la pantalla
// de destino (`navigate_screen: REVISION`) y el `flow_id` quedan fijos en su definición, así que
// aquí solo se mandan las variables del cuerpo y los datos de la primera pantalla.
//
// Cuesta dinero: cada envío fuera de la ventana abre una conversación de utilidad facturable. Por
// eso NO es el camino por defecto — el llamador intenta primero el mensaje interactivo (gratis con
// la sesión abierta) y cae aquí solo ante `APPROVAL_FLOW_SESSION_CLOSED`.

/** Nombre de la plantilla aprobada en la WABA. Configurable porque el nombre vive en Meta, no en
 * el código, y una WABA distinta (o una v2 del copy) puede usar otro. */
// Exportados para que la prueba los cruce con TEMPLATE_NAME/TEMPLATE_LANGUAGE de
// scripts/publish-approval-template.ts, que es quien crea la plantilla en Meta. Estaban duplicados a
// mano en los dos sitios y nada comprobaba que coincidieran.
export const DEFAULT_APPROVAL_TEMPLATE = "aprobacion_requisicion";
export const DEFAULT_APPROVAL_TEMPLATE_LANGUAGE = "es";

export interface ApprovalTemplatePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components: Array<
      | { type: "body"; parameters: Array<{ type: "text"; text: string }> }
      | { type: "button"; sub_type: "flow"; index: "0"; parameters: Array<{ type: "action"; action: { flow_token: string; flow_action_data: Record<string, unknown> } }> }
    >;
  };
}

/**
 * Pura. El orden de los parámetros del cuerpo es POSICIONAL y debe calzar con {{1}}..{{4}} de la
 * plantilla aprobada: nombre del aprobador, consecutivo, obra, total. Cambiar ese orden aquí sin
 * cambiar la plantilla en Meta manda los datos cruzados sin que nada falle visiblemente.
 */
export function buildApprovalTemplatePayload(input: {
  to: string; templateName: string; languageCode: string; flowToken: string; context: ApprovalFlowContext;
}): ApprovalTemplatePayload {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components: [
        {
          type: "body",
          parameters: [input.context.approverName, input.context.consecutive, input.context.work, input.context.totalText]
            .map((text) => ({ type: "text" as const, text })),
        },
        {
          type: "button",
          sub_type: "flow",
          index: "0",
          parameters: [{
            type: "action",
            action: {
              flow_token: input.flowToken,
              flow_action_data: {
                requisitionId: input.context.requisitionId,
                encabezado: input.context.heading,
                resumen: input.context.summary,
                items: input.context.items,
                preseleccion: input.context.items.map((item) => item.id),
              },
            },
          }],
        },
      ],
    },
  };
}

/**
 * Envía el Flow de aprobación dentro de la plantilla. Mismas garantías que `sendApprovalFlow`: el
 * destinatario sale de `aprobador_id`, nunca del llamador, y falla cerrado con los mismos códigos
 * (`APPROVAL_FLOW_NOT_CONFIGURED`, `APPROVAL_FLOW_NO_CONTEXT`, `APPROVAL_FLOW_TOO_MANY_ITEMS`).
 * No puede devolver `APPROVAL_FLOW_SESSION_CLOSED`: es justamente el camino que no depende de la
 * ventana.
 */
export async function sendApprovalTemplate(requisitionId: string, deps: ApprovalFlowSenderDeps = {}): Promise<{ messageId: string; to: string }> {
  const config = approvalSendConfig();
  if (!config) throw new Error("APPROVAL_FLOW_NOT_CONFIGURED");

  const source = deps.source ?? createPostgresApprovalFlowSource();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const context = await source.loadApprovalContext(requisitionId);
  if (!context) throw new Error("APPROVAL_FLOW_NO_CONTEXT");
  if (context.items.length > MAX_APPROVAL_ITEMS) throw new Error("APPROVAL_FLOW_TOO_MANY_ITEMS");
  const to = normalizeApprovalPhone(context.approverPhone);
  if (!to) throw new Error("APPROVAL_FLOW_NO_CONTEXT");

  const payload = buildApprovalTemplatePayload({
    to,
    templateName: process.env.WHATSAPP_APPROVAL_TEMPLATE?.trim() || DEFAULT_APPROVAL_TEMPLATE,
    languageCode: process.env.WHATSAPP_APPROVAL_TEMPLATE_LANG?.trim() || DEFAULT_APPROVAL_TEMPLATE_LANGUAGE,
    flowToken: issueApprovalFlowToken(to, context.requisitionId, config.tokenSecret, now()),
    context,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`APPROVAL_TEMPLATE_SEND_FAILED_${response.status}`);
    const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) throw new Error("APPROVAL_FLOW_RESPONSE_INVALID");
    return { messageId, to };
  } finally {
    clearTimeout(timeout);
  }
}
