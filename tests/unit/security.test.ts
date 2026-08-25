import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter, publicWorkAggregateRateLimiter, publicWorkRateLimiter } from "../../lib/security/rate-limit";
import { hmacSha256, verifyKapsoSignature } from "../../lib/security/crypto";
import { MCP_GATED_TOOL_NAMES, MCP_TOOL_NAMES, assertSafeMcpToolCatalog, verifyMcpApiKey } from "../../lib/security/mcp";
import { auditMcpTool } from "../../lib/security/mcp-audit";
import { isKapsoConfigured, isMcpConfigured, isPublicConfigured, isRuntimeConfigured } from "../../lib/security/env";
import { kapsoWebhookSchema } from "../../app/api/kapso/route";
import { publicRequisitionSchema } from "../../app/api/public/requisitions/route";
import { buildExpensesReport, expensesReportFiltersSchema, type WorkSocietyIndex } from "../../app/api/reports/expenses-report";
import { hasPermission, type Expense } from "../../lib/domain";
import type { ServiceDependencies } from "../../lib/services";

/** Deps mínimas: sólo expenses.listVisibleTo importa para el reporte; todo lo demás no debería invocarse. */
function fakeReportDeps(expenses: Expense[]): ServiceDependencies {
  const notUsed = (): never => { throw new Error("no debería usarse en esta prueba"); };
  return {
    requisitions: { get: notUsed, save: notUsed, list: notUsed, listVisibleTo: notUsed },
    orders: { save: notUsed, list: notUsed, listVisibleTo: notUsed, listByRequisition: notUsed, get: notUsed },
    expenses: { get: notUsed, save: notUsed, saveShares: notUsed, list: notUsed, listVisibleTo: async () => expenses, listByReference: notUsed },
    pettyCash: { save: notUsed, list: notUsed },
    audit: { append: async () => {}, list: async () => [] },
    consecutives: { take: notUsed },
    publicAccess: { verify: notUsed },
    tags: { getApproverId: notUsed },
    features: { isEnabled: async () => false },
    items: { propose: notUsed },
    catalogs: { create: notUsed, get: notUsed, update: notUsed, findSupplierDuplicate: notUsed, isEligibleApprover: notUsed, authUserExists: notUsed },
    notifications: { enqueue: async () => {} },
    transactions: { transaction: notUsed },
    clock: { now: () => new Date("2026-08-24T00:00:00.000Z") },
    ids: { next: notUsed },
  };
}
// UUID válidos para satisfacer expensesReportFiltersSchema; los gastos y la sociedad no son reales.
const workA = "11111111-1111-4111-8111-111111111111", workB = "22222222-2222-4222-8222-222222222222", workC = "33333333-3333-4333-8333-333333333333", societyA = "55555555-5555-4555-8555-555555555555";
const expenseWorkA: Expense = { id: "e1", workId: workA, origin: "requisicion", referenceId: "r1", tagId: "t1", supplierId: "s1", date: "2026-08-05", base: 100, iva: 19, total: 119, period: "2026-08" };
const expenseWorkB: Expense = { id: "e2", workId: workB, origin: "requisicion", referenceId: "r2", tagId: "t2", supplierId: "s2", date: "2026-07-05", base: 200, iva: 38, total: 238, period: "2026-07" };
const expenseWorkC: Expense = { id: "e3", workId: workC, origin: "caja_menor", referenceId: "r3", date: "2026-08-10", base: 50, iva: 0, total: 50, period: "2026-08" };
const accountant = { id: "contadora", roles: ["contabilidad"] as const };
const fakeSocietyIndex: WorkSocietyIndex = { workIdsForSociety: async (societyId) => (societyId === societyA ? [workA, workC] : []) };

