import { DomainError } from "../../../lib/domain";
import { authenticatedJson } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ReportService } from "../../../lib/services";
import { reportFiltersSchema } from "./report-query";

export const runtime = "nodejs";

/**
 * RF-1301 (Reportes, reunión 2026-09-11): datos filtrados para la pantalla de Reportes (obra, periodo,
 * aprobador, etiqueta). La autorización ("report:read") y la visibilidad por rol (un aprobador no
 * elevado solo ve lo suyo, vía `public.es_aprobador_de`) se deciden en `ReportService.listReport` — esta
 * ruta solo valida los query params y traduce el resultado a JSON.
 */
export function GET(request: Request) {
  return authenticatedJson(async (actor) => {
    const url = new URL(request.url);
    const parsed = reportFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Parámetros de reporte inválidos");
    const rows = await new ReportService(createPostgresDependencies()).listReport(parsed.data, { actor });
    return { rows };
  });
}
