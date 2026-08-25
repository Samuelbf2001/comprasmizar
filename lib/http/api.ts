import { z, type ZodType } from "zod";
import { DomainError, type Actor } from "../domain";
import { requireServerActor } from "../infrastructure/auth";

const noStore = { "Cache-Control": "no-store" };
class RequestValidationError extends Error { constructor(readonly issues: z.core.$ZodIssue[]) { super("INVALID_INPUT"); } }

export async function parseJson<T>(request: Request, schema: ZodType<T>, maxBytes = 100_000): Promise<T> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new DomainError("INVALID_INPUT", "Se requiere application/json");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new DomainError("PAYLOAD_TOO_LARGE", "El cuerpo excede el límite permitido");
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > maxBytes) throw new DomainError("PAYLOAD_TOO_LARGE", "El cuerpo excede el límite permitido");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new DomainError("INVALID_INPUT", "JSON inválido"); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RequestValidationError(parsed.error.issues);
  return parsed.data;
}

/** Route params originate outside the typed server boundary; never let an invalid UUID reach Postgres. */
export async function parsePathParams<T>(params: Promise<unknown>, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await params);
  if (!parsed.success) throw new DomainError("INVALID_INPUT", "Parámetros de ruta inválidos");
  return parsed.data;
}

export function assertSameOrigin(request: Request): void {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) throw new Error("APP_ORIGIN_NOT_CONFIGURED");
  const origin = request.headers.get("origin");
  let expected: string;
  try { expected = new URL(configured).origin; } catch { throw new Error("APP_ORIGIN_NOT_CONFIGURED"); }
  if (!origin || origin !== expected) throw new DomainError("ORIGIN_FORBIDDEN", "Origen de solicitud no permitido");
}

export async function authenticatedJson(work: (actor: Actor) => Promise<unknown>, successStatus = 200): Promise<Response> {
  try { return Response.json(await work(await requireServerActor()), { status: successStatus, headers: noStore }); }
  catch (error) { return apiError(error); }
}

export function apiError(error: unknown): Response {
  if (error instanceof RequestValidationError) return Response.json({ error: "invalid_input", issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) }, { status: 400, headers: noStore });
  if (error instanceof DomainError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "UNAUTHENTICATED" ? 401 : ["FORBIDDEN", "NOT_ASSIGNED_APPROVER", "ORIGIN_FORBIDDEN"].includes(error.code) ? 403 : error.code === "CONFLICT" ? 409 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 422;
    return Response.json({ error: error.code.toLowerCase(), message: error.message }, { status, headers: noStore });
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "UNAUTHENTICATED") return Response.json({ error: "unauthenticated" }, { status: 401, headers: noStore });
  if (["ACCOUNT_INACTIVE", "AUTHZ_LOOKUP_FAILED", "ROLE_REQUIRED"].includes(code)) return Response.json({ error: "forbidden" }, { status: 403, headers: noStore });
  if (code === "APP_ORIGIN_NOT_CONFIGURED" || error instanceof z.ZodError) return Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
  return Response.json({ error: "internal_error" }, { status: 500, headers: noStore });
}
