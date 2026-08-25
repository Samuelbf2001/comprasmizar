import { authenticatedJson } from "../../../../lib/http/api";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../lib/services";

export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return authenticatedJson((actor) => new ProcurementService(createPostgresDependencies()).getRequisition(id, { actor })); }
