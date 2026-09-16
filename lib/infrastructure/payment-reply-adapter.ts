import type { SupplierIdentificationType } from "../domain";
import type { KapsoWebhookEvent } from "../services";
import { isNfmReplyWebhookPayload, normalizePhoneForToken, validateFlowToken, type FlowTokenRejectionReason, type RawKapsoWebhookPayload } from "./nfm-reply-adapter";

/**
 * Traduce la respuesta del WhatsApp Flow de SOLICITUD DE PAGO (`solicitud-pago.flow.json`, RF-908)
 * al mismo contrato `KapsoWebhookEvent` que ya consume el webhook idempotente: una requisición
 * `tipo=pago` con UNA línea (concepto = descripción libre, valor = `unitBase`, cantidad 1) y un
 * `beneficiary` por identificación que `ProcurementService.create` enlaza o crea pendiente (RF-606).
 *
 * Es el tercer adaptador de `nfm_reply`, junto a `nfm-reply-adapter.ts` (captura) y
 * `approval-reply-adapter.ts` (aprobación). Como los tres llegan iguales por el webhook, se
 * distingue por el discriminador estático `kind: "pago"` que pone el `complete` del Flow, no por
 * qué campos trae. Comparte con el de captura el contrato de `flow_token` (`issueFlowToken`, el
 * emisor es `sendPaymentFlow`) y la identidad por lista blanca: el número verificado por Meta debe
 * estar en `solicitantes_autorizados`.
 *
 * No escribe nada. Un rechazo es neutro: el webhook lo registra en `whatsapp_eventos` y responde
 * 200 sin crear requisición, nunca 5xx (Kapso reintentaría un formulario mal llenado en bucle).
 */

export const PAYMENT_KIND = "pago";

/** Claves del `complete` que este adaptador LEE. La prueba del Flow las cruza con lo que emite. */
export const CAMPOS_PAGO_LEIDOS = ["tipo_identificacion", "identificacion", "nombre", "empresa", "monto", "concepto"] as const;

