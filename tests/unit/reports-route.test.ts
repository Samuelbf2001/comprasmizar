import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Requisition } from "../../lib/domain";
import type { Page } from "../../lib/services";

/** RF-1301 (Reportes): GET /api/reports (JSON, pantalla) — mismo patrón de mocks que
 *  tests/unit/reports-export-route.test.ts, sin resolución de nombres (eso solo lo hace el Excel). */
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["contabilidad"] as string[] },
  rows: [] as Requisition[],
  queries: [] as unknown[],
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    requisitions: {
      listVisibleTo: async (_actor: unknown, query: unknown): Promise<Page<Requisition>> => {
        mocks.queries.push(query);
        return { rows: mocks.rows, nextCursor: null };
      },
    },
  }),
}));

import { GET } from "../../app/api/reports/route";

const requisition = (overrides: Partial<Requisition> = {}): Requisition => ({
  id: "req-1", consecutive: "REQ-2026-0001", type: "compra", channel: "web", status: "aprobada",
  workId: "work-1", tagId: "tag-1", approverId: "juliana", items: [], createdAt: "2026-09-10T12:00:00.000Z", ...overrides,
});

function requestFor(search = ""): Request {
  return new Request(`https://app.mizar.test/api/reports${search}`);
}

describe("GET /api/reports — RF-1301", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["contabilidad"] };
    mocks.rows = [requisition()];
    mocks.queries = [];
  });

  it("responde 200 con las filas del reporte en JSON, ids crudos (sin resolver nombres)", async () => {
    const response = await GET(requestFor());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<{ id: string; workId?: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: "req-1", workId: "work-1", tagId: "tag-1" });
  });

  it("traduce los query params a los filtros del servicio (obra, mes, aprobador, etiqueta)", async () => {
    await GET(requestFor("?workId=00000000-0000-4000-8000-000000000001&tagId=00000000-0000-4000-8000-000000000002&approverId=00000000-0000-4000-8000-000000000003&period=2026-09"));
    expect(mocks.queries[0]).toMatchObject({
      workId: "00000000-0000-4000-8000-000000000001",
      tagId: "00000000-0000-4000-8000-000000000002",
      approverId: "00000000-0000-4000-8000-000000000003",
      from: "2026-09-01",
      to: "2026-09-30",
    });
  });

  // Centros de costo (UI, 2026-09-12): mismo contrato que obra/etiqueta/aprobador de arriba.
  it("traduce costCenterId a los filtros del servicio", async () => {
    await GET(requestFor("?costCenterId=00000000-0000-4000-8000-000000000004"));
    expect(mocks.queries[0]).toMatchObject({ costCenterId: "00000000-0000-4000-8000-000000000004" });
  });

  // RF-707 (adenda de pagos): empresa facturada, mismo contrato aditivo.
  it("traduce billedCompanyId a los filtros del servicio y rechaza un uuid inválido", async () => {
    await GET(requestFor("?billedCompanyId=00000000-0000-4000-8000-000000000005"));
    expect(mocks.queries[0]).toMatchObject({ billedCompanyId: "00000000-0000-4000-8000-000000000005" });
    expect((await GET(requestFor("?billedCompanyId=no-es-un-uuid"))).status).toBe(422);
  });

  it("un uuid inválido en costCenterId se rechaza con 422", async () => {
    const response = await GET(requestFor("?costCenterId=no-es-un-uuid"));
    expect(response.status).toBe(422);
  });

  it("un revisor SÍ puede ver el reporte (report:read) aunque no pueda exportarlo", async () => {
    mocks.actor = { id: "actor-1", roles: ["revisor"] };
    const response = await GET(requestFor());
    expect(response.status).toBe(200);
  });

  it("un rol sin 'report:read' (solicitante) recibe 403", async () => {
    mocks.actor = { id: "actor-1", roles: ["solicitante"] };
    const response = await GET(requestFor());
    expect(response.status).toBe(403);
  });

  it("un periodo mal formado se rechaza con 422", async () => {
    const response = await GET(requestFor("?period=09-2026"));
    expect(response.status).toBe(422);
  });

  it("un uuid inválido en approverId se rechaza con 422", async () => {
    const response = await GET(requestFor("?approverId=no-es-un-uuid"));
    expect(response.status).toBe(422);
  });
});
