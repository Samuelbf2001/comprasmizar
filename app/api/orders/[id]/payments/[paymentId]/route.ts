import { z } from "zod";
import { authenticatedJson, assertSameOrigin, parseJson, parsePathParams } from "../../../../../../lib/http/api";
import { orderPaymentAnnulSchema } from "../../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../../lib/services";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid(), paymentId: z.string().uuid() }).strict();

/**
 * RF-510 (adenda de pagos): un pago registrado se ANULA con motivo, nunca se borra — por eso es PATCH
 * y no DELETE. Mismo par autenticación + mismo origen que el POST hermano (../route.ts). Devuelve el
 * pago ya anulado y la orden con `paidAmount`/`paymentStatus` frescos.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string; paymentId: string }> }) {
  return authenticatedJson(async (actor) => {
    const { id, paymentId } = await parsePathParams(context.params, paramsSchema);
    assertSameOrigin(request);
    const input = await parseJson(request, orderPaymentAnnulSchema);
    return new ProcurementService(createPostgresDependencies()).annulOrderPayment(id, paymentId, input.reason, { actor });
  });
}
