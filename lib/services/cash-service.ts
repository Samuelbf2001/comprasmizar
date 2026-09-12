/**
 * Cajas, ingresos y cierres mensuales (cliente, 11-sep-2026: «TODOS los gastos (cajas, bancos,
 * personales) quedan en el sistema por centro de costo; Daniel cierra la caja administrativa a inicio
 * de mes e ingresa esos gastos para el reporte; cruce de ingresos/salidas»).
 *
 * Servicio NUEVO y aparte de `ProcurementService` (en vez de crecer ese archivo, ya muy grande): el
 * "gasto directo" de caja sigue siendo `ProcurementService.registerPettyCash` (mismo camino que la
 * caja menor clásica, ahora generalizado a cualquier caja — ver PettyCashInput), pero ingresos y
 * cierres son un concepto propio, sin relación con requisiciones/órdenes.
 */
import { DomainError, assertCop, assertPermission, type Actor, type CashClose, type CashCloseStatus, type CostCenterMovement, type Income, type PaymentMethod } from "../domain";
import type { AuditRepository, RequestContext, ServiceDependencies } from "./contracts";
import type { ListQuery, Page } from "./list-query";

function isPage<T>(value: T[] | Page<T>): value is Page<T> { return !Array.isArray(value); }

/** `registeredBy` no viaja aquí: lo asigna el servicio con el actor autenticado, igual que
 *  `PettyCashInput` no trae `registeredBy` (ver procurement-service.ts). */
