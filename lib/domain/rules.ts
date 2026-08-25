import type { Actor, DashboardActivityItem, DashboardAmountByKey, DashboardMetrics, DashboardQueueItem, Expense, ExpenseShare, ItemLine, Money, Order, OrderType, Requisition, RequisitionStatus, Role } from "./model";
import { DomainError } from "./model";

export const ALL_ROLES: readonly Role[] = ["solicitante", "revisor", "aprobador", "contabilidad", "admin_mizar", "admin_sixteam"];
const permissions: Record<Role, readonly string[]> = {
  solicitante: ["requisition:create", "requisition:read:own", "dashboard:read"],
  revisor: ["requisition:create", "requisition:read", "requisition:review", "item:manage", "supplier:manage", "petty_cash:create", "petty_cash:read", "expense:read", "order:read", "order:update", "dashboard:read"],
  aprobador: ["requisition:read:assigned", "requisition:approve", "requisition:return", "order:read", "dashboard:read"],
  contabilidad: ["requisition:read", "petty_cash:read", "expense:read", "report:export", "order:read", "dashboard:read"],
  admin_mizar: ["requisition:create", "catalog:manage", "dashboard:read", "expense:read", "report:export"],
  admin_sixteam: ["*"],
};
// "requisition:review" protege decline/review/startReview/sendForApproval (procurement-service.ts):
// bloquearlo también estructuralmente cierra la denegación permanente (RF-1205), no solo aprobar/devolver.
const mcpForbidden = new Set(["requisition:approve", "requisition:return", "requisition:review"]);

export function hasPermission(roles: readonly Role[], permission: string, origin: "web" | "mcp" = "web"): boolean {
  if (origin === "mcp" && mcpForbidden.has(permission)) return false;
  return roles.some((role) => permissions[role]?.includes("*") || permissions[role]?.includes(permission));
}
export function assertPermission(roles: readonly Role[], permission: string, origin: "web" | "mcp" = "web"): void {
  if (!hasPermission(roles, permission, origin)) throw new DomainError("FORBIDDEN", `Permiso denegado: ${permission}`);
}

const transitions: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  enviada: ["en_revision"], en_revision: ["en_aprobacion", "declinada"], en_aprobacion: ["aprobada", "devuelta"],
  devuelta: ["en_revision"], aprobada: [], declinada: [],
};
export function canTransition(from: RequisitionStatus, to: RequisitionStatus): boolean { return transitions[from].includes(to); }
export function assertTransition(from: RequisitionStatus, to: RequisitionStatus, comment?: string): void {
  if (!canTransition(from, to)) throw new DomainError("INVALID_TRANSITION", `No se puede pasar de ${from} a ${to}`);
  if ((to === "devuelta" || to === "declinada") && !comment?.trim()) throw new DomainError("COMMENT_REQUIRED", `Se requiere comentario para ${to}`);
}

