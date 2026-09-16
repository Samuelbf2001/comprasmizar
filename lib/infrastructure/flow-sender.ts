import { hmacSha256 } from "../security/crypto";
import { destinatarioWhatsApp } from "./phone";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";

/**
 * Emisor del WhatsApp Flow "Requisición de obra" (RF-902). Arma y envía el mensaje
 * `interactive.type=flow` documentado en `integrations/whatsapp-flow/README.md` — la
 * pieza que faltaba para que alguien reciba el Flow (el Flow en sí y el receptor del
 * webhook ya existían). No toca `app/api/kapso/route.ts` ni `lib/services/kapso-contracts.ts`.
 */

/**
 * Límite de opciones de un `Dropdown` con `data-source` dinámico: **200** si ninguna
 * opción trae imagen, 100 si alguna la trae (`flows/reference/components.md`, tabla
 * "Limits and restrictions" — "Max dropdown options: 200 if no images are present in
 * the data-source, 100 otherwise"). Ninguna opción de `sociedades`/`catalogo` lleva imagen,
 * así que el tope aplicable es 200. Se deja como tope EXPLÍCITO (no "lo que devuelva
 * la BD") para que agregar una sociedad u item número 201 no rompa el envío del Flow.
 */
export const MAX_DROPDOWN_OPTIONS = 200;

/**
 * Misma tabla de límites: el `title` de una opción de Dropdown admite máximo 30
 * caracteres. Los nombres de obra/ítem en la BD pueden ser más largos (hasta 160,
 * ver `createCatalogSchema` en app/api/catalogs/route.ts), así que se recortan aquí
 * — recortar en el emisor, no en el catálogo, porque el límite es de Meta, no del
 * dominio: el nombre completo se sigue usando en cualquier otra pantalla/reporte.
 */
const MAX_OPTION_TITLE_LENGTH = 30;

export interface FlowOption {
  id: string;
  title: string;
}

function truncateTitle(value: string): string {
  return value.length > MAX_OPTION_TITLE_LENGTH ? `${value.slice(0, MAX_OPTION_TITLE_LENGTH - 1)}…` : value;
}

/** Fuente de los dos dropdowns dinámicos del Flow. Inyectable para pruebas — la BD real la da
 * `createPostgresFlowCatalogSource`. */
export interface FlowCatalogSource {
  /** Reunión 2026-08-31: el solicitante elige EMPRESA, no obra (la asigna el revisor). El Flow ya
   * no ofrece un dropdown de obras — ver `requisicion.flow.json`, pantalla TIPO_Y_OBRA renombrada. */
  listActiveSocieties(limit: number): Promise<FlowOption[]>;
  listActiveCatalogItems(limit: number): Promise<FlowOption[]>;
}

/**
 * Bloqueante reportado por Juliana: la pantalla RESUMEN del Flow (v3, PUBLICADO en Meta como
 * `875992355468043`) pinta `${data.empresa}` — el VALOR crudo de la opción elegida en el Dropdown,
 * no su `title` visible (ver integrations/whatsapp-flow/README.md, "Un `${data.x}` dentro de una
 * cadena normal se muestra LITERAL" y "Cómo se llenan los dropdowns dinámicos"). Con `id = uuid` eso
 * mostraba el uuid de la sociedad en vez de su nombre. Como el Flow YA ESTÁ PUBLICADO, su JSON no se
 * puede tocar — Meta no permite editar un Flow publicado, y la alternativa de mapear id→nombre
 * dentro del propio Flow exigiría un `If` por sociedad en el RESUMEN, inviable con un catálogo
 * dinámico (cuántas sociedades hay y cuáles son cambia sin republicar nada). La única salida sin
 * republicar es que el VALOR ya sea el nombre: `id` deja de ser `sociedades.id` y pasa a ser el
 * nombre de la sociedad (ver `buildSocietyOptions`); `title` es el mismo nombre, para que la opción
 * y el resumen digan lo mismo. `lib/infrastructure/nfm-reply-adapter.ts` (`extractTopLevelFields`
 * + `createPostgresSocietyResolver`) resuelve ese nombre de vuelta al uuid real al recibir la
 * respuesta, aceptando también el uuid crudo por si un Flow ya en curso lo trae así.
 */
