import type { Actor, DashboardActivityItem, DashboardAmountByKey, DashboardMetrics, DashboardQueueItem, Expense, ExpenseShare, ItemLine, Money, Order, OrderAdminStatus, OrderStatus, OrderType, Requisition, RequisitionStatus, Role } from "./model";
import { DomainError } from "./model";

export const ALL_ROLES: readonly Role[] = ["solicitante", "revisor", "aprobador", "contabilidad", "admin_mizar", "admin_sixteam"];
const permissions: Record<Role, readonly string[]> = {
  solicitante: ["requisition:create", "requisition:read:own", "dashboard:read"],
  // "order:create" (generar órdenes) es del revisor, NO del aprobador: aprobar y designar proveedor/generar
  // órdenes son roles distintos por decisión explícita de la reunión 2026-08-31 — exigirle al aprobador
  // proveedor o generación de órdenes rompería su rol de solo aprobar.
  revisor: ["requisition:create", "requisition:read", "requisition:review", "item:manage", "supplier:manage", "petty_cash:create", "petty_cash:read", "expense:read", "order:read", "order:update", "order:create", "order:pay", "dashboard:read"],
  aprobador: ["requisition:read:assigned", "requisition:approve", "requisition:return", "order:read", "dashboard:read"],
  contabilidad: ["requisition:read", "petty_cash:read", "expense:read", "report:export", "order:read", "order:account", "dashboard:read"],
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
/**
 * Reunión 2026-08-31: aritmética del formato Excel del cliente, redondeando por LÍNEA (no por unidad):
 * bruto = round(cantidad×precioUnitario) → descuento = round(bruto×descuentoTasa) → base = bruto−descuento
 * → iva = round(base×ivaTasa) (reutiliza calculateTax) → total = base+iva.
 * Compatibilidad hacia atrás: si `ivaRate` está ausente (línea legacy, previa a la tasa por ítem), el IVA se
 * calcula con el mecanismo histórico (cantidad × unitIva, sin descuento) en vez de asumir tasa 0 — de lo
 * contrario el primer cálculo de una requisición vieja pondría su IVA en cero en silencio. `ivaRate: 0`
 * explícito (nuevo estilo, ítem exento) sí usa la vía de tasa y da iva 0 deliberadamente.
 */
export function calculateLineAmounts(line: ItemLine): { base: Money; iva: Money; total: Money } {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new DomainError("INVALID_QUANTITY", "La cantidad debe ser mayor que cero");
  const unitBase = line.unitBase ?? 0; assertCop(unitBase, "Base unitaria");
  const bruto = Math.round(line.quantity * unitBase); assertCop(bruto, "Bruto de línea");
  const discountRate = line.discountRate ?? 0;
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) throw new DomainError("INVALID_MONEY", "Descuento inválido");
  const descuento = Math.round(bruto * discountRate), base = bruto - descuento; assertCop(base, "Base de línea");
  let iva: number;
  if (line.ivaRate !== undefined) {
    if (!Number.isFinite(line.ivaRate) || line.ivaRate < 0 || line.ivaRate > 1) throw new DomainError("INVALID_MONEY", "IVA inválido");
    iva = calculateTax(base, line.ivaRate).iva;
  } else {
    const unitIva = line.unitIva ?? 0, derivedUnitTotal = unitBase + unitIva; assertCop(unitIva, "IVA unitario");
    if (line.unitTotal !== undefined && line.unitTotal !== derivedUnitTotal) throw new DomainError("INCONSISTENT_TOTAL", "El total unitario no cuadra con base e IVA");
    iva = Math.round(line.quantity * unitIva);
  }
  const total = base + iva; assertCop(iva, "IVA de línea"); assertCop(total, "Total de línea"); return { base, iva, total };
}
export function calculateLineTotal(line: ItemLine): Money { return calculateLineAmounts(line).total; }
export function sumLines(lines: readonly ItemLine[]): Money { return lines.reduce((sum, line) => sum + calculateLineTotal(line), 0); }
/** Reunión 2026-08-31: "pendiente" cuenta como vigente (aún no decidido); solo "declinado" queda fuera. */
export function approvedLines(lines: readonly ItemLine[]): ItemLine[] { return lines.filter((line) => line.status !== "declinado"); }
/** Alimenta órdenes y gastos. `sumLines` NO cambia de semántica (la usan create() y dashboard.inProcessValue). */
export function sumApprovedLines(lines: readonly ItemLine[]): Money { return sumLines(approvedLines(lines)); }
export function assertHasApprovedLine(lines: readonly ItemLine[]): void { if (approvedLines(lines).length === 0) throw new DomainError("NO_APPROVED_ITEMS", "La requisición no tiene ítems aprobados"); }
/** Guía de UI: el botón "Generar órdenes" solo aplica a una requisición aprobada, sin órdenes previas y con algo que ordenar. */
export function canGenerateOrders(status: RequisitionStatus, existingOrderCount: number, lines: readonly ItemLine[]): boolean { return status === "aprobada" && existingOrderCount === 0 && approvedLines(lines).length > 0; }
const adminTransitions: Record<OrderAdminStatus, readonly OrderAdminStatus[]> = { pendiente: ["contabilizada"], contabilizada: ["pagada"], pagada: [] };
/**
 * Eje administrativo: pendiente → contabilizada → pagada, irreversible, sin saltos. Única interacción
 * deliberada con el eje de cumplimiento: una orden `no_necesario` no se contabiliza ni se paga.
 */
