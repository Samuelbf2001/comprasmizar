import { authenticatedJson, assertSameOrigin, hasListFilters, parseJson, parseListQuery } from "../../../lib/http/api";
import { pettyCashSchema } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
// H3 (docs/plan-rendimiento.md, Fase 3): `?workId=&from=&to=&limit=&cursor=` son ADITIVOS — mismo
// contrato que las demás rutas de listas. Sin `status`: caja menor no tiene columna de estado.
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const { query, paginated } = parseListQuery(new URL(request.url));
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listPettyCash({ actor });
    return service.listPettyCashPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, pettyCashSchema); return new ProcurementService(createPostgresDependencies()).registerPettyCash(input, { actor }); }, 201); }
