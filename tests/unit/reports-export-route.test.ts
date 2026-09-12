import { beforeEach, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import type { Requisition } from "../../lib/domain";
import type { Page } from "../../lib/services";

/**
 * RF-1301 (Reportes, reunión 2026-09-11): GET /api/reports/export — mismo patrón de mocks que
 * tests/unit/public-access-route.test.ts, para probar SOLO el contrato HTTP (permiso, filtros,
 * content-type/nombre de archivo/filas, agrupado por obra en el mes) sin Postgres real.
 */
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["contabilidad"] as string[] },
  rows: [] as Requisition[],
  appendCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    requisitions: {
      listVisibleTo: async (): Promise<Page<Requisition>> => ({ rows: mocks.rows, nextCursor: null }),
    },
    audit: { append: async (event: Record<string, unknown>) => { mocks.appendCalls.push(event); } },
  }),
  postgresReportCatalogSource: () => ({
    load: async () => ({
      works: new Map([["work-1", "Altos de La Pradera"], ["work-2", "Bodega Industrial Norte"]]),
      tags: new Map([["tag-1", "Materiales"]]),
      societies: new Map([["soc-1", "Constructora Mizar S.A.S."]]),
      users: new Map([["juliana", "Juliana Rojas"], ["nelson", "Nelson Ríos"]]),
      suppliers: new Map([["prov-1", "Cementos del Oriente SAS"]]),
    }),
  }),
}));

import { GET } from "../../app/api/reports/export/route";

const item = (overrides: Partial<Requisition["items"][number]> = {}) => ({
  id: overrides.id ?? "item-1", quantity: 1, unit: "unidad", unitBase: 100_000, unitIva: 19_000, status: "aprobado" as const, ...overrides,
});
const requisition = (overrides: Partial<Requisition> = {}): Requisition => ({
  id: "req-1", consecutive: "REQ-2026-0001", type: "compra", channel: "web", status: "aprobada",
  societyId: "soc-1", workId: "work-1", tagId: "tag-1", approverId: "juliana",
  items: [item({ finalSupplierId: "prov-1" })], createdAt: "2026-09-10T12:00:00.000Z", ...overrides,
});

function requestFor(search = ""): Request {
  return new Request(`https://app.mizar.test/api/reports/export${search}`);
}

// node_modules/exceljs/index.d.ts declara su PROPIO `interface Buffer extends ArrayBuffer {}` local al
// módulo (sin `declare global`) — no es el `Buffer` real de Node que ve el resto de este archivo, así
// que un Buffer de verdad (como el que arma `Buffer.from(await response.arrayBuffer())`) nunca es
// asignable a ese parámetro por more casts que se le pongan a "Buffer" tal cual (ese nombre, en este
// archivo, sigue resolviendo al Buffer real de Node, no al de exceljs). Mismo desajuste de tipos —
// distinta causa exacta— que ya documenta app/api/reports/expenses-report.ts sobre `writeBuffer()`.
// `Parameters<...>[0]` extrae el tipo que `load` pide DE VERDAD en este punto de la llamada, sin tener
// que nombrarlo.
async function loadWorkbookFromResponse(response: Response): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const bytes = Buffer.from(await response.arrayBuffer());
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return workbook;
}

describe("GET /api/reports/export — RF-1301", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["contabilidad"] };
    mocks.rows = [requisition()];
    mocks.appendCalls = [];
  });

  it("responde .xlsx autenticado, con Content-Type y nombre de archivo correctos", async () => {
    const response = await GET(requestFor("?period=2026-09"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=reporte-requisiciones-2026-09.xlsx");
  });

  it("sin filtro de periodo, el nombre de archivo no lleva sufijo de mes", async () => {
    const response = await GET(requestFor());
    expect(response.headers.get("Content-Disposition")).toBe("attachment; filename=reporte-requisiciones.xlsx");
  });

  it("el libro trae una fila por requisición con los nombres resueltos, y una hoja de ítems", async () => {
    const response = await GET(requestFor("?period=2026-09"));
    const workbook = await loadWorkbookFromResponse(response);
    const summary = workbook.getWorksheet("Reporte")!;
    expect(summary.getRow(1).values).toEqual(expect.arrayContaining(["Consecutivo", "Empresa", "Aprobador(es)", "Proveedor(es)"]));
    const dataRow = summary.getRow(2).values as unknown[];
    expect(dataRow).toEqual(expect.arrayContaining(["REQ-2026-0001", "Constructora Mizar S.A.S.", "Altos de La Pradera", "Materiales", "Juliana Rojas", "aprobada", "Cementos del Oriente SAS"]));
    const items = workbook.getWorksheet("Ítems")!;
    expect(items.rowCount).toBe(2); // encabezado + 1 ítem
  });

  it("con periodo (compilado mensual), agrupa por obra con un subtotal por obra", async () => {
    mocks.rows = [requisition({ id: "req-1", workId: "work-1" }), requisition({ id: "req-2", workId: "work-2", consecutive: "REQ-2026-0002" })];
    const response = await GET(requestFor("?period=2026-09"));
    const workbook = await loadWorkbookFromResponse(response);
    const summary = workbook.getWorksheet("Reporte")!;
    const texts = summary.getSheetValues().flat().filter((value): value is string => typeof value === "string");
    expect(texts.some((value) => value.startsWith("Subtotal "))).toBe(true);
    expect(texts).toContain("TOTAL GENERAL");
  });

  it("sin periodo, NO agrupa por obra (export ad-hoc queda plano)", async () => {
    mocks.rows = [requisition({ id: "req-1", workId: "work-1" }), requisition({ id: "req-2", workId: "work-2", consecutive: "REQ-2026-0002" })];
    const response = await GET(requestFor());
    const workbook = await loadWorkbookFromResponse(response);
    const summary = workbook.getWorksheet("Reporte")!;
    const texts = summary.getSheetValues().flat().filter((value): value is string => typeof value === "string");
    expect(texts.some((value) => value.startsWith("Subtotal "))).toBe(false);
  });

  it("registra auditoría con el número de filas y los filtros aplicados", async () => {
    await GET(requestFor("?period=2026-09&workId=00000000-0000-4000-8000-000000000001"));
    expect(mocks.appendCalls).toHaveLength(1);
    expect(mocks.appendCalls[0]).toMatchObject({ entity: "reporte", event: "reporte_requisiciones_descargado", data: { rows: 1, period: "2026-09" } });
  });

  it("rechaza un periodo mal formado con 422, sin llegar a construir el archivo", async () => {
    const response = await GET(requestFor("?period=2026-9"));
    expect(response.status).toBe(422);
    expect(mocks.appendCalls).toHaveLength(0);
  });

  it("un rol sin 'report:export' (revisor) recibe 403 aunque sí tenga 'report:read'", async () => {
    mocks.actor = { id: "actor-1", roles: ["revisor"] };
    const response = await GET(requestFor());
    expect(response.status).toBe(403);
  });

  it("un aprobador SÍ puede exportar (RF-1301, Juliana)", async () => {
    mocks.actor = { id: "juliana", roles: ["aprobador"] };
    const response = await GET(requestFor("?period=2026-09"));
    expect(response.status).toBe(200);
  });
});
