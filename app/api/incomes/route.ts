import { authenticatedJson, assertSameOrigin, hasListFilters, parseJson, parseListQuery } from "../../../lib/http/api";
import { incomeSchema } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { CashService } from "../../../lib/services";

export const runtime = "nodejs";
// Ingresos (2026-09-12, migración 202609120003): mismo contrato aditivo que /api/petty-cash —
// `?cashBoxId=&costCenterId=&workId=&from=&to=&limit=&cursor=`.
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const { query, paginated } = parseListQuery(new URL(request.url));
    const service = new CashService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listIncomes({ actor });
    return service.listIncomesPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
export function POST(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, incomeSchema);
    return new CashService(createPostgresDependencies()).registerIncome(input, { actor });
  }, 201);
}
