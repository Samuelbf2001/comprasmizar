import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DomainError } from "../../lib/domain";
import { apiError, assertSameOrigin, parseJson, parsePathParams } from "../../lib/http/api";

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
  });

  it("fails invalid dynamic parameters as a typed client error before infrastructure access", async () => {
    await expect(parsePathParams(Promise.resolve({ id: "not-a-uuid" }), z.object({ id: z.string().uuid() }))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    try { await parsePathParams(Promise.resolve({ id: "not-a-uuid" }), z.object({ id: z.string().uuid() })); throw new Error("expected parse failure"); }
    catch (error) { expect(apiError(error).status).toBe(422); }
  });
});
