import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { DomainError } from "../../lib/domain";
import { orderPaymentSchema, reviewedItemSchema, requisitionActionSchema } from "../../lib/http/schemas";

// H8 (docs/plan-rendimiento.md): authenticatedJson() llama a requireServerActor() — se mockea igual que
// tests/unit/public-access-route.test.ts para probar SOLO la cabecera Server-Timing, sin Supabase/Postgres.
const mocks = vi.hoisted(() => ({ actor: { id: "actor-1", roles: ["revisor"] as string[] }, authError: null as Error | null }));
vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => { if (mocks.authError) throw mocks.authError; return mocks.actor; },
}));

import { apiError, appOrigin, assertSameOrigin, authenticatedJson, hasListFilters, parseJson, parseListQuery, parsePathParams } from "../../lib/http/api";
import { REQUISITION_STATUS_VALUES } from "../../lib/http/schemas";
import { encodeCursor } from "../../lib/services/list-query";

const previousUrl = process.env.NEXT_PUBLIC_APP_URL;
const previousOrigin = process.env.APP_ORIGIN;
afterEach(() => {
  if (previousUrl === undefined) delete process.env.NEXT_PUBLIC_APP_URL; else process.env.NEXT_PUBLIC_APP_URL = previousUrl;
  if (previousOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = previousOrigin;
});

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

  it("APP_ORIGIN manda sobre NEXT_PUBLIC_APP_URL y sirve cuando esa quedó sin compilar", () => {
    // Producción rota el 11-sep-2026: la imagen se construyó sin el build-arg, Next dejó
    // `process.env.NEXT_PUBLIC_APP_URL` compilado como `undefined` y assertSameOrigin pasó a lanzar
    // siempre — toda escritura respondía 503 mientras las lecturas seguían bien. APP_ORIGIN se lee
    // en ejecución, así que arregla eso sin reconstruir la imagen. Aquí se fija ese contrato.
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api", { headers: { origin: "https://compras.mizar.test" } }))).toThrow("APP_ORIGIN_NOT_CONFIGURED");
    process.env.APP_ORIGIN = "https://compras.mizar.test";
    expect(appOrigin()).toBe("https://compras.mizar.test");
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api", { headers: { origin: "https://compras.mizar.test" } }))).not.toThrow();
    // Y sigue siendo una comprobación de origen, no un pase libre.
    expect(() => assertSameOrigin(new Request("https://compras.mizar.test/api", { headers: { origin: "https://evil.test" } }))).toThrow("Origen");
    // Una cadena vacía no cuenta como configurada: es el caso real de un build-arg sin valor.
    process.env.APP_ORIGIN = "   ";
    expect(appOrigin()).toBeUndefined();
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

// H8 (docs/plan-rendimiento.md): Server-Timing separa cuánto de una respuesta fue autenticación (H1)
// vs el trabajo propio del endpoint — antes no había forma de saberlo sin instrumentación externa.
describe("authenticatedJson — cabecera Server-Timing (H8)", () => {
  beforeEach(() => { mocks.actor = { id: "actor-1", roles: ["revisor"] }; mocks.authError = null; });

  it("incluye auth;dur= y work;dur= en una respuesta exitosa, y conserva Cache-Control: no-store", async () => {
    const response = await authenticatedJson(async () => ({ ok: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const timing = response.headers.get("Server-Timing");
    expect(timing).toMatch(/^auth;dur=\d+(\.\d)?, work;dur=\d+(\.\d)?$/);
  });

  it("también añade Server-Timing cuando el trabajo falla con un DomainError", async () => {
    const response = await authenticatedJson(async () => { throw new DomainError("FORBIDDEN", "No autorizado"); });
    expect(response.status).toBe(403);
    expect(response.headers.get("Server-Timing")).toMatch(/^auth;dur=\d+(\.\d)?, work;dur=\d+(\.\d)?$/);
  });

  it("cuando falla la autenticación misma, work;dur queda en 0 (nunca llegó a correr)", async () => {
    mocks.authError = new Error("UNAUTHENTICATED");
    const response = await authenticatedJson(async () => ({ unreachable: true }));
    expect(response.status).toBe(401);
    expect(response.headers.get("Server-Timing")).toMatch(/^auth;dur=\d+(\.\d)?, work;dur=0$/);
  });
});

// H3 (docs/plan-rendimiento.md, Fase 3): parseListQuery decide, con solo `limit`/`cursor`, si una ruta
// responde el array de siempre o `{ rows, nextCursor }` — hasListFilters decide si el modo "sin
// paginar" debe reutilizar el camino filtrado. Ambas se prueban aquí, sin pasar por ninguna ruta HTTP
// real (que en este entorno de test siempre falla en la autenticación antes de llegar a parsear su
// query, ver el describe "fails closed" de tests/integration/routes.test.ts).
describe("parseListQuery / hasListFilters — H3", () => {
  const url = (query: string) => new URL(`https://mizar.test/api/requisitions${query}`);

  it("sin ningún parámetro, query queda vacío y paginated es false", () => {
    const { query, paginated } = parseListQuery(url(""), REQUISITION_STATUS_VALUES);
    expect(query).toEqual({});
    expect(paginated).toBe(false);
    expect(hasListFilters(query)).toBe(false);
  });

  it("status=a,b se parsea como arreglo; valores fuera del dominio se rechazan", () => {
    const { query } = parseListQuery(url("?status=enviada,en_revision"), REQUISITION_STATUS_VALUES);
    expect(query.status).toEqual(["enviada", "en_revision"]);
    expect(() => parseListQuery(url("?status=enviada,no-existe"), REQUISITION_STATUS_VALUES)).toThrow();
  });

  it("status se ignora sin fallar cuando la ruta no pasa statusValues (gastos/caja menor)", () => {
    const { query } = parseListQuery(url("?status=cualquier-cosa"));
    expect(query.status).toBeUndefined();
  });

  it("workId exige un uuid válido", () => {
    const validId = "11111111-1111-4111-8111-111111111111";
    expect(parseListQuery(url(`?workId=${validId}`)).query.workId).toBe(validId);
    expect(() => parseListQuery(url("?workId=no-es-uuid"))).toThrow();
  });

  it("from/to exigen YYYY-MM-DD y una fecha real (no 2026-13-40)", () => {
    expect(parseListQuery(url("?from=2026-09-01&to=2026-09-30")).query).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(() => parseListQuery(url("?from=01-09-2026"))).toThrow();
    expect(() => parseListQuery(url("?to=2026-13-40"))).toThrow();
  });

  it("limit exige un entero entre 1 y 200; fuera de rango se rechaza", () => {
    expect(parseListQuery(url("?limit=50")).query.limit).toBe(50);
    expect(() => parseListQuery(url("?limit=0"))).toThrow();
    expect(() => parseListQuery(url("?limit=201"))).toThrow();
    expect(() => parseListQuery(url("?limit=1.5"))).toThrow();
  });

  it("paginated es true con limit o con cursor, sin importar si además hay filtros", () => {
    expect(parseListQuery(url("?limit=10")).paginated).toBe(true);
    const cursor = encodeCursor("2026-09-01T00:00:00.000Z", "11111111-1111-4111-8111-111111111111");
    expect(parseListQuery(url(`?cursor=${encodeURIComponent(cursor)}`)).paginated).toBe(true);
    expect(parseListQuery(url("?status=enviada"), REQUISITION_STATUS_VALUES).paginated).toBe(false);
  });

  it("hasListFilters distingue status/workId/from/to de limit/cursor", () => {
    expect(hasListFilters({})).toBe(false);
    expect(hasListFilters({ limit: 10 })).toBe(false);
    expect(hasListFilters({ status: ["enviada"] })).toBe(true);
    expect(hasListFilters({ workId: "work-1" })).toBe(true);
    expect(hasListFilters({ from: "2026-09-01" })).toBe(true);
    expect(hasListFilters({ to: "2026-09-30" })).toBe(true);
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
  // Aprobador por ítem: la ficha de revisión manda `approverId` por línea al repartir la aprobación.
  // Cruza el esquema HTTP a propósito — el hueco que dejó pasar el defecto era que ningún test lo hacía:
  // `.strict()` lo habría rechazado y la función entera caía en la frontera antes de llegar al servicio.
  it("acepta approverId por ítem (uuid) y rechaza uno que no sea uuid", () => {
    expect(reviewedItemSchema.safeParse({ ...base, approverId: "33333333-3333-4333-8333-333333333333" }).success).toBe(true);
    expect(reviewedItemSchema.safeParse({ ...base, approverId: "no-uuid" }).success).toBe(false);
  });
});

describe("requisitionActionSchema — review reparte aprobador por ítem", () => {
  it("un review con approverId por ítem pasa el esquema y conserva el reparto", () => {
    const parsed = requisitionActionSchema.safeParse({
      action: "review",
      tagId: "c4867c2a-397d-4a66-b961-6e33cd551615",
      approverId: "10000000-0000-4000-8000-000000000006",
      items: [
        { id: "11111111-1111-4111-8111-111111111111", itemId: "22222222-2222-4222-8222-222222222222", quantity: 1, unit: "und", unitBase: 1000, approverId: "44444444-4444-4444-8444-444444444444" },
        { id: "55555555-5555-4555-8555-555555555555", itemId: "66666666-6666-4666-8666-666666666666", quantity: 2, unit: "und", unitBase: 2000 },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.action === "review") {
      expect(parsed.data.items[0].approverId).toBe("44444444-4444-4444-8444-444444444444");
      expect(parsed.data.items[1].approverId).toBeUndefined(); // sin reparto: hereda el de cabecera
    }
  });
});

// Reunión agosto 2026: registro de un pago parcial de orden (POST /api/orders/[id]/payments).
describe("orderPaymentSchema — pago parcial de orden", () => {
  const base = { date: "2026-08-05", amount: 100, method: "efectivo" as const };
  it("acepta el shape mínimo (sin externalReference)", () => {
    expect(orderPaymentSchema.safeParse(base).success).toBe(true);
  });
  it("acepta los cinco medios de public.medio_pago (202609120002_pagos_orden.sql) y rechaza cualquier otro", () => {
    for (const method of ["efectivo", "transferencia", "cheque", "tarjeta", "otro"]) {
      expect(orderPaymentSchema.safeParse({ ...base, method }).success).toBe(true);
    }
    expect(orderPaymentSchema.safeParse({ ...base, method: "bitcoin" }).success).toBe(false);
  });
  // Mismo criterio que expenseSharesSchema/pettyCashSchema: el dominio entero asume peso colombiano
  // entero (lib/domain/model.ts), así que un valor con centavos o no positivo se rechaza en la
  // frontera HTTP, antes de llegar al servicio.
  it("exige amount entero y positivo", () => {
    expect(orderPaymentSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ ...base, amount: -100 }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ ...base, amount: 100.5 }).success).toBe(false);
  });
  it("exige date en formato YYYY-MM-DD", () => {
    expect(orderPaymentSchema.safeParse({ ...base, date: "05/08/2026" }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ ...base, date: "2026-08-05" }).success).toBe(true);
  });
  it("acepta externalReference opcional y lo recorta; rechaza uno vacío o demasiado largo", () => {
    expect(orderPaymentSchema.safeParse({ ...base, externalReference: "CONS-123" }).success).toBe(true);
    expect(orderPaymentSchema.safeParse({ ...base, externalReference: "" }).success).toBe(false);
    expect(orderPaymentSchema.safeParse({ ...base, externalReference: "x".repeat(241) }).success).toBe(false);
  });
  it("es .strict(): rechaza campos que el esquema no declara", () => {
    expect(orderPaymentSchema.safeParse({ ...base, orderId: "no-corresponde-aqui" }).success).toBe(false);
  });
});
