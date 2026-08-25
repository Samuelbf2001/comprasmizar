import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { DomainError } from "../../../../lib/domain";
import { apiError } from "../../../../lib/http/api";
import { requireServerActor } from "../../../../lib/infrastructure/auth";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { buildExpensesReport, expensesReportFiltersSchema } from "../expenses-report";

export const runtime = "nodejs";

/** Provisional XLSX/PDF V0.1 only; it deliberately does not claim Helisa validation. RF-705: agrega ?format=pdf al lado del XLSX ya existente. */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireServerActor();
    const url = new URL(request.url);
    const parsed = expensesReportFiltersSchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new DomainError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "Parámetros de reporte inválidos");
    const { period, workId, societyId, format } = parsed.data;
    const dependencies = createPostgresDependencies();
    const file = await buildExpensesReport(dependencies, actor, parsed.data);
    await dependencies.audit.append({ entity: "reporte", entityId: randomUUID(), event: `${format}_provisional_descargado`, actorId: actor.id, at: new Date(), origin: "web", data: { format: `${format}_v0_1`, provisional: true, rows: file.rows, period, workId, societyId } });
    return new Response(Buffer.from(file.bytes), { headers: { "Content-Type": file.mimeType, "Content-Disposition": `attachment; filename=${file.filename}`, "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
