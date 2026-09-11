import { z } from "zod";
import { DomainError } from "../../../lib/domain";
import { authenticatedJson, hasListFilters, parseListQuery } from "../../../lib/http/api";
import { ORDER_STATUS_VALUES } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
const requisitionIdSchema = z.string().uuid();

// H2 (docs/plan-rendimiento.md): `?requisitionId=` es aditivo — sin el parámetro, comportamiento
// intacto (todas las órdenes visibles, como hoy). Con él, filtra a una sola requisición sin traer las
// demás para descartarlas en el cliente. Tiene prioridad sobre los filtros/paginación de H3 (Fase 3,
// abajo): si viene `requisitionId`, el resto de parámetros nuevos se ignora.
// H3: `?status=a,b&workId=&from=&to=&limit=&cursor=` son ADITIVOS — mismo contrato que
// app/api/requisitions/route.ts. `workId` filtra por la obra de la requisición dueña (join, ver
// `order(row)` en postgres-repositories.ts).
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const url = new URL(request.url);
    const rawRequisitionId = url.searchParams.get("requisitionId");
    if (rawRequisitionId !== null) {
      const parsed = requisitionIdSchema.safeParse(rawRequisitionId);
      if (!parsed.success) throw new DomainError("INVALID_INPUT", "requisitionId debe ser un uuid válido");
      return new ProcurementService(createPostgresDependencies()).listOrdersByRequisition(parsed.data, { actor });
    }
    const { query, paginated } = parseListQuery(url, ORDER_STATUS_VALUES);
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listOrders({ actor });
    return service.listOrdersPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
