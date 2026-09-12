import { describe, expect, it } from "vitest";
import type { AuditEvent, CashClose, Income } from "../../lib/domain";
import { CashService, type ServiceDependencies } from "../../lib/services";

/**
 * Mismo estilo que tests/unit/procurement-service.test.ts (fakes en memoria, un solo `fakeDeps` por
 * archivo), pero deliberadamente MÁS PEQUEÑO: CashService solo toca catalogs/incomes/cashCloses/audit
 * — no hace falta replicar requisiciones/órdenes/gastos aquí.
 *
 * Lo que el trigger `validar_periodo_caja_abierto` bloquea de verdad (una fila NUEVA o EDITADA con
 * fecha dentro de un mes ya cerrado) NO vive en este archivo: no cabe en una prueba unitaria porque no
 * vive en TypeScript — ver la sección 5 de supabase/tests/cajas_ingresos_cierres_verification.sql,
 * que lo prueba contra Postgres real. Lo que SÍ es responsabilidad del servicio (y por eso se prueba
 * aquí) es la SECUENCIA de closeCashPeriod (etiquetar antes de cerrar) y sus propias reglas: quién
 * puede cerrar/reabrir, y que un periodo ya cerrado no se puede volver a cerrar.
 */
function fakeDeps() {
  let seq = 0;
  const incomesData: Income[] = [];
  const closesByKey = new Map<string, CashClose>();
  const sumsByKey = new Map<string, { income: number; expense: number }>();
  const taggedCalls: Array<{ cashBoxId: string; period: string; closeId: string }> = [];
  const audits: AuditEvent[] = [];
  const key = (cashBoxId: string, period: string) => `${cashBoxId}:${period}`;

  const catalogs = {
    get: async (kind: string, id: string) => (
      kind === "cashBoxes" && id === "caja-activa" ? { id, name: "Caja Test", type: "caja_menor", active: true }
      : kind === "cashBoxes" && id === "caja-inactiva" ? { id, name: "Caja Inactiva", type: "caja_menor", active: false }
      : kind === "costCenters" && id === "centro-activo" ? { id, name: "Centro Test", active: true }
      : kind === "costCenters" && id === "centro-inactivo" ? { id, name: "Centro Inactivo", active: false }
      : null
    ),
  } as unknown as ServiceDependencies["catalogs"];

  const incomes: ServiceDependencies["incomes"] = {
    save: async (value) => { const income: Income = { ...value, id: `income-${++seq}` }; incomesData.push(income); return income; },
    list: async () => incomesData,
  };

  const cashCloses: ServiceDependencies["cashCloses"] = {
    get: async (cashBoxId, period) => closesByKey.get(key(cashBoxId, period)) ?? null,
    listByCashBox: async (cashBoxId) => [...closesByKey.values()].filter((close) => close.cashBoxId === cashBoxId),
    sumMovements: async (cashBoxId, period) => sumsByKey.get(key(cashBoxId, period)) ?? { income: 0, expense: 0 },
    previousClosingBalance: async () => 0,
    upsert: async (close) => {
      const existingId = closesByKey.get(key(close.cashBoxId, close.period))?.id;
      const saved: CashClose = { ...close, id: existingId ?? `close-${++seq}` };
      closesByKey.set(key(close.cashBoxId, close.period), saved);
      return saved;
    },
    tagMovements: async (cashBoxId, period, closeId) => { taggedCalls.push({ cashBoxId, period, closeId }); },
    setStatus: async (id, status, actorId) => {
      const entry = [...closesByKey.values()].find((close) => close.id === id);
      if (!entry) throw new Error("CASH_CLOSE_NOT_FOUND");
      const updated: CashClose = { ...entry, status, ...(status === "cerrado" ? { closedBy: actorId, closedAt: "2026-09-12T00:00:00.000Z" } : {}) };
      closesByKey.set(key(updated.cashBoxId, updated.period), updated);
      return updated;
    },
    listMovementsByCostCenter: async (period) => [{ costCenterId: "centro-activo", period, origin: "ingreso", amount: 100000 }],
  };

  const audit: ServiceDependencies["audit"] = { append: async (event) => { audits.push(event); }, list: async () => [] };
  const transactions: ServiceDependencies["transactions"] = {
    transaction: async (_lockKey, work) => work({
      catalogs, incomes, cashCloses, audit,
      requisitions: {} as never, orders: {} as never, expenses: {} as never, orderPayments: {} as never, pettyCash: {} as never,
      consecutives: {} as never, features: { isEnabled: async () => false }, items: {} as never, notifications: {} as never,
    }),
  };

  const deps = {
    catalogs, incomes, cashCloses, audit, transactions,
    clock: { now: () => new Date("2026-09-12T00:00:00.000Z") }, ids: { next: () => `id-${++seq}` },
  } as unknown as ServiceDependencies;
  return { deps, incomesData, closesByKey, sumsByKey, taggedCalls, audits, setSum: (cashBoxId: string, period: string, sum: { income: number; expense: number }) => sumsByKey.set(key(cashBoxId, period), sum) };
}

