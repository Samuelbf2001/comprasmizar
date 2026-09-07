import { describe, expect, it } from "vitest";
import { DomainError, approvedLines, assertAdminTransition, assertHasApprovedLine, assertPermission, assertTransition, buildAttentionQueue, buildRecentActivity, calculateDashboard, calculateLineAmounts, calculateLineTotal, calculateTax, canGenerateOrders, canTransition, groupExpenseByPeriod, groupExpenseByTag, groupExpenseByWork, groupOrderItems, hasPermission, nextConsecutive, normalizeItemName, orderTypeFor, sumApprovedLines, sumLines, validateShares, type Order, type Requisition } from "../../lib/domain";

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
    // Sin ivaRate/discountRate (línea legacy): usa el mecanismo histórico (cantidad × unitIva).
    const fractional = { id: "i3", quantity: 2.5, unit: "m3", unitBase: 133333, unitIva: 25333 };
    expect(() => calculateLineAmounts(fractional)).not.toThrow();
    expect(calculateLineAmounts(fractional)).toEqual({ base: 333333, iva: 63333, total: 396666 });
  });
  it("reunión 2026-08-31: aplica bruto→descuento→base→IVA→total con ivaRate/discountRate explícitos, redondeando por línea y con cantidad fraccionaria", () => {
    // bruto = round(2.5×133333) = 333333; descuento = round(333333×0.10) = 33333; base = 300000;
    // iva = round(300000×0.19) = 57000; total = 357000. Cobertura obligatoria ítem 8 del encargo.
    const withRates = { id: "d1", quantity: 2.5, unit: "m3", unitBase: 133333, ivaRate: 0.19, discountRate: 0.1 };
    expect(calculateLineAmounts(withRates)).toEqual({ base: 300000, iva: 57000, total: 357000 });
    // ivaRate: 0 explícito (ítem exento, estilo nuevo) sí usa la vía de tasa y da iva 0 deliberadamente,
    // a diferencia de ivaRate ausente (ver la prueba de arriba, que preserva el mecanismo legacy).
    expect(calculateLineAmounts({ id: "d2", quantity: 1, unit: "und", unitBase: 1000, ivaRate: 0 })).toEqual({ base: 1000, iva: 0, total: 1000 });
  });
  it("requires manual shares to balance exactly", () => {
    expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 40 }, { expenseId: "e", workId: "b", amount: 60 }])).not.toThrow();
    expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 99 }])).toThrow("cuadrar");
    expect(() => validateShares(-1, [])).toThrow("inválido"); expect(() => validateShares(100, [{ expenseId: "e", workId: "a", amount: 50 }, { expenseId: "other", workId: "a", amount: 50 }])).toThrow("únicas");
  });
  it("groups orders by supplier — groupOrderItems perdió el parámetro multiSupplier: siempre agrupa por proveedor y lo exige en toda línea", () => {
    expect(orderTypeFor("compra")).toBe("OC"); expect(orderTypeFor("pago")).toBe("OP");
    expect([...groupOrderItems([{ ...line, finalSupplierId: "a" }, { ...line, id: "i2", finalSupplierId: "b" }], "compra").keys()]).toEqual(["a", "b"]);
    expect(() => groupOrderItems([{ ...line, finalSupplierId: undefined }], "compra")).toThrow("proveedor");
    expect(() => groupOrderItems([{ ...line, finalSupplierId: "a" }, { ...line, id: "i2", finalSupplierId: "b" }], "pago")).toThrow("pago");
  });
  it("takes the success path of a payment order (single group, one proveedor) and rejects a payment order without supplier", () => {
    // Único camino feliz de groupOrderItems para type="pago": una OP de un solo proveedor.
    const grouped = groupOrderItems([{ ...line, finalSupplierId: "p1" }], "pago");
    expect([...grouped.entries()]).toEqual([["p1", [{ ...line, finalSupplierId: "p1" }]]]);
    // Reunión 2026-08-31: el proveedor ahora es obligatorio en TODA línea, también en "pago" (antes una
    // orden de pago sin proveedor pasaba silenciosamente con clave `undefined`; ya no).
    expect(() => groupOrderItems([{ ...line, finalSupplierId: undefined }], "pago")).toThrow("proveedor");
  });
  it("returns period metrics", () => {
    const result = calculateDashboard([{ id: "e", workId: "w", origin: "requisicion", referenceId: "r", orderDate: "2026-08-02", date: "2026-08-02", base: 10, iva: 2, total: 12, period: "2026-08" }], [{ id: "o", consecutive: "OC", type: "OC", requisitionId: "r", itemIds: [], status: "no_cumplida", adminStatus: "pendiente" }, { id: "o2", consecutive: "OC2", type: "OC", requisitionId: "r", itemIds: [], status: "generada", adminStatus: "pendiente" }], ["en_revision"], "2026-08");
    expect(result.periodExpense).toBe(12); expect(result.pendingOrders).toBe(2); expect(result.byStatus.en_revision).toBe(1);
  });
  // Reunión 2026-09: "la fecha del gasto es la del pago" — inProcessValue ya no queda fijo en 0: suma
  // los gastos sin fecha de pago (compromiso de órdenes generadas y aún sin pagar).
  it("calculateDashboard.inProcessValue suma los gastos sin fecha de pago (comprometido sin pagar)", () => {
    const paid = { id: "e1", workId: "w", origin: "requisicion" as const, referenceId: "o1", orderDate: "2026-08-01", date: "2026-08-05", base: 100, iva: 0, total: 100, period: "2026-08" };
    const unpaid1 = { id: "e2", workId: "w", origin: "requisicion" as const, referenceId: "o2", orderDate: "2026-08-02", base: 40, iva: 0, total: 40 };
    const unpaid2 = { id: "e3", workId: "w", origin: "requisicion" as const, referenceId: "o3", orderDate: "2026-08-03", base: 15, iva: 0, total: 15 };
    const result = calculateDashboard([paid, unpaid1, unpaid2], [], [], "2026-08");
    expect(result.inProcessValue).toBe(55);
    expect(result.periodExpense).toBe(100); // solo lo pagado entra al gasto del periodo
  });
});
describe("reunión 2026-08-31: aprobación parcial por ítem y eje administrativo de la orden", () => {
  const approved = { ...line, status: "aprobado" as const }, declined = { ...line, id: "i2", status: "declinado" as const, declineReason: "no aplica" }, pending = { ...line, id: "i3" };
  it("approvedLines conserva pendiente y aprobado como vigentes; solo excluye declinado", () => {
    expect(approvedLines([approved, declined, pending]).map((l) => l.id)).toEqual(["i1", "i3"]);
  });
  it("sumApprovedLines difiere de sumLines cuando hay una línea declinada; sumLines conserva su semántica de sumar todo", () => {
    expect(sumApprovedLines([approved, declined])).toBe(sumLines([approved]));
    expect(sumApprovedLines([approved, declined])).not.toBe(sumLines([approved, declined]));
  });
  it("assertHasApprovedLine exige al menos una línea vigente", () => {
    expect(() => assertHasApprovedLine([declined])).toThrow(DomainError);
    expect(() => assertHasApprovedLine([approved])).not.toThrow();
  });
  it("canGenerateOrders solo habilita el botón con status aprobada, sin órdenes previas y con algo vigente que ordenar", () => {
    expect(canGenerateOrders("aprobada", 0, [approved])).toBe(true);
    expect(canGenerateOrders("aprobada", 1, [approved])).toBe(false);
    expect(canGenerateOrders("en_aprobacion", 0, [approved])).toBe(false);
    expect(canGenerateOrders("aprobada", 0, [declined])).toBe(false);
  });
  it("assertAdminTransition exige pendiente→contabilizada→pagada sin saltos ni reversas, y bloquea no_necesario", () => {
    expect(() => assertAdminTransition("pendiente", "contabilizada", "generada")).not.toThrow();
    expect(() => assertAdminTransition("pendiente", "pagada", "generada")).toThrow(DomainError);
    expect(() => assertAdminTransition("contabilizada", "pendiente", "generada")).toThrow(DomainError);
    expect(() => assertAdminTransition("contabilizada", "pagada", "generada")).not.toThrow();
    expect(() => assertAdminTransition("pendiente", "contabilizada", "no_necesario")).toThrow(DomainError);
    expect(() => assertAdminTransition("contabilizada", "pagada", "no_necesario")).toThrow(DomainError);
  });
});
describe("RF-1102 dashboard queue and recent activity", () => {
  const req = (overrides: Partial<Requisition>): Requisition => ({ id: "r1", consecutive: "REQ-2026-0001", type: "compra", societyId: "soc-a", workId: "work-a", channel: "web", requiredDate: "2026-08-30", status: "enviada", items: [], ...overrides });
  const ord = (overrides: Partial<Order>): Order => ({ id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "r1", itemIds: [], status: "generada", adminStatus: "pendiente", ...overrides });
  it("gives a revisor only requisitions awaiting review plus orders awaiting fulfillment confirmation, sorted by consecutive desc", () => {
    const requisitions = [req({ id: "r1", consecutive: "REQ-2026-0001", status: "aprobada" }), req({ id: "r2", consecutive: "REQ-2026-0002", status: "enviada" }), req({ id: "r3", consecutive: "REQ-2026-0003", status: "en_revision" })];
    const orders = [ord({ id: "o1", consecutive: "OC-2026-0001", status: "generada" }), ord({ id: "o2", consecutive: "OC-2026-0002", status: "cumplida" })];
    const queue = buildAttentionQueue(requisitions, orders, { id: "daniel", roles: ["revisor"] });
    expect(queue.map((item) => item.id)).toEqual(["r3", "r2", "o1"]);
    expect(queue.every((item) => item.action === (item.kind === "orden" ? "Confirmar cumplimiento" : "Revisar"))).toBe(true);
  });
  it("gives an approver only requisitions in en_aprobacion assigned to them, never someone else's", () => {
    const requisitions = [req({ id: "r1", consecutive: "REQ-2026-0001", status: "en_aprobacion", approverId: "nelson" }), req({ id: "r2", consecutive: "REQ-2026-0002", status: "en_aprobacion", approverId: "other" })];
    const queue = buildAttentionQueue(requisitions, [], { id: "nelson", roles: ["aprobador"] });
    expect(queue).toEqual([{ kind: "requisicion", id: "r1", consecutive: "REQ-2026-0001", workId: "work-a", status: "en_aprobacion", action: "Aprobar" }]);
  });
  it("gives a solicitante only their own returned requisitions, needing correction", () => {
    const requisitions = [req({ id: "r1", consecutive: "REQ-2026-0001", status: "devuelta", requesterId: "sol" }), req({ id: "r2", consecutive: "REQ-2026-0002", status: "devuelta", requesterId: "other" })];
    const queue = buildAttentionQueue(requisitions, [], { id: "sol", roles: ["solicitante"] });
    expect(queue).toEqual([{ kind: "requisicion", id: "r1", consecutive: "REQ-2026-0001", workId: "work-a", status: "devuelta", action: "Corregir" }]);
  });
  it("gives admin_sixteam the union across review, approval (any approver) and order confirmation — plus its own contabilizar, ya que admin_sixteam también puede accionar el eje administrativo", () => {
    const requisitions = [req({ id: "r1", consecutive: "REQ-2026-0001", status: "enviada" }), req({ id: "r2", consecutive: "REQ-2026-0002", status: "en_aprobacion", approverId: "someone-else" })];
    const orders = [ord({ id: "o1", consecutive: "OC-2026-0001", status: "generada" })];
    const queue = buildAttentionQueue(requisitions, orders, { id: "daniel", roles: ["admin_sixteam"] });
    // o1 aparece dos veces: una vez como "Confirmar cumplimiento" (revisor) y otra como "Contabilizar"
    // (contabilidad) — admin_sixteam reúne ambos permisos a la vez.
    expect(queue.map((item) => item.id).sort()).toEqual(["o1", "o1", "r1", "r2"]);
    expect(queue.map((item) => item.action).sort()).toEqual(["Aprobar", "Confirmar cumplimiento", "Contabilizar", "Revisar"]);
  });
  it("gives contabilidad no requisition review/approve items (sin ese permiso), pero SÍ las órdenes pendientes de contabilizar — su propia acción sobre el eje administrativo", () => {
    // Reunión 2026-08-31: contabilidad gana order:account; ya no es una cola vacía.
    const requisitions = [req({ status: "enviada" }), req({ status: "en_aprobacion", approverId: "x" })];
    const orders = [ord({ id: "o1", status: "generada", adminStatus: "pendiente" }), ord({ id: "o2", status: "cumplida", adminStatus: "contabilizada" }), ord({ id: "o3", status: "no_necesario", adminStatus: "pendiente" })];
    const queue = buildAttentionQueue(requisitions, orders, { id: "c", roles: ["contabilidad"] });
    // Ninguna requisición (sin permiso de revisar/aprobar); solo la orden pendiente y con cumplimiento
    // ≠ no_necesario — o3 queda fuera porque assertAdminTransition nunca dejaría contabilizarla.
    expect(queue).toEqual([{ kind: "orden", id: "o1", consecutive: "OC-2026-0001", workId: "work-a", status: "pendiente", action: "Contabilizar" }]);
  });
  it("orders recent activity by timestamp desc across requisitions, orders and expenses, and caps to the limit", () => {
    const requisitions = [req({ id: "r1", updatedAt: "2026-08-20T10:00:00.000Z" }), req({ id: "r2", updatedAt: "2026-08-22T10:00:00.000Z" })];
    const orders = [ord({ id: "o1", updatedAt: "2026-08-21T10:00:00.000Z" })];
    const expenses = [{ id: "e1", workId: "work-a", origin: "requisicion" as const, referenceId: "r1", orderDate: "2026-08-23", date: "2026-08-23", base: 100, iva: 19, total: 119, period: "2026-08" }];
    const activity = buildRecentActivity(requisitions, orders, expenses, 3);
    expect(activity.map((item) => item.id)).toEqual(["e1", "r2", "o1"]);
  });
  it("omits requisitions/orders without a populated updatedAt (in-memory objects that never round-tripped through Postgres)", () => {
    const activity = buildRecentActivity([req({ id: "r1" })], [ord({ id: "o1" })], []);
    expect(activity).toEqual([]);
  });
  // Reunión 2026-09: un gasto sin fecha de pago usa orderDate como `at` — no desaparece de la
  // actividad reciente solo porque la orden que lo originó aún no se ha pagado.
  it("uses orderDate as `at` for an unpaid expense (no date yet)", () => {
    const expenses = [{ id: "e1", workId: "work-a", origin: "requisicion" as const, referenceId: "r1", orderDate: "2026-08-23", base: 100, iva: 19, total: 119 }];
    const activity = buildRecentActivity([], [], expenses);
    expect(activity).toEqual([{ kind: "gasto", id: "e1", consecutive: "e1".slice(0, 8), workId: "work-a", status: "requisicion", at: "2026-08-23" }]);
  });
  it("groups expenses by work, tag (using '' for missing tagId) and period, most recent months last", () => {
    const expenses = [
      { id: "e1", workId: "a", origin: "requisicion" as const, referenceId: "r1", tagId: "t1", orderDate: "2026-07-01", date: "2026-07-01", base: 100, iva: 0, total: 100, period: "2026-07" },
      { id: "e2", workId: "a", origin: "requisicion" as const, referenceId: "r2", orderDate: "2026-08-01", date: "2026-08-01", base: 50, iva: 0, total: 50, period: "2026-08" },
      { id: "e3", workId: "b", origin: "requisicion" as const, referenceId: "r3", tagId: "t1", orderDate: "2026-08-02", date: "2026-08-02", base: 30, iva: 0, total: 30, period: "2026-08" },
    ];
    expect(groupExpenseByWork(expenses)).toEqual([{ key: "a", total: 150 }, { key: "b", total: 30 }]);
    expect(groupExpenseByTag(expenses)).toEqual([{ key: "t1", total: 130 }, { key: "", total: 50 }]);
    expect(groupExpenseByPeriod(expenses)).toEqual([{ key: "2026-07", total: 100 }, { key: "2026-08", total: 80 }]);
    expect(groupExpenseByPeriod(expenses, 1)).toEqual([{ key: "2026-08", total: 80 }]);
  });
  // Reunión 2026-09: groupExpenseByPeriod excluye lo no pagado (period undefined) — no inventa un
  // bucket "sin periodo" en una serie que es, por definición, mensual.
  it("groupExpenseByPeriod excluye los gastos sin periodo (aún sin pagar)", () => {
    const expenses = [
      { id: "e1", workId: "a", origin: "requisicion" as const, referenceId: "r1", orderDate: "2026-08-01", date: "2026-08-01", base: 100, iva: 0, total: 100, period: "2026-08" },
      { id: "e2", workId: "a", origin: "requisicion" as const, referenceId: "r2", orderDate: "2026-08-05", base: 40, iva: 0, total: 40 },
    ];
    expect(groupExpenseByPeriod(expenses)).toEqual([{ key: "2026-08", total: 100 }]);
  });
});
