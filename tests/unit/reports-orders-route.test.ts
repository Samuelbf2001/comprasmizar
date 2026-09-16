import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../../lib/domain";
import type { Page } from "../../lib/services";

/** RF-707: GET /api/reports/orders (JSON, bloque "comprometido vs pagado" de /reportes) — mismo patrón
 *  de mocks que tests/unit/reports-route.test.ts. */
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["contabilidad"] as string[] },
  rows: [] as Order[],
  queries: [] as unknown[],
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    orders: {
      listVisibleTo: async (_actor: unknown, query: unknown): Promise<Page<Order>> => {
        mocks.queries.push(query);
        return { rows: mocks.rows, nextCursor: null };
      },
    },
  }),
}));

import { GET } from "../../app/api/reports/orders/route";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "ord-1", consecutive: "OP-2026-0007", type: "OP", requisitionId: "req-1", itemIds: ["a"], status: "generada", adminStatus: "pendiente",
  generatedAt: "2026-09-10T12:00:00.000Z", costCenterId: "cc-1", billedCompanyId: "soc-1",
  lines: [{ id: "a", quantity: 1, unit: "unidad", unitBase: 640_000, unitIva: 0, status: "aprobado" }], paidAmount: 640_000, paymentStatus: "pagada", paymentMethods: ["efectivo"], ...overrides,
});

function requestFor(search = ""): Request {
  return new Request(`https://app.mizar.test/api/reports/orders${search}`);
}

describe("GET /api/reports/orders — RF-707", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["contabilidad"] };
    mocks.rows = [order()];
    mocks.queries = [];
  });

  it("responde 200 con una fila por orden: total, pagado, estado de pago y periodo", async () => {
    const response = await GET(requestFor());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: Array<Record<string, unknown>> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ id: "ord-1", consecutive: "OP-2026-0007", total: 640_000, paidAmount: 640_000, paymentStatus: "pagada", period: "2026-09", costCenterId: "cc-1", billedCompanyId: "soc-1" });
  });

  it("traduce los query params (mes, centro de costo, empresa facturada, medio y estado de pago) al ListQuery", async () => {
    await GET(requestFor("?period=2026-09&costCenterId=00000000-0000-4000-8000-000000000004&billedCompanyId=00000000-0000-4000-8000-000000000005&paymentMethod=efectivo&paymentStatus=parcial"));
    expect(mocks.queries[0]).toMatchObject({
      from: "2026-09-01", to: "2026-09-30", costCenterId: "00000000-0000-4000-8000-000000000004", billedCompanyId: "00000000-0000-4000-8000-000000000005",
      paymentMethod: "efectivo", paymentStatus: "parcial", status: ["generada", "cumplida", "no_cumplida"],
    });
  });

  it("rechaza con 422 un medio de pago fuera del enum, un estado de pago inválido o un parámetro desconocido", async () => {
    expect((await GET(requestFor("?paymentMethod=caja"))).status).toBe(422);
    expect((await GET(requestFor("?paymentStatus=pagado"))).status).toBe(422);
    expect((await GET(requestFor("?approverId=00000000-0000-4000-8000-000000000003"))).status).toBe(422);
    expect(mocks.queries).toHaveLength(0);
  });

  it("un rol sin 'report:read' (solicitante) recibe 403; un revisor sí lo ve", async () => {
    mocks.actor = { id: "actor-1", roles: ["solicitante"] };
    expect((await GET(requestFor())).status).toBe(403);
    mocks.actor = { id: "actor-1", roles: ["revisor"] };
    expect((await GET(requestFor())).status).toBe(200);
  });
});
