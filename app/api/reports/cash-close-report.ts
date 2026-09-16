import ExcelJS from "exceljs";
import { z } from "zod";
import { assertPermission, type Actor } from "../../../lib/domain";
import { postgresReportCatalogSource } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService, toCashCloseReport, type CashCloseReport, type ReportCatalogSource, type ServiceDependencies } from "../../../lib/services";

/**
 * RF-708 (cierre de caja, adenda A10): caso de uso compartido entre la ruta JSON de la pantalla y la
 * descarga en Excel — mismo patrón que `buildExpensesReport` (expenses-report.ts). La autorización de
 * lectura la decide `ProcurementService.listCashPayments` ("expense:read"); descargar exige además
 * "report:export", la misma puerta que el resto de exportaciones.
 */
export const cashCloseFiltersSchema = z
  .object({
    from: z.string().date("Fecha inicial inválida (use AAAA-MM-DD)"),
    to: z.string().date("Fecha final inválida (use AAAA-MM-DD)"),
    costCenterId: z.string().uuid("Centro de costo inválido").optional(),
    format: z.enum(["json", "xlsx"]).default("json"),
  })
  .strict();
export type CashCloseFilters = z.infer<typeof cashCloseFiltersSchema>;

export interface BuildCashCloseOptions { origin?: "web" | "mcp"; names?: ReportCatalogSource; }

export async function buildCashCloseReport(dependencies: ServiceDependencies, actor: Actor, filters: Pick<CashCloseFilters, "from" | "to" | "costCenterId">, options: BuildCashCloseOptions = {}): Promise<CashCloseReport> {
  const query = { from: filters.from, to: filters.to, costCenterId: filters.costCenterId };
  const [payments, names] = await Promise.all([
    new ProcurementService(dependencies).listCashPayments(query, { actor, origin: options.origin ?? "web" }),
    (options.names ?? postgresReportCatalogSource()).load(),
  ]);
  return toCashCloseReport(payments, names, query);
}

export function assertCanDownloadCashClose(actor: Actor, origin: "web" | "mcp" = "web"): void {
  assertPermission(actor.roles, "report:export", origin);
}

export async function buildCashCloseXlsx(report: CashCloseReport): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Plataforma Mizar";
  const sheet = workbook.addWorksheet("Cierre de caja");
  sheet.addRow([`Cierre de caja (efectivo) · del ${report.from} al ${report.to}`]);
  sheet.mergeCells("A1:L1");
  sheet.getRow(1).font = { bold: true };
  sheet.addRow(["Fecha", "Orden", "Tipo", "Requisición", "Beneficiario", "Obra", "Centro de costo", "Empresa facturada", "Referencia", "Nota", "Comprobante", "Valor COP"]);
  sheet.getRow(2).font = { bold: true };
  for (const row of report.rows) {
    sheet.addRow([row.date, row.orderConsecutive, row.orderType, row.requisitionConsecutive, row.supplierName, row.workName, row.costCenterName, row.billedCompanyName, row.externalReference ?? "", row.note ?? "", row.attachmentId ? "Sí" : "No", row.amount]);
  }
  const totalRow = sheet.addRow(["", "", "", "", "", "", "", "", "", "", "TOTAL", report.total]);
  totalRow.font = { bold: true };
  sheet.columns.forEach((column) => { column.width = 20; });
  // Mismo cast que expenses-report.ts: el "Buffer" que declara exceljs no es el de @types/node actual.
  return (await workbook.xlsx.writeBuffer()) as unknown as Uint8Array;
}
