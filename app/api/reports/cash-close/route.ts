import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../../../lib/domain";
import { apiError } from "../../../../lib/http/api";
import { requireServerActor } from "../../../../lib/infrastructure/auth";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { assertCanDownloadCashClose, buildCashCloseReport, buildCashCloseXlsx, cashCloseFiltersSchema } from "../cash-close-report";

export const runtime = "nodejs";

/**
 * RF-708 (cierre de caja): `?from&to[&costCenterId]` devuelve los pagos VIGENTES con medio Caja
 * (efectivo) del rango, con nombres resueltos y total (JSON para la pantalla); `&format=xlsx` descarga el
 * mismo resultado en Excel. Sin `assertSameOrigin` por la misma razón documentada en export/route.ts: es
 * una navegación GET (`<a href>`), y ninguna ruta GET del repo la exige.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireServerActor();
    const url = new URL(request.url);
    const parsed = cashCloseFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Parámetros del cierre inválidos");
    const { format, ...filters } = parsed.data;
    const dependencies = createPostgresDependencies();
    if (format === "xlsx") assertCanDownloadCashClose(actor);
    const report = await buildCashCloseReport(dependencies, actor, filters);
    if (format !== "xlsx") return Response.json(report, { headers: { "Cache-Control": "no-store" } });
    const bytes = await buildCashCloseXlsx(report);
    await dependencies.audit.append({ entity: "reporte", entityId: randomUUID(), event: "cierre_caja_descargado", actorId: actor.id, at: new Date(), origin: "web", data: { rows: report.rows.length, total: report.total, ...filters } });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename=cierre-caja-${filters.from}-a-${filters.to}.xlsx`, "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
