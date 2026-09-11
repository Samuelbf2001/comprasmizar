import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { validateApprovalFlowToken, normalizeApprovalPhone, type ApprovalTokenRejectionReason } from "./approval-flow-sender";
import { isNfmReplyWebhookPayload, type RawKapsoWebhookPayload } from "./nfm-reply-adapter";
import type { Role } from "../domain";

/**
 * Traduce la respuesta del WhatsApp Flow de APROBACIÓN (`aprobacion.flow.json`) a una decisión
 * tipada que el webhook aplica con los métodos que ya existen en el dominio. Es el gemelo de
 * `nfm-reply-adapter.ts` (que traduce el Flow de captura hacia una requisición nueva) y comparte
 * con él la forma cruda de entrada (`RawKapsoWebhookPayload`), que se importa en vez de
 * redeclararse.
 *
 * Está en un archivo aparte, y no dentro de `nfm-reply-adapter.ts`, por una razón de seguridad y no
 * de orden: aquel adaptador CREA una requisición a nombre de un tercero autorizado, este EJECUTA
 * una decisión de control interno. Sus reglas de identidad no deben poder mezclarse por accidente
 * al editar una función común.
 *
 * ---------------------------------------------------------------------------------------------
 * Por qué aprobar por WhatsApp no contradice RF-1205
 * ---------------------------------------------------------------------------------------------
 * RF-1205 (PRD.md, verificado: "Aprobar/denegar requisiciones queda EXCLUIDO del MCP a propósito:
 * la aprobación es el acto de control interno de Mizar y debe ocurrir en la interfaz con la persona
 * autenticada, no delegable a un agente") está implementado como `mcpForbidden` en
 * lib/domain/rules.ts, que deniega `requisition:approve`/`return`/`review` cuando
 * `context.origin === "mcp"`.
 *
 * Este canal entra con `origin: "kapso"`, que `authOrigin()` trata como "web" — y eso es correcto,
 * no un rodeo: lo que RF-1205 prohíbe es que un AGENTE decida, no que la persona decida desde otra
 * pantalla. Aquí la decisión la toma una persona, y su identidad se sostiene en cuatro capas
 * independientes, todas verificadas antes de llamar al servicio:
 *   1. La firma del webhook (`verifyKapsoSignature`), que ya protege todo el canal.
 *   2. El remitente verificado por Meta (`message.from`): no lo declara el payload, lo declara
 *      WhatsApp.
 *   3. Un `flow_token` HMAC atado a ESE número y a ESA requisición (ver el contrato en
 *      approval-flow-sender.ts), emitido únicamente al teléfono del aprobador asignado.
 *   4. `requisition.approverId === actor.id`, que sigue comprobándose dentro de
 *      `decideItems`/`approve`/`returnForCorrection` — este adaptador no lo reimplementa ni lo
 *      relaja: resuelve un actor real y deja que el dominio acepte o rechace.
 * Ninguna de las cuatro se debilita para que este canal funcione. Es una decisión propia y
 * explícita, no un requisito documentado del PRD.
 */

export type ApprovalAction = "aprobar" | "devolver";
export type ApprovalRejectionReason =
  | "invalid_response_json" | ApprovalTokenRejectionReason | "invalid_fields" | "unauthorized_approver";

export interface ApprovalDecision {
  requisitionId: string;
  /** Actor real de la plataforma, resuelto desde el teléfono remitente. */
  approver: { id: string; roles: Role[] };
  action: ApprovalAction;
  /** Ítems que el aprobador dejó marcados. Vacío = no marcó ninguno. */
  approvedItemIds: string[];
  /** Texto libre del aprobador; vacío se normaliza a `undefined`. */
  reason?: string;
  phone: string;
  wamid: string;
}

export type AdaptApprovalResult =
  | { ok: true; decision: ApprovalDecision }
  | { ok: false; reason: ApprovalRejectionReason; wamid?: string; phone?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Discriminador estático que el Flow de aprobación pone en su `complete` (ver aprobacion.flow.json).
 * Es lo único que distingue las dos respuestas de Flow antes de validar nada. */
const APPROVAL_KIND = "aprobacion";

function asString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function parseResponseJson(payload: RawKapsoWebhookPayload): Record<string, unknown> | null {
  const raw = payload.message.interactive?.nfm_reply?.response_json;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

/**
 * ¿Es este webhook una respuesta del Flow de APROBACIÓN? Se consulta ANTES que el camino de captura
 * en app/api/kapso/route.ts, porque ambos llegan como `nfm_reply` y `isNfmReplyWebhookPayload` los
 * acepta a los dos. La distinción es el campo `kind` del payload, no una heurística sobre qué
 * campos trae: un discriminador explícito evita que agregar un campo a cualquiera de los dos Flows
 * cambie en silencio por qué camino entra un mensaje.
 */
export function isApprovalNfmReply(payload: unknown): payload is RawKapsoWebhookPayload {
  if (!isNfmReplyWebhookPayload(payload)) return false;
  const fields = parseResponseJson(payload);
  return fields !== null && asString(fields.kind) === APPROVAL_KIND;
}

/**
 * `CheckboxGroup` devuelve un arreglo de ids. Se acepta también un string JSON con ese arreglo por
 * tolerancia al transporte (algunos proxies serializan los valores no escalares del payload), pero
 * NUNCA una lista separada por comas: eso sería adivinar un formato que nadie documenta. Cualquier
 * elemento que no sea un UUID invalida el campo completo en vez de descartarse en silencio — un id
 * ilegible aquí significaría aprobar un subconjunto distinto del que la persona marcó.
 */
function parseSelectedIds(value: unknown): { ok: true; ids: string[] } | { ok: false } {
  let raw: unknown = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (text === "" || text === "[]") return { ok: true, ids: [] };
    if (!text.startsWith("[")) return { ok: false };
    try { raw = JSON.parse(text); } catch { return { ok: false }; }
  }
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false };
  const ids: string[] = [];
  for (const entry of raw) {
    const id = asString(entry);
    if (!UUID_RE.test(id)) return { ok: false };
    ids.push(id);
  }
  return { ok: true, ids: [...new Set(ids)] };
}

