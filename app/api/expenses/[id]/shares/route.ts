import { authenticatedJson, assertSameOrigin, parseJson } from "../../../../../lib/http/api";
import { expenseSharesSchema } from "../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";
export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, expenseSharesSchema); await new ProcurementService(createPostgresDependencies()).redistribute(id, input.total, input.shares.map((share) => ({ expenseId: id, ...share })), { actor }); return { updated: true }; }); }
