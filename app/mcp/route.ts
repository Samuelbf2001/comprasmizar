import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isMcpConfigured, mcpEnv } from "../../lib/security/env";
import { lookupMcpActor } from "../../lib/infrastructure/mcp-auth";
import { verifyMcpApiKey } from "../../lib/security/mcp";
import { createPostgresDependencies, sharedPostgres } from "../../lib/infrastructure/postgres-repositories";
import { createSupplierServiceDependencies } from "../../lib/infrastructure/supplier-repositories";
import { CatalogService, ProcurementService, SupplierService, type CatalogCostCenter } from "../../lib/services";
import { mcpRateLimiter } from "../../lib/security/rate-limit";
import { clientIpFrom } from "../../lib/security/client-ip";
import { buildExpensesReport } from "../api/reports/expenses-report";
import { createMcpServer, type McpServices } from "./server";

export const runtime = "nodejs";

/** Cableado de producción de las herramientas (ver server.ts para el catálogo y sus pruebas). */
function productionServices(): McpServices {
  const dependencies = createPostgresDependencies();
  return {
    procurement: new ProcurementService(dependencies),
    suppliers: new SupplierService(createSupplierServiceDependencies()),
    catalogs: new CatalogService(dependencies),
    audit: dependencies.audit,
    // Misma consulta que GET /api/catalogs/manage (centros activos e inactivos, con tipo).
    listCostCenters: () => sharedPostgres()<CatalogCostCenter[]>`select id, nombre as name, codigo as code, sociedad_id as "societyId", tipo as type, activo as active from centros_costo order by nombre`,
    exportExpenses: (actor, filters) => buildExpensesReport(dependencies, actor, filters, { origin: "mcp" }),
  };
}

async function handle(request: Request): Promise<Response> {
  if (!isMcpConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 });
  const clientIp = clientIpFrom(request.headers);
  if (!mcpRateLimiter.consume(clientIp)) return Response.json({ error: "rate_limited" }, { status: 429 });
  const actor = await verifyMcpApiKey(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null, mcpEnv().MCP_KEY_PEPPER, lookupMcpActor);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  const server = createMcpServer(actor, productionServices()), transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request, { authInfo: { token: actor.id, clientId: actor.id, scopes: [...actor.roles] } }); } finally { await server.close(); }
}
export const POST = handle; export const GET = handle; export const DELETE = handle;
