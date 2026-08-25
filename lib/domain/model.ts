/** Domain vocabulary. Monetary values are integer Colombian pesos (COP). */
export type Role = "solicitante" | "revisor" | "aprobador" | "contabilidad" | "admin_mizar" | "admin_sixteam";
export type RequisitionStatus = "enviada" | "en_revision" | "en_aprobacion" | "aprobada" | "devuelta" | "declinada";
export type RequisitionType = "compra" | "pago";
export type RequisitionChannel = "web" | "publico" | "whatsapp";
export type OrderType = "OC" | "OP";
export type OrderStatus = "generada" | "cumplida" | "no_cumplida" | "no_necesario";
export type Money = number;

export interface Actor { id: string; roles: readonly Role[]; }
export interface AuditEvent { entity: string; entityId: string; event: string; actorId?: string; at: Date; data?: Record<string, unknown>; origin?: "web" | "mcp" | "kapso"; }
export interface ItemLine {
  id: string; itemId?: string; description?: string; quantity: number; unit: string;
  /** Unit prices in COP. A line total is quantity × its corresponding unit price. */
  possibleSupplier?: string; productLink?: string; finalSupplierId?: string; unitBase?: Money; unitIva?: Money; unitTotal?: Money;
}
export interface Requisition {
  id: string; consecutive: string; type: RequisitionType; workId: string; requesterId?: string;
  externalRequester?: { name: string; phone?: string }; channel: RequisitionChannel; requiredDate: string;
  destination?: string; observations?: string; tagId?: string; approverId?: string; status: RequisitionStatus;
  declineReason?: string; returnReason?: string; /** Trusted Kapso event ID only; DB enforces uniqueness. */ kapsoEventId?: string; items: ItemLine[];
}
export interface Order { id: string; consecutive: string; type: OrderType; requisitionId: string; supplierId?: string; itemIds: string[]; status: OrderStatus; }
export interface Expense { id: string; workId: string; origin: "requisicion" | "caja_menor"; referenceId: string; tagId?: string; supplierId?: string; date: string; base: Money; iva: Money; total: Money; period: string; }
export interface ExpenseShare { expenseId: string; workId: string; amount: Money; }
export interface PettyCash { id: string; workId: string; date: string; concept: string; tagId: string; amount: Money; registeredBy: string; attachmentUrl?: string; }
export interface DashboardMetrics { byStatus: Record<RequisitionStatus, number>; inProcessValue: Money; periodExpense: Money; pendingOrders: number; }

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
