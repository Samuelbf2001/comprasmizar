import { assertPermission, approvedLines, calculateLineAmounts, calculateLineTotal, paymentStatus as derivePaymentStatus, sumLineAmounts, type Actor, type CashPayment, type Money, type Order, type OrderType, type PaymentMethod, type PaymentStatus, type Requisition } from "../domain";
import type { RequestContext, ServiceDependencies } from "./contracts";
import type { ListQuery, Page } from "./list-query";
import type { CashPaymentsQuery } from "./procurement-service";

/**
 * RF-1301 (Reportes, reunión 2026-09-11): filtros del reporte de requisiciones. `workId`/`period` ya
 * existían en la pantalla (obra y periodo); `approverId`/`tagId` son los que pidió el cliente.
 * `costCenterId` (UI, 2026-09-12, ya con la entidad propia — ver `resolveCostCenter` en
 * lib/domain/rules.ts) filtra por el centro de costo EFECTIVO de la requisición
 * (`requisiciones.centro_costo_id`), independiente de `workId`: una requisición puede compartir centro
 * con otras obras.
 */
export interface ReportFilters {
  workId?: string;
  tagId?: string;
  approverId?: string;
  costCenterId?: string;
  /** RF-707 (adenda de pagos): empresa facturada (`requisiciones.empresa_facturada_id`). */
  billedCompanyId?: string;
  /** "YYYY-MM": se resuelve a un rango de fecha que cubre el mes completo (RF-1301, "compilado mensual"),
   *  sobre la misma columna (`requisiciones.created_at`) que ya usa el filtro de periodo de /revision. */
  period?: string;
  status?: readonly string[];
}
/**
 * RF-707: filtros del reporte de ÓRDENES (comprometido vs pagado). `period` filtra por mes de
 * `fecha_generacion`; `paymentMethod`/`paymentStatus` son los mismos filtros del panel de órdenes
 * (`ListQuery`, RF-509). Sin aprobador ni etiqueta: una orden no los tiene.
 */
export interface OrderReportFilters {
  workId?: string;
  costCenterId?: string;
  billedCompanyId?: string;
  period?: string;
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
}
/**
 * Una fila del reporte por ORDEN (RF-707, "comprometido vs pagado"): `total` = Σ líneas de la orden
 * (`calculateLineTotal`, la única fuente de verdad, nunca un cálculo propio); `paidAmount` = Σ pagos
 * vigentes (los anulados no cuentan, N1); `paymentStatus` derivado. `period` es el mes de generación:
 * el compromiso nace cuando se genera la orden, no cuando se paga.
 */
export interface OrderReportRow {
  id: string;
  consecutive: string;
  type: OrderType;
  requisitionId: string;
  requisitionConsecutive?: string;
  generatedAt?: string;
  period?: string;
  workId?: string;
  costCenterId?: string;
  billedCompanyId?: string;
  supplierId?: string;
  total: Money;
  paidAmount: Money;
  paymentStatus: PaymentStatus;
  paymentMethods: PaymentMethod[];
  lastPaymentAt?: string;
}
/** Una fila del reporte por ÍTEM (hoja 2 del Excel, RF-1301). Los montos ya pasaron por
 *  `calculateLineAmounts` (lib/domain/rules.ts) — nunca se recalculan aguas abajo. */
export interface ReportItemRow {
  id: string;
  description: string;
  quantity: number;
  unit: string;
  status: string;
  approverId?: string;
  finalSupplierId?: string;
  base: number;
  iva: number;
  total: number;
}
/**
 * Una fila del reporte por REQUISICIÓN (hoja 1 del Excel y tabla en pantalla, RF-1301). `approverIds`/
 * `supplierIds` van en plural a propósito: una requisición puede tener aprobador de cabecera y
 * aprobadores por ítem distintos (herencia, ver `itemApproverId` en lib/domain/rules.ts), y puede repartir
 * sus ítems entre varios proveedores finales antes de generar cualquier orden. `base`/`iva`/`total` suman
 * solo los ítems NO declinados (`approvedLines`) — el mismo criterio que ya usa el resumen de ítems en
 * revisión/aprobación (`summarizeLines`, components/screens/connected/shared.tsx) y que gobierna cuánto
 * se termina comprando de verdad.
 */
