import { randomUUID } from "node:crypto";
import { authenticatedJson, assertSameOrigin, hasListFilters, parseJson, parseListQuery } from "../../../lib/http/api";
import { createRequisitionSchema, REQUISITION_STATUS_VALUES } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
// H3 (docs/plan-rendimiento.md, Fase 3): `?status=a,b&workId=&from=&to=&limit=&cursor=` son ADITIVOS —
// sin ninguno de los seis, responde exactamente el array de siempre (compatibilidad hacia atrás
// obligatoria: la bandeja/mis requisiciones/detalle actuales lo consumen tal cual). `limit`/`cursor`
// deciden el shape de la respuesta (`{ rows, nextCursor }` vs el array de siempre); status/workId/
// from/to sin limit/cursor filtran mientras siguen devolviendo un array plano.
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const { query, paginated } = parseListQuery(new URL(request.url), REQUISITION_STATUS_VALUES);
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listRequisitions({ actor });
    return service.listRequisitionsPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, createRequisitionSchema); return new ProcurementService(createPostgresDependencies()).create({ ...input, channel: "web", items: input.items.map((item) => ({ ...item, id: randomUUID(), unitBase: 0, unitIva: 0 })) }, { actor }); }, 201); }
