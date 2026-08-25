import type { KapsoAdapter, KapsoWebhookEvent } from "../services";
import { verifyKapsoSignature } from "../security/crypto";

export interface KapsoEventStore { seen(eventId: string): Promise<boolean>; record(event: KapsoWebhookEvent): Promise<void>; }
export type KapsoClaim = "claimed" | "completed" | "in_progress";
/** Durable claim contract: event_id must be unique and state transitions atomic in the database. */
export interface KapsoProcessingStore { claim(event: KapsoWebhookEvent): Promise<KapsoClaim>; complete(eventId: string, requisitionId?: string): Promise<void>; release(eventId: string): Promise<void>; findRequisitionId(eventId: string): Promise<string | null>; }
export class VerifiedKapsoAdapter implements KapsoAdapter {
  constructor(private readonly secret: string, private readonly store: KapsoEventStore) {}
  verifySignature(rawBody: string, signature: string): boolean { return verifyKapsoSignature(rawBody, signature, this.secret); }
  async recordInbound(event: KapsoWebhookEvent): Promise<void> { if (await this.store.seen(event.eventId)) return; await this.store.record(event); }
  async sendTemplate(): Promise<{ messageId: string }> { throw new Error("KAPSO_NOT_CONFIGURED"); }
}
