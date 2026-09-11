import type { KapsoAdapter, KapsoWebhookEvent } from "../services";
import { verifyKapsoSignature } from "../security/crypto";
import { IDIOMA_PLANTILLAS, PLANTILLAS_WHATSAPP, esPlantillaDeclarada, type NombrePlantilla } from "./plantillas-whatsapp";
import { destinatarioWhatsApp } from "./phone";

export interface KapsoEventStore { seen(eventId: string): Promise<boolean>; record(event: KapsoWebhookEvent): Promise<void>; }
export type KapsoClaim = "claimed" | "completed" | "in_progress";
/** Durable claim contract: event_id must be unique and state transitions atomic in the database. */
export interface KapsoProcessingStore { claim(event: KapsoWebhookEvent): Promise<KapsoClaim>; complete(eventId: string, requisitionId?: string): Promise<void>; release(eventId: string): Promise<void>; findRequisitionId(eventId: string): Promise<string | null>; }

interface KapsoSendConfig { apiKey: string; baseUrl: string; phoneNumberId: string; timeoutMs: number; }
/**
 * Outbound sending needs its own API key (`KAPSO_API_KEY`), separate from the inbound webhook secret
 * (`KAPSO_WEBHOOK_SECRET`) already covered by `kapsoEnv()`. Read directly from `process.env`, same as
 * other operational settings outside the zod schemas (see `assertSameOrigin` in lib/http/api.ts) —
 * the account, number and approved templates are the external gate documented in docs/gates-externos.md,
 * not something a schema can validate.
 *
 * `KAPSO_API_URL` ya NO se usa para enviar plantillas. El endpoint que había aquí
 * (`{KAPSO_API_URL}/v1/whatsapp/messages/templates`) NO EXISTE en Kapso: devuelve la página HTML
 * "Page not found (404)" de Django, un 404 de enrutado. Medido contra el servicio real en las tres
 * variantes plausibles (`/v1/...`, `/api/v1/...`, `/platform/v1/...`), las tres 404.
 *
 * Consecuencia de haberlo tenido mal: NINGUNA plantilla de texto salió nunca. El
 * `KAPSO_SEND_FAILED_404` que se leía en `notificaciones.ultimo_error` parecía "la plantilla no
 * existe en Meta" y era la URL — tanto que `requisicion_recibida` siguió fallando igual DESPUÉS de
 * que Meta la aprobara.
 *
 * El transporte bueno ya estaba en el repo, en `approval-flow-sender.ts`: el proxy de Meta que
 * expone Kapso, `POST {KAPSO_META_PROXY_URL}/{KAPSO_PHONE_NUMBER_ID}/messages`, con cabecera
 * `X-API-Key` (no `Authorization: Bearer`) y el cuerpo de la Cloud API de WhatsApp.
 */
function kapsoSendConfig(): KapsoSendConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  const phoneNumberId = process.env.KAPSO_PHONE_NUMBER_ID?.trim();
  if (!apiKey || !phoneNumberId) return null;
  const baseUrl = (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
  const timeoutMs = Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000;
  return { apiKey, baseUrl, phoneNumberId, timeoutMs };
}

/**
 * Cuerpo de la Cloud API para una plantilla de texto. Puro, y exportado para poder fijarlo en una
 * prueba sin red: es lo único que separa un mensaje que llega de uno que Meta rechaza, y el primer
 * envío real no se puede ensayar dos veces.
 *
 * PARÁMETROS CON NOMBRE. Las cinco plantillas se crearon con `parameter_format: "NAMED"` (ver
 * plantillas-whatsapp.ts y scripts/publish-text-templates.ts), así que cada parámetro del cuerpo
 * lleva `parameter_name` además del texto. Es la diferencia con `buildApprovalTemplatePayload`, que
 * es posicional porque `aprobacion_requisicion` se creó así. `parameter_name` debe coincidir LETRA
 * POR LETRA con la variable del texto aprobado: Meta no interpola por posición en este formato.
 *
 * El orden sale de `variables` de la definición, no de las claves del payload recibido: el objeto
 * encolado es JSON libre y su orden de claves no es un contrato.
 */
export function buildTextTemplatePayload(input: { to: string; template: NombrePlantilla; payload: Record<string, string> }) {
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: input.to,
    type: "template",
    template: {
      name: input.template,
      language: { code: IDIOMA_PLANTILLAS },
      components: [
        {
          type: "body",
          parameters: PLANTILLAS_WHATSAPP[input.template].variables.map((variable) => ({
            type: "text" as const,
            parameter_name: variable,
            text: input.payload[variable] ?? "",
          })),
        },
      ],
    },
  };
}