export interface ReportRow {
  id: string;
  consecutive: string;
  /** Fecha de radicación (Requisition.createdAt); ausente solo si el adaptador no la trajo (fakes de test). */
  date?: string;
  societyId?: string;
  workId?: string;
  tagId?: string;
  /** Centro de costo EFECTIVO de la requisición (UI, 2026-09-12) — ver `Requisition.costCenterId`/
   *  `resolveCostCenter` en lib/domain/rules.ts. */
  costCenterId?: string;
  /** RF-009/RF-707: empresa facturada de la requisición (`Requisition.billedCompanyId`). */
  billedCompanyId?: string;
  approverIds: string[];
  status: string;
  supplierIds: string[];
  base: number;
  iva: number;
  total: number;
  items: ReportItemRow[];
}

// Tope de página por vuelta de paginación interna (igual al máximo que ya impone
// lib/services/list-query.ts#pageLimit) y válvula de seguridad de vueltas: un reporte NUNCA debe
// paginar sin límite sobre una base real. 50 × 200 = 10 000 requisiciones por consulta de reporte,
// muy por encima de cualquier volumen mensual plausible para un solo cliente.
const REPORT_PAGE_LIMIT = 200;
const REPORT_MAX_PAGES = 50;

function isPage<T>(value: T[] | Page<T>): value is Page<T> { return !Array.isArray(value); }

/** RF-1301: primer y último día calendario de "YYYY-MM", en UTC (mismo criterio que `asIsoDate` en el
 *  adaptador Postgres: una fecha de calendario, no un instante) — evita el corrimiento de día que daría
 *  construir la fecha con el reloj/zona horaria del proceso. */
