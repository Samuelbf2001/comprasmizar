import { z } from "zod";
import { randomUUID } from "node:crypto";
import { processKapsoEvent } from "../../../lib/infrastructure/kapso-processor";
import { createPostgresKapsoProcessingStore } from "../../../lib/infrastructure/kapso-store";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService, type KapsoWebhookEvent } from "../../../lib/services";
import { verifyKapsoSignature } from "../../../lib/security/crypto";
import { isKapsoConfigured, kapsoEnv } from "../../../lib/security/env";

export const runtime = "nodejs";
const httpsUrl = z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required");
const kapsoItemSchema = z.object({
  quantity: z.number().finite().positive().max(1_000_000), unit: z.string().trim().min(1).max(40),
  itemId: z.string().uuid().optional(), proposedDescription: z.string().trim().min(1).max(500).optional(),
  possibleSupplier: z.string().trim().min(1).max(240).optional(), productLink: httpsUrl.optional(), attachmentUrl: httpsUrl.optional(),
}).strict().refine((item) => Boolean(item.itemId || item.proposedDescription), { message: "itemId or proposedDescription is required" });

export const kapsoWebhookSchema = z.object({
  eventId: z.string().trim().min(1).max(200), type: z.enum(["flow_submission", "message_status"]), receivedAt: z.string().datetime(),
  messageId: z.string().trim().min(1).max(200).optional(), deliveryStatus: z.enum(["sent", "delivered", "failed"]).optional(),
  submission: z.object({ eventId: z.string().trim().min(1).max(200), phone: z.string().trim().min(7).max(20), workId: z.string().uuid(), requiredDate: z.string().date(), type: z.enum(["compra", "pago"]), requesterName: z.string().trim().min(2).max(160), items: z.array(kapsoItemSchema).min(1).max(100) }).strict().optional(),
}).strict().superRefine((event, context) => {
  if (event.type === "flow_submission" && !event.submission) context.addIssue({ code: z.ZodIssueCode.custom, message: "submission required" });
  if (event.submission && event.submission.eventId !== event.eventId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["submission", "eventId"], message: "event IDs must match" });
});
export async function POST(request: Request) {
  if (!isKapsoConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 });
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 100_000) return Response.json({ error: "invalid_event" }, { status: 413 });
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > 100_000) return Response.json({ error: "invalid_event" }, { status: 413 });
  if (!verifyKapsoSignature(raw, request.headers.get("x-kapso-signature") ?? "", kapsoEnv().KAPSO_WEBHOOK_SECRET)) return Response.json({ error: "unauthorized" }, { status: 401 });

  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return Response.json({ error: "invalid_event" }, { status: 400 }); }
  const parsed = kapsoWebhookSchema.safeParse(payload);
  if (!parsed.success) return Response.json({ error: "invalid_event" }, { status: 400 });
  const event = parsed.data as KapsoWebhookEvent;

  // The Flow may carry private evidence. It remains fail-closed until its HTTPS
  // bytes can be copied to the private Supabase bucket and malware-validated.
  if (event.submission?.items.some((item) => item.attachmentUrl)) return Response.json({ error: "attachment_storage_not_configured" }, { status: 503 });

  const store = createPostgresKapsoProcessingStore();
  const dependencies = createPostgresDependencies();
  const service = new ProcurementService(dependencies);
  const creator = {
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
  };

  try {
    const result = await processKapsoEvent(store, creator, event);
    if (result === "in_progress") return Response.json({ received: true, status: "processing" }, { status: 202 });
    return Response.json({ received: true, status: result });
  } catch {
    return Response.json({ error: "processing_failed" }, { status: 503 });
  }
}
