import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../../../lib/domain";
import { apiError } from "../../../../lib/http/api";
import { requireServerActor } from "../../../../lib/infrastructure/auth";
import { createPostgresDependencies, postgresReportCatalogSource } from "../../../../lib/infrastructure/postgres-repositories";
import { buildRequisitionReportXlsx } from "../../../../lib/reports";
import { ReportService } from "../../../../lib/services";
import { filterOrderReportRows } from "../../../../lib/services/report-service";
import { reportExportFiltersSchema } from "../report-query";

export const runtime = "nodejs";

/**
 * RF-1301 (Reportes, reunión 2026-09-11): descarga en Excel del resultado filtrado (obra, periodo,
 * aprobador, etiqueta) — mismos filtros que `GET /api/reports`. Autenticado como el resto de rutas
 * (`requireServerActor`); DELIBERADAMENTE sin `assertSameOrigin`: esa comprobación exige la cabecera
 * `Origin`, que el navegador NO envía en una navegación GET de nivel superior (`<a href>`) ni en un
 * `fetch()` mismo-origen sin modo `cors` explícito (ver el propio comentario de `assertSameOrigin` en
 * lib/http/api.ts: compara contra `Origin`, no contra `Sec-Fetch-Site`) — por esa razón NINGUNA ruta GET
 * de este repo la usa, ni siquiera la descarga de XLSX ya existente
 * (`app/api/reports/expenses/route.ts`). Añadirla aquí rompería la descarga para cualquier navegador
 * real: quedaría protegida solo por autenticación, exactamente como su hermana de gastos.
 *
 * "aprobador(es)"/"proveedor(es)"/nombres de obra-etiqueta-empresa se resuelven aquí (server), no en el
 * cliente: un archivo .xlsx no tiene una pantalla que los traduzca después, a diferencia de
 * `GET /api/reports` (que sí puede devolver ids crudos porque la pantalla ya tiene `CatalogData`).
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireServerActor();
    const url = new URL(request.url);
    const parsed = reportExportFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Parámetros de reporte inválidos");
    const { paymentMethod, paymentStatus, ...filters } = parsed.data;
    const dependencies = createPostgresDependencies();
    const reportService = new ReportService(dependencies);
    reportService.assertCanExport(actor);
    // RF-707 (hallazgo del ensayo 2026-09-22): el Excel trae también el "Estado de pago" y el bloque
    // "Comprometido vs pagado". Las órdenes se piden SIN filtros y se filtran con `filterOrderReportRows`,
    // exactamente como hace la pantalla con GET /api/reports/orders — mismas cifras, misma regla.
    const [rows, names, allOrders] = await Promise.all([
      reportService.listReport(filters, { actor }),
      postgresReportCatalogSource().load(),
      reportService.listOrderReport({}, { actor }),
    ]);
    const filteredOrders = filterOrderReportRows(allOrders, { workId: filters.workId, period: filters.period, costCenterId: filters.costCenterId, billedCompanyId: filters.billedCompanyId, paymentMethod, paymentStatus });
    // RF-1301 punto 3 ("compilado mensual"): agrupado por obra solo cuando el filtro trae un mes —
    // Daniel: "el compilado debe ir por obra/centro de costo"; un export ad-hoc sin mes se queda plano.
    const bytes = (await buildRequisitionReportXlsx(rows, names, { grouped: Boolean(filters.period), orders: { all: allOrders, filtered: filteredOrders } })) as unknown as Uint8Array;
    const filename = `reporte-requisiciones${filters.period ? `-${filters.period}` : ""}.xlsx`;
    await dependencies.audit.append({ entity: "reporte", entityId: randomUUID(), event: "reporte_requisiciones_descargado", actorId: actor.id, at: new Date(), origin: "web", data: { rows: rows.length, ...parsed.data } });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=${filename}`, "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