export function nextConsecutive(prefix: "REQ" | "OC" | "OP", year: number, currentNext: number): { value: string; next: number } {
  if (!Number.isInteger(currentNext) || currentNext < 1) throw new DomainError("INVALID_CONSECUTIVE", "El consecutivo debe iniciar en 1");
  return { value: `${prefix}-${year}-${String(currentNext).padStart(4, "0")}`, next: currentNext + 1 };
}
export function calculateTax(base: Money, ivaRate: number): { base: Money; iva: Money; total: Money } {
  if (!Number.isInteger(base) || base < 0 || !Number.isFinite(ivaRate) || ivaRate < 0) throw new DomainError("INVALID_MONEY", "Base o IVA inválidos");
  const iva = Math.round(base * ivaRate);
  return { base, iva, total: base + iva };
}
export function assertCop(value: Money, label = "valor"): void {
  if (!Number.isInteger(value) || value < 0) throw new DomainError("INVALID_MONEY", `${label} debe ser un peso COP entero no negativo`);
}
export function calculateLineAmounts(line: ItemLine): { base: Money; iva: Money; total: Money } {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new DomainError("INVALID_QUANTITY", "La cantidad debe ser mayor que cero");
  const unitBase = line.unitBase ?? 0, unitIva = line.unitIva ?? 0, derivedUnitTotal = unitBase + unitIva;
  assertCop(unitBase, "Base unitaria"); assertCop(unitIva, "IVA unitario");
  if (line.unitTotal !== undefined && line.unitTotal !== derivedUnitTotal) throw new DomainError("INCONSISTENT_TOTAL", "El total unitario no cuadra con base e IVA");
  // Cantidades fraccionarias (m3, metros, litros) casi nunca caen en un peso exacto: se redondea base e IVA
  // por separado (igual que calculateTax) y el total se deriva de esa suma, nunca de una tercera multiplicación,
  // para que base + iva === total siempre cuadre al peso.
  const base = Math.round(line.quantity * unitBase), iva = Math.round(line.quantity * unitIva), total = base + iva;
  assertCop(base, "Base de línea"); assertCop(iva, "IVA de línea"); assertCop(total, "Total de línea"); return { base, iva, total };
}
export function calculateLineTotal(line: ItemLine): Money { return calculateLineAmounts(line).total; }
export function sumLines(lines: readonly ItemLine[]): Money { return lines.reduce((sum, line) => sum + calculateLineTotal(line), 0); }
export function validateShares(total: Money, shares: readonly ExpenseShare[]): void {
  if (!Number.isInteger(total) || total <= 0 || shares.length === 0 || shares.some((share) => !share.expenseId || !share.workId || !Number.isInteger(share.amount) || share.amount <= 0)) throw new DomainError("INVALID_SHARE", "Reparto inválido");
  if (new Set(shares.map((share) => share.expenseId)).size !== 1 || new Set(shares.map((share) => share.workId)).size !== shares.length) throw new DomainError("INVALID_SHARE", "Cada reparto debe usar un gasto y obras únicas");
  if (shares.reduce((sum, share) => sum + share.amount, 0) !== total) throw new DomainError("UNBALANCED_SHARE", "El reparto debe cuadrar al peso");
}
export function orderTypeFor(requisitionType: "compra" | "pago"): OrderType { return requisitionType === "compra" ? "OC" : "OP"; }
export function groupOrderItems(lines: readonly ItemLine[], multiSupplier: boolean, type: "compra" | "pago"): Map<string | undefined, ItemLine[]> {
  if (type === "pago") {
    const suppliers = new Set(lines.map((line) => line.finalSupplierId).filter((value): value is string => Boolean(value)));
    if (suppliers.size > 1) throw new DomainError("MULTI_SUPPLIER_PAYMENT", "Una orden de pago solo puede tener un proveedor");
    return new Map([[suppliers.values().next().value, [...lines]]]);
  }
  if (!multiSupplier) {
    if (lines.some((line) => !line.finalSupplierId)) throw new DomainError("SUPPLIER_REQUIRED", "La orden de compra requiere proveedor final");
    const suppliers = new Set(lines.map((line) => line.finalSupplierId));
    if (suppliers.size > 1) throw new DomainError("MULTI_SUPPLIER_REQUIRES_COMPLETE", "Varios proveedores requieren la división de órdenes del alcance Completo");
    return new Map([[suppliers.values().next().value, [...lines]]]);
  }
  const groups = new Map<string | undefined, ItemLine[]>();
  for (const line of lines) {
    if (!line.finalSupplierId) throw new DomainError("SUPPLIER_REQUIRED", "Cada ítem de compra debe tener proveedor final");
    const key = line.finalSupplierId; groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return groups;
}
export function calculateDashboard(expenses: readonly Expense[], orders: readonly Order[], statuses: readonly RequisitionStatus[], period: string): DashboardMetrics {
  const byStatus = { enviada: 0, en_revision: 0, en_aprobacion: 0, aprobada: 0, devuelta: 0, declinada: 0 };
  for (const status of statuses) byStatus[status]++;
  return { byStatus, inProcessValue: 0, periodExpense: expenses.filter((expense) => expense.period === period).reduce((sum, expense) => sum + expense.total, 0), pendingOrders: orders.filter((order) => order.status === "generada" || order.status === "no_cumplida").length };
}
/**
 * RF-1102: cola de "qué espera algo de mí" en el dashboard conectado. Se calcula en el dominio sobre
 * las mismas colecciones que ya filtró `listVisibleTo(actor)` (procurement-service.dashboard): nunca
 * expone un documento que ese alcance no hubiera autorizado ya. Determinística: ordena por consecutivo
 * descendente (el formato PREFIJO-AÑO-NNNN es monótono) y limita a 20 elementos para el panel.
 */
export function buildAttentionQueue(requisitions: readonly Requisition[], orders: readonly Order[], actor: Actor): DashboardQueueItem[] {
  const workByRequisition = new Map(requisitions.map((requisition) => [requisition.id, requisition.workId]));
  const canReview = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam");
  const canApprove = actor.roles.includes("aprobador") || actor.roles.includes("admin_sixteam");
  const items: DashboardQueueItem[] = [];
  if (canReview) for (const requisition of requisitions) if (requisition.status === "enviada" || requisition.status === "en_revision") items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Revisar" });
  if (canApprove) for (const requisition of requisitions) if (requisition.status === "en_aprobacion" && (actor.roles.includes("admin_sixteam") || requisition.approverId === actor.id)) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Aprobar" });
  for (const requisition of requisitions) if (requisition.status === "devuelta" && requisition.requesterId === actor.id) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Corregir" });
  if (canReview) for (const order of orders) if (order.status === "generada") items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId), status: order.status, action: "Confirmar cumplimiento" });
  return items.sort((a, b) => b.consecutive.localeCompare(a.consecutive)).slice(0, 20);
}
/**
 * RF-1102: actividad reciente combinando requisiciones, órdenes y gastos visibles para el actor.
 * Requisiciones/órdenes ordenan por su `updatedAt` real (poblado solo por el adaptador Postgres); los
 * gastos del dominio solo llevan fecha (sin hora), así que dos eventos del mismo día ordenan por esa
 * fecha. Es una aproximación explícita, no un registro de auditoría con hora exacta.
 */