export function buildSocietyOptions(rows: { name: string; nit: string | null }[]): FlowOption[] {
  // `sociedades.nombre` tiene una restricción UNIQUE en la BD (migración 202608240001), así que hoy
  // dos sociedades ACTIVAS nunca pueden compartir nombre — pero se desambigua con el NIT de todos
  // modos: es lo que pide el ticket, y evita que el emisor dependa en silencio de una restricción
  // que vive en otra capa y podría relajarse el día de mañana.
  const nameCounts = new Map<string, number>();
  for (const row of rows) nameCounts.set(row.name, (nameCounts.get(row.name) ?? 0) + 1);
  return rows.map((row) => {
    const ambiguous = (nameCounts.get(row.name) ?? 0) > 1 && Boolean(row.nit);
    const label = ambiguous ? `${row.name} (${row.nit})` : row.name;
    // Mismo recorte de 30 caracteres que ya aplicaba a `title` (tope de Meta para Dropdown, ver
    // `MAX_OPTION_TITLE_LENGTH`): ahora se aplica también a `id`, porque `id` y `title` son
    // deliberadamente el MISMO valor — es lo que hace que el resumen muestre el nombre.
    const value = truncateTitle(label);
    return { id: value, title: value };
  });
}

/**
 * Lee sociedades activas y catálogo de items activos, ya listos como `{id, title}` para
 * `flow_action_payload.data`. Mismo patrón que los demás adaptadores de infraestructura:
 * `sharedPostgres()` (una sola conexión compartida en el proceso) y el mismo filtro de estado que
 * ya usa `GET /api/catalogs` para sociedades (`activa = true`) e items (`estado = 'activo'`).
 */
export function createPostgresFlowCatalogSource(databaseUrl = runtimeEnv().DATABASE_URL): FlowCatalogSource {
  const sql = sharedPostgres(databaseUrl);
  return {
    async listActiveSocieties(limit) {
      // `nit` viaja solo para desambiguar (ver `buildSocietyOptions`); `id` (el uuid) ya NO se
      // expone en la opción del Dropdown — ver comentario de `buildSocietyOptions` arriba.
      const rows = await sql<{ name: string; nit: string | null }[]>`
        select nombre as name, nit from sociedades where activa = true order by nombre limit ${limit}`;
      return buildSocietyOptions(rows);
    },
    // Orden: uso más reciente primero cuando hay señal (última vez que el item se pidió en una
    // requisición real, `requisicion_items.created_at`); alfabético para lo nunca usado — y como
    // desempate entre items igualmente nunca usados, para que el orden sea estable y predecible.
    async listActiveCatalogItems(limit) {
      const rows = await sql<{ id: string; name: string }[]>`
        select i.id, i.nombre as name
        from items i
        left join (
          select item_id, max(created_at) as last_used
          from requisicion_items
          where item_id is not null
          group by item_id
        ) u on u.item_id = i.id
        where i.estado = 'activo'
        order by u.last_used desc nulls last, i.nombre
        limit ${limit}`;
      return rows.map((row) => ({ id: row.id, title: truncateTitle(row.name) }));
    },
  };
}

/**
 * Contrato de `flow_token` acordado con el receptor del webhook (documentado también en
 * integrations/whatsapp-flow/README.md): `hmac(telefono + '.' + timestampISO)` en hex,
 * viajando como `"<timestampISO>.<hex>"`. `timestampISO` (formato `Date#toISOString`) ya
 * contiene un punto propio (el separador de milisegundos) — quien lo valide debe tomar
 * los últimos 64 caracteres como el hex (sha256 siempre produce 64), no partir por el
 * primer punto.
 *
 * Se firma con `KAPSO_WEBHOOK_SECRET`: es el secreto que ya comparten este backend y el
 * canal de Kapso/Meta para el webhook entrante (`verifyKapsoSignature` en
 * lib/infrastructure/kapso.ts), así que el `flow_token` queda dentro del mismo límite de
 * confianza — nadie que no pueda ya falsificar una firma de webhook puede falsificar un
 * `flow_token`. No se introduce un secreto nuevo solo para esto.
 */
