import ExcelJS from "exceljs";
import type { ReportExpense } from "./types";
// Import de solo TIPOS (se borra en compilación, cero acoplamiento en runtime): lib/reports no depende
// de lib/services para nada ejecutable, solo reutiliza sus formas de datos en vez de duplicarlas — el
// mismo problema que "el predicado a mano copiado trece veces" (ver postgres-repositories.ts), aplicado
// a un tipo en vez de a una consulta.
import type { ReportCatalogNames, ReportRow } from "../services/report-service";

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

const nameOf = (map: ReadonlyMap<string, string> | undefined, id: string | undefined): string => (id ? (map?.get(id) ?? "—") : "—");
/** "aprobador(es)"/"proveedor(es)" (RF-1301): varios ids resueltos y unidos, o "—" si no hay ninguno —
 *  el mismo criterio GRAVE 4 de nunca mostrar un id crudo (ver components/screens/connected/shared.tsx). */
const namesJoined = (map: ReadonlyMap<string, string>, ids: readonly string[]): string => (ids.length ? ids.map((id) => map.get(id) ?? "—").join(", ") : "—");

/**
 * RF-1301 (Reportes, reunión 2026-09-11): Excel del reporte de requisiciones — filtros por obra, periodo,
 * aprobador y etiqueta (lib/services/report-service.ts). Hoja 1 = una fila por requisición con las
 * columnas que pidió el cliente; hoja 2 = sus ítems. `grouped` (compilado mensual, RF-1301 punto 3):
 * cuando el filtro trae un mes, las filas se agrupan por obra/centro de costo con un subtotal por obra —
 * Daniel: "el compilado debe ir por obra/centro de costo". Sin `grouped`, filas planas + un total general
 * (un export ad-hoc sin mes no tiene un "periodo" que compilar).
 */
export async function buildRequisitionReportXlsx(rows: readonly ReportRow[], names: ReportCatalogNames, options: { grouped?: boolean } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Plataforma Mizar";
  const summary = workbook.addWorksheet("Reporte");
  const headers = ["Consecutivo", "Fecha", "Empresa", "Obra", "Etiqueta", "Aprobador(es)", "Estado", "Proveedor(es)", "Base COP", "IVA COP", "Total COP"];
  summary.addRow(headers);
  summary.getRow(1).font = { bold: true };
  const writeRow = (row: ReportRow) =>
    summary.addRow([
      row.consecutive, row.date ? row.date.slice(0, 10) : "", nameOf(names.societies, row.societyId), nameOf(names.works, row.workId),
      nameOf(names.tags, row.tagId), namesJoined(names.users, row.approverIds), row.status, namesJoined(names.suppliers, row.supplierIds),
      row.base, row.iva, row.total,
    ]);
  const grandTotal = { base: 0, iva: 0, total: 0 };
  for (const row of rows) { grandTotal.base += row.base; grandTotal.iva += row.iva; grandTotal.total += row.total; }
  if (options.grouped) {
    // Agrupado por obra (centro de costo ≈ obra, ver ReportFilters en report-service.ts), obras sin
    // nombre resuelto van al final ("—" ordena después de cualquier nombre real en es-CO).
    const byWork = new Map<string, ReportRow[]>();
    for (const row of rows) { const key = row.workId ?? ""; (byWork.get(key) ?? byWork.set(key, []).get(key)!).push(row); }
    const groups = [...byWork.entries()].sort((a, b) => nameOf(names.works, a[0]).localeCompare(nameOf(names.works, b[0]), "es"));
    for (const [workId, groupRows] of groups) {
      for (const row of groupRows) writeRow(row);
      const subtotal = groupRows.reduce((sum, row) => ({ base: sum.base + row.base, iva: sum.iva + row.iva, total: sum.total + row.total }), { base: 0, iva: 0, total: 0 });
      const subtotalRow = summary.addRow(["", "", "", `Subtotal ${nameOf(names.works, workId)}`, "", "", "", "", subtotal.base, subtotal.iva, subtotal.total]);
      subtotalRow.font = { bold: true };
    }
  } else {
    for (const row of rows) writeRow(row);
  }
  const totalRow = summary.addRow(["", "", "", "", "", "", "", "TOTAL GENERAL", grandTotal.base, grandTotal.iva, grandTotal.total]);
  totalRow.font = { bold: true };
  summary.columns.forEach((column) => { column.width = 20; });

  const itemsSheet = workbook.addWorksheet("Ítems");
  itemsSheet.addRow(["Consecutivo", "Descripción", "Cantidad", "Unidad", "Estado", "Base COP", "IVA COP", "Total COP"]);
  itemsSheet.getRow(1).font = { bold: true };
  for (const row of rows) for (const item of row.items) itemsSheet.addRow([row.consecutive, item.description, item.quantity, item.unit, item.status, item.base, item.iva, item.total]);
  itemsSheet.columns.forEach((column) => { column.width = 20; });

  return workbook.xlsx.writeBuffer();
}
