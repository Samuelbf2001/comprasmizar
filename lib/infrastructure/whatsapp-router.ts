import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { normalizeCoPhone } from "./phone";
import { asJsonb } from "./jsonb";
import { sendRequisitionFlow, type FlowSenderDeps } from "./flow-sender";

/**
 * Router de mensajes ENTRANTES de WhatsApp.
 *
 * Antes de esto, un mensaje suelto al número de la plataforma (un "hola") moría en el `400
 * invalid_event` de `app/api/kapso/route.ts`: el webhook solo entendía respuestas de Flow
 * (`interactive.type === "nfm_reply"`) y cualquier otra cosa fallaba el `.strict()` de
 * `kapsoWebhookSchema`. No se respondía, y además no quedaba rastro: el
 * `NfmReplyRejectionRecorder` solo se invoca en las ramas de Flow, que nunca se alcanzaban.
 *
 * POR QUÉ SON DOS MENSAJES Y NO UNO. Lo natural sería un único mensaje con dos botones, uno que
 * abra el Flow de captura y otro que consulte el estado. WhatsApp no lo permite: un mensaje
 * `interactive` es de UN tipo. `type: "flow"` lleva un solo botón de llamada a la acción y ningún
 * botón de respuesta; `type: "button"` lleva hasta tres botones de respuesta y ningún Flow. Así que
 * el menú son botones de respuesta, y al pulsar "Montar requisición" se envía el Flow como segundo
 * mensaje. Para la persona es un toque más; para nosotros es la única forma que admite la API.
 *
 * POR QUÉ NUNCA SE ENVÍA UNA PLANTILLA DESDE AQUÍ. Todo lo que este router manda es respuesta a un
 * mensaje que la persona acaba de escribir, así que la ventana de 24 h está abierta y el texto
 * libre es legal. Fuera de esa ventana haría falta plantilla, y de las cinco que el código
 * referencia por nombre solo `aprobacion_requisicion` existe en Meta (verificado el 2026-09-11);
 * las otras cuatro fallarían con 4xx. Pero es que además, fuera de la ventana, no hay nada que
 * enrutar: si nadie escribió, este código no corre.
 *
 * EL WEBHOOK NUNCA SE CAE POR CULPA DEL ROUTER. Todo lo que puede fallar aquí —la consulta de
 * estado, el envío, el registro del evento— está aislado, y el resultado peor es un `outcome` que
 * dice qué pasó. Un 5xx haría que Kapso reintentara el mismo mensaje en bucle, y un mensaje
 * entrante no es una operación que convenga reintentar sola.
 */

/** Identificadores de los botones. Viajan en el webhook al pulsarlos, así que son contrato. */
export const BOTON_NUEVA_REQUISICION = "mizar_nueva_requisicion";
export const BOTON_ESTADO_REQUISICIONES = "mizar_estado_requisiciones";

/** WhatsApp corta los títulos de botón a 20 caracteres. Estos miden 18 y 17. */
const TITULO_NUEVA = "Montar requisición";
const TITULO_ESTADO = "Mis requisiciones";

const SALUDO = "Hola, ¿quieres montar una requisición?";
const SIN_REQUISICIONES =
  "No encuentro requisiciones registradas a este número. Si acabas de enviar una, dale unos minutos; si no, pulsa \"Montar requisición\" para crear la primera.";

/** Cuántas requisiciones se listan en la respuesta de estado. Un mensaje de WhatsApp se lee en el
 *  móvil, de pie y en obra: cinco es lo que cabe sin que haya que hacer scroll. */
const MAX_REQUISICIONES_EN_RESPUESTA = 5;

// ---------------------------------------------------------------------------------------------
// Reconocimiento del payload entrante
// ---------------------------------------------------------------------------------------------

export interface MensajeTexto { wamid: string; from: string; texto: string }
export interface MensajeBoton { wamid: string; from: string; botonId: string }

function mensajeDe(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  const message = (payload as Record<string, unknown>).message;
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (typeof m.id !== "string" || m.id.trim() === "") return null;
  if (typeof m.from !== "string" || m.from.trim() === "") return null;
  return m;
}

