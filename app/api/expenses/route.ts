import { authenticatedJson } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
export function GET() { return authenticatedJson((actor) => new ProcurementService(createPostgresDependencies()).listExpenses({ actor })); }
