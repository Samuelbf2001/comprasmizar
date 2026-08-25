import { dispatchPendingNotifications, createPostgresNotificationDispatchStore } from "../../../../lib/infrastructure/notification-dispatcher";
import { sendKapsoTemplate } from "../../../../lib/infrastructure/kapso";
import { safeEqual } from "../../../../lib/security/crypto";

export const runtime = "nodejs";
const noStore = { "Cache-Control": "no-store" };

/**
 * Internal-only endpoint that drains the `notificaciones` outbox (RF-406/904/905). Meant to be hit by
 * a scheduled job (VPS cron / hosting scheduler), never by a browser or an unauthenticated caller.
 *
 * Auth: a shared secret in `NOTIFICATION_DISPATCH_SECRET`, compared with `x-dispatch-secret` using a
 * constant-time check. No secret configured, no missing/mismatched header -> the route never touches
 * the queue; it is closed by default rather than open to the internet.
 *
 * The response carries counts only — never phone numbers or message content, per requirement.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.NOTIFICATION_DISPATCH_SECRET;
  if (!secret) return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
  const provided = request.headers.get("x-dispatch-secret") ?? "";
  if (!provided || !safeEqual(provided, secret)) return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });

  try {
    const store = createPostgresNotificationDispatchStore();
    const outcome = await dispatchPendingNotifications(store, { sendTemplate: sendKapsoTemplate });
    return Response.json({ ok: true, ...outcome }, { status: 200, headers: noStore });
  } catch {
    return Response.json({ error: "dispatch_failed" }, { status: 500, headers: noStore });
  }
}
