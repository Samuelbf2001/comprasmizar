import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, publicWorkAggregateRateLimiter, publicWorkRateLimiter } from "../../lib/security/rate-limit";
import { hmacSha256, verifyKapsoSignature } from "../../lib/security/crypto";
import { MCP_GATED_TOOL_NAMES, MCP_TOOL_NAMES, assertSafeMcpToolCatalog, verifyMcpApiKey } from "../../lib/security/mcp";
import { auditMcpTool } from "../../lib/security/mcp-audit";
import { isKapsoConfigured, isMcpConfigured, isPublicConfigured, isRuntimeConfigured } from "../../lib/security/env";
import { kapsoWebhookSchema } from "../../app/api/kapso/route";
import { publicRequisitionSchema } from "../../app/api/public/requisitions/route";

describe("security boundaries", () => {
  it("uses timing-safe Kapso verification and a fixed VPS window", () => { const secret = "a".repeat(32), raw = '{"event":"x"}', signature = `sha256=${hmacSha256(raw, secret)}`; expect(verifyKapsoSignature(raw, signature, secret)).toBe(true); expect(verifyKapsoSignature(raw, "bad", secret)).toBe(false); let now = 0; const limiter = new FixedWindowRateLimiter(2, 100, () => now); expect(limiter.consume("ip")).toBe(true); expect(limiter.consume("ip")).toBe(true); expect(limiter.consume("ip")).toBe(false); expect(limiter.consume("ip-2")).toBe(true); now = 101; expect(limiter.consume("ip-3")).toBe(true); expect(limiter.size()).toBe(1); });
  it("excludes approval and return from the MCP catalog by construction", async () => { expect(MCP_TOOL_NAMES).not.toContain("aprobar_requisicion"); expect(() => assertSafeMcpToolCatalog(["consultar_gastos", "aprobar_requisicion"])).toThrow("FORBIDDEN"); const pepper = "p".repeat(32), hashes: string[] = [], actor = await verifyMcpApiKey("mizar_test", pepper, async (hash) => { hashes.push(hash); return { id: "u", roles: ["revisor"] }; }); expect(actor?.id).toBe("u"); expect(hashes[0]).toBe(hmacSha256("mizar_test", pepper)); expect(await verifyMcpApiKey("wrong", pepper, async () => actor)).toBeNull(); });
  it("audits MCP reads with MCP origin before executing and keeps gated tools out of runtime catalog", async () => { const events: unknown[] = []; const value = await auditMcpTool({ append: async (entry) => { events.push(entry); }, list: async () => [] }, { id: "reader", roles: ["revisor"] }, "consultar_requisiciones", async () => "ok", "audit-id"); expect(value).toBe("ok"); expect(events).toMatchObject([{ entity: "mcp", entityId: "audit-id", actorId: "reader", origin: "mcp", data: { tool: "consultar_requisiciones" } }]); expect(MCP_TOOL_NAMES).toEqual(["consultar_requisiciones", "consultar_ordenes", "consultar_gastos", "estado_embudo", "registrar_caja_menor", "actualizar_estado_orden"]); expect(MCP_GATED_TOOL_NAMES).toContain("crear_requisicion"); expect(MCP_TOOL_NAMES).not.toContain("crear_requisicion"); });
  it("separates core, public, Kapso and MCP runtime gates", () => { const core = { DATABASE_URL: "https://db.example.test", NEXT_PUBLIC_SUPABASE_URL: "https://supabase.example.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a".repeat(20), SUPABASE_SERVICE_ROLE_KEY: "s".repeat(20) }; expect(isRuntimeConfigured(core)).toBe(true); expect(isPublicConfigured({ ...core, PUBLIC_FORM_CODE_PEPPER: "p".repeat(32) })).toBe(true); expect(isKapsoConfigured({ ...core, PUBLIC_FORM_CODE_PEPPER: "p".repeat(32) })).toBe(false); expect(isMcpConfigured({ ...core, PUBLIC_FORM_CODE_PEPPER: "p".repeat(32) })).toBe(false); expect(isKapsoConfigured({ ...core, KAPSO_WEBHOOK_SECRET: "k".repeat(32) })).toBe(true); expect(isMcpConfigured({ ...core, MCP_KEY_PEPPER: "m".repeat(32) })).toBe(true); });
  it("caps public code attempts against one obra in aggregate, closing the multi-IP evasion of the per-IP limiter", () => {
    // publicWorkRateLimiter solo limita por ip:workId: un atacante que reparte sus intentos entre muchas IPs
    // recibe un cupo de 10/60s por cada IP nueva, sin techo agregado. Simulamos 5 IPs distintas agotando su
    // cupo individual completo (10 cada una = 50 intentos) contra la misma obra y verificamos que el nuevo
    // límite agregado por workId (sin IP) corta el total muy por debajo de esos 50 intentos.
    publicWorkRateLimiter.reset(); publicWorkAggregateRateLimiter.reset();
    const workId = "obra-atacada";
    let allowedByBothChecks = 0;
    for (let ipIndex = 0; ipIndex < 5; ipIndex++) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const perIpOk = publicWorkRateLimiter.consume(`ip-${ipIndex}:${workId}`);
        expect(perIpOk).toBe(true); // cada IP nueva sí tiene su propio cupo completo: la brecha es real
        if (perIpOk && publicWorkAggregateRateLimiter.consume(workId)) allowedByBothChecks++;
      }
    }
    expect(allowedByBothChecks).toBe(30); // techo agregado, no 50: el ataque multi-IP queda acotado
  });
  it("rejects public quoted money and foreign line IDs, and bounds Kapso payloads", () => { const publicPayload = { workId: "11111111-1111-4111-8111-111111111111", code: "1234", type: "compra", requiredDate: "2026-09-01", name: "Ana", phone: "+57 300 123 4567", items: [{ itemId: "22222222-2222-4222-8222-222222222222", quantity: 1, unit: "und", id: "33333333-3333-4333-8333-333333333333", unitBase: 900 }] }; expect(publicRequisitionSchema.safeParse(publicPayload).success).toBe(false); const kapsoPayload = { eventId: "event-1", type: "flow_submission", receivedAt: "2026-08-24T10:00:00.000Z", submission: { eventId: "different", phone: "+573001234567", workId: "11111111-1111-4111-8111-111111111111", requiredDate: "2026-09-01", type: "compra", requesterName: "Ana", items: [{ quantity: 1, unit: "und", proposedDescription: "Tornillo", attachmentUrl: "http://example.test/file" }] } }; expect(kapsoWebhookSchema.safeParse(kapsoPayload).success).toBe(false); });
});