export function monthRange(period: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`INVALID_PERIOD: "${period}" no tiene forma YYYY-MM`);
  const year = Number(match[1]), month = Number(match[2]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(lastDay).padStart(2, "0")}` };
}

function approverIdsFor(requisition: Requisition): string[] {
  const ids = new Set<string>();
  if (requisition.approverId) ids.add(requisition.approverId);
  for (const line of requisition.items) if (line.approverId) ids.add(line.approverId);
  return [...ids];
}
function supplierIdsFor(requisition: Requisition): string[] {
  return [...new Set(requisition.items.map((line) => line.finalSupplierId).filter((id): id is string => Boolean(id)))];
}
function toReportRow(requisition: Requisition): ReportRow {
  const amounts = sumLineAmounts(approvedLines(requisition.items));
  const items: ReportItemRow[] = requisition.items.map((line) => {
    // Una línea con cantidad inválida (0, negativa) no debería existir en una requisición ya guardada,
    // pero `calculateLineAmounts` SÍ lo valida (assertCop/DomainError) — el reporte es de solo lectura y
    // no debe tumbarse por una fila legacy inconsistente: se muestra en 0 en vez de reventar el export.
    let lineAmounts = { base: 0, iva: 0, total: 0 };
    try { lineAmounts = calculateLineAmounts(line); } catch { /* fila legacy inconsistente: se reporta en 0, no se tumba el reporte */ }
    return { id: line.id, description: line.description ?? line.itemId ?? "—", quantity: line.quantity, unit: line.unit, status: line.status ?? "pendiente", approverId: line.approverId, finalSupplierId: line.finalSupplierId, ...lineAmounts };
  });
  return {
    id: requisition.id, consecutive: requisition.consecutive, date: requisition.createdAt,
    societyId: requisition.societyId, workId: requisition.workId, tagId: requisition.tagId,
    costCenterId: requisition.costCenterId, billedCompanyId: requisition.billedCompanyId,
    approverIds: approverIdsFor(requisition), status: requisition.status, supplierIds: supplierIdsFor(requisition),
    base: amounts.base, iva: amounts.iva, total: amounts.total, items,
  };
}
// Una línea legacy inconsistente se reporta en 0 en vez de tumbar el reporte (mismo criterio que toReportRow).
function orderTotal(order: Order): Money {
  let total = 0;
  for (const line of order.lines ?? []) { try { total += calculateLineTotal(line); } catch { /* fila legacy inconsistente */ } }
  return total;
}
function toOrderReportRow(order: Order): OrderReportRow {
  const total = orderTotal(order), paidAmount = order.paidAmount ?? 0;
  return {
    id: order.id, consecutive: order.consecutive, type: order.type, requisitionId: order.requisitionId, requisitionConsecutive: order.requisitionConsecutive,
    generatedAt: order.generatedAt, period: order.generatedAt?.slice(0, 7), workId: order.workId || undefined, costCenterId: order.costCenterId,
    billedCompanyId: order.billedCompanyId, supplierId: order.supplierId, total, paidAmount,
    paymentStatus: order.paymentStatus ?? derivePaymentStatus(total, paidAmount), paymentMethods: order.paymentMethods ?? [], lastPaymentAt: order.lastPaymentAt,
  };
}
/** Una orden `no_necesario` dejó de ser un compromiso (su gasto se anuló): no entra en "comprometido". */
const COMMITTED_ORDER_STATUSES = ["generada", "cumplida", "no_cumplida"] as const;

/**
 * RF-1301: índice de nombres para RESOLVER los ids crudos del reporte a texto legible — solo lo necesita
 * la exportación a Excel (un archivo no tiene forma de "resolver en cliente" como sí hace la pantalla vía
 * `resolveUserName`/`CatalogData`, ver components/screens/connected/shared.tsx). Puerto inyectable
 * (mismo patrón que `WorkSocietyIndex` en app/api/reports/expenses-report.ts) para poder probar
 * `buildRequisitionReportXlsx` sin Postgres real; la implementación de producción vive en
 * lib/infrastructure/postgres-repositories.ts (`postgresReportCatalogSource`).
 */
export interface ReportCatalogNames { works: ReadonlyMap<string, string>; tags: ReadonlyMap<string, string>; societies: ReadonlyMap<string, string>; users: ReadonlyMap<string, string>; suppliers: ReadonlyMap<string, string>; costCenters: ReadonlyMap<string, string>; }
export interface ReportCatalogSource { load(): Promise<ReportCatalogNames>; }

/**
 * RF-708 (cierre de caja, adenda A10): una fila del cierre = un pago VIGENTE con medio `efectivo` (Caja)
 * dentro del rango, con los nombres YA resueltos en el servidor. A diferencia de `ReportRow`, aquí sí se
 * resuelven: la pantalla de cierre no parte de un bundle con catálogos (consulta el rango bajo demanda,
 * ver components/screens/connected/expenses.tsx) y el Excel del cierre tampoco tiene quién los traduzca
 * después — resolverlos una vez sirve a ambos. `attachmentId` es el comprobante (adjunto `pago_orden`).
 */
export interface CashCloseReportRow {
  id: string; date: string; amount: number; externalReference?: string; note?: string; attachmentId?: string; registeredBy?: string;
  orderId: string; orderConsecutive: string; orderType: OrderType; requisitionId: string; requisitionConsecutive: string;
  workId?: string; workName: string; costCenterId?: string; costCenterName: string; billedCompanyId?: string; billedCompanyName: string;
  supplierId?: string; supplierName: string;
}
export interface CashCloseReport { from: string; to: string; costCenterId?: string; rows: CashCloseReportRow[]; total: number; }

const nameOf = (map: ReadonlyMap<string, string>, id: string | undefined): string => (id ? (map.get(id) ?? "—") : "—");

/** Pura (sin permisos ni I/O): la autorización y la consulta viven en `ProcurementService.listCashPayments`. */
export function toCashCloseReport(payments: readonly CashPayment[], names: ReportCatalogNames, query: CashPaymentsQuery): CashCloseReport {
  const rows: CashCloseReportRow[] = payments.map((payment) => ({
    id: payment.id, date: payment.date, amount: payment.amount, externalReference: payment.externalReference, note: payment.note,
    attachmentId: payment.attachmentId, registeredBy: payment.registeredBy,
    orderId: payment.orderId, orderConsecutive: payment.orderConsecutive, orderType: payment.orderType,
    requisitionId: payment.requisitionId, requisitionConsecutive: payment.requisitionConsecutive,
    workId: payment.workId, workName: nameOf(names.works, payment.workId),
    costCenterId: payment.costCenterId, costCenterName: nameOf(names.costCenters, payment.costCenterId),
    billedCompanyId: payment.billedCompanyId, billedCompanyName: nameOf(names.societies, payment.billedCompanyId),
    supplierId: payment.supplierId, supplierName: nameOf(names.suppliers, payment.supplierId),
  }));
  return { from: query.from, to: query.to, costCenterId: query.costCenterId || undefined, rows, total: rows.reduce((sum, row) => sum + row.amount, 0) };
}

export class ReportService {
  constructor(private readonly deps: ServiceDependencies) {}
  private actor(context: RequestContext): Actor { if (!context.actor) throw new Error("UNAUTHENTICATED"); return context.actor; }
  private authOrigin(context: RequestContext): "web" | "mcp" { return context.origin === "mcp" ? "mcp" : "web"; }

  /**
   * RF-1301: reporte de requisiciones con los mismos filtros que la pantalla ofrece (obra, periodo,
   * aprobador, etiqueta). La visibilidad por rol NO se toca aquí — se hereda íntegra de
   * `listVisibleTo`/`public.es_aprobador_de` (lib/infrastructure/postgres-repositories.ts): un aprobador
   * no elevado sigue viendo solo lo suyo, sin importar qué `approverId` pida en el filtro.
   */
  async listReport(filters: ReportFilters, context: RequestContext): Promise<ReportRow[]> {
    const actor = this.actor(context);
    assertPermission(actor, "report:read", this.authOrigin(context));
    const range = filters.period ? monthRange(filters.period) : undefined;
    const requisitions: Requisition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < REPORT_MAX_PAGES; page++) {
      const result = await this.deps.requisitions.listVisibleTo(actor, {
        workId: filters.workId, tagId: filters.tagId, approverId: filters.approverId, costCenterId: filters.costCenterId,
        billedCompanyId: filters.billedCompanyId,
        status: filters.status ? [...filters.status] : undefined,
        from: range?.from, to: range?.to, limit: REPORT_PAGE_LIMIT, cursor,
      });
      // Siempre se pasa `query` (aunque venga vacío de filtros): el adaptador SIEMPRE devuelve
      // `Page<Requisition>` en ese caso — `isPage` estrecha el tipo estático, no cambia el comportamiento.
      if (!isPage(result)) throw new Error("UNEXPECTED_NON_PAGED_RESULT");
      requisitions.push(...result.rows);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return requisitions.map(toReportRow);
  }

  /**
   * RF-707: reporte de ÓRDENES para "comprometido (Σ órdenes generadas) vs pagado (Σ pagos vigentes)".
   * Misma puerta ("report:read") y misma visibilidad heredada del repositorio que `listReport`; los
   * filtros van al SQL vía `ListQuery` (RF-509). Paginado con el mismo tope que el de requisiciones.
   */
  async listOrderReport(filters: OrderReportFilters, context: RequestContext): Promise<OrderReportRow[]> {
    const actor = this.actor(context);
    assertPermission(actor, "report:read", this.authOrigin(context));
    const range = filters.period ? monthRange(filters.period) : undefined;
    const orders: Order[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < REPORT_MAX_PAGES; page++) {
      const query: ListQuery = {
        status: [...COMMITTED_ORDER_STATUSES], workId: filters.workId, costCenterId: filters.costCenterId, billedCompanyId: filters.billedCompanyId,
        paymentMethod: filters.paymentMethod, paymentStatus: filters.paymentStatus,
        from: range?.from, to: range?.to, limit: REPORT_PAGE_LIMIT, cursor,
      };
      const result = await this.deps.orders.listVisibleTo(actor, query);
      if (!isPage(result)) { orders.push(...result); break; }
      orders.push(...result.rows);
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    return orders.map(toOrderReportRow);
  }

  /** Único punto que decide si ESTE actor puede descargar el Excel — la ruta de export lo llama antes de
   *  construir el libro, además de `listReport` (que ya exige "report:read", un permiso más amplio). */
  assertCanExport(actor: Actor, origin: "web" | "mcp" = "web"): void {
    assertPermission(actor, "report:export", origin);
  }
}
