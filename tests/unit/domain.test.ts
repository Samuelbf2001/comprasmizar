import { describe, expect, it } from "vitest";
import { DomainError, assertPermission, assertTransition, calculateDashboard, calculateLineAmounts, calculateLineTotal, calculateTax, canTransition, groupOrderItems, hasPermission, nextConsecutive, normalizeItemName, orderTypeFor, sumLines, validateShares } from "../../lib/domain";

const line = { id: "i1", quantity: 2, unit: "und", unitBase: 100, unitIva: 19, unitTotal: 119 };
describe("domain permissions", () => {
  it("is deny-by-default and makes MCP approval impossible", () => {
    expect(hasPermission([], "requisition:create")).toBe(false);
    expect(hasPermission(["solicitante"], "requisition:create")).toBe(true);
    expect(hasPermission(["admin_sixteam"], "requisition:approve", "mcp")).toBe(false);
    expect(() => assertPermission(["contabilidad"], "requisition:review")).toThrow(DomainError);
  });
});
describe("domain workflow", () => {
  it("enforces the finite state machine and comments", () => {
    expect(canTransition("enviada", "en_revision")).toBe(true); expect(canTransition("aprobada", "en_revision")).toBe(false);
    expect(() => assertTransition("en_revision", "declinada")).toThrow("comentario");
    expect(() => assertTransition("aprobada", "en_revision")).toThrow("No se puede");
    expect(() => assertTransition("en_aprobacion", "devuelta", "motivo")).not.toThrow();
  });
});
describe("domain calculations", () => {
  it("formats consecutive numbers and rejects invalid counters", () => {
    expect(nextConsecutive("REQ", 2026, 7)).toEqual({ value: "REQ-2026-0007", next: 8 });
    expect(() => nextConsecutive("OC", 2026, 0)).toThrow("iniciar");
  });
  it("normalizes proposed catalogue names deterministically", () => { expect(normalizeItemName("  Tubería   PVC 4” ")).toBe("tuberia pvc 4"); });
  it("calculates integer COP tax and validates inputs", () => {
    expect(calculateTax(105, .19)).toEqual({ base: 105, iva: 20, total: 125 });
    expect(() => calculateTax(1.2, .19)).toThrow("inválidos"); expect(() => calculateTax(1, -1)).toThrow();
  });
  it("sums lines and rejects invalid quantities", () => {
    expect(calculateLineAmounts(line)).toEqual({ base: 200, iva: 38, total: 238 }); expect(calculateLineTotal({ ...line, unitTotal: undefined })).toBe(238);
    expect(sumLines([line, { ...line, id: "i2" }])).toBe(476); expect(() => calculateLineTotal({ ...line, quantity: 0 })).toThrow("cantidad"); expect(() => calculateLineTotal({ ...line, unitTotal: 1.5 })).toThrow("no cuadra");
  });
  it("requires manual shares to balance exactly", () => {
    expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 40 }, { expenseId: "e", workId: "b", amount: 60 }])).not.toThrow();
    expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 99 }])).toThrow("cuadrar");
    expect(() => validateShares(-1, [])).toThrow("inválido"); expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 50 }, { expenseId: "other", workId: "a", amount: 50 }])).toThrow("únicas");
  });
  it("groups orders by supplier when requested", () => {
    expect(orderTypeFor("compra")).toBe("OC"); expect(orderTypeFor("pago")).toBe("OP");
    expect([...groupOrderItems([{ ...line, finalSupplierId: "a" }, { ...line, id: "i2", finalSupplierId: "b" }], true, "compra").keys()]).toEqual(["a", "b"]);
    expect([...groupOrderItems([{ ...line, finalSupplierId: "a" }], false, "compra").keys()]).toEqual(["a"]); expect(() => groupOrderItems([{ ...line, finalSupplierId: undefined }], true, "compra")).toThrow("proveedor"); expect(() => groupOrderItems([{ ...line, finalSupplierId: "a" }, { ...line, id: "i2", finalSupplierId: "b" }], false, "compra")).toThrow("Completo"); expect(() => groupOrderItems([{ ...line, finalSupplierId: "a" }, { ...line, id: "i2", finalSupplierId: "b" }], true, "pago")).toThrow("pago");
  });
  it("returns period metrics", () => {
    const result = calculateDashboard([{ id: "e", workId: "w", origin: "requisicion", referenceId: "r", date: "2026-08-02", base: 10, iva: 2, total: 12, period: "2026-08" }], [{ id: "o", consecutive: "OC", type: "OC", requisitionId: "r", itemIds: [], status: "no_cumplida" }, { id: "o2", consecutive: "OC2", type: "OC", requisitionId: "r", itemIds: [], status: "generada" }], ["en_revision"], "2026-08");
    expect(result.periodExpense).toBe(12); expect(result.pendingOrders).toBe(2); expect(result.byStatus.en_revision).toBe(1);
  });
});