describe("security boundaries", () => {
  it("uses timing-safe Kapso verification and a fixed VPS window", () => { const secret = "a".repeat(32), raw = '{"event":"x"}', signature = `sha256=${hmacSha256(raw, secret)}`; expect(verifyKapsoSignature(raw, signature, secret)).toBe(true); expect(verifyKapsoSignature(raw, "bad", secret)).toBe(false); let now = 0; const limiter = new FixedWindowRateLimiter(2, 100, () => now); expect(limiter.consume("ip")).toBe(true); expect(limiter.consume("ip")).toBe(true); expect(limiter.consume("ip")).toBe(false); expect(limiter.consume("ip-2")).toBe(true); now = 101; expect(limiter.consume("ip-3")).toBe(true); expect(limiter.size()).toBe(1); });
  it("excludes approval and return from the MCP catalog by construction", async () => { expect(MCP_TOOL_NAMES).not.toContain("aprobar_requisicion"); expect(() => assertSafeMcpToolCatalog(["consultar_gastos", "aprobar_requisicion"])).toThrow("FORBIDDEN"); const pepper = "p".repeat(32), hashes: string[] = [], actor = await verifyMcpApiKey("mizar_test", pepper, async (hash) => { hashes.push(hash); return { id: "u", roles: ["revisor"] }; }); expect(actor?.id).toBe("u"); expect(hashes[0]).toBe(hmacSha256("mizar_test", pepper)); expect(await verifyMcpApiKey("wrong", pepper, async () => actor)).toBeNull(); });
  it("audits MCP reads with MCP origin before executing and keeps gated tools out of runtime catalog", async () => { const events: unknown[] = []; const value = await auditMcpTool({ append: async (entry) => { events.push(entry); }, list: async () => [] }, { id: "reader", roles: ["revisor"] }, "consultar_requisiciones", async () => "ok", "audit-id"); expect(value).toBe("ok"); expect(events).toMatchObject([{ entity: "mcp", entityId: "audit-id", actorId: "reader", origin: "mcp", data: { tool: "consultar_requisiciones" } }]); expect(MCP_TOOL_NAMES).toEqual(["consultar_requisiciones", "consultar_ordenes", "consultar_gastos", "estado_embudo", "registrar_caja_menor", "actualizar_estado_orden", "ficha_proveedor", "exportar_reporte"]); expect(MCP_GATED_TOOL_NAMES).toContain("crear_requisicion"); expect(MCP_TOOL_NAMES).not.toContain("crear_requisicion"); });
  // RF-1203/1204: ficha_proveedor y exportar_reporte dejaron de ser nombres huérfanos en MCP_GATED_TOOL_NAMES
  // y ahora son herramientas reales registradas en app/mcp/route.ts.
  it("promotes ficha_proveedor and exportar_reporte out of the gated MCP catalog", () => {
    expect(MCP_TOOL_NAMES).toEqual(expect.arrayContaining(["ficha_proveedor", "exportar_reporte"]));
    expect(MCP_GATED_TOOL_NAMES).not.toContain("ficha_proveedor");
    expect(MCP_GATED_TOOL_NAMES).not.toContain("exportar_reporte");
    expect(MCP_GATED_TOOL_NAMES).toEqual(["crear_requisicion", "administrar_catalogo", "reenviar_notificacion"]);
  });
  // RF-1205, prueba explícita para las herramientas MCP agregadas en esta tarea: ninguna de las dos decide
  // sobre aprobar/devolver/revisar, y la puerta estructural en lib/domain/rules.ts los bloquea por origen
  // MCP sin importar el rol -- incluso admin_sixteam, que tiene "*" en todo lo demás.
  it("keeps approve/return/review unreachable from MCP for every role, including the new read tools' own permission gate", () => {
    for (const permission of ["requisition:approve", "requisition:return", "requisition:review"] as const) {
      expect(hasPermission(["admin_sixteam"], permission, "mcp")).toBe(false);
      expect(hasPermission(["admin_sixteam"], permission, "web")).toBe(true); // control: la web sí puede, confirma que el bloqueo es por origen
    }
    // ficha_proveedor y exportar_reporte sólo dependen de permisos de lectura (report:export / SupplierService.canRead),
    // nunca de los prohibidos: no hay una tercera vía indirecta hacia ellos.
    expect(hasPermission(["contabilidad"], "report:export", "mcp")).toBe(true);
    expect(hasPermission(["contabilidad"], "requisition:approve", "mcp")).toBe(false);
  });
  it("builds the shared expenses report filtered by period, obra and sociedad, and dispatches xlsx vs pdf (RF-705/RF-1204)", async () => {
    const deps = fakeReportDeps([expenseWorkA, expenseWorkB, expenseWorkC]);
    const all = await buildExpensesReport(deps, accountant, expensesReportFiltersSchema.parse({}));
    expect(all).toMatchObject({ rows: 3, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: "gastos-provisional-v0.1.xlsx" });
    const byPeriod = await buildExpensesReport(deps, accountant, expensesReportFiltersSchema.parse({ period: "2026-08" }));
    expect(byPeriod.rows).toBe(2); // e1 (work-a) y e3 (work-c), no e2 que es de julio
    const byWork = await buildExpensesReport(deps, accountant, expensesReportFiltersSchema.parse({ workId: workB }));
    expect(byWork.rows).toBe(1);
    const bySociety = await buildExpensesReport(deps, accountant, expensesReportFiltersSchema.parse({ societyId: societyA, format: "pdf" }), { societyIndex: fakeSocietyIndex });
    expect(bySociety).toMatchObject({ rows: 2, mimeType: "application/pdf", filename: "gastos-socios-provisional-v0.1.pdf" }); // workA y workC pertenecen a societyA
    const bySocietyAndPeriod = await buildExpensesReport(deps, accountant, expensesReportFiltersSchema.parse({ societyId: societyA, period: "2026-07" }), { societyIndex: fakeSocietyIndex });
    expect(bySocietyAndPeriod.rows).toBe(0); // ninguna obra de societyA tiene gastos en julio
    await expect(buildExpensesReport(deps, { id: "solicitante", roles: ["solicitante"] }, expensesReportFiltersSchema.parse({}))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("validates expensesReportFiltersSchema query params and defaults to xlsx", () => {
    expect(expensesReportFiltersSchema.parse({})).toEqual({ format: "xlsx" });
    expect(expensesReportFiltersSchema.safeParse({ format: "docx" }).success).toBe(false);
    expect(expensesReportFiltersSchema.safeParse({ workId: "not-a-uuid" }).success).toBe(false);
    expect(expensesReportFiltersSchema.safeParse({ period: "2026-8" }).success).toBe(false);
    expect(expensesReportFiltersSchema.parse({ period: "2026-08", societyId: "11111111-1111-4111-8111-111111111111", format: "pdf" })).toMatchObject({ format: "pdf", period: "2026-08" });
  });
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