export interface IncomeInput { cashBoxId: string; costCenterId: string; workId?: string; date: string; concept: string; amount: number; paymentMethod: PaymentMethod; thirdParty?: string; }

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export class CashService {
  constructor(private readonly deps: ServiceDependencies) {}
  private now(): Date { return this.deps.clock.now(); }
  private origin(context: RequestContext): "web" | "mcp" | "kapso" { return context.origin ?? "web"; }
  private authOrigin(context: RequestContext): "web" | "mcp" { return this.origin(context) === "mcp" ? "mcp" : "web"; }
  private transaction<T>(lockKey: string | undefined, work: Parameters<ServiceDependencies["transactions"]["transaction"]>[1]): Promise<T> { return this.deps.transactions.transaction(lockKey, work) as Promise<T>; }
  private actor(context: RequestContext): Actor { if (!context.actor) throw new DomainError("UNAUTHENTICATED", "Debe autenticarse"); return context.actor; }
  private async audit(entity: string, entityId: string, event: string, actor: Actor, data?: Record<string, unknown>, origin: "web" | "mcp" | "kapso" = "web", repository: AuditRepository = this.deps.audit): Promise<void> { const actorId = actor.id === "kapso" || actor.id === "public" ? undefined : actor.id; await repository.append({ entity, entityId, event, actorId, at: this.now(), data, origin }); }
  private assertPeriod(period: string): void { if (!PERIOD_RE.test(period)) throw new DomainError("INVALID_INPUT", "El periodo debe tener el formato AAAA-MM"); }

  /**
   * Reunión con el cliente: «cruce de ingresos/salidas» — un ingreso NUNCA es un gasto negativo (tabla
   * `ingresos` aparte, `valor > 0` a nivel de base). `income:register` es revisor/contabilidad/
   * admin_sixteam, el mismo conjunto de roles que `payment:register` (registrar un pago parcial de
   * orden es el mismo tipo de gesto operativo/contable).
   */
  async registerIncome(input: IncomeInput, context: RequestContext): Promise<Income> {
    const actor = this.actor(context);
    assertPermission(actor.roles, "income:register", this.authOrigin(context));
    if (!input.cashBoxId || !input.costCenterId || !input.concept.trim() || !input.paymentMethod || !input.date) throw new DomainError("INVALID_INPUT", "Campos de ingreso obligatorios");
    assertCop(input.amount, "Valor");
    if (input.amount <= 0) throw new DomainError("INVALID_MONEY", "El valor debe ser mayor a cero");
    return this.transaction(undefined, async (tx) => {
      const cashBox = await tx.catalogs.get("cashBoxes", input.cashBoxId);
      if (!cashBox || !cashBox.active) throw new DomainError("INVALID_INPUT", "La caja indicada no existe o está inactiva");
      const costCenter = await tx.catalogs.get("costCenters", input.costCenterId);
      if (!costCenter || !costCenter.active) throw new DomainError("INVALID_INPUT", "El centro de costo indicado no existe o está inactivo");
      const income = await tx.incomes.save({ ...input, registeredBy: actor.id });
      await this.audit("ingreso", income.id, "registrado", actor, { cashBoxId: income.cashBoxId, costCenterId: income.costCenterId, amount: income.amount }, this.origin(context), tx.audit);
      return income;
    });
  }
  async listIncomes(context: RequestContext, query?: ListQuery): Promise<Income[]> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context));
    const result = await this.deps.incomes.list(query);
    return isPage(result) ? result.rows : result;
  }
  async listIncomesPage(query: ListQuery, context: RequestContext): Promise<Page<Income>> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context));
    const result = await this.deps.incomes.list(query);
    return isPage(result) ? result : { rows: result, nextCursor: null };
  }

  /**
   * Daniel (contabilidad) cierra la caja administrativa a inicio de mes. `cash:close` es contabilidad/
   * admin_sixteam — a propósito SIN revisor (cerrar caja es un gesto contable, no de compras).
   *
   * SECUENCIA DELIBERADA (documentada también junto a `cierres_caja` en la migración): se guarda el
   * cierre como 'abierto' (o se reutiliza uno ya abierto), se ETIQUETAN los movimientos del periodo con
   * ese `cierre_id` MIENTRAS el periodo sigue abierto, y SOLO AL FINAL se marca 'cerrado'. Si se marcara
   * 'cerrado' primero, el propio etiquetado (un UPDATE sobre caja_menor/ingresos) quedaría bloqueado por
   * el trigger `validar_periodo_caja_abierto` que este mismo cierre acaba de activar.
   */
  async closeCashPeriod(cashBoxId: string, period: string, context: RequestContext): Promise<CashClose> {
    const actor = this.actor(context);
    assertPermission(actor.roles, "cash:close", this.authOrigin(context));
    this.assertPeriod(period);
    return this.transaction(undefined, async (tx) => {
      const cashBox = await tx.catalogs.get("cashBoxes", cashBoxId);
      if (!cashBox) throw new DomainError("NOT_FOUND", "Caja no encontrada");
      const existing = await tx.cashCloses.get(cashBoxId, period);
      if (existing?.status === "cerrado") throw new DomainError("CASH_PERIOD_ALREADY_CLOSED", "Ese periodo ya está cerrado para esta caja");
      const { income, expense } = await tx.cashCloses.sumMovements(cashBoxId, period);
      const openingBalance = await tx.cashCloses.previousClosingBalance(cashBoxId, period);
      const closingBalance = openingBalance + income - expense;
      const opened = await tx.cashCloses.upsert({ cashBoxId, period, status: "abierto", openingBalance, totalIncome: income, totalExpense: expense, closingBalance });
      await tx.cashCloses.tagMovements(cashBoxId, period, opened.id);
      const closed = await tx.cashCloses.setStatus(opened.id, "cerrado", actor.id);
      await this.audit("cierre_caja", closed.id, "cerrado", actor, { cashBoxId, period, openingBalance, totalIncome: income, totalExpense: expense, closingBalance }, this.origin(context), tx.audit);
      return closed;
    });
  }

  /** Reabrir es EXCLUSIVO de admin_sixteam (más estricto que `cash:close`, que además da a
   *  contabilidad) — con auditoría, mismo criterio de "gesto sensible" que otras acciones exclusivas
   *  de admin_sixteam en este repo (p. ej. reactivar el último rol elegible de un aprobador). */
  async reopenCashPeriod(cashBoxId: string, period: string, context: RequestContext): Promise<CashClose> {
    const actor = this.actor(context);
    if (!actor.roles.includes("admin_sixteam")) throw new DomainError("FORBIDDEN", "Solo un administrador Sixteam puede reabrir un cierre de caja");
    this.assertPeriod(period);
    return this.transaction(undefined, async (tx) => {
      const existing = await tx.cashCloses.get(cashBoxId, period);
      if (!existing) throw new DomainError("NOT_FOUND", "No hay un cierre para esa caja y periodo");
      if (existing.status === ("abierto" as CashCloseStatus)) return existing;
      const reopened = await tx.cashCloses.setStatus(existing.id, "abierto");
      await this.audit("cierre_caja", reopened.id, "reabierto", actor, { cashBoxId, period }, this.origin(context), tx.audit);
      return reopened;
    });
  }
  async listCashCloses(cashBoxId: string, context: RequestContext): Promise<CashClose[]> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context));
    return this.deps.cashCloses.listByCashBox(cashBoxId);
  }
  /**
   * La pestaña "Cierre mensual" necesita mostrar saldo inicial/ingresos/gastos/saldo final ANTES de
   * que exista una fila en `cierres_caja` (el mes en curso, todavía abierto) — no solo después de
   * cerrarlo. Si ya hay un cierre para esa caja/periodo (abierto o cerrado) se devuelve tal cual; si no,
   * se calcula en vivo (mismos dos pasos que usa `closeCashPeriod` para los totales) sin persistir
   * nada. `id: ""` es el sentinela de "todavía no existe una fila" — nunca debe usarse para escribir.
   */
  async getCashPeriodSummary(cashBoxId: string, period: string, context: RequestContext): Promise<CashClose> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context));
    this.assertPeriod(period);
    const existing = await this.deps.cashCloses.get(cashBoxId, period);
    if (existing) return existing;
    const { income, expense } = await this.deps.cashCloses.sumMovements(cashBoxId, period);
    const openingBalance = await this.deps.cashCloses.previousClosingBalance(cashBoxId, period);
    return { id: "", cashBoxId, period, status: "abierto", openingBalance, totalIncome: income, totalExpense: expense, closingBalance: openingBalance + income - expense };
  }

  /** Vista `movimientos_centro_costo`: el cruce ingresos(+)/gastos(-) de un mes, por centro de costo —
   *  lo que pide el reporte ("cruce de ingresos/salidas"). Mismo permiso que leer gastos. */
  async listMovementsByCostCenter(period: string, context: RequestContext): Promise<CostCenterMovement[]> {
    const actor = this.actor(context); assertPermission(actor.roles, "expense:read", this.authOrigin(context));
    this.assertPeriod(period);
    return this.deps.cashCloses.listMovementsByCostCenter(period);
  }
}
