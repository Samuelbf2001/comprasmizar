import { z } from "zod";
import { DomainError } from "../../../lib/domain";
import { authenticatedJson, hasListFilters, parseListQuery } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
const referenceIdSchema = z.string().uuid();

// H2 (docs/plan-rendimiento.md): `?referenceId=` es aditivo — sin el parámetro, comportamiento intacto
// (todos los gastos visibles, como hoy). Con él, filtra a los gastos de una requisición (directos o vía
// sus órdenes, ver `listByReference` en postgres-repositories.ts) sin traer los demás. Tiene prioridad
// sobre los filtros/paginación de H3 (Fase 3, abajo): si viene `referenceId`, el resto se ignora.
// H3: `?workId=&from=&to=&limit=&cursor=` son ADITIVOS — mismo contrato que las demás rutas de listas.
// Sin `status`: gastos no tiene columna de estado (ver ListQuery en lib/services/list-query.ts); un
// `?status=` en esta ruta se ignora en vez de fallar (parseListQuery sin `statusValues`).
// Centros de costo (2026-09-12): `?costCenterId=` filtra por `gastos.centro_costo_id` (ver
// listVisibleExpenses en postgres-repositories.ts) — mismo patrón aditivo que `workId`.
// Cajas (2026-09-12): `?cajaId=` filtra por `gastos.caja_id` (columna copiada por
// sincronizar_gasto_caja_menor, NULL en origen 'requisicion') — mismo patrón aditivo, nombre de
// parámetro en español ("caja") porque es como lo llama la pestaña "Gastos y caja".
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const url = new URL(request.url);
    const rawReferenceId = url.searchParams.get("referenceId");
    if (rawReferenceId !== null) {
      const parsed = referenceIdSchema.safeParse(rawReferenceId);
      if (!parsed.success) throw new DomainError("INVALID_INPUT", "referenceId debe ser un uuid válido");
      return new ProcurementService(createPostgresDependencies()).listExpensesByReference(parsed.data, { actor });
    }
    const { query, paginated } = parseListQuery(url);
    const rawCashBoxId = url.searchParams.get("cajaId");
    if (rawCashBoxId !== null) {
      const parsed = referenceIdSchema.safeParse(rawCashBoxId);
      if (!parsed.success) throw new DomainError("INVALID_INPUT", "cajaId debe ser un uuid válido");
      query.cashBoxId = parsed.data;
    }
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listExpenses({ actor });
    return service.listExpensesPage(query, { actor }).then((page) => (paginated ? page : page.rows));
  });
}
