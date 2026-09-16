import { Buffer } from "node:buffer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "../../lib/domain";
import { orderPaymentSchema } from "../../lib/http/schemas";
import { MCP_TOOL_NAMES, assertSafeMcpToolCatalog } from "../../lib/security/mcp";
import { auditMcpTool } from "../../lib/security/mcp-audit";
import type { AuditRepository, CatalogCostCenter, CatalogService, ProcurementService, SupplierService } from "../../lib/services";
import { expensesReportFiltersSchema, type ExpensesReportFile, type ExpensesReportFilters } from "../api/reports/expenses-report";

/**
 * RF-1204 (adenda M12): las herramientas del MCP se registran aquí, con sus servicios INYECTADOS, para
 * poder probarlas sin Postgres ni clave de API (tests/unit/mcp-route.test.ts); route.ts solo cablea la
 * producción y la autenticación. Cada herramienta reutiliza el MISMO caso de uso que la ruta HTTP
 * equivalente — el MCP nunca decide permisos nuevos: `assertPermission(..., "mcp")` en el servicio y
 * `mcpForbidden` (lib/domain/rules.ts) siguen bloqueando aprobar/devolver/revisar para cualquier rol.
 */
export interface McpServices {
  procurement: ProcurementService;
  suppliers: SupplierService;
  catalogs: CatalogService;
  audit: AuditRepository;
  listCostCenters(): Promise<CatalogCostCenter[]>;
  exportExpenses(actor: Actor, filters: ExpensesReportFilters): Promise<ExpensesReportFile>;
}

function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value) }] }; }
/** MCP no tiene un canal binario aquí: el archivo viaja como base64 dentro del mismo content de texto (RF-1203/1204). */
function fileResult(file: ExpensesReportFile) { return result({ filename: file.filename, mimeType: file.mimeType, rows: file.rows, base64: Buffer.from(file.bytes).toString("base64") }); }

// Mismas reglas que `createCatalogSchema` (app/api/catalogs/route.ts) para kind "costCenters".
const costCenterInput = {
  name: z.string().trim().min(2).max(160),
  code: z.string().trim().min(1).max(32).optional(),
  societyId: z.string().uuid().optional(),
  type: z.enum(["obra", "administrativo", "personal", "empresa"]).optional(),
};

export function createMcpServer(actor: Actor, services: McpServices): McpServer {
  assertSafeMcpToolCatalog(MCP_TOOL_NAMES);
  const mcp = { actor, origin: "mcp" as const };
  const server = new McpServer({ name: "mizar-compras", version: "0.2.0" });
  const audited = <T>(tool: (typeof MCP_TOOL_NAMES)[number], work: () => Promise<T>) => auditMcpTool(services.audit, actor, tool, work);

  server.registerTool("estado_embudo", { description: "Consulta el embudo visible para el usuario autenticado.", inputSchema: { periodo: z.string().regex(/^\d{4}-\d{2}$/) } }, async ({ periodo }) => result(await audited("estado_embudo", () => services.procurement.dashboard(periodo, mcp))));
  server.registerTool("consultar_requisiciones", { description: "Consulta requisiciones dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited("consultar_requisiciones", () => services.procurement.listRequisitions(mcp))));
  server.registerTool("consultar_ordenes", { description: "Consulta órdenes dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited("consultar_ordenes", () => services.procurement.listOrders(mcp))));
  server.registerTool("consultar_gastos", { description: "Consulta gastos dentro del alcance del usuario.", inputSchema: {} }, async () => result(await audited("consultar_gastos", () => services.procurement.listExpenses(mcp))));
  // RF-1204 / A10: el "gasto de caja" ES un pago con medio efectivo sobre una orden — misma validación
  // (orderPaymentSchema) y mismo caso de uso que POST /api/orders/[id]/payments; `registrar_caja_menor` se retiró.
  server.registerTool("registrar_pago", { description: "Registra un pago (parcial o total) sobre una orden, con fecha, valor, medio (efectivo = Caja), referencia y nota; el mismo que la web.", inputSchema: { orderId: z.string().uuid(), ...orderPaymentSchema.shape } }, async ({ orderId, ...input }) => result(await audited("registrar_pago", () => services.procurement.registerOrderPayment(orderId, input, mcp))));
  server.registerTool("actualizar_estado_orden", { description: "Actualiza cumplimiento de una OC/OP.", inputSchema: { orderId: z.string().uuid(), status: z.enum(["cumplida", "no_cumplida", "no_necesario"]) } }, async (input) => result(await audited("actualizar_estado_orden", () => services.procurement.updateOrderStatus(input.orderId, input.status, mcp))));
  // RF-1204: CRUD de centros de costo — listar (cualquier usuario autenticado, como GET /api/catalogs) y
  // crear (CatalogService.create decide el permiso: admin_sixteam, o admin_mizar con el autoservicio activo).
  server.registerTool("listar_centros_costo", { description: "Lista los centros de costo (id, nombre, código, tipo, sociedad y si está activo).", inputSchema: { soloActivos: z.boolean().default(true) } }, async ({ soloActivos }) => result(await audited("listar_centros_costo", async () => (await services.listCostCenters()).filter((costCenter) => !soloActivos || costCenter.active))));
  server.registerTool("crear_centro_costo", { description: "Crea un centro de costo activo (tipo obra/administrativo/personal/empresa; sociedad opcional = compartido).", inputSchema: costCenterInput }, async (input) => result(await audited("crear_centro_costo", () => services.catalogs.create("costCenters", { ...input, active: true }, actor))));
  // RF-1203: reutiliza SupplierService.get tal cual la usa la web (app/api/suppliers/[id]/route.ts); la autorización
  // de lectura (canRead) y la redacción de datos bancarios ya viven ahí, el MCP no decide nada nuevo.
  server.registerTool("ficha_proveedor", { description: "Consulta la ficha de un proveedor (datos, historial de órdenes y documentos) dentro del alcance del usuario.", inputSchema: { supplierId: z.string().uuid() } }, async ({ supplierId }) => result(await audited("ficha_proveedor", () => services.suppliers.get(supplierId, actor))));
  // RF-1204: reutiliza el mismo caso de uso que la ruta HTTP de reportes (RF-705); "report:export" es la única puerta.
  server.registerTool("exportar_reporte", { description: "Exporta el reporte de gastos (XLSX o PDF) filtrado por obra, sociedad y periodo, dentro del alcance del usuario.", inputSchema: expensesReportFiltersSchema.shape }, async (filters) => fileResult(await audited("exportar_reporte", () => services.exportExpenses(actor, filters))));
  return server;
}
