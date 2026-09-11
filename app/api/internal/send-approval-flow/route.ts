import { z } from "zod";
import { apiError, parseJson } from "../../../../lib/http/api";
import { sendApprovalFlow } from "../../../../lib/infrastructure/approval-flow-sender";
import { safeEqual } from "../../../../lib/security/crypto";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
const bodySchema = z.object({ requisitionId: z.string().uuid() }).strict();

/**
 * Reenvía a mano el WhatsApp Flow de aprobación al aprobador asignado de una requisición. El
 * camino normal es automático (la notificación `pendiente_aprobador` que encola `sendForApproval`
 * sale como Flow desde `POST /api/internal/dispatch-notifications`); esto existe para el caso
 * operativo real de "al aprobador se le perdió el mensaje" o "se cargó su teléfono después", sin
 * tener que tocar la cola a mano en la BD.
 *
 * Candado: mismo patrón y mismo secreto que `POST /api/internal/send-flow` (`SEND_FLOW_SECRET` en
 * `x-dispatch-secret`, comparado en tiempo constante, cerrado por defecto). Comparten secreto a
 * propósito: son la misma clase de operación —empujar un mensaje real de WhatsApp— y este endpoint
 * es el MÁS estrecho de los dos, porque no acepta un número destino: solo una requisición, y el
 * destinatario sale de `aprobador_id` en la BD.
 *
 * La respuesta nunca lleva el teléfono: solo `{ ok, messageId }`.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.SEND_FLOW_SECRET;
  if (!secret) return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
  const provided = request.headers.get("x-dispatch-secret") ?? "";
  if (!provided || !safeEqual(provided, secret)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });

  try {
    const input = await parseJson(request, bodySchema);
    const { messageId } = await sendApprovalFlow(input.requisitionId);
    return Response.json({ ok: true, messageId }, { status: 200, headers: noStore });
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (code === "APPROVAL_FLOW_NOT_CONFIGURED") return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
    // La requisición no está en aprobación, no tiene aprobador con teléfono, o tiene más ítems de
    // los que caben en el Flow: es una condición del dato, no un fallo del servidor.
    if (code === "APPROVAL_FLOW_NO_CONTEXT" || code === "APPROVAL_FLOW_TOO_MANY_ITEMS") return Response.json({ error: "invalid_input", reason: code }, { status: 409, headers: noStore });
    return apiError(error);
  }
}
