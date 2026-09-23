import { describe, expect, it } from "vitest";
import { distributeExpenses, groupExpenseByWork, prorate, requisitionCountsInTotal, type Expense } from "../../lib/domain";
import { filterOrderReportRows, requisitionPaymentStatuses, summarizeCommittedVsPaid, type OrderReportRow } from "../../lib/services/report-service";

/**
 * Hallazgos del ensayo en navegador contra backend real (2026-09-22), reglas de dominio:
 * 1. el total del Reporte operativo sumaba requisiciones devueltas/declinadas;
 * 3. "Repartir gasto entre obras" se guardaba pero ninguna lectura lo aplicaba.
 * Estas pruebas fallan contra 8da7ecf (las funciones no existían o `groupExpenseByWork` ignoraba el reparto).
 */

// Gasto real del ensayo: orden OC-2026-0008 por $267.750 (base 225.000 + IVA 42.750).
const gasto: Expense = {
  id: "g-oc8", workId: "torre-1", origin: "requisicion", referenceId: "oc-8", orderDate: "2026-09-20", date: "2026-09-22", period: "2026-09",
  base: 225_000, iva: 42_750, total: 267_750, costCenterId: "cc-1",
};
const repartido: Expense = { ...gasto, shares: [{ expenseId: "g-oc8", workId: "torre-1", amount: 150_000 }, { expenseId: "g-oc8", workId: "obra-2", amount: 117_750 }] };

describe("prorate — reparte en pesos enteros y cuadra al peso", () => {
  it("la suma de las partes es exactamente el valor, aunque la proporción no sea exacta", () => {
    const parts = prorate(225_000, [150_000, 117_750], 267_750);
    expect(parts).toEqual([126_050, 98_950]);
    expect(parts.reduce((sum, part) => sum + part, 0)).toBe(225_000);
    const thirds = prorate(100, [1, 1, 1], 3);
    expect(thirds).toEqual([33, 33, 34]);
  });
  it("con un total en cero no divide por cero", () => {
    expect(prorate(0, [0], 0)).toEqual([0]);
  });
});

describe("distributeExpenses — un gasto repartido cuenta en cada obra por su parte (RF-305)", () => {
  it("parte el gasto de OC-2026-0008 en $150.000 (Torre) + $117.750 (otra obra), sin duplicar el total", () => {
    const portions = distributeExpenses([repartido]);
    expect(portions.map((portion) => [portion.workId, portion.total])).toEqual([["torre-1", 150_000], ["obra-2", 117_750]]);
    expect(portions.reduce((sum, portion) => sum + portion.total, 0)).toBe(267_750);
    // base + IVA === total en cada porción, y Σ base / Σ IVA === los del gasto.
    for (const portion of portions) expect(portion.base + portion.iva).toBe(portion.total);
    expect(portions.reduce((sum, portion) => sum + portion.base, 0)).toBe(225_000);
    expect(portions.reduce((sum, portion) => sum + portion.iva, 0)).toBe(42_750);
    expect(portions[1].portionOf).toEqual({ expenseTotal: 267_750, index: 1, count: 2 });
    // Cada porción conserva el resto del gasto (id, fecha, centro) y no arrastra el reparto.
    expect(portions[1]).toMatchObject({ id: "g-oc8", date: "2026-09-22", costCenterId: "cc-1", shares: undefined });
  });
  it("un gasto sin reparto pasa tal cual", () => {
    expect(distributeExpenses([gasto])).toEqual([gasto]);
  });
  it("un reparto que no cuadra se ignora: el gasto se cuenta entero en su obra (ni se pierde ni se inventa plata)", () => {
    const roto: Expense = { ...gasto, shares: [{ expenseId: "g-oc8", workId: "obra-2", amount: 1_000 }] };
    expect(distributeExpenses([roto])).toEqual([roto]);
  });
  it("funciona con la fila del cliente, que no trae base/IVA", () => {
    const [a, b] = distributeExpenses([{ id: "g", workId: "torre-1", total: 267_750, shares: [{ workId: "torre-1", amount: 150_000 }, { workId: "obra-2", amount: 117_750 }] }]);
    expect(a).not.toHaveProperty("base");
    expect([a.total, b.total]).toEqual([150_000, 117_750]);
  });
});

describe("groupExpenseByWork — aplica el reparto (dashboard / modo pantalla)", () => {
  it("el gasto repartido aparece en las dos obras y el total general no cambia", () => {
    const byWork = groupExpenseByWork([repartido]);
    expect(byWork).toEqual([{ key: "torre-1", total: 150_000 }, { key: "obra-2", total: 117_750 }]);
    expect(byWork.reduce((sum, row) => sum + row.total, 0)).toBe(267_750);
  });
});

describe("requisitionCountsInTotal — qué estados suman en el Reporte operativo", () => {
  it("suman enviada, en revisión, en aprobación y aprobada; devuelta y declinada no", () => {
    expect(["enviada", "en_revision", "en_aprobacion", "aprobada"].every(requisitionCountsInTotal)).toBe(true);
    expect(requisitionCountsInTotal("devuelta")).toBe(false);
    expect(requisitionCountsInTotal("declinada")).toBe(false);
  });
});

describe("Comprometido vs pagado — cálculos compartidos por pantalla y Excel", () => {
  const row = (overrides: Partial<OrderReportRow>): OrderReportRow => ({
    id: "o", consecutive: "OC", type: "OC", requisitionId: "r1", period: "2026-09", workId: "w1", costCenterId: "cc-1", billedCompanyId: "s1",
    total: 100, paidAmount: 0, paymentStatus: "pendiente", paymentMethods: [], ...overrides,
  });
  const rows = [
    row({ id: "o1", requisitionId: "r1", paidAmount: 100, paymentStatus: "pagada", paymentMethods: ["transferencia"] }),
    row({ id: "o2", requisitionId: "r1", paidAmount: 0, paymentStatus: "pendiente" }),
    row({ id: "o3", requisitionId: "r2", paidAmount: 100, paymentStatus: "pagada", paymentMethods: ["efectivo"], period: "2026-08" }),
    row({ id: "o4", requisitionId: "r3", paidAmount: 0, paymentStatus: "pendiente", costCenterId: "cc-2" }),
  ];
  it("filterOrderReportRows aplica los filtros de la pantalla (vacío = sin filtro)", () => {
    expect(filterOrderReportRows(rows, {}).length).toBe(4);
    expect(filterOrderReportRows(rows, { period: "2026-09", costCenterId: "cc-1" }).map((r) => r.id)).toEqual(["o1", "o2"]);
    expect(filterOrderReportRows(rows, { paymentMethod: "efectivo" }).map((r) => r.id)).toEqual(["o3"]);
    expect(filterOrderReportRows(rows, { paymentStatus: "pendiente", workId: "w1", billedCompanyId: "s1" }).map((r) => r.id)).toEqual(["o2", "o4"]);
  });
  it("summarizeCommittedVsPaid: saldo = comprometido − pagado", () => {
    expect(summarizeCommittedVsPaid(rows)).toEqual({ orders: 4, committed: 400, paid: 200, balance: 200 });
  });
  it("requisitionPaymentStatuses combina los estados YA derivados de sus órdenes: mezcla = parcial", () => {
    const statuses = requisitionPaymentStatuses(rows);
    expect(statuses.get("r1")).toBe("parcial");
    expect(statuses.get("r2")).toBe("pagada");
    expect(statuses.get("r3")).toBe("pendiente");
    expect(statuses.has("sin-ordenes")).toBe(false);
  });
});
