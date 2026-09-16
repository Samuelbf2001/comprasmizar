import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { CashPayment } from "../../lib/domain";

/**
 * RF-708 (cierre de caja, adenda A10): GET /api/reports/cash-close — mismo patrón de mocks que
 * tests/unit/reports-export-route.test.ts: solo el contrato HTTP (permisos, rango, JSON con nombres
 * resueltos y total, Excel) sin Postgres real.
 */
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["contabilidad"] as string[] },
  payments: [] as CashPayment[],
  queries: [] as unknown[],
  appendCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    orderPayments: {
      listCash: async (query: unknown) => { mocks.queries.push(query); return mocks.payments; },
    },
    audit: { append: async (event: Record<string, unknown>) => { mocks.appendCalls.push(event); } },
  }),
  postgresReportCatalogSource: () => ({
    load: async () => ({
      works: new Map([["work-1", "Altos de La Pradera"]]),
      tags: new Map(),
      societies: new Map([["soc-1", "Constructora Mizar S.A.S."]]),
      users: new Map(),
      suppliers: new Map([["sup-1", "Pedro Topógrafo"]]),
      costCenters: new Map([["cc-1", "Administración"]]),
    }),
  }),
}));

import { GET } from "../../app/api/reports/cash-close/route";

const costCenterId = "00000000-0000-4000-8000-000000000001";
const payment = (overrides: Partial<CashPayment> = {}): CashPayment => ({
  id: "pay-1", orderId: "ord-1", date: "2026-09-14", amount: 640_000, method: "efectivo", note: "Anticipo", attachmentId: "att-1",
  orderConsecutive: "OP-2026-0007", orderType: "OP", requisitionId: "req-1", requisitionConsecutive: "REQ-2026-0041",
  workId: "work-1", costCenterId: "cc-1", billedCompanyId: "soc-1", supplierId: "sup-1", ...overrides,
});

function requestFor(search = ""): Request {
  return new Request(`https://app.mizar.test/api/reports/cash-close${search}`);
}

describe("GET /api/reports/cash-close — RF-708", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["contabilidad"] };
    mocks.payments = [payment(), payment({ id: "pay-2", amount: 80_000, attachmentId: undefined, note: undefined, workId: undefined, orderConsecutive: "OC-2026-0090", orderType: "OC" })];
    mocks.queries = [];
    mocks.appendCalls = [];
  });

  it("responde JSON con el rango pedido, los pagos con nombres resueltos y el total", async () => {
    const response = await GET(requestFor(`?from=2026-09-14&to=2026-09-18&costCenterId=${costCenterId}`));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { from: string; to: string; costCenterId?: string; total: number; rows: Array<Record<string, unknown>> };
    expect(body).toMatchObject({ from: "2026-09-14", to: "2026-09-18", costCenterId, total: 720_000 });
    expect(body.rows[0]).toMatchObject({ id: "pay-1", orderConsecutive: "OP-2026-0007", supplierName: "Pedro Topógrafo", costCenterName: "Administración", billedCompanyName: "Constructora Mizar S.A.S.", workName: "Altos de La Pradera", attachmentId: "att-1" });
    // Orden sin obra (N4): la fila sale igual, con "—" en la obra.
    expect(body.rows[1]).toMatchObject({ id: "pay-2", workName: "—" });
    expect(mocks.queries[0]).toEqual({ from: "2026-09-14", to: "2026-09-18", costCenterId });
    expect(mocks.appendCalls).toHaveLength(0);
  });

  it("format=xlsx descarga el libro con una fila por pago, el total y auditoría", async () => {
    const response = await GET(requestFor("?from=2026-09-14&to=2026-09-18&format=xlsx"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=cierre-caja-2026-09-14-a-2026-09-18.xlsx");
    const workbook = new ExcelJS.Workbook();
    const bytes = Buffer.from(await response.arrayBuffer());
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    const sheet = workbook.getWorksheet("Cierre de caja")!;
    expect(sheet.getRow(2).values).toEqual(expect.arrayContaining(["Fecha", "Orden", "Beneficiario", "Centro de costo", "Empresa facturada", "Comprobante", "Valor COP"]));
    expect(sheet.getRow(3).values).toEqual(expect.arrayContaining(["2026-09-14", "OP-2026-0007", "Pedro Topógrafo", "Administración", "Constructora Mizar S.A.S.", "Sí", 640_000]));
    expect(sheet.getRow(4).values).toEqual(expect.arrayContaining(["OC-2026-0090", "—", "No", 80_000]));
    expect(sheet.getRow(5).values).toEqual(expect.arrayContaining(["TOTAL", 720_000]));
    expect(mocks.appendCalls[0]).toMatchObject({ entity: "reporte", event: "cierre_caja_descargado", data: { rows: 2, total: 720_000, from: "2026-09-14", to: "2026-09-18" } });
  });

  it("un revisor consulta el cierre (expense:read) pero no puede descargarlo (report:export)", async () => {
    mocks.actor = { id: "daniel", roles: ["revisor"] };
    expect((await GET(requestFor("?from=2026-09-14&to=2026-09-18"))).status).toBe(200);
    expect((await GET(requestFor("?from=2026-09-14&to=2026-09-18&format=xlsx"))).status).toBe(403);
    expect(mocks.appendCalls).toHaveLength(0);
  });

  it("un rol sin expense:read (aprobador) recibe 403", async () => {
    mocks.actor = { id: "juliana", roles: ["aprobador"] };
    expect((await GET(requestFor("?from=2026-09-14&to=2026-09-18"))).status).toBe(403);
  });

  it("rechaza con 422 un rango incompleto, mal formado o invertido", async () => {
    expect((await GET(requestFor("?from=2026-09-14"))).status).toBe(422);
    expect((await GET(requestFor("?from=14-09-2026&to=2026-09-18"))).status).toBe(422);
    expect((await GET(requestFor("?from=2026-09-18&to=2026-09-14"))).status).toBe(422);
    expect(mocks.queries).toHaveLength(0);
  });
});
