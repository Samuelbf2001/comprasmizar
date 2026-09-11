// @vitest-environment jsdom

// BLOQUEANTE 2 (QA 2026-08-31): Daniel aprobaba una requisición y esta desaparecía de toda
// bandeja — "Generar órdenes" vive en el detalle de una requisición `aprobada`, pero /revision
// solo mostraba ["enviada", "en_revision", "devuelta"] y /ordenes solo lista órdenes YA
// generadas. Este test cubre que una `aprobada` SIN ninguna orden generada aparezca en un grupo
// propio y visible en /revision ("Listas para generar orden"), y que una `aprobada` que YA
// generó su orden no vuelva a aparecer ahí (ni en la bandeja normal).

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitions } from "../../components/screens/connected";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [{ id: "tag-1", name: "Urgente" }],
  suppliers: [],
  items: [],
  features: {},
};

const rows = [
  {
    id: "req-ready",
    consecutive: "RQ-100",
    type: "compra" as const,
    workId: "work-1",
    channel: "web",
    requiredDate: "2026-08-10",
    tagId: "tag-1",
    status: "aprobada",
    items: [{ id: "item-1", description: "Arena", quantity: 10, unit: "m3", unitBase: 50_000, ivaRate: 0.19 }],
  },
  {
    id: "req-already-ordered",
    consecutive: "RQ-101",
    type: "compra" as const,
    workId: "work-1",
    channel: "web",
    requiredDate: "2026-08-11",
    tagId: "tag-1",
    status: "aprobada",
    items: [{ id: "item-2", description: "Grava", quantity: 5, unit: "m3", unitBase: 40_000, ivaRate: 0.19 }],
  },
  {
    id: "req-in-review",
    consecutive: "RQ-102",
    type: "compra" as const,
    workId: "work-1",
    channel: "web",
    requiredDate: "2026-08-12",
    status: "en_revision",
    items: [],
  },
];

const orders = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-already-ordered",
    status: "generada",
    adminStatus: "pendiente" as const,
    itemIds: ["item-2"],
  },
];

describe("BLOQUEANTE 2: aprobada sin órdenes aparece en /revision", () => {
  afterEach(() => cleanup());

  it("muestra la 'aprobada' sin órdenes en el grupo 'Listas para generar orden', con contador", () => {
    render(
      <ConnectedRequisitions data={{ rows, catalogs, orders }} pathname="/revision" go={vi.fn()} />,
    );
    const panel = screen.getByTestId("ready-for-order-panel");
    expect(panel).toHaveTextContent("Listas para generar orden");
    expect(panel).toHaveTextContent("RQ-100");
    expect(panel).toHaveTextContent("1 lista");
    // La que ya generó su orden no debe aparecer en el grupo nuevo...
    expect(screen.queryByText("RQ-101")).toBeNull();
    // ...ni en la bandeja normal (que solo trae enviada/en_revision/devuelta).
    expect(screen.getByText("RQ-102")).toBeInTheDocument();
  });

  it("no revienta ni muestra el grupo cuando el bundle no trae `orders` (rol sin order:read)", () => {
    render(
      <ConnectedRequisitions data={{ rows: [rows[2]], catalogs }} pathname="/revision" go={vi.fn()} />,
    );
    expect(screen.queryByTestId("ready-for-order-panel")).toBeNull();
    expect(screen.getByText("RQ-102")).toBeInTheDocument();
  });
});
