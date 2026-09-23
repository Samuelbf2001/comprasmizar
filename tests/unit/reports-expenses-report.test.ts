import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { Expense, Order } from "../../lib/domain";
import type { ServiceDependencies } from "../../lib/services";
import { buildExpensesReport, expensesReportFiltersSchema, type WorkSocietyIndex } from "../../app/api/reports/expenses-report";

/**
 * RF-707 (adenda de pagos) + N4 (obra opcional): el Excel de gastos cruza cada gasto con su orden
 * (pagado, estado de pago) e imprime la empresa facturada; un gasto SIN obra (`workId` vacío) no se
 * pierde ni al filtrar por sociedad ni al imprimir la obra.
 */
const workA = "11111111-1111-4111-8111-111111111111", societyA = "55555555-5555-4555-8555-555555555555", societyB = "66666666-6666-4666-8666-666666666666";
const accountant = { id: "contadora", roles: ["contabilidad"] as const };
const orders: Order[] = [
  { id: "ord-1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", itemIds: ["a"], status: "generada", adminStatus: "pendiente", lines: [{ id: "a", quantity: 1, unit: "und", unitBase: 100, unitIva: 19, status: "aprobado" }], paidAmount: 50, paymentStatus: "parcial", paymentMethods: ["efectivo"] },
  { id: "ord-2", consecutive: "OP-2026-0002", type: "OP", requisitionId: "req-2", itemIds: ["b"], status: "generada", adminStatus: "pendiente", lines: [{ id: "b", quantity: 1, unit: "und", unitBase: 200, unitIva: 0, status: "aprobado" }], paidAmount: 200, paymentStatus: "pagada", paymentMethods: ["transferencia"] },
];
const expenseWithWork: Expense = { id: "e1", workId: workA, origin: "requisicion", referenceId: "ord-1", tagId: "t1", supplierId: "s1", orderDate: "2026-08-05", date: "2026-08-05", base: 100, iva: 19, total: 119, period: "2026-08", billedCompanyId: societyA };
// N4: un gasto de un centro de costo administrativo llega con obra VACÍA (no undefined) y su empresa facturada.
const expenseWithoutWork: Expense = { id: "e2", workId: "", origin: "requisicion", referenceId: "ord-2", orderDate: "2026-08-06", date: "2026-08-06", base: 200, iva: 0, total: 200, period: "2026-08", billedCompanyId: societyA };
const expenseOtherSociety: Expense = { id: "e3", workId: "", origin: "requisicion", referenceId: "ord-x", orderDate: "2026-08-07", base: 30, iva: 0, total: 30, billedCompanyId: societyB };
const cajaMenor: Expense = { id: "e4", workId: workA, origin: "caja_menor", referenceId: "p1", orderDate: "2026-08-08", date: "2026-08-08", base: 40, iva: 0, total: 40, period: "2026-08" };

function deps(expenses: Expense[]): ServiceDependencies {
  return { expenses: { listVisibleTo: async () => expenses }, orders: { listVisibleTo: async () => ({ rows: orders, nextCursor: null }) } } as unknown as ServiceDependencies;
}
const societyIndex: WorkSocietyIndex = { workIdsForSociety: async (societyId) => (societyId === societyA ? [workA] : []) };

async function sheetOf(bytes: Uint8Array) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook.getWorksheet("Gastos provisional")!;
}

describe("buildExpensesReport — RF-707 y gasto sin obra (N4)", () => {
  it("un gasto sin obra aparece en el reporte y en el Excel: '—' en Obra, su empresa facturada, y lo pagado de su orden", async () => {
    const file = await buildExpensesReport(deps([expenseWithWork, expenseWithoutWork, cajaMenor]), accountant, expensesReportFiltersSchema.parse({}));
    expect(file.rows).toBe(3);
    const sheet = await sheetOf(file.bytes);
    expect(sheet.getRow(2).values).toEqual(expect.arrayContaining(["Obra", "Empresa facturada", "Estado de pago", "Total COP", "Pagado COP"]));
    expect(sheet.getRow(3).values).toEqual(expect.arrayContaining([workA, societyA, "parcial", 119, 50]));
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining(["—", societyA, "pagada", 200, 200]));
    // Caja menor histórica: nació pagada en el acto.
    expect(sheet.getRow(5).values).toEqual(expect.arrayContaining(["caja_menor", "pagada", 40, 40]));
    expect(sheet.getRow(6).values).toEqual(expect.arrayContaining(["TOTAL", 359, 290]));
  });

  it("el filtro por sociedad conserva el gasto sin obra por su empresa facturada y descarta el de otra sociedad", async () => {
    const file = await buildExpensesReport(deps([expenseWithWork, expenseWithoutWork, expenseOtherSociety]), accountant, expensesReportFiltersSchema.parse({ societyId: societyA }), { societyIndex });
    expect(file.rows).toBe(2);
    const sheet = await sheetOf(file.bytes);
    const works = [sheet.getRow(3).values, sheet.getRow(4).values].map((values) => (values as unknown[])[3]);
    expect(works).toEqual([workA, "—"]);
  });
});

// Hallazgo del ensayo 2026-09-22 (RF-305): el reporte de gastos (Excel/PDF de socios) seguía mostrando el
// 100 % del gasto en la obra original después de repartirlo. Falla contra 8da7ecf.
describe("buildExpensesReport — un gasto repartido entre obras sale por obra, sin duplicar", () => {
  const workB = "22222222-2222-4222-8222-222222222222";
  // $119 (base 100 + IVA 19) de ord-1, con 50 pagados, repartido 70 obra A + 49 obra B.
  const repartido: Expense = { ...expenseWithWork, shares: [{ expenseId: "e1", workId: workA, amount: 70 }, { expenseId: "e1", workId: workB, amount: 49 }] };

  it("una fila por obra del reparto, con base/IVA/pagado prorrateados y los totales del gasto intactos", async () => {
    const file = await buildExpensesReport(deps([repartido]), accountant, expensesReportFiltersSchema.parse({}));
    expect(file.rows).toBe(2);
    const sheet = await sheetOf(file.bytes);
    expect(sheet.getRow(3).values).toEqual(expect.arrayContaining([workA, "parcial", 59, 11, 70, 29]));
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining([workB, "parcial", 41, 8, 49, 21]));
    expect(sheet.getRow(5).values).toEqual(expect.arrayContaining(["TOTAL", 119, 50]));
  });

  it("filtrar por la otra obra trae solo su parte (antes no traía nada)", async () => {
    const file = await buildExpensesReport(deps([repartido]), accountant, expensesReportFiltersSchema.parse({ workId: workB }));
    expect(file.rows).toBe(1);
    const sheet = await sheetOf(file.bytes);
    expect(sheet.getRow(3).values).toEqual(expect.arrayContaining([workB, 49, 21]));
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining(["TOTAL", 49, 21]));
  });
});
