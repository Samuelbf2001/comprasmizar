import type { Requisition } from "../domain";
import type { KapsoWebhookEvent } from "../services";
import type { KapsoProcessingStore } from "./kapso";

export interface KapsoRequisitionCreator { findExisting(eventId: string): Promise<Requisition | null>; create(event: KapsoWebhookEvent): Promise<Requisition>; }
export type KapsoProcessResult = "created" | "duplicate" | "in_progress";
/** A failure releases its claim; a retry may safely continue. The creator must be idempotent by event_id in production. */
export async function processKapsoEvent(store: KapsoProcessingStore, creator: KapsoRequisitionCreator, event: KapsoWebhookEvent): Promise<KapsoProcessResult> { const claim = await store.claim(event); if (claim === "completed") return "duplicate"; if (claim === "in_progress") return "in_progress"; try { const existing = event.type === "flow_submission" ? await creator.findExisting(event.eventId) : null; if (existing) { await store.complete(event.eventId, existing.id); return "duplicate"; } const requisition = event.type === "flow_submission" ? await creator.create(event) : undefined; await store.complete(event.eventId, requisition?.id); return "created"; } catch (error) { const persisted = event.type === "flow_submission" ? await creator.findExisting(event.eventId) : null; if (persisted) { await store.complete(event.eventId, persisted.id); return "duplicate"; } await store.release(event.eventId); throw error; } }
