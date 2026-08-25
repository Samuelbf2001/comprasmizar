import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { isMcpConfigured, mcpEnv } from "../../lib/security/env";
import { lookupMcpActor } from "../../lib/infrastructure/mcp-auth";
import { assertSafeMcpToolCatalog, verifyMcpApiKey } from "../../lib/security/mcp";
import { createPostgresDependencies } from "../../lib/infrastructure/postgres-repositories";
import { createSupplierServiceDependencies } from "../../lib/infrastructure/supplier-repositories";
import { ProcurementService, SupplierService } from "../../lib/services";
import { mcpRateLimiter } from "../../lib/security/rate-limit";
import { auditMcpTool } from "../../lib/security/mcp-audit";
import { buildExpensesReport, expensesReportFiltersSchema, type ExpensesReportFile } from "../api/reports/expenses-report";

export const runtime = "nodejs";
function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
/** MCP no tiene un canal binario aquí: el archivo viaja como base64 dentro del mismo content de texto (RF-1203/1204). */
function fileResult(file: ExpensesReportFile) { return result({ filename: file.filename, mimeType: file.mimeType, rows: file.rows, base64: Buffer.from(file.bytes).toString("base64") }); }
async function audited<T>(actor: NonNullable<Awaited<ReturnType<typeof lookupMcpActor>>>, tool: string, work: () => Promise<T>): Promise<T> { return auditMcpTool(createPostgresDependencies().audit, actor, tool, work); }
function createServer(actor: Awaited<ReturnType<typeof lookupMcpActor>>) {
  if (!actor) throw new Error("unauthorized"); assertSafeMcpToolCatalog(); const service = new ProcurementService(createPostgresDependencies()), server = new McpServer({ name: "mizar-compras", version: "0.1.0" });
  server.registerTool("estado_embudo", { description: "Consulta el embudo visible para el usuario autenticado.", inputSchema: { periodo: z.string().regex(/^\d{4}-\d{2}$/) } }, async ({ periodo }) => result(await audited(actor, "estado_embudo", () => service.dashboard(periodo, { actor, origin: "mcp" }))));
  server.registerTool("consultar_requisiciones", { description: "Consulta requisiciones dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited(actor, "consultar_requisiciones", () => service.listRequisitions({ actor, origin: "mcp" }))));
  server.registerTool("consultar_ordenes", { description: "Consulta órdenes dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited(actor, "consultar_ordenes", () => service.listOrders({ actor, origin: "mcp" }))));
  server.registerTool("consultar_gastos", { description: "Consulta gastos dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited(actor, "consultar_gastos", () => service.listExpenses({ actor, origin: "mcp" }))));
  server.registerTool("registrar_caja_menor", { description: "Registra caja menor usando el mismo servicio de la web.", inputSchema: { workId: z.string().uuid(), date: z.string().date(), concept: z.string().min(1), tagId: z.string().uuid(), amount: z.number().int().positive() } }, async (input) => result(await audited(actor, "registrar_caja_menor", () => service.registerPettyCash(input, { actor, origin: "mcp" }))));
  server.registerTool("actualizar_estado_orden", { description: "Actualiza cumplimiento de una OC/OP.", inputSchema: { orderId: z.string().uuid(), status: z.enum(["cumplida", "no_cumplida", "no_necesario"]) } }, async (input) => result(await audited(actor, "actualizar_estado_orden", () => service.updateOrderStatus(input.orderId, input.status, { actor, origin: "mcp" }))));
  // RF-1203: reutiliza SupplierService.get tal cual la usa la web (app/api/suppliers/[id]/route.ts); la autorización
  // de lectura (canRead) y la redacción de datos bancarios ya viven ahí, el MCP no decide nada nuevo.
  server.registerTool("ficha_proveedor", { description: "Consulta la ficha de un proveedor (datos, historial de órdenes y documentos) dentro del alcance del usuario.", inputSchema: { supplierId: z.string().uuid() } }, async ({ supplierId }) => result(await audited(actor, "ficha_proveedor", () => new SupplierService(createSupplierServiceDependencies()).get(supplierId, actor))));
  // RF-1204: reutiliza el mismo caso de uso que la ruta HTTP de reportes (RF-705); "report:export" es la única
  // puerta y mcpForbidden (RF-1205) sigue bloqueando aprobar/devolver/revisar sin importar el rol del actor.
  server.registerTool("exportar_reporte", { description: "Exporta el reporte de gastos (XLSX o PDF) filtrado por obra, sociedad y periodo, dentro del alcance del usuario.", inputSchema: expensesReportFiltersSchema.shape }, async (filters) => fileResult(await audited(actor, "exportar_reporte", () => buildExpensesReport(createPostgresDependencies(), actor, filters, { origin: "mcp" }))));
  return server;
}
async function handle(request: Request): Promise<Response> { if (!isMcpConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 }); const clientIp = request.headers.get("x-real-ip") ?? "direct"; if (!mcpRateLimiter.consume(clientIp)) return Response.json({ error: "rate_limited" }, { status: 429 }); const actor = await verifyMcpApiKey(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, mcpEnv().MCP_KEY_PEPPER, lookupMcpActor); if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 }); const server = createServer(actor), transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true }); await server.connect(transport); try { return await transport.handleRequest(request, { authInfo: { token: actor.id, clientId: actor.id, scopes: [...actor.roles] } }); } finally { await server.close(); } }
export const POST = handle; export const GET = handle; export const DELETE = handle;
