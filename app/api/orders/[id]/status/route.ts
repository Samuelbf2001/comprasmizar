import { authenticatedJson, assertSameOrigin, parseJson } from "../../../../../lib/http/api";
import { orderStatusSchema } from "../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";
// Extiende esta ruta (ya auditada y probada) con el eje administrativo en vez de crear una hermana:
// "status" sigue siendo cumplimiento (updateOrderStatus); "adminStatus" es el eje contable nuevo
// (updateOrderAdminStatus) — reunión 2026-08-31.
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, orderStatusSchema), service = new ProcurementService(createPostgresDependencies()), requestContext = { actor };
    if ("status" in input) return service.updateOrderStatus(id, input.status, requestContext);
    return service.updateOrderAdminStatus(id, input.adminStatus, requestContext);
  });
}
