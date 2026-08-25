import type { KapsoAdapter, KapsoWebhookEvent } from "../services";
import { verifyKapsoSignature } from "../security/crypto";

export interface KapsoEventStore { seen(eventId: string): Promise<boolean>; record(event: KapsoWebhookEvent): Promise<void>; }
export type KapsoClaim = "claimed" | "completed" | "in_progress";
/** Durable claim contract: event_id must be unique and state transitions atomic in the database. */
export interface KapsoProcessingStore { claim(event: KapsoWebhookEvent): Promise<KapsoClaim>; complete(eventId: string, requisitionId?: string): Promise<void>; release(eventId: string): Promise<void>; findRequisitionId(eventId: string): Promise<string | null>; }

interface KapsoSendConfig { apiKey: string; baseUrl: string; timeoutMs: number; }
/**
 * Outbound sending needs its own API key (`KAPSO_API_KEY`), separate from the inbound webhook secret
 * (`KAPSO_WEBHOOK_SECRET`) already covered by `kapsoEnv()`. Read directly from `process.env`, same as
 * other operational settings outside the zod schemas (see `assertSameOrigin` in lib/http/api.ts) —
 * the account, number and approved templates are the external gate documented in docs/gates-externos.md,
 * not something a schema can validate.
 */
function kapsoSendConfig(): KapsoSendConfig | null {
  const apiKey = process.env.KAPSO_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.KAPSO_API_URL?.trim() || "https://api.kapso.ai").replace(/\/+$/, "");
  const timeoutMs = Number(process.env.KAPSO_SEND_TIMEOUT_MS) || 8_000;
  return { apiKey, baseUrl, timeoutMs };
}

/**
 * Real send path. Fails closed with `KAPSO_NOT_CONFIGURED` when no API key is set — the dispatcher
 * (lib/infrastructure/notification-dispatcher.ts) treats that specific error as "leave it pending,
 * never lose it, never count it as a failed attempt". Any other rejection (timeout, network error,
 * non-2xx response) is a normal `Error` that the dispatcher retries with backoff.
 * Never interpolate `input.to` or `input.payload` into thrown messages: those reach `ultimo_error` in
 * Postgres and must not leak phone numbers or message content.
 */
export async function sendKapsoTemplate(input: { to: string; template: string; payload: Record<string, string> }): Promise<{ messageId: string }> {
  const config = kapsoSendConfig();
  if (!config) throw new Error("KAPSO_NOT_CONFIGURED");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/v1/whatsapp/messages/templates`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ to: input.to, template: input.template, parameters: input.payload }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`KAPSO_SEND_FAILED_${response.status}`);
    const data = (await response.json().catch(() => null)) as { id?: string; messageId?: string } | null;
    const messageId = data?.messageId ?? data?.id;
    if (!messageId) throw new Error("KAPSO_SEND_RESPONSE_INVALID");
    return { messageId };
  } finally {
    clearTimeout(timeout);
  }
}

export class VerifiedKapsoAdapter implements KapsoAdapter {
  constructor(private readonly secret: string, private readonly store: KapsoEventStore) {}
  verifySignature(rawBody: string, signature: string): boolean { return verifyKapsoSignature(rawBody, signature, this.secret); }
  async recordInbound(event: KapsoWebhookEvent): Promise<void> { if (await this.store.seen(event.eventId)) return; await this.store.record(event); }
  sendTemplate(input: { to: string; template: string; payload: Record<string, string> }): Promise<{ messageId: string }> { return sendKapsoTemplate(input); }
}
