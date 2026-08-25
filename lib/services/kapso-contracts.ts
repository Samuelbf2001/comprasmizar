export interface KapsoFlowItem { itemId?: string; proposedDescription?: string; quantity: number; unit: string; possibleSupplier?: string; productLink?: string; attachmentUrl?: string; }
export interface KapsoFlowSubmission { eventId: string; phone: string; workId: string; requiredDate: string; type: "compra" | "pago"; requesterName: string; items: KapsoFlowItem[]; }
export interface KapsoWebhookEvent { eventId: string; type: "flow_submission" | "message_status"; receivedAt: string; submission?: KapsoFlowSubmission; messageId?: string; deliveryStatus?: "sent" | "delivered" | "failed"; }
/** Adapter contract only: signatures and idempotency verification belong in the HTTP/Kapso adapter. */
export interface KapsoAdapter { verifySignature(rawBody: string, signature: string): boolean; recordInbound(event: KapsoWebhookEvent): Promise<void>; sendTemplate(input: { to: string; template: string; payload: Record<string, string> }): Promise<{ messageId: string }>; }
