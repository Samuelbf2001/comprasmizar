import { hmacSha256 } from "../security/crypto";
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
 * the data-source, 100 otherwise"). Ninguna opción de `obras`/`catalogo` lleva imagen,
 * así que el tope aplicable es 200. Se deja como tope EXPLÍCITO (no "lo que devuelva
 * la BD") para que agregar una obra u item número 201 no rompa el envío del Flow.
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
  listActiveWorks(limit: number): Promise<FlowOption[]>;
  listActiveCatalogItems(limit: number): Promise<FlowOption[]>;
}

/**
 * Lee obras activas y catálogo de items activos, ya listos como `{id, title}` para
 * `flow_action_payload.data`. Mismo patrón que los demás adaptadores de infraestructura:
 * `sharedPostgres()` (una sola conexión compartida en el proceso) y filtros de estado
 * idénticos a los que ya usa `GET /api/catalogs` (`estado = 'activa'` / `estado = 'activo'`).
 */
export function createPostgresFlowCatalogSource(databaseUrl = runtimeEnv().DATABASE_URL): FlowCatalogSource {
  const sql = sharedPostgres(databaseUrl);
  return {
    async listActiveWorks(limit) {
      const rows = await sql<{ id: string; name: string }[]>`
        select id, nombre as name from obras where estado = 'activa' order by nombre limit ${limit}`;
      return rows.map((row) => ({ id: row.id, title: truncateTitle(row.name) }));
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
          screen: "TIPO_Y_OBRA";
          data: {
            obras: FlowOption[];
            catalogo: FlowOption[];
            telefono_remitente: string;
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
  obras: FlowOption[];
  catalogo: FlowOption[];
  telefonoRemitente: string;
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
            screen: "TIPO_Y_OBRA",
            data: {
              obras: input.obras,
              catalogo: input.catalogo,
              telefono_remitente: input.telefonoRemitente,
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
  const bodyText = process.env.WHATSAPP_FLOW_BODY?.trim() || "Solicita materiales o pagos para tu obra directamente desde WhatsApp.";
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

  const normalizedPhone = to.replace(/[^0-9]/g, "");
  if (!normalizedPhone) throw new Error("FLOW_SEND_INVALID_PHONE");

  const catalogSource = deps.catalogSource ?? createPostgresFlowCatalogSource();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const [obras, catalogo] = await Promise.all([
    catalogSource.listActiveWorks(MAX_DROPDOWN_OPTIONS),
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
    obras,
    catalogo,
    telefonoRemitente: normalizedPhone,
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
    if (!response.ok) throw new Error(`FLOW_SEND_FAILED_${response.status}`);
    const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) throw new Error("FLOW_SEND_RESPONSE_INVALID");
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}
