import { z } from "zod";
import { randomUUID } from "node:crypto";
import { processKapsoEvent, type KapsoRequisitionCreator } from "../../../lib/infrastructure/kapso-processor";
import { createKapsoAttachmentCopier, createPostgresKapsoProcessingStore, type KapsoAttachmentSource } from "../../../lib/infrastructure/kapso-store";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService, type KapsoWebhookEvent } from "../../../lib/services";
import { verifyKapsoSignature } from "../../../lib/security/crypto";
import { isKapsoConfigured, kapsoEnv } from "../../../lib/security/env";
import { adaptNfmReply, createPostgresNfmReplyRejectionRecorder, isNfmReplyWebhookPayload, resolveKapsoMediaDownloadUrl } from "../../../lib/infrastructure/nfm-reply-adapter";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 100_000;
/**
 * Reads at most `maxBytes` off the request stream, cancelling it the moment the running total
 * crosses the limit — a spoofed or absent content-length header must not let an oversized body be
 * fully buffered in memory before it gets rejected (endurecimiento: antes se validaba con
 * Buffer.byteLength sobre el resultado de request.text(), que ya había bufferizado todo).
 */
async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) { const raw = await request.text(); return Buffer.byteLength(raw, "utf8") > maxBytes ? null : raw; }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel("payload_too_large").catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}
const httpsUrl = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const kapsoItemSchema = z.object({
  quantity: z.number().finite().positive().max(1_000_000), unit: z.string().trim().min(1).max(40),
  itemId: z.string().uuid().optional(), proposedDescription: z.string().trim().min(1).max(500).optional(),
  possibleSupplier: z.string().trim().min(1).max(240).optional(), productLink: httpsUrl.optional(), attachmentUrl: httpsUrl.optional(),
}).strict().refine((item) => Boolean(item.itemId || item.proposedDescription), { message: "itemId or proposedDescription is required" });

export const kapsoWebhookSchema = z.object({
  eventId: z.string().trim().min(1).max(200), type: z.enum(["flow_submission", "message_status"]), receivedAt: z.string().datetime(),
  messageId: z.string().trim().min(1).max(200).optional(), deliveryStatus: z.enum(["sent", "delivered", "failed"]).optional(),
  submission: z.object({ eventId: z.string().trim().min(1).max(200), phone: z.string().trim().min(7).max(20), workId: z.string().uuid(), requiredDate: z.string().date(), type: z.enum(["compra", "pago"]), requesterName: z.string().trim().min(2).max(160), destination: z.string().trim().min(1).max(500).optional(), observations: z.string().trim().min(1).max(1024).optional(), items: z.array(kapsoItemSchema).min(1).max(100) }).strict().optional(),
}).strict().superRefine((event, context) => {
  if (event.type === "flow_submission" && !event.submission) context.addIssue({ code: z.ZodIssueCode.custom, message: "submission required" });
  if (event.submission && event.submission.eventId !== event.eventId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["submission", "eventId"], message: "event IDs must match" });
});
export async function POST(request: Request) {
  if (!isKapsoConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) return Response.json({ error: "invalid_event" }, { status: 413 });
  const raw = await readBoundedBody(request, MAX_BODY_BYTES);
  if (raw === null) return Response.json({ error: "invalid_event" }, { status: 413 });
  if (!verifyKapsoSignature(raw, request.headers.get("x-kapso-signature") ?? "", kapsoEnv().KAPSO_WEBHOOK_SECRET)) return Response.json({ error: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: "invalid_event" }, { status: 400 }); }

  // Un envío real de Kapso para un WhatsApp Flow llega como `{ message: { interactive: { type:
  // "nfm_reply", ... } } }` (ver lib/infrastructure/nfm-reply-adapter.ts), no como el contrato ya
  // normalizado `{eventId, type, receivedAt, submission}` que valida kapsoWebhookSchema más abajo.
  // Este bloque traduce ese caso concreto y reescribe `payload` con el evento normalizado antes de
  // seguir; cualquier otro payload (incluido el shape ya normalizado que usan los fixtures/pruebas
  // existentes) sigue el camino de siempre sin cambios.
  if (isNfmReplyWebhookPayload(payload)) {
    const adapted = await adaptNfmReply(payload, { secret: kapsoEnv().KAPSO_WEBHOOK_SECRET, resolveAttachmentUrl: resolveKapsoMediaDownloadUrl });
    if (!adapted.ok) {
      try {
        await createPostgresNfmReplyRejectionRecorder().record({ wamid: adapted.wamid, phone: adapted.phone, reason: adapted.reason, rawPayload: payload });
      } catch {
        // El registro de auditoría es best-effort: un rechazo neutro nunca debe convertirse en 500.
      }
      return Response.json({ received: true, status: "rejected", reason: adapted.reason });
    }
    payload = adapted.event;
  }

  const parsed = kapsoWebhookSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "invalid_event" }, { status: 400 });
  const event = parsed.data as KapsoWebhookEvent;

  const store = createPostgresKapsoProcessingStore();
  const dependencies = createPostgresDependencies();
  const service = new ProcurementService(dependencies);
  const attachmentCopier = createKapsoAttachmentCopier();
  const creator: KapsoRequisitionCreator = {
    findExisting: async (eventId: string) => {
      const requisitionId = await store.findRequisitionId(eventId);
      return requisitionId ? dependencies.requisitions.get(requisitionId) : null;
    },
    create: async (inputEvent: KapsoWebhookEvent) => {
      const submission = inputEvent.submission;
      if (!submission) throw new Error("KAPSO_SUBMISSION_REQUIRED");
      return service.create({
        type: submission.type,
        workId: submission.workId,
        requiredDate: submission.requiredDate,
        channel: "whatsapp",
        kapsoEventId: inputEvent.eventId,
        destination: submission.destination,
        observations: submission.observations,
        externalRequester: { name: submission.requesterName, phone: submission.phone },
        items: submission.items.map((item) => ({
          id: randomUUID(),
          itemId: item.itemId,
          description: item.proposedDescription,
          quantity: item.quantity,
          unit: item.unit,
          possibleSupplier: item.possibleSupplier,
          productLink: item.productLink,
          unitBase: 0,
          unitIva: 0,
        })),
      }, { origin: "kapso" });
    },
    // The Flow may carry evidence photos per item. A download/copy failure must never take down
    // an otherwise-valid requisition (RF-903): processKapsoEvent already isolates this call, and
    // the copier itself isolates each item and self-logs any failure for manual retry.
    attachEvidence: async (inputEvent, requisition) => {
      const submission = inputEvent.submission;
      if (!submission) return;
      const sources: KapsoAttachmentSource[] = [];
      submission.items.forEach((item, index) => {
        const itemId = requisition.items[index]?.id;
        if (item.attachmentUrl && itemId) sources.push({ itemId, attachmentUrl: item.attachmentUrl });
      });
      if (sources.length) await attachmentCopier.copyAll(inputEvent, requisition.id, sources);
    },
  };

  try {
    const result = await processKapsoEvent(store, creator, event);
    if (result === "in_progress") return Response.json({ received: true, status: "processing" }, { status: 202 });
    return Response.json({ received: true, status: result });
  } catch {
    return Response.json({ error: "processing_failed" }, { status: 503 });
  }
}
