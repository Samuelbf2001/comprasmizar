import { describe, expect, it, vi, afterEach } from "vitest";
import { dispatchPendingNotifications, type NotificationDispatchStore, type PendingNotification } from "../../lib/infrastructure/notification-dispatcher";
import { sendKapsoTemplate } from "../../lib/infrastructure/kapso";

function notification(overrides: Partial<PendingNotification> = {}): PendingNotification {
  return { id: "n-1", phone: "+573001234567", template: "pendiente_aprobador", payload: { requisitionId: "11111111-1111-1111-1111-111111111111", consecutive: "REQ-2026-0001" }, attempts: 0, ...overrides };
}

/** Simple queue-backed mock: `claimBatch` just dequeues, mirroring the shape kapso-idempotency.test.ts uses for its store mock. */
function fakeStore(initial: PendingNotification[]) {
  const queue = [...initial];
  const calls = { markSent: [] as unknown[][], markRetry: [] as unknown[][], markFailed: [] as unknown[][], release: [] as unknown[][] };
  const store: NotificationDispatchStore = {
    claimBatch: async (limit) => queue.splice(0, limit),
    markSent: async (...args) => { calls.markSent.push(args); },
    markRetry: async (...args) => { calls.markRetry.push(args); },
    markFailed: async (...args) => { calls.markFailed.push(args); },
    release: async (...args) => { calls.release.push(args); },
  };
  return { store, calls };
}

describe("dispatchPendingNotifications", () => {
  it("sends a pending notification and marks it enviado with the returned message id", async () => {
    const { store, calls } = fakeStore([notification()]);
    const adapter = { sendTemplate: vi.fn(async () => ({ messageId: "wamid.1" })) };
    const outcome = await dispatchPendingNotifications(store, adapter);
    expect(outcome).toEqual({ claimed: 1, sent: 1, retried: 0, failed: 0, deferred: 0 });
    expect(adapter.sendTemplate).toHaveBeenCalledWith({ to: "+573001234567", template: "pendiente_aprobador", payload: { requisitionId: "11111111-1111-1111-1111-111111111111", consecutive: "REQ-2026-0001" } });
    expect(calls.markSent).toHaveLength(1);
    const [id, sent] = calls.markSent[0] as [string, { messageId: string; phone: string; template: string }];
    expect(id).toBe("n-1");
    expect(sent).toMatchObject({ messageId: "wamid.1", phone: "+573001234567", template: "pendiente_aprobador" });
  });

  it("retries a transient failure with backoff, staying pendiente without losing the notification", async () => {
    const { store, calls } = fakeStore([notification({ attempts: 1 })]);
    const adapter = { sendTemplate: vi.fn(async () => { throw new Error("network_error"); }) };
    const now = new Date("2026-08-24T00:00:00.000Z");
    const outcome = await dispatchPendingNotifications(store, adapter, { maxAttempts: 5, now: () => now, backoffMs: (attempts) => attempts * 1000 });
    expect(outcome).toEqual({ claimed: 1, sent: 0, retried: 1, failed: 0, deferred: 0 });
    expect(calls.markRetry).toEqual([["n-1", 2, "network_error", new Date(now.getTime() + 2000)]]);
    expect(calls.markFailed).toHaveLength(0);
  });

  it("marks fallido once the retry budget is exhausted, so it stops blocking the queue", async () => {
    const { store, calls } = fakeStore([notification({ attempts: 4 })]);
    const adapter = { sendTemplate: vi.fn(async () => { throw new Error("network_error"); }) };
    const outcome = await dispatchPendingNotifications(store, adapter, { maxAttempts: 5 });
    expect(outcome).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1, deferred: 0 });
    expect(calls.markFailed).toEqual([["n-1", 5, "network_error"]]);
  });

  it("fails closed on KAPSO_NOT_CONFIGURED: releases the whole batch, spends no attempt, marks nothing fallido", async () => {
    const { store, calls } = fakeStore([notification({ id: "n-1" }), notification({ id: "n-2" }), notification({ id: "n-3" })]);
    const adapter = { sendTemplate: vi.fn(async () => { throw new Error("KAPSO_NOT_CONFIGURED"); }) };
    const outcome = await dispatchPendingNotifications(store, adapter);
    expect(outcome).toEqual({ claimed: 3, sent: 0, retried: 0, failed: 0, deferred: 3 });
    expect(adapter.sendTemplate).toHaveBeenCalledTimes(1);
    expect(calls.release.map((call) => call[0])).toEqual(["n-1", "n-2", "n-3"]);
    expect(calls.markRetry).toHaveLength(0);
    expect(calls.markFailed).toHaveLength(0);
  });

  it("marks fallido immediately when no destination phone resolved, without calling the adapter", async () => {
    const { store, calls } = fakeStore([notification({ phone: "" })]);
    const adapter = { sendTemplate: vi.fn() };
    const outcome = await dispatchPendingNotifications(store, adapter);
    expect(outcome).toEqual({ claimed: 1, sent: 0, retried: 0, failed: 1, deferred: 0 });
    expect(adapter.sendTemplate).not.toHaveBeenCalled();
    expect(calls.markFailed).toEqual([["n-1", 0, "SIN_TELEFONO_DESTINO"]]);
  });

  it("does not double-send when two dispatch runs race for the same leased notification", async () => {
    // Mirrors the Postgres lease semantics of createPostgresNotificationDispatchStore: a claimed row
    // is unavailable to any other claimBatch until it is resolved or its lease expires.
    const record = { id: "n-1", phone: "+573001234567", template: "pendiente_aprobador", payload: {} as Record<string, unknown>, attempts: 0, leased: false };
    let sends = 0;
    const store: NotificationDispatchStore = {
      claimBatch: async () => { if (record.leased) return []; record.leased = true; return [{ id: record.id, phone: record.phone, template: record.template, payload: record.payload, attempts: record.attempts }]; },
      markSent: async () => { record.leased = false; },
      markRetry: async () => { record.leased = false; },
      markFailed: async () => { record.leased = false; },
      release: async () => { record.leased = false; },
    };
    const adapter = { sendTemplate: vi.fn(async () => { sends++; await new Promise((resolve) => setTimeout(resolve, 5)); return { messageId: `wamid.${sends}` }; }) };
    const [first, second] = await Promise.all([dispatchPendingNotifications(store, adapter), dispatchPendingNotifications(store, adapter)]);
    expect(sends).toBe(1);
    expect([first.claimed, second.claimed].sort()).toEqual([0, 1]);
  });
});

describe("sendKapsoTemplate (fail-closed contract with Kapso unconfigured)", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("throws KAPSO_NOT_CONFIGURED and never reaches the network when no API key is set", async () => {
    vi.stubEnv("KAPSO_API_KEY", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(sendKapsoTemplate({ to: "+573001234567", template: "pendiente_aprobador", payload: {} })).rejects.toThrow("KAPSO_NOT_CONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