export function issueFlowToken(phone: string, secret: string, now: Date = new Date()): string {
  const timestampISO = now.toISOString();
  const digest = hmacSha256(`${phone}.${timestampISO}`, secret);
  return `${timestampISO}.${digest}`;
}

export interface FlowMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "flow";
    // Meta exige `body.text` en TODO mensaje interactivo salvo `location_request_message`
    // (`InteractiveMessage` en api/meta/whatsapp/openapi-whatsapp.yaml del corpus de Kapso:
    // "Required for all types except location_request_message"). `type=flow` no está en esa
    // excepción — omitirlo hace que Meta rechace el envío real con 400, aunque el README
    // original (centrado solo en cómo se llenan los dropdowns) no lo mostrara.
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
          screen: "TIPO_Y_EMPRESA";
          data: {
            sociedades: FlowOption[];
            catalogo: FlowOption[];
          };
        };
      };
    };
  };
}

/**
 * Arma el mensaje exactamente como lo especifica el README (misma forma que
 * `flows/guides/sendingaflow.md` documenta para `interactive.type=flow`, verificada
 * también contra el ejemplo `interactive_flow` de `api/meta/whatsapp/openapi-whatsapp.yaml`
 * del corpus de Kapso). Pura — no hace I/O — para poder probar el shape sin red ni BD.
 */
export function buildFlowSendPayload(input: {
  to: string;
  flowId: string;
  flowCta: string;
  flowToken: string;
  mode?: "draft" | "published";
  bodyText: string;
  sociedades: FlowOption[];
  catalogo: FlowOption[];
}): FlowMessagePayload {
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
            screen: "TIPO_Y_EMPRESA",
            data: {
              sociedades: input.sociedades,
              catalogo: input.catalogo,
            },
          },
        },
      },
    },
  };
}

interface FlowSendConfig {
  apiKey: string;
  baseUrl: string;
  phoneNumberId: string;
  flowId: string;
  flowCta: string;
  bodyText: string;
  mode?: "draft" | "published";
  tokenSecret: string;
  timeoutMs: number;
}

/**
 * Igual que `kapsoSendConfig` en lib/infrastructure/kapso.ts: variables operativas leídas
 * directamente de `process.env` (no de los esquemas zod de lib/security/env.ts), porque son
 * la puerta externa documentada en docs/gates-externos.md, no algo que un esquema deba validar.
 *
 * Devuelve `null` — nunca lanza — cuando falta cualquier requisito para enviar de verdad:
 * `KAPSO_API_KEY` y `WHATSAPP_FLOW_ID` son los dos exigidos explícitamente por el ticket,
 * y se suman `KAPSO_PHONE_NUMBER_ID` (sin él no hay URL de envío posible) y
 * `KAPSO_WEBHOOK_SECRET` (sin él no hay como firmar el `flow_token`) bajo el mismo criterio
 * de "cerrado por defecto": ninguno de los dos deja enviar un mensaje a medias.
 */
