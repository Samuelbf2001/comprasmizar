import { dispatchPendingNotifications, createPostgresNotificationDispatchStore } from "../../../../lib/infrastructure/notification-dispatcher";
import { sendKapsoTemplate } from "../../../../lib/infrastructure/kapso";
import { isApprovalFlowConfigured, sendApprovalFlow, sendApprovalTemplate } from "../../../../lib/infrastructure/approval-flow-sender";
import { safeEqual } from "../../../../lib/security/crypto";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

/**
 * Errores que significan "este envío no puede ir como Flow EN ABSOLUTO" (la requisición ya no está
 * en aprobación, tiene más ítems de los que Meta admite, o el canal no está configurado). La
 * persona igual tiene que enterarse, así que se cae al aviso de texto de siempre y entra por la
 * web. Cualquier otro error (red, 5xx de Kapso) se propaga para que la cola lo reintente con su
 * backoff normal.
 */
const FLOW_IMPOSSIBLE = new Set(["APPROVAL_FLOW_NO_CONTEXT", "APPROVAL_FLOW_TOO_MANY_ITEMS", "APPROVAL_FLOW_NOT_CONFIGURED"]);
function isFlowImpossible(error: unknown): boolean { return error instanceof Error && FLOW_IMPOSSIBLE.has(error.message); }
/**
 * Distinto: el Flow SÍ se puede mandar, pero no como mensaje interactivo suelto porque la persona
 * no le ha escrito al negocio en 24 h (el caso normal de un aprobador). Para eso está la plantilla
 * con botón de Flow, que sí atraviesa la ventana y lleva el mismo Flow adentro.
 */
function isSessionClosed(error: unknown): boolean { return error instanceof Error && error.message === "APPROVAL_FLOW_SESSION_CLOSED"; }

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
      // Orden deliberado, por costo: primero el mensaje interactivo, que es GRATIS mientras la
      // sesión de 24 h esté abierta; si está cerrada (lo habitual en un aprobador), la plantilla
      // con botón de Flow, que la atraviesa pero abre una conversación de utilidad facturable; y
      // solo si el Flow no cabe de ninguna forma, el aviso de texto para que entre por la web.
      // Nunca al revés: invertirlo pagaría una conversación cada vez, incluso con el chat abierto.
      ...(isApprovalFlowConfigured() ? {
        sendApprovalFlow: async ({ requisitionId, fallback }) => {
          try {
            return await sendApprovalFlow(requisitionId);
          } catch (error) {
            if (isFlowImpossible(error)) return fallback();
            if (!isSessionClosed(error)) throw error;
          }
          try { return await sendApprovalTemplate(requisitionId); }
          catch (error) { if (isFlowImpossible(error)) return fallback(); throw error; }
        },
      } : {}),
    });
    return Response.json({ ok: true, ...outcome }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ error: "dispatch_failed" }, { status: 500, headers: noStore });
  }
}
