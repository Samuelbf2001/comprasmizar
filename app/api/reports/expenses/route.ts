import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { assertPermission, DomainError } from "../../../../lib/domain";
import { apiError } from "../../../../lib/http/api";
import { requireServerActor } from "../../../../lib/infrastructure/auth";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { buildProvisionalHelisaXlsx } from "../../../../lib/reports";
import { ProcurementService } from "../../../../lib/services";

export const runtime = "nodejs";

/** Provisional XLSX V0.1 only; it deliberately does not claim Helisa validation. */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = await requireServerActor();
    assertPermission(actor.roles, "report:export");
    const url = new URL(request.url), period = url.searchParams.get("period"), workId = url.searchParams.get("workId");
    if (period && !/^\d{4}-\d{2}$/.test(period)) throw new DomainError("INVALID_INPUT", "Periodo inválido");
    if (workId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId)) throw new DomainError("INVALID_INPUT", "Obra inválida");
    const dependencies = createPostgresDependencies(), visible = await new ProcurementService(dependencies).listExpenses({ actor });
    const expenses = visible.filter((expense) => (!period || expense.period === period) && (!workId || expense.workId === workId));
    const bytes = await buildProvisionalHelisaXlsx(expenses.map((expense) => ({ date: expense.date, work: expense.workId, tag: expense.tagId, supplier: expense.supplierId, origin: expense.origin, base: expense.base, iva: expense.iva, total: expense.total })));
    await dependencies.audit.append({ entity: "reporte", entityId: randomUUID(), event: "xlsx_provisional_descargado", actorId: actor.id, at: new Date(), origin: "web", data: { format: "xlsx_v0_1", provisional: true, rows: expenses.length, period, workId } });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=gastos-provisional-v0.1.xlsx", "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
