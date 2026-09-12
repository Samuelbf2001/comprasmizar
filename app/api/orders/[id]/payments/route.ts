import { z } from "zod";
import { authenticatedJson, assertSameOrigin, parseJson, parsePathParams } from "../../../../../lib/http/api";
import { orderPaymentSchema } from "../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";
const paramsSchema = z.object({ id: z.string().uuid() }).strict();

/**
 * Reunión agosto 2026: "saber cuánto se ha pagado de cada orden" con pagos parciales. GET lista el
 * historial de la orden (panel "Pagos" de su ficha); POST registra un abono nuevo. Mismo par
 * autenticación + mismo origen que el resto de rutas de escritura de este directorio (ver
 * app/api/orders/[id]/status/route.ts) — GET no exige `assertSameOrigin` (no muta nada), igual que
 * las demás rutas de solo lectura del repo.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return authenticatedJson(async (actor) => {
    const { id } = await parsePathParams(context.params, paramsSchema);
    return new ProcurementService(createPostgresDependencies()).listOrderPayments(id, { actor });
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return authenticatedJson(async (actor) => {
    const { id } = await parsePathParams(context.params, paramsSchema);
    assertSameOrigin(request);
    const input = await parseJson(request, orderPaymentSchema);
    return new ProcurementService(createPostgresDependencies()).registerOrderPayment(id, input, { actor });
  }, 201);
}