function flowSendConfig(): FlowSendConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const flowId = process.env.WHATSAPP_FLOW_ID?.trim();
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  const tokenSecret = process.env.KAPSO_WEBHOOK_SECRET?.trim();
  if (!apiKey || !flowId || !phoneNumberId || !tokenSecret) return null;
  const baseUrl = (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
  const flowCta = process.env.WHATSAPP_FLOW_CTA?.trim() || "Solicitar";
  // `body.text` es obligatorio para Meta (ver comentario en FlowMessagePayload) — configurable
  // por si el copy comercial cambia, con un valor por defecto que ya describe la acción.
  const bodyText = process.env.WHATSAPP_FLOW_BODY?.trim() || "Solicita materiales para tu obra directamente desde WhatsApp.";
  // El Flow real (ver README) hoy es un BORRADOR: Meta exige `mode: "draft"` explícito para
  // poder probarlo, porque el valor por defecto de la Graph API es "published"
  // (flows/guides/sendingaflow.md, tabla de parámetros de `interactive.action.parameters`).
  // Configurable por env para no tener que tocar código el día que el Flow se publique
  // (ese día, quitar la variable o ponerla en "published" y listo).
  const modeRaw = process.env.WHATSAPP_FLOW_MODE?.trim().toLowerCase();
  const mode = modeRaw === "draft" || modeRaw === "published" ? modeRaw : undefined;
  const timeoutMs = Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000;
  return { apiKey, baseUrl, phoneNumberId, flowId, flowCta, bodyText, mode, tokenSecret, timeoutMs };
}

export interface FlowSenderDeps {
  catalogSource?: FlowCatalogSource;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * Envía el Flow "Requisición de obra" al `to` dado. Falla cerrado con
 * `FLOW_SEND_NOT_CONFIGURED` cuando falta cualquiera de las variables requeridas
 * (ver `flowSendConfig`) — nunca toca la BD en ese caso porque la comprobación de
 * configuración ocurre antes de cualquier consulta a `catalogSource`.
 *
 * Nunca interpolar `to` en un mensaje de error: igual que `sendKapsoTemplate`, cualquier
 * rechazo aquí puede terminar en un log.
 */
export async function sendRequisitionFlow(to: string, deps: FlowSenderDeps = {}): Promise<{ messageId: string }> {
  const config = flowSendConfig();
  if (!config) throw new Error("FLOW_SEND_NOT_CONFIGURED");

  // Mismo destino canónico que los otros dos emisores. Antes era solo "quita los no-dígitos", que
  // dejaba salir un número local sin indicativo — Meta lo acepta en la llamada y lo descarta después.
  const normalizedPhone = destinatarioWhatsApp(to);
  if (!normalizedPhone) throw new Error("FLOW_SEND_INVALID_PHONE");

  const catalogSource = deps.catalogSource ?? createPostgresFlowCatalogSource();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const [sociedades, catalogo] = await Promise.all([
    catalogSource.listActiveSocieties(MAX_DROPDOWN_OPTIONS),
    catalogSource.listActiveCatalogItems(MAX_DROPDOWN_OPTIONS),
  ]);

  const flowToken = issueFlowToken(normalizedPhone, config.tokenSecret, now());
  const payload = buildFlowSendPayload({
    to: normalizedPhone,
    flowId: config.flowId,
    flowCta: config.flowCta,
    flowToken,
    mode: config.mode,
    bodyText: config.bodyText,
    sociedades,
    catalogo,
  });
  return postFlowMessage(config, payload, fetchImpl);
}

async function postFlowMessage(config: FlowSendConfig, payload: FlowMessagePayload | PaymentFlowMessagePayload, fetchImpl: typeof fetch): Promise<{ messageId: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`FLOW_SEND_FAILED_${response.status}`);
    const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) throw new Error("FLOW_SEND_RESPONSE_INVALID");
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------------------------
// Flow de SOLICITUD DE PAGO (RF-908): `integrations/whatsapp-flow/solicitud-pago.flow.json`
// ---------------------------------------------------------------------------------------------
//
// Tercer Flow, con su propio id en Meta (`WHATSAPP_FLOW_PAGO_ID`). Comparte con el de captura el
// contrato de `flow_token` (`issueFlowToken`: teléfono + timestamp) y el transporte, porque desde
// el punto de vista de la plataforma es lo mismo: un solicitante autorizado por su número crea una
// requisición nueva. Lo que cambia es la pantalla de entrada y que solo necesita `sociedades` (no
// hay catálogo de artículos: una solicitud de pago es un concepto libre con un valor).

