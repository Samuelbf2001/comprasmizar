import { authenticatedJson, assertSameOrigin, parseJson } from "../../../../lib/http/api";
import { requisitionHeaderSchema } from "../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../lib/services";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return authenticatedJson((actor) => new ProcurementService(createPostgresDependencies()).getRequisition(id, { actor })); }
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, requisitionHeaderSchema); return new ProcurementService(createPostgresDependencies()).updateRequisitionHeader(id, input, { actor }); }); }