/** Un mensaje de texto libre: `{ message: { type: "text", text: { body } } }`. */
export function leerMensajeTexto(payload: unknown): MensajeTexto | null {
  const m = mensajeDe(payload);
  if (!m || m.type !== "text") return null;
  const text = m.text as Record<string, unknown> | undefined;
  const body = text && typeof text.body === "string" ? text.body : "";
  return { wamid: m.id as string, from: m.from as string, texto: body };
}

/**
 * La pulsación de un botón: `{ message: { type: "interactive", interactive: { type:
 * "button_reply", button_reply: { id, title } } } }`. Se distingue de `nfm_reply` por
 * `interactive.type`, así que las dos ramas del webhook no se pisan.
 */
export function leerMensajeBoton(payload: unknown): MensajeBoton | null {
  const m = mensajeDe(payload);
  if (!m || m.type !== "interactive") return null;
  const interactive = m.interactive as Record<string, unknown> | undefined;
  if (!interactive || interactive.type !== "button_reply") return null;
  const reply = interactive.button_reply as Record<string, unknown> | undefined;
  if (!reply || typeof reply.id !== "string" || reply.id.trim() === "") return null;
  return { wamid: m.id as string, from: m.from as string, botonId: reply.id };
}

/** Lo que este router sabe atender. El webhook lo consulta para decidir si entra en esta rama. */
export function esMensajeEnrutable(payload: unknown): boolean {
  return leerMensajeTexto(payload) !== null || leerMensajeBoton(payload) !== null;
}

// ---------------------------------------------------------------------------------------------
// Construcción de los mensajes salientes (puro, sin red: es lo que verifican las pruebas)
// ---------------------------------------------------------------------------------------------

export interface PayloadWhatsApp { messaging_product: "whatsapp"; recipient_type: "individual"; to: string; type: string; [clave: string]: unknown }

export function construirMenu(to: string, saludo = SALUDO): PayloadWhatsApp {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: saludo },
      action: {
        buttons: [
          { type: "reply", reply: { id: BOTON_NUEVA_REQUISICION, title: TITULO_NUEVA } },
          { type: "reply", reply: { id: BOTON_ESTADO_REQUISICIONES, title: TITULO_ESTADO } },
        ],
      },
    },
  };
}

export function construirTexto(to: string, cuerpo: string): PayloadWhatsApp {
  // `preview_url: false` a propósito: el resumen de estado no lleva enlaces, y si algún día los
  // llevara no queremos que WhatsApp los resuelva y muestre una tarjeta con contenido de la
  // plataforma en el chat.
  return { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: cuerpo } };
}

// ---------------------------------------------------------------------------------------------
// Consulta de estado por teléfono
// ---------------------------------------------------------------------------------------------

export interface RequisicionResumen { consecutivo: string; estado: string; fecha: string }
export interface FuenteEstadoRequisiciones { listarPorTelefono(telefonoNormalizado: string): Promise<RequisicionResumen[]> }

/**
 * Consultar el estado por teléfono no existía en la plataforma: el portal público ni siquiera
 * devuelve el consecutivo al radicar, a propósito, para no dar un oráculo de enumeración
 * (`components/screens/public-request.tsx`). Aquí sí se puede, y la diferencia es quién pregunta:
 * el número de `message.from` lo verifica Meta, no lo escribe quien envía. O sea que ya está
 * demostrado que quien pregunta es el dueño de esa línea, y solo se le devuelve LO SUYO.
 *
 * El cruce va por los dos caminos por los que una requisición puede llevar teléfono: el solicitante
 * externo del portal/WhatsApp (`solicitante_telefono_externo`) y el usuario con cuenta
 * (`usuarios.telefono`). Los dos lados se homologan con `public.normalizar_telefono_co`, la MISMA
 * función que genera `solicitantes_autorizados.telefono_normalizado` y el espejo exacto de
 * `normalizeCoPhone` — sin eso, un "3001112233" guardado a mano nunca casaría con el
 * "573001112233" que entrega WhatsApp.
 */
