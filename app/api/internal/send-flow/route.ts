import { z } from "zod";
import { apiError, parseJson } from "../../../../lib/http/api";
import { sendRequisitionFlow } from "../../../../lib/infrastructure/flow-sender";
import { safeEqual } from "../../../../lib/security/crypto";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };
const bodySchema = z.object({ to: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/) }).strict();

/**
 * Endpoint interno que dispara el envío del WhatsApp Flow "Requisición de obra" (RF-902)
 * a un número dado. Nunca lo llama un navegador ni un caller sin autenticar — solo algo
 * interno (backoffice, otro job) que ya conoce el secreto compartido.
 *
 * Candado: mismo patrón exacto que `POST /api/internal/dispatch-notifications` — secreto
 * compartido en el header `x-dispatch-secret`, comparado con `safeEqual` (tiempo constante),
 * cerrado por defecto (503 si no hay secreto configurado, 401 si el header falta o no
 * coincide). Se usa un secreto PROPIO (`SEND_FLOW_SECRET`), no `NOTIFICATION_DISPATCH_SECRET`:
 * ese otro secreto autoriza drenar una cola interna ya validada (`notificaciones`), mientras
 * que este autoriza empujar un mensaje real a CUALQUIER número que el llamador decida — un
 * radio de impacto distinto que no debería compartir credencial con el del cron de
 * notificaciones (rotar uno no debería obligar a rotar el otro, y viceversa).
 *
 * La respuesta nunca lleva teléfonos: solo `{ ok, messageId }` en éxito, o `{ error }` sin
 * detalle en fallo — igual que `sendKapsoTemplate`/`dispatch-notifications`, cualquier mensaje
 * de error de `sendRequisitionFlow` podría llevar embebido el número o la razón de Kapso, así
 * que solo los códigos propios (`FLOW_SEND_NOT_CONFIGURED`, `FLOW_SEND_INVALID_PHONE`) se
 * traducen a un status; el resto cae al 500 genérico de `apiError`.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.SEND_FLOW_SECRET;
  if (!secret) return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
  const provided = request.headers.get("x-dispatch-secret") ?? "";
  if (!provided || !safeEqual(provided, secret)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });

  try {
    const input = await parseJson(request, bodySchema);
    const { messageId } = await sendRequisitionFlow(input.to);
    return Response.json({ ok: true, messageId }, { status: 200, headers: noStore });
  } catch (error) {
    if (error instanceof Error && error.message === "FLOW_SEND_NOT_CONFIGURED") return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
    if (error instanceof Error && error.message === "FLOW_SEND_INVALID_PHONE") return Response.json({ error: "invalid_input" }, { status: 400, headers: noStore });
    return apiError(error);
  }
}
