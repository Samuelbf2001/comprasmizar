import type { DashboardMetrics, Expense, ExpenseShare, ItemLine, Money, Order, OrderType, RequisitionStatus, Role } from "./model";
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