export function createPostgresFuenteEstadoRequisiciones(databaseUrl = runtimeEnv().DATABASE_URL): FuenteEstadoRequisiciones {
  const sql = sharedPostgres(databaseUrl);
  return {
    async listarPorTelefono(telefonoNormalizado) {
      const filas = await sql<{ consecutivo: string; estado: string; fecha: Date }[]>`
        select r.consecutivo, r.estado::text as estado, r.created_at as fecha
          from public.requisiciones r
          left join public.usuarios u on u.id = r.solicitante_id
         where public.normalizar_telefono_co(coalesce(r.solicitante_telefono_externo, u.telefono)) = ${telefonoNormalizado}
         order by r.created_at desc
         limit ${MAX_REQUISICIONES_EN_RESPUESTA}`;
      return filas.map((fila) => ({
        consecutivo: String(fila.consecutivo),
        estado: String(fila.estado),
        fecha: new Date(fila.fecha).toISOString().slice(0, 10),
      }));
    },
  };
}

/** Etiquetas legibles: `estado_requisicion` es un enum con guiones bajos que nadie quiere leer. */
const ETIQUETA_ESTADO: Record<string, string> = {
  enviada: "Enviada",
  en_revision: "En revisión",
  en_aprobacion: "Esperando aprobación",
  aprobada: "Aprobada",
  devuelta: "Devuelta para corregir",
  declinada: "Declinada",
};

export function formatearRespuestaEstado(filas: readonly RequisicionResumen[]): string {
  if (!filas.length) return SIN_REQUISICIONES;
  const lineas = filas.map((fila) => `• ${fila.consecutivo} · ${ETIQUETA_ESTADO[fila.estado] ?? fila.estado} · ${fila.fecha}`);
  const encabezado = filas.length === 1 ? "Tu requisición:" : `Tus últimas ${filas.length} requisiciones:`;
  return `${encabezado}\n${lineas.join("\n")}`;
}

// ---------------------------------------------------------------------------------------------
// Envío
// ---------------------------------------------------------------------------------------------

interface ConfigEnvio { apiKey: string; baseUrl: string; phoneNumberId: string; timeoutMs: number }

/**
 * Mismo criterio que `flowSendConfig` y `approvalSendConfig`: variables operativas leídas de
 * `process.env` (la puerta externa de docs/gates-externos.md, no algo que valide un esquema zod) y
 * `null` —nunca una excepción— cuando falta algo. Aquí no hace falta ningún `WHATSAPP_*_FLOW_ID`:
 * el menú y el texto son mensajes normales; el Flow lo envía `sendRequisitionFlow`, que trae su
 * propia configuración.
 */
function configEnvio(): ConfigEnvio | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!apiKey || !phoneNumberId) return null;
  const baseUrl = (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
  return { apiKey, baseUrl, phoneNumberId, timeoutMs: Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000 };
}

/** Permite decidir ANTES de entrar en la rama si este canal puede responder. */
export function estaRouterConfigurado(): boolean { return configEnvio() !== null; }

/**
 * Nunca interpola `to` ni el cuerpo en el mensaje de error: cualquier rechazo puede acabar en un
 * log o en `whatsapp_eventos`, y ahí no deben aparecer ni teléfonos ni contenido. Mismo criterio
 * que `sendRequisitionFlow` y `sendApprovalFlow`.
 */
