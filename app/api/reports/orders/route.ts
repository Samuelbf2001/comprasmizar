import { DomainError } from "../../../../lib/domain";
import { authenticatedJson } from "../../../../lib/http/api";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { ReportService } from "../../../../lib/services";
import { orderReportFiltersSchema } from "../report-query";

export const runtime = "nodejs";

/**
 * RF-707 (adenda de pagos): órdenes con su total, lo pagado y el estado de pago, para el bloque
 * "comprometido vs pagado" de /reportes. Misma división de responsabilidades que `GET /api/reports`:
 * la ruta valida los query params; permiso y visibilidad viven en `ReportService.listOrderReport`.
 */
export function GET(request: Request) {
  return authenticatedJson(async (actor) => {
    const url = new URL(request.url);
    const parsed = orderReportFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Parámetros de reporte inválidos");
    const rows = await new ReportService(createPostgresDependencies()).listOrderReport(parsed.data, { actor });
    return { rows };
  });
}
