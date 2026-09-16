import { describe, expect, it, vi } from "vitest";
import type { Expense, Order, Requisition } from "../../lib/domain";

// Parche del coordinador (ver ESTADO.md, feat/captura-pago-ui → "Parche para el coordinador"):
// GET /api/requisitions/:id/detail debe devolver viewerRoles = actor.roles, igual que ya hace con
// viewerId, para que detail.tsx (S2, RF-308/A9) pueda ofrecer "Aprobar yo mismo" a un revisor+
// aprobador sin depender de la lente `role`, que solo conoce el rol único con el que se inició sesión.

const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["revisor", "aprobador"] as string[] },
  detail: {
    requisition: { id: "req-1", consecutive: "REQ-2026-0001", type: "compra", channel: "web", status: "en_revision", items: [] } as Requisition,
    orders: [] as Order[],
    expenses: [] as Expense[],
    history: [],
  },
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => ({}),
}));
vi.mock("../../lib/infrastructure/attachment-repositories", () => ({
  createPrivateAttachmentServiceDependencies: () => ({}),
}));
vi.mock("../../lib/services", () => ({
  ProcurementService: class { async getRequisitionDetail() { return mocks.detail; } },
  PrivateAttachmentService: class { async listForRequisition() { return { attachments: [] }; } },
}));

import { GET } from "../../app/api/requisitions/[id]/detail/route";

describe("GET /api/requisitions/:id/detail — viewerRoles", () => {
  it("la respuesta trae viewerRoles = actor.roles junto a viewerId", async () => {
    const response = await GET(
      new Request("https://app.mizar.test/api/requisitions/11111111-1111-4111-8111-111111111111/detail"),
      { params: Promise.resolve({ id: "11111111-1111-4111-8111-111111111111" }) },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { viewerId?: string; viewerRoles?: string[] };
    expect(body.viewerId).toBe("actor-1");
    expect(body.viewerRoles).toEqual(["revisor", "aprobador"]);
  });
});
