import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Actor, AuditEvent } from "../../lib/domain";
import { MCP_TOOL_NAMES } from "../../lib/security/mcp";
import { createMcpServer, type McpServices } from "../../app/mcp/server";

/**
 * RF-1204 (adenda M12): el catálogo de herramientas MCP se prueba de punta a punta (cliente MCP real
 * sobre un transporte en memoria) con los servicios inyectados — sin Postgres ni clave de API. Lo que
 * importa: qué herramientas existen, que `registrar_pago` llega al servicio con el usuario de la API
 * key y origen "mcp", y que aprobar sigue sin existir (RF-1205).
 */
const apiKeyActor: Actor = { id: "usuario-api-key", roles: ["revisor"] };
const orderId = "11111111-1111-4111-8111-111111111111";

function fakeServices() {
  const calls = { registerOrderPayment: [] as unknown[][], createCatalog: [] as unknown[][], audits: [] as AuditEvent[] };
  const services = {
    procurement: {
      registerOrderPayment: vi.fn(async (...args: unknown[]) => { calls.registerOrderPayment.push(args); return { payment: { id: "pay-1", orderId, amount: 640_000 }, order: { id: orderId, paymentStatus: "parcial" } }; }),
      listOrders: vi.fn(async () => [{ id: orderId, consecutive: "OP-2026-0007" }]),
    },
    suppliers: {},
    catalogs: { create: vi.fn(async (...args: unknown[]) => { calls.createCatalog.push(args); return { id: "cc-nuevo", name: "Administración", type: "administrativo", active: true }; }) },
    audit: { append: async (event: AuditEvent) => { calls.audits.push(event); }, list: async () => [] },
    listCostCenters: vi.fn(async () => [
      { id: "cc-1", name: "Administración", code: "ADM", societyId: null, type: "administrativo", active: true },
      { id: "cc-2", name: "Obra vieja", code: null, societyId: "soc-1", type: "obra", active: false },
    ]),
    exportExpenses: vi.fn(),
  };
  return { services: services as unknown as McpServices, calls };
}

async function connect(services: McpServices, actor: Actor = apiKeyActor) {
  const server = createMcpServer(actor, services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prueba", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}
type ToolResponse = Awaited<ReturnType<Client["callTool"]>>;
const textOf = (response: ToolResponse) => JSON.parse(((response.content as Array<{ type: string; text: string }>)[0]).text) as unknown;
// El SDK responde los errores de validación y de herramienta desconocida como resultado con `isError`
// (código -32602 en el texto), no como rechazo de la promesa.
async function expectToolError(pending: Promise<ToolResponse>, pattern: RegExp) {
  const response = await pending;
  expect(response.isError).toBe(true);
  expect((response.content as Array<{ text: string }>)[0].text).toMatch(pattern);
}

describe("app/mcp — catálogo de herramientas (RF-1204/RF-1205)", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("expone exactamente MCP_TOOL_NAMES: con registrar_pago, listar/crear centros de costo y sin registrar_caja_menor", async () => {
    const { client, server } = await connect(fakeServices().services);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...MCP_TOOL_NAMES].sort());
    expect(names).toContain("registrar_pago");
    expect(names).toContain("listar_centros_costo");
    expect(names).toContain("crear_centro_costo");
    expect(names).not.toContain("registrar_caja_menor");
    await client.close(); await server.close();
  });

  it("aprobar, devolver y declinar no existen como herramientas y llamarlas falla", async () => {
    const { client, server } = await connect(fakeServices().services);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => /aprobar|devolv|declinar|approve|return/i.test(name))).toBe(false);
    await expectToolError(client.callTool({ name: "aprobar_requisicion", arguments: { requisitionId: orderId } }), /aprobar_requisicion.*not found|-32602/i);
    await client.close(); await server.close();
  });

  it("registrar_pago llama a ProcurementService.registerOrderPayment con el usuario de la API key, origen mcp y el cuerpo validado", async () => {
    const { services, calls } = fakeServices();
    const { client, server } = await connect(services);
    const response = await client.callTool({ name: "registrar_pago", arguments: { orderId, date: "2026-09-15", amount: 640_000, method: "efectivo", note: "  Anticipo topógrafo " } });
    expect(response.isError).toBeFalsy();
    expect(textOf(response)).toMatchObject({ payment: { id: "pay-1" }, order: { paymentStatus: "parcial" } });
    expect(calls.registerOrderPayment).toHaveLength(1);
    const [calledOrderId, input, context] = calls.registerOrderPayment[0] as [string, Record<string, unknown>, Record<string, unknown>];
    expect(calledOrderId).toBe(orderId);
    expect(input).toEqual({ date: "2026-09-15", amount: 640_000, method: "efectivo", note: "Anticipo topógrafo" });
    expect(context).toEqual({ actor: apiKeyActor, origin: "mcp" });
    expect(calls.audits).toMatchObject([{ entity: "mcp", event: "MCP_TOOL", actorId: apiKeyActor.id, origin: "mcp", data: { tool: "registrar_pago" } }]);
    await client.close(); await server.close();
  });

  it("registrar_pago aplica la misma validación que POST /api/orders/[id]/payments (medio del enum, valor entero) antes de tocar el servicio", async () => {
    const { services, calls } = fakeServices();
    const { client, server } = await connect(services);
    await expectToolError(client.callTool({ name: "registrar_pago", arguments: { orderId, date: "2026-09-15", amount: 640_000, method: "caja" } }), /method/);
    await expectToolError(client.callTool({ name: "registrar_pago", arguments: { orderId, date: "2026-09-15", amount: 640_000.5, method: "efectivo" } }), /amount/);
    await expectToolError(client.callTool({ name: "registrar_pago", arguments: { orderId: "no-es-uuid", date: "2026-09-15", amount: 1, method: "efectivo" } }), /orderId/);
    expect(calls.registerOrderPayment).toHaveLength(0);
    await client.close(); await server.close();
  });

  it("listar_centros_costo devuelve solo activos por defecto y crear_centro_costo pasa por CatalogService.create con el actor", async () => {
    const { services, calls } = fakeServices();
    const { client, server } = await connect(services);
    expect(textOf(await client.callTool({ name: "listar_centros_costo", arguments: {} }))).toEqual([{ id: "cc-1", name: "Administración", code: "ADM", societyId: null, type: "administrativo", active: true }]);
    expect((textOf(await client.callTool({ name: "listar_centros_costo", arguments: { soloActivos: false } })) as unknown[]).length).toBe(2);
    const created = await client.callTool({ name: "crear_centro_costo", arguments: { name: "Administración", type: "administrativo" } });
    expect(textOf(created)).toMatchObject({ id: "cc-nuevo" });
    expect(calls.createCatalog[0]).toEqual(["costCenters", { name: "Administración", type: "administrativo", active: true }, apiKeyActor]);
    await expectToolError(client.callTool({ name: "crear_centro_costo", arguments: { name: "A", type: "otro" } }), /name[\s\S]*type/);
    expect(calls.createCatalog).toHaveLength(1);
    await client.close(); await server.close();
  });
});
