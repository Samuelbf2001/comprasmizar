import { z, type ZodType } from "zod";
import { DomainError, type Actor, type PaymentMethod, type PaymentStatus } from "../domain";
import { requireServerActor } from "../infrastructure/auth";
import type { ListQuery } from "../services/list-query";
import { PAYMENT_METHOD_VALUES, PAYMENT_STATUS_VALUES } from "./schemas";

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

/**
 * Origen propio con el que se compara el `Origin` del navegador.
 *
 * `APP_ORIGIN` primero, y `NEXT_PUBLIC_APP_URL` solo como respaldo, por una razón que costó una
 * producción rota: Next SUSTITUYE `process.env.NEXT_PUBLIC_*` por un literal en tiempo de
 * compilación, también en el código de servidor. Si la build no recibe el valor, aquí no queda una
 * variable que leer sino la constante `undefined`, y el compilador poda el resto de la función
 * dejando un `throw` incondicional. Entonces la variable puesta en el entorno del contenedor ya no
 * sirve de nada: llega tarde. Eso fue exactamente lo que pasó el 11-sep-2026 — la imagen se
 * construyó en el VPS sin `args`, el `ARG NEXT_PUBLIC_APP_URL=""` del Dockerfile quedó vacío, y
 * TODA escritura (aprobar, guardar revisión, crear) respondió 503 mientras las lecturas seguían
 * funcionando, que es la forma más difícil de diagnosticar que tiene esto de fallar.
 *
 * `APP_ORIGIN` no lleva el prefijo `NEXT_PUBLIC_`, así que se lee en ejecución y se puede corregir
 * sin reconstruir la imagen. `/api/health` informa si está resuelto (componente `origin`).
 */
export function appOrigin(): string | undefined { return process.env.APP_ORIGIN?.trim() || process.env.NEXT_PUBLIC_APP_URL?.trim() || undefined; }

export function assertSameOrigin(request: Request): void {
  const configured = appOrigin();
  if (!configured) throw new Error("APP_ORIGIN_NOT_CONFIGURED");
  const origin = request.headers.get("origin");
  let expected: string;
  try { expected = new URL(configured).origin; } catch { throw new Error("APP_ORIGIN_NOT_CONFIGURED"); }
  if (!origin || origin !== expected) throw new DomainError("ORIGIN_FORBIDDEN", "Origen de solicitud no permitido");
}

const roundMs = (ms: number) => Math.round(ms * 10) / 10;
/** H8 (docs/plan-rendimiento.md): sin esto no había forma de saber, desde afuera, cuánto de una
 *  respuesta lenta era autenticación (H1) vs el trabajo propio del endpoint — Caddy ya loguea la
 *  latencia total por request, pero no la partición. Formato estándar `Server-Timing` (un `dur` por
 *  métrica), legible por la pestaña Red de cualquier navegador sin instrumentación adicional. */
function serverTimingHeader(authMs: number, workMs: number): string { return `auth;dur=${roundMs(authMs)}, work;dur=${roundMs(workMs)}`; }

export async function authenticatedJson(work: (actor: Actor) => Promise<unknown>, successStatus = 200): Promise<Response> {
  const start = performance.now();
  let afterAuth: number | undefined;
  try {
    const actor = await requireServerActor();
    afterAuth = performance.now();
    const result = await work(actor);
    return Response.json(result, { status: successStatus, headers: { ...noStore, "Server-Timing": serverTimingHeader(afterAuth - start, performance.now() - afterAuth) } });
  } catch (error) {
    const now = performance.now();
    // afterAuth solo queda definido si requireServerActor() ya había resuelto: separa cuánto tiempo se
    // fue en autenticar de cuánto en el `work` que falló, sin fingir un tiempo de trabajo que nunca corrió.
    const authMs = afterAuth === undefined ? now - start : afterAuth - start;
    const workMs = afterAuth === undefined ? 0 : now - afterAuth;
    return apiError(error, serverTimingHeader(authMs, workMs));
  }
}

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
/**
 * H3 (docs/plan-rendimiento.md, Fase 3): parsea los parámetros de query compartidos por requisiciones,
 * órdenes, gastos y caja menor (`status`, `workId`, `from`, `to`, `limit`, `cursor`) en un `ListQuery`.
 * `statusValues`, cuando se pasa, restringe `status` a los valores válidos de esa entidad — se omite en
 * las rutas de gastos/caja menor (no tienen columna de estado): un `?status=` en esas rutas se IGNORA a
 * propósito, no falla (ver el comentario de `ListQuery` en lib/services/list-query.ts). `paginated` es
 * la señal exacta que cada ruta usa para decidir el shape de la respuesta: `true` solo si `limit` o
 * `cursor` vinieron en la URL (responde `{ rows, nextCursor }`); `false` si no (responde el array de
 * siempre, con filtros aplicados si los hay).
 */
