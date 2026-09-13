import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Requisition } from "../../lib/domain";
import type { Page } from "../../lib/services";

// «Aprobar desde la lista» (reunión 11-sep-2026): GET /api/requisitions?limit=... es lo que
// components/screens/connected/data.ts pide para la bandeja — necesita saber QUIÉN MIRA para
// calcular, en cliente, qué ítems de cada fila decide esa persona (pendingItemsFor,
// lib/domain/rules.ts) sin duplicar esa herencia en el servidor. Mismo patrón de mocks que
// tests/unit/reports-route.test.ts.
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["aprobador"] as string[] },
  rows: [] as Requisition[],
  queries: [] as unknown[],
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({
    requisitions: {
      listVisibleTo: async (_actor: unknown, query?: unknown): Promise<Requisition[] | Page<Requisition>> => {
        mocks.queries.push(query);
        return query ? { rows: mocks.rows, nextCursor: null } : mocks.rows;
      },
    },
  }),
}));

import { GET } from "../../app/api/requisitions/route";

const requisition = (overrides: Partial<Requisition> = {}): Requisition => ({
  id: "req-1", consecutive: "REQ-2026-0001", type: "compra", channel: "web", status: "en_aprobacion",
  workId: "work-1", tagId: "tag-1", approverId: "actor-1", items: [], createdAt: "2026-09-10T12:00:00.000Z", ...overrides,
});

function requestFor(search = ""): Request {
  return new Request(`https://app.mizar.test/api/requisitions${search}`);
}

describe("GET /api/requisitions — viewerId para «Aprobar desde la lista»", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["aprobador"] };
    mocks.rows = [requisition()];
    mocks.queries = [];
  });

  it("la forma paginada ({ rows, nextCursor }, la que usa la bandeja) trae viewerId = actor.id", async () => {
    const response = await GET(requestFor("?limit=100"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rows: unknown[]; nextCursor: string | null; viewerId?: string };
    expect(body.viewerId).toBe("actor-1");
    expect(body.rows).toHaveLength(1);
  });

  it("la forma en array (compatibilidad hacia atrás, sin filtros/paginación) NO cambia: sigue siendo un array plano", async () => {
    const response = await GET(requestFor());
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });
});