export function assertAdminTransition(from: OrderAdminStatus, to: OrderAdminStatus, fulfillment: OrderStatus): void {
  if (!adminTransitions[from].includes(to)) throw new DomainError("INVALID_ADMIN_TRANSITION", `No se puede pasar de ${from} a ${to}`);
  if (fulfillment === "no_necesario") throw new DomainError("ORDER_NOT_NEEDED", "Una orden no necesaria no se contabiliza ni se paga");
}
export function validateShares(total: Money, shares: readonly ExpenseShare[]): void {
  if (!Number.isInteger(total) || total <= 0 || shares.length === 0 || shares.some((share) => !share.expenseId || !share.workId || !Number.isInteger(share.amount) || share.amount <= 0)) throw new DomainError("INVALID_SHARE", "Reparto inválido");
  if (new Set(shares.map((share) => share.expenseId)).size !== 1 || new Set(shares.map((share) => share.workId)).size !== shares.length) throw new DomainError("INVALID_SHARE", "Cada reparto debe usar un gasto y obras únicas");
  if (shares.reduce((sum, share) => sum + share.amount, 0) !== total) throw new DomainError("UNBALANCED_SHARE", "El reparto debe cuadrar al peso");
}
export function orderTypeFor(requisitionType: "compra" | "pago"): OrderType { return requisitionType === "compra" ? "OC" : "OP"; }
/**
 * La generación de órdenes ya no admite el parámetro `multiSupplier`: siempre agrupa por proveedor final,
 * y lo exige en TODAS las líneas (antes, una orden de pago sin proveedor pasaba silenciosamente con clave
 * `undefined`). El llamador (generateOrders) debe pasar únicamente líneas aprobadas — esta función se
 * mantiene deliberadamente ciega al estado por ítem para que su prueba siga siendo legible.
 */
export function groupOrderItems(lines: readonly ItemLine[], type: "compra" | "pago"): Map<string, ItemLine[]> {
  if (lines.some((line) => !line.finalSupplierId)) throw new DomainError("SUPPLIER_REQUIRED", "Cada ítem debe tener proveedor final para generar la orden");
  if (type === "pago") {
    const suppliers = new Set(lines.map((line) => line.finalSupplierId as string));
    if (suppliers.size > 1) throw new DomainError("MULTI_SUPPLIER_PAYMENT", "Una orden de pago solo puede tener un proveedor");
    return new Map(lines.length ? [[lines[0].finalSupplierId as string, [...lines]]] : []);
  }
  const groups = new Map<string, ItemLine[]>();
  for (const line of lines) { const key = line.finalSupplierId as string; groups.set(key, [...(groups.get(key) ?? []), line]); }
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
  // Reunión 2026-08-31: contabilidad tiene su propia acción sobre el eje administrativo (order:account),
  // independiente de la confirmación de cumplimiento que ya ve el revisor.
  const canAccount = actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam");
  const items: DashboardQueueItem[] = [];
  if (canReview) for (const requisition of requisitions) if (requisition.status === "enviada" || requisition.status === "en_revision") items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Revisar" });
  if (canApprove) for (const requisition of requisitions) if (requisition.status === "en_aprobacion" && (actor.roles.includes("admin_sixteam") || requisition.approverId === actor.id)) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Aprobar" });
  for (const requisition of requisitions) if (requisition.status === "devuelta" && requisition.requesterId === actor.id) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Corregir" });
  if (canReview) for (const order of orders) if (order.status === "generada") items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId), status: order.status, action: "Confirmar cumplimiento" });
  // Una orden `no_necesario` nunca se contabiliza (assertAdminTransition la bloquea): no tiene sentido ponerla en la cola.
  if (canAccount) for (const order of orders) if (order.adminStatus === "pendiente" && order.status !== "no_necesario") items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId), status: order.adminStatus, action: "Contabilizar" });
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