export function parseListQuery(url: URL, statusValues?: readonly string[]): { query: ListQuery; paginated: boolean } {
  const params = url.searchParams, query: ListQuery = {};
  const rawStatus = params.get("status");
  if (rawStatus !== null && statusValues) {
    const values = rawStatus.split(",").map((value) => value.trim()).filter(Boolean);
    if (!values.length) throw new DomainError("INVALID_INPUT", "status no puede estar vacío");
    for (const value of values) if (!statusValues.includes(value)) throw new DomainError("INVALID_INPUT", `status inválido: ${value}`);
    query.status = values;
  }
  const rawWorkId = params.get("workId");
  if (rawWorkId !== null) { if (!z.string().uuid().safeParse(rawWorkId).success) throw new DomainError("INVALID_INPUT", "workId debe ser un uuid válido"); query.workId = rawWorkId; }
  const rawCostCenterId = params.get("costCenterId");
  if (rawCostCenterId !== null) { if (!z.string().uuid().safeParse(rawCostCenterId).success) throw new DomainError("INVALID_INPUT", "costCenterId debe ser un uuid válido"); query.costCenterId = rawCostCenterId; }
  // RF-509/RF-707 (adenda de pagos): empresa facturada — requisiciones, órdenes y gastos.
  const rawBilledCompanyId = params.get("billedCompanyId");
  if (rawBilledCompanyId !== null) { if (!z.string().uuid().safeParse(rawBilledCompanyId).success) throw new DomainError("INVALID_INPUT", "billedCompanyId debe ser un uuid válido"); query.billedCompanyId = rawBilledCompanyId; }
  // Cajas (2026-09-12): `?cashBoxId=` genérico para caja menor/ingresos; `/api/expenses` usa además
  // `?cajaId=` (ver app/api/expenses/route.ts) — mismo filtro, nombre de parámetro pedido aparte.
  const rawCashBoxId = params.get("cashBoxId");
  if (rawCashBoxId !== null) { if (!z.string().uuid().safeParse(rawCashBoxId).success) throw new DomainError("INVALID_INPUT", "cashBoxId debe ser un uuid válido"); query.cashBoxId = rawCashBoxId; }
  // RF-509 (adenda de pagos): filtros del panel de órdenes — solo los consume `listVisibleOrders`; en
  // las demás rutas se aceptan y se ignoran, mismo criterio aditivo que costCenterId/cashBoxId.
  const rawPaymentMethod = params.get("paymentMethod");
  if (rawPaymentMethod !== null) { if (!(PAYMENT_METHOD_VALUES as readonly string[]).includes(rawPaymentMethod)) throw new DomainError("INVALID_INPUT", `paymentMethod inválido: ${rawPaymentMethod}`); query.paymentMethod = rawPaymentMethod as PaymentMethod; }
  const rawPaymentStatus = params.get("paymentStatus");
  if (rawPaymentStatus !== null) { if (!(PAYMENT_STATUS_VALUES as readonly string[]).includes(rawPaymentStatus)) throw new DomainError("INVALID_INPUT", `paymentStatus inválido: ${rawPaymentStatus}`); query.paymentStatus = rawPaymentStatus as PaymentStatus; }
  for (const field of ["from", "to", "paidFrom", "paidTo"] as const) {
    const raw = params.get(field);
    if (raw !== null) { if (!isoDatePattern.test(raw) || Number.isNaN(Date.parse(raw))) throw new DomainError("INVALID_INPUT", `${field} debe ser una fecha YYYY-MM-DD`); query[field] = raw; }
  }
  const rawLimit = params.get("limit");
  if (rawLimit !== null) {
    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) throw new DomainError("INVALID_INPUT", "limit debe ser un entero entre 1 y 200");
    query.limit = parsedLimit;
  }
  const rawCursor = params.get("cursor");
  if (rawCursor !== null) { if (!rawCursor.trim()) throw new DomainError("INVALID_INPUT", "cursor inválido"); query.cursor = rawCursor; }
  return { query, paginated: rawLimit !== null || rawCursor !== null };
}
/** `true` si `query` trae algún filtro (status/workId/from/to) — decide si el modo "array sin paginar"
 *  debe reutilizar el camino filtrado (con el límite por defecto de `pageLimit`, ver
 *  lib/services/list-query.ts) o el camino sin `query` de siempre, más barato. */
export function hasListFilters(query: ListQuery): boolean { return query.status !== undefined || query.workId !== undefined || query.costCenterId !== undefined || query.billedCompanyId !== undefined || query.cashBoxId !== undefined || query.from !== undefined || query.to !== undefined || query.paymentMethod !== undefined || query.paymentStatus !== undefined || query.paidFrom !== undefined || query.paidTo !== undefined; }

export function apiError(error: unknown, serverTiming?: string): Response {
  const headers = serverTiming ? { ...noStore, "Server-Timing": serverTiming } : noStore;
  if (error instanceof RequestValidationError) return Response.json({ error: "invalid_input", issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) }, { status: 400, headers });
  if (error instanceof DomainError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "UNAUTHENTICATED" ? 401 : ["FORBIDDEN", "NOT_ASSIGNED_APPROVER", "ORIGIN_FORBIDDEN"].includes(error.code) ? 403 : error.code === "CONFLICT" ? 409 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 422;
    return Response.json({ error: error.code.toLowerCase(), message: error.message }, { status, headers });
  }
  const code = error instanceof Error ? error.message : "";
  if (code === "UNAUTHENTICATED") return Response.json({ error: "unauthenticated" }, { status: 401, headers });
  if (["ACCOUNT_INACTIVE", "AUTHZ_LOOKUP_FAILED", "ROLE_REQUIRED"].includes(code)) return Response.json({ error: "forbidden" }, { status: 403, headers });
  if (code === "APP_ORIGIN_NOT_CONFIGURED" || error instanceof z.ZodError) return Response.json({ error: "service_unavailable" }, { status: 503, headers });
  return Response.json({ error: "internal_error" }, { status: 500, headers });
}
