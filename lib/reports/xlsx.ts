import ExcelJS from "exceljs";
import type { ReportExpense } from "./types";

/**
 * Provisional export V0.1: column mapping must be confirmed by Helisa/accounting before production
 * use. Reunión 2026-09: dos columnas de fecha, "Fecha orden" (nace con el registro, siempre presente)
 * y "Fecha pago" (vacía mientras la orden no se ha pagado) — antes había una sola "Fecha" que asumía
 * que el gasto nacía ya con fecha final.
 */
export async function buildProvisionalHelisaXlsx(expenses: readonly ReportExpense[]) {
  const workbook = new ExcelJS.Workbook(); workbook.creator = "Plataforma Mizar";
  // "provisional" en minúscula a propósito: el marcador ALL-CAPS de esta exportación (evaluado en
  // producción como "identificador técnico a la vista", ver informe de la tarea de fechas de gasto)
  // se retiró del literal del PDF de socios; este mismo criterio aplica aquí.
  const sheet = workbook.addWorksheet("Gastos provisional"); sheet.addRow(["Exportación provisional V0.1 - pendiente validación Helisa"]); sheet.mergeCells("A1:I1");
  sheet.addRow(["Fecha orden", "Fecha pago", "Obra", "Etiqueta", "Proveedor", "Origen", "Base COP", "IVA COP", "Total COP"]);
  for (const row of expenses) sheet.addRow([row.orderDate, row.date ?? "", row.work, row.tag ?? "", row.supplier ?? "", row.origin, row.base, row.iva, row.total]);
  const total = expenses.reduce((sum, row) => sum + row.total, 0); sheet.addRow(["", "", "", "", "", "TOTAL", "", "", total]); sheet.getRow(2).font = { bold: true }; sheet.columns.forEach((column) => { column.width = 18; });
  return workbook.xlsx.writeBuffer();
}
