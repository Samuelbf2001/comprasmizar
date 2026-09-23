import ExcelJS from "exceljs";
import type { ReportExpense } from "./types";
// Reutiliza las formas de datos de lib/services en vez de duplicarlas — el mismo problema que "el
// predicado a mano copiado trece veces" (ver postgres-repositories.ts), aplicado a un tipo en vez de a
// una consulta. De lib/services solo importa funciones PURAS de report-service.ts (ver abajo).
import type { CommittedVsPaidGroup, OrderReportRow, ReportCatalogNames, ReportRow } from "../services/report-service";
// Estos sí son de runtime, pero PUROS (sin I/O ni permisos): son exactamente los cálculos que usa la
// pantalla de Reportes, para que el Excel no tenga una copia propia de ninguna regla.
import { groupCommittedVsPaid, requisitionPaymentStatuses, summarizeCommittedVsPaid } from "../services/report-service";
import { REQUISITION_STATUSES_OUT_OF_TOTAL, requisitionCountsInTotal } from "../domain/rules";
import { MEDIO_PAGO_LABELS, PAYMENT_STATUS_LABELS } from "./payment-labels";

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
  const sheet = workbook.addWorksheet("Gastos provisional"); sheet.addRow(["Exportación provisional V0.1 - pendiente validación Helisa"]); sheet.mergeCells("A1:L1");
  // RF-707: empresa facturada, estado de pago y pagado (Σ pagos vigentes de la orden) al lado del total.
  sheet.addRow(["Fecha orden", "Fecha pago", "Obra", "Etiqueta", "Proveedor", "Empresa facturada", "Origen", "Estado de pago", "Base COP", "IVA COP", "Total COP", "Pagado COP"]);
  for (const row of expenses) sheet.addRow([row.orderDate, row.date ?? "", row.work, row.tag ?? "", row.supplier ?? "", row.billedCompany ?? "", row.origin, row.paymentStatus ?? "", row.base, row.iva, row.total, row.paid ?? ""]);
  const total = expenses.reduce((sum, row) => sum + row.total, 0), paid = expenses.reduce((sum, row) => sum + (row.paid ?? 0), 0);
  sheet.addRow(["", "", "", "", "", "", "", "TOTAL", "", "", total, paid]); sheet.getRow(2).font = { bold: true }; sheet.columns.forEach((column) => { column.width = 18; });
  return workbook.xlsx.writeBuffer();
}

const nameOf = (map: ReadonlyMap<string, string> | undefined, id: string | undefined): string => (id ? (map?.get(id) ?? "—") : "—");
/** "aprobador(es)"/"proveedor(es)" (RF-1301): varios ids resueltos y unidos, o "—" si no hay ninguno —
 *  el mismo criterio GRAVE 4 de nunca mostrar un id crudo (ver components/screens/connected/shared.tsx). */
const namesJoined = (map: ReadonlyMap<string, string>, ids: readonly string[]): string => (ids.length ? ids.map((id) => map.get(id) ?? "—").join(", ") : "—");

/**
 * RF-1301 (Reportes, reunión 2026-09-11): Excel del reporte de requisiciones — filtros por obra, periodo,
 * aprobador, etiqueta y centro de costo (lib/services/report-service.ts). Hoja 1 = una fila por
 * requisición con las columnas que pidió el cliente; hoja 2 = sus ítems. `grouped` (compilado mensual,
 * RF-1301 punto 3): cuando el filtro trae un mes, las filas se agrupan por CENTRO DE COSTO (con la obra
 * como columna propia dentro de cada fila) con un subtotal por centro — Daniel: "el compilado debe ir
 * por obra/centro de costo", y desde que el centro de costo es una entidad propia (2026-09-12, ver
 * `resolveCostCenter` en lib/domain/rules.ts) es el eje correcto para agrupar: varias obras pueden
 * compartir un mismo centro. Sin `grouped`, filas planas + un total general (un export ad-hoc sin mes no
 * tiene un "periodo" que compilar).
 */
