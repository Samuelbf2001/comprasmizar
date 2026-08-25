import ExcelJS from "exceljs";
import type { ReportExpense } from "./types";

/** Provisional export V0.1: column mapping must be confirmed by Helisa/accounting before production use. */
export async function buildProvisionalHelisaXlsx(expenses: readonly ReportExpense[]) {
  const workbook = new ExcelJS.Workbook(); workbook.creator = "Plataforma Mizar";
  const sheet = workbook.addWorksheet("Gastos provisional"); sheet.addRow(["EXPORTACIÓN PROVISIONAL V0.1 - PENDIENTE VALIDACIÓN HELISA"]); sheet.mergeCells("A1:H1");
  sheet.addRow(["Fecha", "Obra", "Etiqueta", "Proveedor", "Origen", "Base COP", "IVA COP", "Total COP"]);
  for (const row of expenses) sheet.addRow([row.date, row.work, row.tag ?? "", row.supplier ?? "", row.origin, row.base, row.iva, row.total]);
  const total = expenses.reduce((sum, row) => sum + row.total, 0); sheet.addRow(["", "", "", "", "TOTAL", "", "", total]); sheet.getRow(2).font = { bold: true }; sheet.columns.forEach((column) => { column.width = 18; });
  return workbook.xlsx.writeBuffer();
}
