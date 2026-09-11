export interface KapsoFlowItem { itemId?: string; proposedDescription?: string; quantity: number; unit: string; possibleSupplier?: string; productLink?: string; attachmentUrl?: string; }
/** Reunión 2026-08-31: el solicitante elige EMPRESA, no obra — el Flow ya no la pide. `societyId`
 *  es la identidad real y obligatoria; `workId` se conserva solo como compatibilidad y ya no se envía
 *  desde el Flow vigente (ver `lib/infrastructure/nfm-reply-adapter.ts`, `extractTopLevelFields`).
 *  `requiredDate` opcional en los tres canales (reunión 2026-08-31). MENOR (QA Postgres real): este
 *  tipo declaraba `destination?: string` (campo obsoleto, fusionado en `observations` desde el propio
 *  Flow — ya eliminado aquí) y `requiredDate: string` NO opcional, un desajuste con
 *  `kapsoWebhookSchema` (app/api/kapso/route.ts) que forzaba un `as unknown as` en la frontera HTTP y
 *  dejaba de proteger ese punto de entrada. */
export interface KapsoFlowSubmission { eventId: string; phone: string; societyId: string; workId?: string; requiredDate?: string; type: "compra" | "pago"; requesterName: string; observations?: string; items: KapsoFlowItem[]; }
export interface KapsoWebhookEvent { eventId: string; type: "flow_submission" | "message_status"; receivedAt: string; submission?: KapsoFlowSubmission; messageId?: string; deliveryStatus?: "sent" | "delivered" | "failed"; }
/** Adapter contract only: signatures and idempotency verification belong in the HTTP/Kapso adapter. */
export interface KapsoAdapter { verifySignature(rawBody: string, signature: string): boolean; recordInbound(event: KapsoWebhookEvent): Promise<void>; sendTemplate(input: { to: string; template: string; payload: Record<string, string> }): Promise<{ messageId: string }>; }