const revisor = { actor: { id: "daniel", roles: ["revisor"] as const } };
const contabilidad = { actor: { id: "claudia", roles: ["contabilidad"] as const } };
const adminSixteam = { actor: { id: "admin", roles: ["admin_sixteam"] as const } };
const solicitante = { actor: { id: "sol", roles: ["solicitante"] as const } };

describe("CashService.registerIncome", () => {
  it("un ingreso nunca es un gasto negativo: rechaza valor cero o negativo antes de tocar la base", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.registerIncome({ cashBoxId: "caja-activa", costCenterId: "centro-activo", date: "2026-09-10", concept: "Test", amount: 0, paymentMethod: "efectivo" }, contabilidad)).rejects.toThrow();
    await expect(service.registerIncome({ cashBoxId: "caja-activa", costCenterId: "centro-activo", date: "2026-09-10", concept: "Test", amount: -500, paymentMethod: "efectivo" }, contabilidad)).rejects.toThrow();
  });
  it("income:register es de revisor/contabilidad/admin_sixteam — un solicitante no puede registrar", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.registerIncome({ cashBoxId: "caja-activa", costCenterId: "centro-activo", date: "2026-09-10", concept: "Test", amount: 1000, paymentMethod: "efectivo" }, solicitante)).rejects.toThrow("Permiso denegado");
  });
  it("rechaza una caja inexistente o inactiva", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.registerIncome({ cashBoxId: "caja-inactiva", costCenterId: "centro-activo", date: "2026-09-10", concept: "Test", amount: 1000, paymentMethod: "efectivo" }, contabilidad)).rejects.toThrow();
    await expect(service.registerIncome({ cashBoxId: "caja-inexistente", costCenterId: "centro-activo", date: "2026-09-10", concept: "Test", amount: 1000, paymentMethod: "efectivo" }, contabilidad)).rejects.toThrow();
  });
  it("rechaza un centro de costo inexistente o inactivo", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.registerIncome({ cashBoxId: "caja-activa", costCenterId: "centro-inactivo", date: "2026-09-10", concept: "Test", amount: 1000, paymentMethod: "efectivo" }, contabilidad)).rejects.toThrow();
  });
  it("registra el ingreso con el actor como registeredBy y lo audita", async () => {
    const { deps, incomesData, audits } = fakeDeps(), service = new CashService(deps);
    const income = await service.registerIncome({ cashBoxId: "caja-activa", costCenterId: "centro-activo", date: "2026-09-10", concept: "Anticipo cliente", amount: 500000, paymentMethod: "transferencia", thirdParty: "Cliente X" }, contabilidad);
    expect(income).toMatchObject({ cashBoxId: "caja-activa", costCenterId: "centro-activo", amount: 500000, registeredBy: "claudia" });
    expect(incomesData).toHaveLength(1);
    expect(audits.map((event) => event.event)).toContain("registrado");
  });
});

