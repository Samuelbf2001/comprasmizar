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
  it("blocks decline/review/startReview/sendForApproval from MCP too, per RF-1205", () => {
    // RF-1205 excluye del MCP tanto aprobar como denegar (decline). decline/review/startReview/sendForApproval
    // comparten el permiso "requisition:review": si ese permiso no está bloqueado para origin=mcp, cualquier
    // API key con rol revisor podría declinar una requisición ajena vía MCP sin pasar por la interfaz autenticada.
    expect(hasPermission(["revisor"], "requisition:review", "mcp")).toBe(false);
    expect(hasPermission(["revisor"], "requisition:review", "web")).toBe(true);
    expect(() => assertPermission(["admin_sixteam"], "requisition:review", "mcp")).toThrow(DomainError);
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
  it("rounds fractional quantities (m3, metros, litros) to the nearest peso instead of rejecting them", () => {
    // RF-103: la UI y el esquema HTTP permiten cantidades fraccionarias hasta milésimas (step="0.001") y el
    // catálogo sembrado usa unidades fraccionables como 'm3'. 2.5 * 133333 = 333332.5 no es un peso exacto:
    // debe redondearse, no lanzar INVALID_MONEY. base e iva se redondean por separado y total = base + iva.
    const fractional = { id: "i3", quantity: 2.5, unit: "m3", unitBase: 133333, unitIva: 25333 };
    expect(() => calculateLineAmounts(fractional)).not.toThrow();
    expect(calculateLineAmounts(fractional)).toEqual({ base: 333333, iva: 63333, total: 396666 });
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
  it("takes the success path of a payment order (single group, one or zero suppliers)", () => {
    // Único camino feliz de groupOrderItems para type="pago": una OP de un solo proveedor.
    const grouped = groupOrderItems([{ ...line, finalSupplierId: "p1" }], false, "pago");
    expect([...grouped.entries()]).toEqual([["p1", [{ ...line, finalSupplierId: "p1" }]]]);
    // Sin proveedor final la agrupación aún debe producir un único grupo con clave undefined, no lanzar.
    const withoutSupplier = groupOrderItems([{ ...line, finalSupplierId: undefined }], false, "pago");
    expect([...withoutSupplier.keys()]).toEqual([undefined]);
  });
  it("returns period metrics", () => {
    const result = calculateDashboard([{ id: "e", workId: "w", origin: "requisicion", referenceId: "r", date: "2026-08-02", base: 10, iva: 2, total: 12, period: "2026-08" }], [{ id: "o", consecutive: "OC", type: "OC", requisitionId: "r", itemIds: [], status: "no_cumplida" }, { id: "o2", consecutive: "OC2", type: "OC", requisitionId: "r", itemIds: [], status: "generada" }], ["en_revision"], "2026-08");
    expect(result.periodExpense).toBe(12); expect(result.pendingOrders).toBe(2); expect(result.byStatus.en_revision).toBe(1);
  });
});
