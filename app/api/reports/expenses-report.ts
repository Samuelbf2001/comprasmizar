import { z } from "zod";
import { assertPermission, type Actor } from "../../../lib/domain";
import { sharedPostgres } from "../../../lib/infrastructure/postgres-repositories";
import { buildPartnersExpensePdf, buildProvisionalHelisaXlsx, type ReportExpense } from "../../../lib/reports";
import { ProcurementService, type ServiceDependencies } from "../../../lib/services";

/**
 * Caso de uso compartido del reporte de gastos: lo consumen tanto la ruta HTTP
 * (app/api/reports/expenses/route.ts, RF-705) como la herramienta MCP de solo lectura
 * `exportar_reporte` (RF-1203/1204). La autorización ("report:export") se decide una única
 * vez aquí para que ningún llamador pueda registrar un tercer camino que la salte.
 *
 * Nota de arquitectura: AGENTS.md exige que la autorización viva en lib/services. Este módulo
 * queda fuera de ese árbol porque el alcance de esta tarea solo autoriza tocar app/api/reports/**,
 * app/mcp/route.ts y lib/security/mcp.ts (otros agentes trabajan en paralelo sobre lib/services).
 * Se deja como pendiente migrar esta función a lib/services/report-service.ts cuando ese árbol
 * quede libre; mientras tanto sigue siendo el único punto que decide el permiso.
 */
export const expensesReportFiltersSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, "Periodo inválido").optional(),
  workId: z.string().uuid("Obra inválida").optional(),
  societyId: z.string().uuid("Sociedad inválida").optional(),
  format: z.enum(["xlsx", "pdf"]).default("xlsx"),
});
export type ExpensesReportFilters = z.infer<typeof expensesReportFiltersSchema>;

export interface ExpensesReportFile { bytes: Uint8Array; mimeType: string; filename: string; rows: number; }

/** Resuelve qué obras pertenecen a una sociedad. Inyectable para poder probar el filtro sin Postgres real. */
export interface WorkSocietyIndex { workIdsForSociety(societyId: string): Promise<readonly string[]>; }
export function postgresWorkSocietyIndex(): WorkSocietyIndex {
  return {
    async workIdsForSociety(societyId) {
      const sql = sharedPostgres();
      return (await sql<{ id: string }[]>`select id from obras where sociedad_id = ${societyId}`).map((row) => row.id);
    },
  };
}

export interface BuildExpensesReportOptions { origin?: "web" | "mcp"; societyIndex?: WorkSocietyIndex; }

/** Cada obra pertenece a una sociedad distinta y el corte es mensual (RF-705): se puede filtrar por obra, sociedad y periodo. */
export async function buildExpensesReport(dependencies: ServiceDependencies, actor: Actor, filters: ExpensesReportFilters, options: BuildExpensesReportOptions = {}): Promise<ExpensesReportFile> {
  const origin = options.origin ?? "web";
  assertPermission(actor.roles, "report:export", origin);
  const visible = await new ProcurementService(dependencies).listExpenses({ actor, origin });
  const workIdsForSociety = filters.societyId
    ? new Set(await (options.societyIndex ?? postgresWorkSocietyIndex()).workIdsForSociety(filters.societyId))
    : null;
  const expenses = visible.filter((expense) =>
    (!filters.period || expense.period === filters.period) &&
    (!filters.workId || expense.workId === filters.workId) &&
    (!workIdsForSociety || workIdsForSociety.has(expense.workId)));
  const mapped: ReportExpense[] = expenses.map((expense) => ({ date: expense.date, work: expense.workId, tag: expense.tagId, supplier: expense.supplierId, origin: expense.origin, base: expense.base, iva: expense.iva, total: expense.total }));
  if (filters.format === "pdf") {
    return { bytes: await buildPartnersExpensePdf("Gastos por socios", mapped), mimeType: "application/pdf", filename: "gastos-socios-provisional-v0.1.pdf", rows: expenses.length };
  }
  // exceljs.writeBuffer() resuelve su tipo "Buffer" contra el @types/node viejo que arrastra @fast-csv
  // (dependencia transitiva de exceljs), que el checker ve incompatible con el Uint8Array<ArrayBufferLike>
  // genérico del resto de la app aunque en runtime sí es un Buffer real. El cast puntual evita tocar
  // lib/reports/xlsx.ts, que no está entre los archivos de esta tarea.
  const xlsxBytes = await buildProvisionalHelisaXlsx(mapped) as unknown as Uint8Array;
  return { bytes: xlsxBytes, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "gastos-provisional-v0.1.xlsx", rows: expenses.length };
}
