import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../../lib/domain";
import { apiError, assertSameOrigin, parseJson, parsePathParams } from "../../lib/http/api";
import { reviewedItemSchema } from "../../lib/http/schemas";

const previousUrl = process.env.NEXT_PUBLIC_APP_URL;
afterEach(() => { if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = previousUrl; });

describe("authenticated HTTP boundary", () => {
  it("accepts bounded JSON and rejects unsupported or oversized bodies", async () => {
    await expect(parseJson(new Request("https://mizar.test/api", { method: "POST", headers: { "content-type": "application/json" }, body: '{"name":"ok"}' }), z.object({ name: z.string() }))).resolves.toEqual({ name: "ok" });
    await expect(parseJson(new Request("https://mizar.test/api", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), z.object({}))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(parseJson(new Request("https://mizar.test/api", { method: "POST", headers: { "content-type": "application/json", "content-length": "100001" }, body: "{}" }), z.object({}))).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("requires the exact configured origin for cookie-authenticated writes", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://compras.mizar.test/path";
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api", { headers: { origin: "https://compras.mizar.test" } }))).not.toThrow();
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api", { headers: { origin: "https://evil.test" } }))).toThrow("Origen");
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api"))).toThrow("Origen");
  });

  it("maps typed errors without exposing exception details", async () => {
    const forbidden = apiError(new DomainError("FORBIDDEN", "No autorizado")); expect(forbidden.status).toBe(403); expect(await forbidden.json()).toMatchObject({ error: "forbidden" });
    const unknown = apiError(new Error("database password=secret")); expect(unknown.status).toBe(500); expect(await unknown.text()).not.toContain("secret");
    // Regresión: ORDER_LINE_LOCKED (traducido en el adaptador Postgres para el 23503 de
    // orden_items_requisicion_item_id_fkey) debe salir como 422 sin cambios en apiError — el 422 ya
    // es el default de la cadena ternaria, no una lista blanca.
    const orderLineLocked = apiError(new DomainError("ORDER_LINE_LOCKED", "No se puede eliminar un ítem que ya está en una orden generada"));
    expect(orderLineLocked.status).toBe(422); expect(await orderLineLocked.json()).toMatchObject({ error: "order_line_locked" });
  });

  it("fails invalid dynamic parameters as a typed client error before infrastructure access", async () => {
    await expect(parsePathParams(Promise.resolve({ id: "not-a-uuid" }), z.object({ id: z.string().uuid() }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    try { await parsePathParams(Promise.resolve({ id: "not-a-uuid" }), z.object({ id: z.string().uuid() })); throw new Error("expected parse failure"); }
    catch (error) { expect(apiError(error).status).toBe(422); }
  });
});

// MENOR (QA Postgres real): un "declinado" sin motivo pasaba esta validación HTTP y moría en la BD
// con un 500 crudo (requisicion_items_motivo_declinacion_check, 23514) en vez de un 422 legible.
describe("reviewedItemSchema — declinado exige motivo (MENOR, QA Postgres real)", () => {
  const base = { id: "11111111-1111-4111-8111-111111111111", itemId: "22222222-2222-4222-8222-222222222222", quantity: 1, unit: "und", unitBase: 1000 };
  it("rechaza status declinado sin declineReason", () => {
    expect(reviewedItemSchema.safeParse({ ...base, status: "declinado" }).success).toBe(false);
    expect(reviewedItemSchema.safeParse({ ...base, status: "declinado", declineReason: "   " }).success).toBe(false);
  });
  it("acepta status declinado con declineReason, y cualquier otro status sin exigir motivo", () => {
    expect(reviewedItemSchema.safeParse({ ...base, status: "declinado", declineReason: "No disponible" }).success).toBe(true);
    expect(reviewedItemSchema.safeParse({ ...base, status: "aprobado" }).success).toBe(true);
    expect(reviewedItemSchema.safeParse({ ...base }).success).toBe(true);
  });
});
