import { z } from "zod";
import { assertPermission, distributeExpenses, prorate, type Actor, type Expense } from "../../../lib/domain";
import { sharedPostgres } from "../../../lib/infrastructure/postgres-repositories";
import { buildPartnersExpensePdf, buildProvisionalHelisaXlsx, type ReportExpense } from "../../../lib/reports";
import { ProcurementService, ReportService, type ServiceDependencies } from "../../../lib/services";

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
  assertPermission(actor, "report:export", origin);
  // RF-707: lo pagado y el estado de pago de cada gasto salen de su orden (Σ pagos vigentes); el
  // reporte de órdenes exige "report:read", que todo rol con "report:export" ya tiene.
  const [visible, orders] = await Promise.all([
    new ProcurementService(dependencies).listExpenses({ actor, origin }),
    new ReportService(dependencies).listOrderReport({}, { actor, origin }),
  ]);
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const workIdsForSociety = filters.societyId
    ? new Set(await (options.societyIndex ?? postgresWorkSocietyIndex()).workIdsForSociety(filters.societyId))
    : null;
  // Un gasto SIN obra (centro de costo administrativo/personal/empresa: `workId` vacío) no puede
  // resolverse por obra → el filtro por sociedad lo conserva por su empresa facturada.
  const inSociety = (expense: Expense) => !workIdsForSociety || workIdsForSociety.has(expense.workId) || (!expense.workId && expense.billedCompanyId === filters.societyId);
  // RF-305 (hallazgo del ensayo 2026-09-22): un gasto repartido entra al reporte como una fila por obra
  // (`distributeExpenses`), ANTES de filtrar por obra/sociedad — así cada obra/socio ve solo su parte y el
  // total del archivo sigue siendo el de los gastos, sin duplicar.
  const expenseById = new Map(visible.map((expense) => [expense.id, expense]));
  const expenses = distributeExpenses(visible).filter((expense) =>
    (!filters.period || expense.period === filters.period) &&
    (!filters.workId || expense.workId === filters.workId) &&
    inSociety(expense));
  const mapped: ReportExpense[] = expenses.map((expense) => {
    const order = expense.origin === "requisicion" ? orderById.get(expense.referenceId) : undefined;
    // Un movimiento de caja menor histórico nació pagado en el acto.
    const paidTotal = expense.origin === "caja_menor" ? expense.portionOf?.expenseTotal ?? expense.total : order?.paidAmount;
    // Lo pagado de la orden se prorratea con el mismo reparto que el gasto (Σ porciones === pagado).
    const full = expenseById.get(expense.id);
    const paid = paidTotal !== undefined && expense.portionOf && full?.shares
      ? prorate(paidTotal, full.shares.map((share) => share.amount), full.total)[expense.portionOf.index]
      : paidTotal;
    return {
      orderDate: expense.orderDate, date: expense.date, work: expense.workId || "—", tag: expense.tagId, supplier: expense.supplierId, origin: expense.origin,
      base: expense.base, iva: expense.iva, total: expense.total, billedCompany: expense.billedCompanyId,
      paymentStatus: expense.origin === "caja_menor" ? "pagada" : order?.paymentStatus, paid,
    };
  });
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