export interface AdaptApprovalConfig {
  /** `KAPSO_WEBHOOK_SECRET`, el mismo que firma el webhook y el flow_token. */
  secret: string;
  now?: Date;
  /**
   * Teléfono remitente → actor real con rol de aprobación. Debe fallar cerrado (devolver `null`)
   * ante 0 coincidencias, más de una, o cualquier error: nunca debe lanzar.
   */
  resolveApprover: (phone: string) => Promise<{ id: string; roles: Role[] } | null>;
}

/**
 * Valida y traduce. No escribe nada y no aplica la decisión: eso lo hace el webhook con
 * `ProcurementService`, para que el dominio siga siendo el único lugar donde se decide si una
 * transición es legal.
 */
export async function adaptApprovalReply(payload: RawKapsoWebhookPayload, config: AdaptApprovalConfig): Promise<AdaptApprovalResult> {
  const now = config.now ?? new Date();
  const wamid = payload.message.id;
  const verifiedPhone = payload.message.from;

  const fields = parseResponseJson(payload);
  if (!fields) return { ok: false, reason: "invalid_response_json", wamid, phone: verifiedPhone };

  const requisitionId = asString(fields.requisitionId);
  if (!UUID_RE.test(requisitionId)) return { ok: false, reason: "invalid_fields", wamid, phone: verifiedPhone };

  // El token se valida ANTES de tocar la BD y contra la requisición que el propio payload declara:
  // si alguien cambia `requisitionId` para decidir sobre otra, el HMAC deja de cuadrar.
  const flowToken = asString(fields.flow_token);
  if (flowToken === "") return { ok: false, reason: "invalid_flow_token_format", wamid, phone: verifiedPhone };
  const tokenCheck = validateApprovalFlowToken(flowToken, verifiedPhone, requisitionId, config.secret, now);
  if (!tokenCheck.ok) return { ok: false, reason: tokenCheck.reason, wamid, phone: verifiedPhone };

  const action = asString(fields.accion);
  if (action !== "aprobar" && action !== "devolver") return { ok: false, reason: "invalid_fields", wamid, phone: verifiedPhone };

  const selected = parseSelectedIds(fields.aprobados);
  if (!selected.ok) return { ok: false, reason: "invalid_fields", wamid, phone: verifiedPhone };

  let approver: { id: string; roles: Role[] } | null = null;
  try { approver = await config.resolveApprover(verifiedPhone); } catch { approver = null; }
  if (!approver) return { ok: false, reason: "unauthorized_approver", wamid, phone: verifiedPhone };

  const reason = asString(fields.motivo);
  return {
    ok: true,
    decision: {
      requisitionId, approver, action, approvedItemIds: selected.ids,
      reason: reason === "" ? undefined : reason.slice(0, 500),
      phone: `+${normalizeApprovalPhone(verifiedPhone)}`, wamid,
    },
  };
}

/**
 * Resuelve el teléfono remitente contra `usuarios`, exigiendo un único usuario ACTIVO con rol de
 * aprobación (`aprobador` o `admin_sixteam`, los mismos que el dominio deja decidir — ver M-5 en
 * lib/domain/rules.ts).
 *
 * Decisión propia y consciente: se usa `usuarios.telefono` en vez de crear una tabla nueva de
 * "teléfonos que pueden aprobar". `usuarios.telefono` es dato de contacto — nullable y SIN índice
 * único — así que por sí solo no sería una credencial aceptable; aquí no lo es: la autorización la
 * dan el `flow_token` HMAC (emitido solo al aprobador asignado de esa requisición) y el chequeo
 * `approverId === actor.id` del dominio. Esta consulta solo pone NOMBRE al actor que ya quedó
 * autorizado por el token. Por eso mismo se exige unicidad: si dos usuarios comparten teléfono, la
 * resolución es ambigua y se rechaza (devuelve `null`) en vez de elegir uno — un empate aquí sería
 * atribuirle a la persona equivocada una decisión de control interno.
 *
 * `normalizar_telefono_co` (migración 202609010001) se aplica a ambos lados: WhatsApp entrega E.164
 * con indicativo y los teléfonos cargados a mano suelen venir sin él.
 */
export function createPostgresApproverResolver(databaseUrl = runtimeEnv().DATABASE_URL): (phone: string) => Promise<{ id: string; roles: Role[] } | null> {
  const sql = sharedPostgres(databaseUrl);
  return async (phone: string) => {
    const digits = normalizeApprovalPhone(phone);
    if (!digits) return null;
    const rows = await sql<{ id: string; roles: string[] }[]>`
      select u.id, coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles
      from usuarios u
      join usuario_roles ur on ur.usuario_id = u.id
      where u.estado = 'activo'
        and public.normalizar_telefono_co(coalesce(u.telefono, '')) = public.normalizar_telefono_co(${digits})
        and exists (
          select 1 from usuario_roles r
          where r.usuario_id = u.id and r.rol in ('aprobador', 'admin_sixteam')
        )
      group by u.id
      limit 2`;
    if (rows.length !== 1) return null;
    return { id: rows[0].id, roles: rows[0].roles as Role[] };
  };
}