export function buildRecentActivity(requisitions: readonly Requisition[], orders: readonly Order[], expenses: readonly Expense[], limit = 8): DashboardActivityItem[] {
  const workByRequisition = new Map(requisitions.map((requisition) => [requisition.id, requisition.workId]));
  const items: DashboardActivityItem[] = [];
  for (const requisition of requisitions) if (requisition.updatedAt) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, at: requisition.updatedAt });
  for (const order of orders) if (order.updatedAt) items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId) ?? "", status: order.status, at: order.updatedAt });
  for (const expense of expenses) items.push({ kind: "gasto", id: expense.id, consecutive: expense.id.slice(0, 8), workId: expense.workId, status: expense.origin, at: expense.date });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
function amountByKey(rows: Iterable<readonly [string, Money]>): DashboardAmountByKey[] {
  const totals = new Map<string, number>();
  for (const [key, amount] of rows) totals.set(key, (totals.get(key) ?? 0) + amount);
  return [...totals.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => b.total - a.total);
}
/** RF-706/RF-1103: gasto agrupado por obra, mayor a menor, para el gráfico ejecutivo correspondiente. */
export function groupExpenseByWork(expenses: readonly Expense[]): DashboardAmountByKey[] { return amountByKey(expenses.map((expense) => [expense.workId, expense.total] as const)); }
/** RF-706/RF-1103: gasto agrupado por etiqueta; clave "" representa gastos sin etiqueta asignada. */
export function groupExpenseByTag(expenses: readonly Expense[]): DashboardAmountByKey[] { return amountByKey(expenses.map((expense) => [expense.tagId ?? "", expense.total] as const)); }
/** RF-706/RF-1103: tendencia de gasto por periodo (YYYY-MM), cronológica, limitada a los últimos `monthsBack`. */
export function groupExpenseByPeriod(expenses: readonly Expense[], monthsBack = 6): DashboardAmountByKey[] {
  return amountByKey(expenses.map((expense) => [expense.period, expense.total] as const)).sort((a, b) => a.key.localeCompare(b.key)).slice(-monthsBack);
}
