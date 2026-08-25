import { authenticatedJson, assertSameOrigin, parseJson } from "../../../lib/http/api";
import { pettyCashSchema } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
export function GET() { return authenticatedJson((actor) => new ProcurementService(createPostgresDependencies()).listPettyCash({ actor })); }
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, pettyCashSchema); return new ProcurementService(createPostgresDependencies()).registerPettyCash(input, { actor }); }, 201); }