export async function enviarPayload(payload: PayloadWhatsApp, fetchImpl: typeof fetch = fetch): Promise<{ messageId: string }> {
  const config = configEnvio();
  if (!config) throw new Error("ROUTER_NOT_CONFIGURED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const respuesta = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // 422 = fuera de la ventana de 24 h. Aquí no debería pasar nunca, porque solo respondemos a
    // quien acaba de escribir, pero se distingue igual: si aparece, el problema es de reloj o de
    // reintento tardío de Kapso, no una avería de red que convenga reintentar.
    if (respuesta.status === 422) throw new Error("ROUTER_SESSION_CLOSED");
    if (!respuesta.ok) throw new Error(`ROUTER_SEND_FAILED_${respuesta.status}`);
    const datos = (await respuesta.json().catch(() => null)) as { id?: string; messageId?: string; messages?: { id?: string }[] } | null;
    const messageId = datos?.messageId ?? datos?.id ?? datos?.messages?.[0]?.id;
    if (!messageId) throw new Error("ROUTER_SEND_RESPONSE_INVALID");
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------------------------
// Registro del evento entrante
// ---------------------------------------------------------------------------------------------

export interface RegistroEntrante { registrar(input: { wamid: string; telefono: string; clase: string; resultado: string }): Promise<void> }

/**
 * Deja rastro de CADA entrante que atiende el router, que es justo lo que faltaba: hasta ahora un
 * "hola" no aparecía en ningún lado. No se guarda el texto del mensaje a propósito — `payload_json`
 * de `whatsapp_eventos` no está redactado por `auditoria_campo_sensible`, y lo que escribe la gente
 * por WhatsApp puede traer cualquier cosa. Con la clase de mensaje y el resultado basta para
 * depurar.
 *
 * El sufijo ":router" en `kapso_message_id` evita colisionar con el ledger de idempotencia de
 * `kapso-store.ts` y con el ":rejected" del `NfmReplyRejectionRecorder`: mismo índice único,
 * propósitos distintos.
 */
export function createPostgresRegistroEntrante(databaseUrl = runtimeEnv().DATABASE_URL): RegistroEntrante {
  const sql = sharedPostgres(databaseUrl);
  return {
    async registrar({ wamid, telefono, clase, resultado }) {
      await sql`insert into whatsapp_eventos (direccion, telefono, tipo, payload_json, estado_entrega, kapso_message_id, fecha)
        values ('entrada', ${telefono}, 'mensaje', ${asJsonb(sql, { evento: "router_entrante", clase, resultado })},
                ${resultado.startsWith("error") ? "fallido" : "entregado"}, ${`${wamid}:router`}, now())
        on conflict (kapso_message_id) where kapso_message_id is not null do nothing`;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------------------------

export type ResultadoRouter =
  | { atendido: false; motivo: "no_enrutable" | "no_configurado" }
  | { atendido: true; accion: "menu" | "flow" | "estado"; resultado: string };

export interface RouterDeps {
  fuenteEstado?: FuenteEstadoRequisiciones;
  registro?: RegistroEntrante;
  fetchImpl?: typeof fetch;
  enviarFlow?: (to: string, deps?: FlowSenderDeps) => Promise<{ messageId: string }>;
}

/**
 * Atiende un entrante y responde. Devuelve siempre, nunca lanza: el llamador (el webhook) responde
 * 200 pase lo que pase, porque un mensaje entrante no es una operación que convenga que Kapso
 * reintente en bucle.
 */
export async function atenderMensajeEntrante(payload: unknown, deps: RouterDeps = {}): Promise<ResultadoRouter> {
  const texto = leerMensajeTexto(payload);
  const boton = leerMensajeBoton(payload);
  if (!texto && !boton) return { atendido: false, motivo: "no_enrutable" };
  if (!estaRouterConfigurado()) return { atendido: false, motivo: "no_configurado" };

  const wamid = (texto ?? boton)!.wamid;
  const from = (texto ?? boton)!.from;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const enviarFlow = deps.enviarFlow ?? sendRequisitionFlow;

  const accion: "menu" | "flow" | "estado" =
    boton?.botonId === BOTON_NUEVA_REQUISICION ? "flow" : boton?.botonId === BOTON_ESTADO_REQUISICIONES ? "estado" : "menu";

  let resultado = "ok";
  try {
    if (accion === "flow") {
      await enviarFlow(from);
    } else if (accion === "estado") {
      const fuente = deps.fuenteEstado ?? createPostgresFuenteEstadoRequisiciones();
      const filas = await fuente.listarPorTelefono(normalizeCoPhone(from));
      await enviarPayload(construirTexto(from, formatearRespuestaEstado(filas)), fetchImpl);
    } else {
      // Un botón desconocido (una versión vieja del menú, por ejemplo) cae aquí a propósito:
      // devolver el menú es más útil que ignorarlo en silencio.
      await enviarPayload(construirMenu(from), fetchImpl);
    }
  } catch (error) {
    resultado = `error:${error instanceof Error ? error.message : "desconocido"}`;
  }

  try {
    const registro = deps.registro ?? createPostgresRegistroEntrante();
    await registro.registrar({ wamid, telefono: from, clase: accion, resultado });
  } catch {
    // Best-effort, igual que el `NfmReplyRejectionRecorder`: que no se pueda auditar no cambia lo
    // que ya se le respondió a la persona.
  }

  return { atendido: true, accion, resultado };
}
