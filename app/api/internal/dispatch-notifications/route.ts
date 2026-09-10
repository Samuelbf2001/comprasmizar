import { dispatchPendingNotifications, createPostgresNotificationDispatchStore } from "../../../../lib/infrastructure/notification-dispatcher";
import { sendKapsoTemplate } from "../../../../lib/infrastructure/kapso";
import { isApprovalFlowConfigured, sendApprovalFlow } from "../../../../lib/infrastructure/approval-flow-sender";
import { safeEqual } from "../../../../lib/security/crypto";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

/**
 * Errores del emisor del Flow de aprobación que significan "esta requisición concreta no se puede
 * decidir por WhatsApp", no "el canal está roto": la persona igual tiene que enterarse, así que se
 * cae al aviso de plantilla de siempre y ella entra por la web. Cualquier otro error (red, 5xx de
 * Kapso) se propaga para que la cola lo reintente con su backoff normal.
 */
const FLOW_UNAVAILABLE = new Set(["APPROVAL_FLOW_NO_CONTEXT", "APPROVAL_FLOW_TOO_MANY_ITEMS", "APPROVAL_FLOW_NOT_CONFIGURED"]);
function isFlowUnavailable(error: unknown): boolean { return error instanceof Error && FLOW_UNAVAILABLE.has(error.message); }

/**
 * Internal-only endpoint that drains the `notificaciones` outbox (RF-406/904/905). Meant to be hit by
 * a scheduled job (VPS cron / hosting scheduler), never by a browser or an unauthenticated caller.
 *
 * Auth: a shared secret in `NOTIFICATION_DISPATCH_SECRET`, compared with `x-dispatch-secret` using a
 * constant-time check. No secret configured, no missing/mismatched header -> the route never touches
 * the queue; it is closed by default rather than open to the internet.
 *
 * The response carries counts only — never phone numbers or message content, per requirement.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.NOTIFICATION_DISPATCH_SECRET;
  if (!secret) return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
  const provided = request.headers.get("x-dispatch-secret") ?? "";
  if (!provided || !safeEqual(provided, secret)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });

  try {
    const store = createPostgresNotificationDispatchStore();
    const outcome = await dispatchPendingNotifications(store, {
      sendTemplate: sendKapsoTemplate,
      // Solo se inyecta si el Flow de aprobación está configurado: sin `WHATSAPP_APPROVAL_FLOW_ID`
      // la cola sigue enviando exactamente las plantillas de antes, sin gastar intentos en un canal
      // que no existe. El destinatario del Flow NO es `to`: lo resuelve el emisor desde
      // `aprobador_id` (ver sendApprovalFlow), así que un `to` equivocado no puede desviar una
      // aprobación a otra persona.
      ...(isApprovalFlowConfigured() ? {
        sendApprovalFlow: async ({ requisitionId, fallback }) => {
          try { return await sendApprovalFlow(requisitionId); }
          catch (error) { if (isFlowUnavailable(error)) return fallback(); throw error; }
        },
      } : {}),
    });
    return Response.json({ ok: true, ...outcome }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ error: "dispatch_failed" }, { status: 500, headers: noStore });
  }
}
