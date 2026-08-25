import { authenticatedJson, assertSameOrigin, parseJson } from "../../../../../lib/http/api";
import { orderStatusSchema } from "../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, orderStatusSchema); return new ProcurementService(createPostgresDependencies()).updateOrderStatus(id, input.status, { actor }); }); }