/**
 * Códigos de Meta que significan "la plantilla todavía no se puede usar" — no existe con ese nombre,
 * o no está disponible en ese idioma. El despachador los trata como precondición ausente y NO gasta
 * intento (ver `isPlantillaAusente` en notification-dispatcher.ts).
 *
 * NO ESTÁ MEDIDO, y conviene saberlo antes de confiar en ello. 132001 es el código DOCUMENTADO por
 * Meta; intenté comprobarlo contra la API real con un nombre de plantilla inexistente y el número
 * `000000000000`, y no se puede: Meta valida el destinatario ANTES que la plantilla, así que
 * devuelve 131009 ("Parameter value is not valid") tanto con una plantilla inexistente como con una
 * aprobada. El error del número enmascara el de la plantilla. Medirlo de verdad exigiría un
 * destinatario válido, es decir, mandarle un WhatsApp a una persona.
 *
 * Es un conjunto, y no una constante, precisamente por eso: si aparece otro código —el caso "existe
 * pero sigue en PENDING" tampoco pudo medirse, porque las seis se aprobaron antes— se añade aquí sin
 * tocar el despachador. Equivocarse por defecto es barato: la notificación agota sus cinco intentos
 * y queda `fallido`, visible, que es el comportamiento que ya había.
 */
export const META_ERRORES_PLANTILLA_AUSENTE: ReadonlySet<number> = new Set([132001]);

/** `KAPSO_SEND_FAILED_<http>` o `KAPSO_SEND_FAILED_<http>_<codigo de Meta>` cuando el cuerpo lo trae.
 *
 * Solo el número: el mensaje de Meta puede repetir el teléfono destino, y esto acaba en
 * `notificaciones.ultimo_error`, que se lee sin ceremonia desde la base. */
function sendFailureCode(status: number, body: unknown): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "number" ? `KAPSO_SEND_FAILED_${status}_${code}` : `KAPSO_SEND_FAILED_${status}`;
}

/**
 * Real send path. Fails closed with `KAPSO_NOT_CONFIGURED` when no API key is set — the dispatcher
 * (lib/infrastructure/notification-dispatcher.ts) treats that specific error as "leave it pending,
 * never lose it, never count it as a failed attempt". Any other rejection (timeout, network error,
 * non-2xx response) is a normal `Error` that the dispatcher retries with backoff.
 * Never interpolate `input.to` or `input.payload` into thrown messages: those reach `ultimo_error` in
 * Postgres and must not leak phone numbers or message content.
 */
export async function sendKapsoTemplate(input: { to: string; template: string; payload: Record<string, string> }, fetchImpl: typeof fetch = fetch): Promise<{ messageId: string }> {
  const config = kapsoSendConfig();
  if (!config) throw new Error("KAPSO_NOT_CONFIGURED");
  // Una plantilla no declarada falla AQUÍ y de forma visible, en vez de viajar a Meta con un cuerpo
  // inventado: plantillas-whatsapp.ts es la fuente única, y si alguien encola un nombre que no está
  // ahí, el nombre tampoco existe en Meta. Mejor un error propio y legible en `ultimo_error` que un
  // 400 de Meta que hay que ir a traducir.
  if (!esPlantillaDeclarada(input.template)) throw new Error("KAPSO_TEMPLATE_NOT_DECLARED");
  // El destinatario se canoniza AQUÍ, no donde se encola. `usuarios.telefono` guarda el número local
  // ("3002408743") y así salía: Kapso devuelve un `wamid` —la cola lo daba por enviado— y Meta lo
  // descartaba después con `failed`, por un evento de estado al que el webhook no está suscrito. El
  // aviso no llegaba y el sistema decía que sí.
  const to = destinatarioWhatsApp(input.to);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}/${config.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": config.apiKey },
      body: JSON.stringify(buildTextTemplatePayload({ to, template: input.template, payload: input.payload })),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(sendFailureCode(response.status, await response.json().catch(() => null)));
    const data = (await response.json().catch(() => null)) as { messages?: Array<{ id?: string }> } | null;
    // La Cloud API responde `{ messages: [{ id: "wamid..." }] }`, no `{ id }` como asumía el emisor
    // viejo contra el endpoint inexistente de Kapso.
    const messageId = data?.messages?.[0]?.id;
    if (!messageId) throw new Error("KAPSO_SEND_RESPONSE_INVALID");
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

export class VerifiedKapsoAdapter implements KapsoAdapter {
  constructor(private readonly secret: string, private readonly store: KapsoEventStore) {}
  verifySignature(rawBody: string, signature: string): boolean { return verifyKapsoSignature(rawBody, signature, this.secret); }
  async recordInbound(event: KapsoWebhookEvent): Promise<void> { if (await this.store.seen(event.eventId)) return; await this.store.record(event); }
  sendTemplate(input: { to: string; template: string; payload: Record<string, string> }): Promise<{ messageId: string }> { return sendKapsoTemplate(input); }
}
