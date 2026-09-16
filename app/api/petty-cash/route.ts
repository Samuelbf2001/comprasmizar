import { authenticatedJson, hasListFilters, parseListQuery } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
// H3 (docs/plan-rendimiento.md, Fase 3): `?workId=&from=&to=&limit=&cursor=` son ADITIVOS — mismo
// contrato que las demás rutas de listas. Sin `status`: caja menor no tiene columna de estado.
// Solo lectura del histórico: la tabla `caja_menor` queda dormida (adenda A10, sin DROP).
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const { query, paginated } = parseListQuery(new URL(request.url));
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listPettyCash({ actor });
    return service.listPettyCashPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
// Adenda de pagos (A10, RF-801/802 derogados): el "gasto directo" de caja sin requisición ni
// aprobación ya no existe — la caja menor es un pago con medio Caja (efectivo) sobre la orden
// (POST /api/orders/[id]/payments). `ProcurementService.registerPettyCash` queda sin llamador.
export function POST() {
  return Response.json(
    { error: "RETIRADO", message: "Los gastos de caja se registran como pagos con medio Caja sobre la orden. Ver Cierre de caja." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}
