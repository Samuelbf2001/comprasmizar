/** Domain vocabulary. Monetary values are integer Colombian pesos (COP). */
export type Role = "solicitante" | "revisor" | "aprobador" | "contabilidad" | "admin_mizar" | "admin_sixteam";
export type RequisitionStatus = "enviada" | "en_revision" | "en_aprobacion" | "aprobada" | "devuelta" | "declinada";
export type RequisitionType = "compra" | "pago";
export type RequisitionChannel = "web" | "publico" | "whatsapp";
export type OrderType = "OC" | "OP";
export type OrderStatus = "generada" | "cumplida" | "no_cumplida" | "no_necesario";
/** Reunión 2026-08-31: decisión del aprobador por ítem. Ausente en una fila cargada de BD = 'pendiente' (default de columna). */
export type ItemStatus = "pendiente" | "aprobado" | "declinado";
/** Reunión 2026-08-31: eje administrativo/contable de una orden, independiente de OrderStatus (cumplimiento). */
export type OrderAdminStatus = "pendiente" | "contabilizada" | "pagada";
export type Money = number;

export interface Actor { id: string; roles: readonly Role[]; }
export interface AuditEvent { entity: string; entityId: string; event: string; actorId?: string; at: Date; data?: Record<string, unknown>; origin?: "web" | "mcp" | "kapso"; }
export interface ItemLine {
  id: string; itemId?: string; description?: string; quantity: number; unit: string;
  /** Unit prices in COP. A line total is quantity × its corresponding unit price. */
  possibleSupplier?: string; productLink?: string; finalSupplierId?: string; unitBase?: Money; unitIva?: Money; unitTotal?: Money;
  /** Reunión 2026-08-31: decisión del aprobador por ítem; ausente = pendiente. Declinar exige declineReason. */
  status?: ItemStatus; declineReason?: string;
  /** Fracción 0..1 (0.19, no 19). Ausente = línea legacy sin tasa capturada; ver calculateLineAmounts para el fallback. */
  ivaRate?: number; discountRate?: number;
}
export interface Requisition {
  id: string; consecutive: string; type: RequisitionType;
  /** Reunión 2026-08-31: el solicitante elige empresa, no obra; la obra (centro de costo) la asigna el revisor.
   *  Opcional: solo puede faltar en el canal público, cuyo enlace ya está anclado a una obra concreta y cuya
   *  sociedad deriva la base (trigger `requisiciones_0_derivar_sociedad`) — nunca se le pide al público. */
  societyId?: string; workId?: string; requesterId?: string;
  externalRequester?: { name: string; phone?: string }; channel: RequisitionChannel; requiredDate?: string;
  observations?: string; tagId?: string; approverId?: string; status: RequisitionStatus;
  /** Forma de pago capturada en la revisión, persistida en `requisiciones.forma_pago` y copiada a cada
   *  orden generada (`ordenes.forma_pago`). Ver procurement-service.ts. */
  paymentTerms?: string;
  declineReason?: string; returnReason?: string; /** Trusted Kapso event ID only; DB enforces uniqueness. */ kapsoEventId?: string; items: ItemLine[];
  /** RF-1102: última modificación (ISO), poblada solo por el adaptador Postgres; ausente en objetos construidos en memoria. */
  updatedAt?: string;
}
export interface Order {
  id: string; consecutive: string; type: OrderType; requisitionId: string; supplierId?: string; itemIds: string[]; status: OrderStatus;
  /** Reunión 2026-08-31: eje administrativo/contable, independiente de `status` (cumplimiento). */
  adminStatus: OrderAdminStatus; generatedAt?: string; accountedAt?: string; paidAt?: string; paymentTerms?: string;
  /** RF-1102: ver Requisition.updatedAt. */ updatedAt?: string;
}
/**
 * Decisión del cliente (reunión 2026-09, literal): "que quede como fechas aparte cuándo se sube y
 * cuándo se paga; la del gasto es la del pago". `orderDate`: fecha en que nace el registro (generación
 * de la orden, o el movimiento de caja menor); nunca cambia. `date`/`period` (mes de `date`): fecha y
 * periodo del GASTO, es decir del PAGO — ausentes mientras la orden que lo originó no se ha pagado
 * (es un compromiso, todavía no un gasto). Para `origin: "caja_menor"` ambas fechas coinciden siempre
 * (se paga en el acto).
 */
export interface Expense { id: string; workId: string; origin: "requisicion" | "caja_menor"; referenceId: string; tagId?: string; supplierId?: string; orderDate: string; date?: string; base: Money; iva: Money; total: Money; period?: string; }
export interface ExpenseShare { expenseId: string; workId: string; amount: Money; }
export interface PettyCash { id: string; workId: string; date: string; concept: string; tagId: string; amount: Money; registeredBy: string; attachmentUrl?: string; }
/** RF-1102: un elemento de la cola de "qué espera algo de mí" en el dashboard conectado. */
export interface DashboardQueueItem { kind: "requisicion" | "orden"; id: string; consecutive: string; workId?: string; status: string; action: string; }
/** RF-1102: un evento de la lista de actividad reciente del dashboard conectado. */
export interface DashboardActivityItem { kind: "requisicion" | "orden" | "gasto"; id: string; consecutive: string; workId?: string; status: string; at: string; }
/** RF-706/RF-1103: un punto agregado (obra, etiqueta o periodo) para los gráficos ejecutivos de gasto. */
export interface DashboardAmountByKey { key: string; total: Money; }
export interface DashboardMetrics {
  byStatus: Record<RequisitionStatus, number>; inProcessValue: Money; periodExpense: Money; pendingOrders: number;
  /** RF-1102/RF-706/RF-1103: agregados por el servicio después de calculateDashboard(); opcionales para no romper llamadas existentes. */
  attentionQueue?: DashboardQueueItem[]; recentActivity?: DashboardActivityItem[];
  expenseByWork?: DashboardAmountByKey[]; expenseByTag?: DashboardAmountByKey[]; expenseByPeriod?: DashboardAmountByKey[];
}

/** Supplier records are deliberately separate from the generic catalogue shape: bank data must never leak through catalogue/bootstrap responses. */
export interface SupplierContact { name?: string; phone?: string; email?: string; address?: string; }
export interface SupplierBankDetails { bankName?: string; accountType?: "ahorros" | "corriente"; accountNumber?: string; accountHolder?: string; accountHolderNit?: string; }
export interface Supplier { id: string; name: string; nit?: string | null; contact: SupplierContact; bankDetails: SupplierBankDetails; active: boolean; }
export type SupplierDocumentType = "rut" | "camara_comercio" | "certificacion_bancaria" | "certificado_calidad";
/** A document record only exists after its private Storage object passed server-side HEAD validation. */
export interface SupplierDocument { id: string; supplierId: string; type: SupplierDocumentType; name: string; mimeType: string; sizeBytes: number; uploadedBy?: string; uploadedAt: string; storagePath: string; }
export interface SupplierOrderHistory { id: string; consecutive: string; type: OrderType; status: OrderStatus; generatedAt: string; total: Money; }

/** A generic private support always belongs to one allowed parent; Storage keys remain internal. */
export type AttachmentEntity = "requisicion" | "requisicion_item" | "caja_menor";
export interface PrivateAttachment { id: string; entity: AttachmentEntity; entityId: string; type: string; name: string; mimeType: string; sizeBytes: number; uploadedBy?: string; uploadedAt: string; storagePath: string; }

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DomainError"; }
}