/** Pantalla de entrada del Flow de pago; debe coincidir con `PANTALLA_ENTRADA_PAGO` del generador. */
export const PAYMENT_FLOW_ENTRY_SCREEN = "BENEFICIARIO";

export interface PaymentFlowMessagePayload {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "flow";
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
        flow_action_payload: { screen: typeof PAYMENT_FLOW_ENTRY_SCREEN; data: { sociedades: FlowOption[] } };
      };
    };
  };
}

/** Pura, sin I/O: el shape exacto que se manda al proxy de Kapso para abrir el Flow de pago. */
export function buildPaymentFlowSendPayload(input: {
  to: string;
  flowId: string;
  flowCta: string;
  flowToken: string;
  mode?: "draft" | "published";
  bodyText: string;
  sociedades: FlowOption[];
}): PaymentFlowMessagePayload {
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
          flow_action_payload: { screen: PAYMENT_FLOW_ENTRY_SCREEN, data: { sociedades: input.sociedades } },
        },
      },
    },
  };
}

/** Mismo criterio que `flowSendConfig`; solo cambian las variables propias del Flow de pago. */
function paymentFlowSendConfig(): FlowSendConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const flowId = process.env.WHATSAPP_FLOW_PAGO_ID?.trim();
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  const tokenSecret = process.env.KAPSO_WEBHOOK_SECRET?.trim();
  if (!apiKey || !flowId || !phoneNumberId || !tokenSecret) return null;
  const baseUrl = (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
  const flowCta = process.env.WHATSAPP_FLOW_PAGO_CTA?.trim() || "Solicitar pago";
  const bodyText = process.env.WHATSAPP_FLOW_PAGO_BODY?.trim() || "Pide un pago para ti o para un tercero: identificación, empresa que paga y monto.";
  const modeRaw = process.env.WHATSAPP_FLOW_PAGO_MODE?.trim().toLowerCase();
  const mode = modeRaw === "draft" || modeRaw === "published" ? modeRaw : undefined;
  const timeoutMs = Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000;
  return { apiKey, baseUrl, phoneNumberId, flowId, flowCta, bodyText, mode, tokenSecret, timeoutMs };
}

/** Permite decidir antes de enviar si el canal de pago está activo (sin `WHATSAPP_FLOW_PAGO_ID` no lo está). */
export function isPaymentFlowConfigured(): boolean { return paymentFlowSendConfig() !== null; }

/**
 * Envía el Flow de solicitud de pago al `to` dado. Mismas garantías que `sendRequisitionFlow`:
 * falla cerrado con `PAYMENT_FLOW_NOT_CONFIGURED` antes de tocar la BD, normaliza el destino con
 * `destinatarioWhatsApp` y nunca interpola el teléfono en un error. Solo consulta sociedades: este
 * Flow no tiene dropdown de catálogo.
 */
export async function sendPaymentFlow(to: string, deps: FlowSenderDeps = {}): Promise<{ messageId: string }> {
  const config = paymentFlowSendConfig();
  if (!config) throw new Error("PAYMENT_FLOW_NOT_CONFIGURED");
  const normalizedPhone = destinatarioWhatsApp(to);
  if (!normalizedPhone) throw new Error("FLOW_SEND_INVALID_PHONE");

  const catalogSource = deps.catalogSource ?? createPostgresFlowCatalogSource();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const sociedades = await catalogSource.listActiveSocieties(MAX_DROPDOWN_OPTIONS);
  const payload = buildPaymentFlowSendPayload({
    to: normalizedPhone,
    flowId: config.flowId,
    flowCta: config.flowCta,
    flowToken: issueFlowToken(normalizedPhone, config.tokenSecret, now()),
    mode: config.mode,
    bodyText: config.bodyText,
    sociedades,
  });
  return postFlowMessage(config, payload, fetchImpl);
}