describe("CashService.closeCashPeriod", () => {
  it("cash:close es de contabilidad/admin_sixteam — un revisor (que sí tiene income:register) no puede cerrar", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.closeCashPeriod("caja-activa", "2026-09", revisor)).rejects.toThrow("Permiso denegado");
  });
  it("calcula saldo_final = saldo_inicial + ingresos - gastos y deja el cierre 'cerrado'", async () => {
    const { deps, setSum, taggedCalls } = fakeDeps(), service = new CashService(deps);
    setSum("caja-activa", "2026-09", { income: 300000, expense: 120000 });
    const close = await service.closeCashPeriod("caja-activa", "2026-09", contabilidad);
    expect(close).toMatchObject({ cashBoxId: "caja-activa", period: "2026-09", status: "cerrado", openingBalance: 0, totalIncome: 300000, totalExpense: 120000, closingBalance: 180000, closedBy: "claudia" });
    // Secuencia: los movimientos se etiquetaron con el id del cierre YA creado, antes (o en el mismo
    // paso) de marcarlo cerrado — nunca después, que es justo lo que el trigger de la migración
    // bloquearía (ver el comentario grande en cierres_caja / CashService.closeCashPeriod).
    expect(taggedCalls).toEqual([{ cashBoxId: "caja-activa", period: "2026-09", closeId: close.id }]);
  });
  it("un periodo ya cerrado no se puede volver a cerrar", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await service.closeCashPeriod("caja-activa", "2026-09", contabilidad);
    await expect(service.closeCashPeriod("caja-activa", "2026-09", contabilidad)).rejects.toThrow();
  });
  it("rechaza un periodo con formato inválido", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.closeCashPeriod("caja-activa", "septiembre-2026", contabilidad)).rejects.toThrow();
    await expect(service.closeCashPeriod("caja-activa", "2026-13", contabilidad)).rejects.toThrow();
  });
});

describe("CashService.reopenCashPeriod", () => {
  it("reabrir es EXCLUSIVO de admin_sixteam — contabilidad, que sí puede cerrar, no puede reabrir", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await service.closeCashPeriod("caja-activa", "2026-09", contabilidad);
    await expect(service.reopenCashPeriod("caja-activa", "2026-09", contabilidad)).rejects.toThrow("administrador Sixteam");
  });
  it("admin_sixteam reabre un cierre y queda auditado", async () => {
    const { deps, audits } = fakeDeps(), service = new CashService(deps);
    const closed = await service.closeCashPeriod("caja-activa", "2026-09", contabilidad);
    expect(closed.status).toBe("cerrado");
    const reopened = await service.reopenCashPeriod("caja-activa", "2026-09", adminSixteam);
    expect(reopened.status).toBe("abierto");
    expect(audits.map((event) => event.event)).toContain("reabierto");
  });
  it("reabrir un periodo sin cierre previo falla explícito, no en silencio", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.reopenCashPeriod("caja-activa", "2026-09", adminSixteam)).rejects.toThrow();
  });
});

describe("CashService.listMovementsByCostCenter", () => {
  it("requiere expense:read — un solicitante no puede consultar el cruce", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    await expect(service.listMovementsByCostCenter("2026-09", solicitante)).rejects.toThrow("Permiso denegado");
  });
  it("devuelve el cruce de la vista movimientos_centro_costo para el periodo pedido", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    const movements = await service.listMovementsByCostCenter("2026-09", contabilidad);
    expect(movements).toEqual([{ costCenterId: "centro-activo", period: "2026-09", origin: "ingreso", amount: 100000 }]);
  });
});

describe("CashService.getCashPeriodSummary", () => {
  it("sin cierre todavía: calcula el resumen EN VIVO (saldo inicial + ingresos - gastos) sin persistir nada", async () => {
    const { deps, setSum, closesByKey } = fakeDeps(), service = new CashService(deps);
    setSum("caja-activa", "2026-09", { income: 200000, expense: 50000 });
    const summary = await service.getCashPeriodSummary("caja-activa", "2026-09", contabilidad);
    expect(summary).toMatchObject({ id: "", status: "abierto", openingBalance: 0, totalIncome: 200000, totalExpense: 50000, closingBalance: 150000 });
    expect(closesByKey.size).toBe(0);
  });
  it("con un cierre ya existente, devuelve esa fila tal cual (no la recalcula)", async () => {
    const { deps } = fakeDeps(), service = new CashService(deps);
    const closed = await service.closeCashPeriod("caja-activa", "2026-09", contabilidad);
    const summary = await service.getCashPeriodSummary("caja-activa", "2026-09", contabilidad);
    expect(summary).toEqual(closed);
  });
});