export interface RequisitionReportXlsxOptions {
  grouped?: boolean;
  /**
   * RF-707 (hallazgo del ensayo 2026-09-22: el Excel no traía lo que sí muestra la pantalla). `all` =
   * todas las órdenes comprometidas visibles (de ahí sale el "Estado de pago" de cada requisición, igual
   * que en pantalla); `filtered` = las que pasan los filtros del bloque (`filterOrderReportRows`), de
   * donde sale la hoja "Comprometido vs pagado". Ausente = sin columna ni hoja (llamadores viejos).
   */
  orders?: { all: readonly OrderReportRow[]; filtered: readonly OrderReportRow[] };
}
/** Suma de base/IVA/total solo de las filas que cuentan (`requisitionCountsInTotal`). */
function sumCounted(rows: readonly ReportRow[]): { base: number; iva: number; total: number } {
  return rows.reduce((sum, row) => (requisitionCountsInTotal(row.status) ? { base: sum.base + row.base, iva: sum.iva + row.iva, total: sum.total + row.total } : sum), { base: 0, iva: 0, total: 0 });
}
export async function buildRequisitionReportXlsx(rows: readonly ReportRow[], names: ReportCatalogNames, options: RequisitionReportXlsxOptions = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Plataforma Mizar";
  const summary = workbook.addWorksheet("Reporte");
  const paymentByRequisition = options.orders ? requisitionPaymentStatuses(options.orders.all) : undefined;
  const paymentLabel = (id: string) => { const status = paymentByRequisition?.get(id); return status ? PAYMENT_STATUS_LABELS[status] : "Sin orden"; };
  // RF-707: "Empresa facturada" (a quién viene el soporte) junto al centro de costo; "Empresa" sigue
  // siendo la sociedad de la requisición. "Estado de pago" (de sus órdenes) y "Suma al total" (devueltas
  // y declinadas no suman, ver `requisitionCountsInTotal`) — mismas cifras que la pantalla.
  const headers = ["Consecutivo", "Fecha", "Empresa", "Obra", "Centro de costo", "Empresa facturada", "Etiqueta", "Aprobador(es)", "Estado", ...(paymentByRequisition ? ["Estado de pago"] : []), "Suma al total", "Proveedor(es)", "Base COP", "IVA COP", "Total COP"];
  // Columnas de texto antes de Base/IVA/Total: los subtotales y el total general se alinean con ellas.
  const leading = headers.length - 3;
  const amountsRow = (label: string, labelIndex: number, amounts: { base: number; iva: number; total: number }) => {
    const cells: Array<string | number> = Array.from({ length: leading }, () => "");
    cells[labelIndex] = label;
    return summary.addRow([...cells, amounts.base, amounts.iva, amounts.total]);
  };
  summary.addRow(headers);
  summary.getRow(1).font = { bold: true };
  const writeRow = (row: ReportRow) =>
    summary.addRow([
      row.consecutive, row.date ? row.date.slice(0, 10) : "", nameOf(names.societies, row.societyId), nameOf(names.works, row.workId),
      nameOf(names.costCenters, row.costCenterId), nameOf(names.societies, row.billedCompanyId), nameOf(names.tags, row.tagId), namesJoined(names.users, row.approverIds), row.status,
      ...(paymentByRequisition ? [paymentLabel(row.id)] : []), requisitionCountsInTotal(row.status) ? "Sí" : "No",
      namesJoined(names.suppliers, row.supplierIds), row.base, row.iva, row.total,
    ]);
  // Hallazgo del ensayo 2026-09-22: totales y subtotales con la MISMA regla que la pantalla — las
  // devueltas y declinadas se listan pero no suman (antes el TOTAL GENERAL las sumaba).
  const grandTotal = sumCounted(rows);
  if (options.grouped) {
    // Agrupado por CENTRO DE COSTO (2026-09-12: ya es una entidad propia, no "centro ≈ obra" como
    // antes de esa fecha) — la obra queda como columna propia dentro de cada fila (arriba), así que su
    // desglose sigue siendo legible sin necesitar un subnivel aparte. Sin nombre resuelto va al final
    // ("—" ordena después de cualquier nombre real en es-CO).
    const byCostCenter = new Map<string, ReportRow[]>();
    for (const row of rows) { const key = row.costCenterId ?? ""; (byCostCenter.get(key) ?? byCostCenter.set(key, []).get(key)!).push(row); }
    const groups = [...byCostCenter.entries()].sort((a, b) => nameOf(names.costCenters, a[0]).localeCompare(nameOf(names.costCenters, b[0]), "es"));
    for (const [costCenterId, groupRows] of groups) {
      for (const row of groupRows) writeRow(row);
      amountsRow(`Subtotal ${nameOf(names.costCenters, costCenterId)}`, 4, sumCounted(groupRows)).font = { bold: true };
    }
  } else {
    for (const row of rows) writeRow(row);
  }
  amountsRow("TOTAL GENERAL", leading - 1, grandTotal).font = { bold: true };
  const excluded = rows.filter((row) => !requisitionCountsInTotal(row.status));
  if (excluded.length) {
    const excludedTotals = excluded.reduce((sum, row) => ({ base: sum.base + row.base, iva: sum.iva + row.iva, total: sum.total + row.total }), { base: 0, iva: 0, total: 0 });
    amountsRow(`No suman al total (${REQUISITION_STATUSES_OUT_OF_TOTAL.join(" y ")}): ${excluded.length}`, leading - 1, excludedTotals).font = { italic: true };
  }
  summary.columns.forEach((column) => { column.width = 20; });

  if (options.orders) {
    // RF-707: el mismo bloque "Comprometido vs pagado" de la pantalla, con los mismos cálculos
    // (lib/services/report-service.ts) sobre las mismas órdenes filtradas.
    const orders = options.orders.filtered;
    const sheet = workbook.addWorksheet("Comprometido vs pagado");
    const totals = summarizeCommittedVsPaid(orders);
    sheet.addRow(["Comprometido vs pagado"]).font = { bold: true };
    sheet.addRow(["Órdenes generadas (lo comprometido) frente a sus pagos vigentes; los pagos anulados no cuentan."]);
    sheet.addRow([]);
    sheet.addRow(["Comprometido COP", totals.committed]);
    sheet.addRow(["Pagado COP", totals.paid]);
    sheet.addRow(["Saldo por pagar COP", totals.balance]);
    sheet.addRow(["Órdenes", totals.orders]);
    const groupTable = (title: string, groups: CommittedVsPaidGroup[], labelOf: (key: string) => string) => {
      sheet.addRow([]);
      sheet.addRow([title, "Órdenes", "Comprometido COP", "Pagado COP", "Saldo COP"]).font = { bold: true };
      for (const group of groups) sheet.addRow([labelOf(group.key), group.orders, group.committed, group.paid, group.committed - group.paid]);
    };
    const costCenterLabel = (key: string) => (key ? nameOf(names.costCenters, key) : "Sin centro de costo");
    groupTable("Centro de costo", groupCommittedVsPaid(orders, (row) => row.costCenterId).sort((a, b) => costCenterLabel(a.key).localeCompare(costCenterLabel(b.key), "es")), costCenterLabel);
    groupTable("Periodo (mes de la orden)", groupCommittedVsPaid(orders, (row) => row.period).sort((a, b) => b.key.localeCompare(a.key)), (key) => key || "Sin fecha");
    sheet.addRow([]);
    sheet.addRow(["Orden", "Requisición", "Fecha orden", "Centro de costo", "Empresa facturada", "Proveedor", "Medio(s) de pago", "Estado de pago", "Comprometido COP", "Pagado COP", "Saldo COP"]).font = { bold: true };
    for (const order of orders) {
      sheet.addRow([
        order.consecutive, order.requisitionConsecutive ?? "—", order.generatedAt ? order.generatedAt.slice(0, 10) : "", costCenterLabel(order.costCenterId ?? ""),
        nameOf(names.societies, order.billedCompanyId), nameOf(names.suppliers, order.supplierId),
        order.paymentMethods.length ? order.paymentMethods.map((method) => MEDIO_PAGO_LABELS[method] ?? method).join(", ") : "—",
        PAYMENT_STATUS_LABELS[order.paymentStatus] ?? order.paymentStatus, order.total, order.paidAmount, order.total - order.paidAmount,
      ]);
    }
    sheet.columns.forEach((column) => { column.width = 20; });
  }

  const itemsSheet = workbook.addWorksheet("Ítems");
  itemsSheet.addRow(["Consecutivo", "Descripción", "Cantidad", "Unidad", "Estado", "Base COP", "IVA COP", "Total COP"]);
  itemsSheet.getRow(1).font = { bold: true };
  for (const row of rows) for (const item of row.items) itemsSheet.addRow([row.consecutive, item.description, item.quantity, item.unit, item.status, item.base, item.iva, item.total]);
  itemsSheet.columns.forEach((column) => { column.width = 20; });

  return workbook.xlsx.writeBuffer();
}