const IDENTIFICATION_TYPES: readonly SupplierIdentificationType[] = ["NIT", "CC", "CE", "PAS"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Techo de una solicitud por WhatsApp: un billón de pesos entero. Por encima es un error de dedo. */
const MAX_AMOUNT_COP = 1_000_000_000_000;

export type PaymentReplyRejectionReason = "invalid_response_json" | FlowTokenRejectionReason | "invalid_fields" | "invalid_amount" | "unauthorized_requester";

export interface AdaptPaymentReplyConfig {
  /** `KAPSO_WEBHOOK_SECRET`, el mismo que firma el webhook y el flow_token. */
  secret: string;
  now?: Date;
  /** Lista blanca global por teléfono verificado; `null` = no autorizado. Nunca debe lanzar. */
  resolveRequester: (phone: string) => Promise<{ name: string } | null>;
  /** Nombre de la sociedad (valor del Dropdown, ver `buildSocietyOptions`) → uuid. Opcional en pruebas puras. */
  resolveSocietyId?: (nameOrLabel: string) => Promise<string | null>;
}

export type AdaptPaymentReplyResult =
  | { ok: true; event: KapsoWebhookEvent }
  | { ok: false; reason: PaymentReplyRejectionReason; wamid?: string; phone?: string };

function asString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function parseResponseJson(payload: RawKapsoWebhookPayload): Record<string, unknown> | null {
  const raw = payload.message.interactive?.nfm_reply?.response_json;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

/** ¿Es este webhook una respuesta del Flow de pago? Se consulta ANTES que el camino de captura. */
export function isPaymentNfmReply(payload: unknown): payload is RawKapsoWebhookPayload {
  if (!isNfmReplyWebhookPayload(payload)) return false;
  const fields = parseResponseJson(payload);
  return fields !== null && asString(fields.kind) === PAYMENT_KIND;
}

/**
 * El Flow valida `^[1-9][0-9]{0,11}$`, pero un payload de otra fuente puede traer puntos o espacios
 * de MILES ("1.500.000", la convención colombiana). Se aceptan solo cuando separan grupos de tres
 * dígitos: un punto que no separa miles ("1500000.50", "1.5") sería un decimal, y un peso COP no
 * los tiene — quitarlo en silencio multiplicaría el monto por cien. Todo lo demás es `null`.
 */
export function parsePaymentAmount(raw: string): number | null {
  const text = raw.trim();
  if (!/^[0-9]+$/.test(text) && !/^[0-9]{1,3}([. ][0-9]{3})+$/.test(text)) return null;
  const amount = Number(text.replace(/[. ]/g, ""));
  return Number.isInteger(amount) && amount > 0 && amount <= MAX_AMOUNT_COP ? amount : null;
}

async function resolveSocietyIdField(raw: string, resolveSocietyId?: (nameOrLabel: string) => Promise<string | null>): Promise<string | null> {
  if (UUID_RE.test(raw)) return raw;
  if (!resolveSocietyId) return null;
  try { return await resolveSocietyId(raw); } catch { return null; }
}

export async function adaptPaymentReply(payload: RawKapsoWebhookPayload, config: AdaptPaymentReplyConfig): Promise<AdaptPaymentReplyResult> {
  const now = config.now ?? new Date();
  const wamid = payload.message.id;
  const verifiedPhone = payload.message.from;
  const rejected = (reason: PaymentReplyRejectionReason): AdaptPaymentReplyResult => ({ ok: false, reason, wamid, phone: verifiedPhone });

  const fields = parseResponseJson(payload);
  if (!fields) return rejected("invalid_response_json");

  const flowToken = asString(fields.flow_token);
  if (flowToken === "") return rejected("invalid_flow_token_format");
  const tokenCheck = validateFlowToken(flowToken, verifiedPhone, config.secret, now);
  if (!tokenCheck.ok) return rejected(tokenCheck.reason);

  const identificationType = asString(fields.tipo_identificacion) as SupplierIdentificationType;
  if (!IDENTIFICATION_TYPES.includes(identificationType)) return rejected("invalid_fields");
  const identification = asString(fields.identificacion);
  if (identification.length < 3 || identification.length > 32) return rejected("invalid_fields");
  const name = asString(fields.nombre);
  if (name.length < 2 || name.length > 160) return rejected("invalid_fields");
  const concept = asString(fields.concepto);
  if (concept === "" || concept.length > 500) return rejected("invalid_fields");
  const societyRaw = asString(fields.empresa);
  if (societyRaw === "") return rejected("invalid_fields");

  // El monto se comprueba después de la forma pero ANTES de tocar la BD (sociedad, lista blanca):
  // es el fallo más probable de un formulario y no merece dos consultas.
  const amount = parsePaymentAmount(asString(fields.monto));
  if (amount === null) return rejected("invalid_amount");

  const societyId = await resolveSocietyIdField(societyRaw, config.resolveSocietyId);
  if (!societyId) return rejected("invalid_fields");

  let requester: { name: string } | null = null;
  try { requester = await config.resolveRequester(verifiedPhone); } catch { requester = null; }
  if (!requester) return rejected("unauthorized_requester");

  // Identidad = remitente verificado por WhatsApp, en E.164 con "+" (misma convención que captura).
  // El mismo número queda como teléfono de contacto del beneficiario si nace pendiente: es el único
  // dato de contacto que hay, y quien pide el pago casi siempre es quien cobra.
  const phone = `+${normalizePhoneForToken(verifiedPhone)}`;
  const event: KapsoWebhookEvent = {
    eventId: wamid,
    type: "flow_submission",
    receivedAt: now.toISOString(),
    submission: {
      eventId: wamid,
      phone,
      societyId,
      type: "pago",
      requesterName: requester.name,
      beneficiary: { identificationType, identification, name, phone },
      items: [{ quantity: 1, unit: "unidad", proposedDescription: concept, unitBase: amount }],
    },
  };
  return { ok: true, event };
}
