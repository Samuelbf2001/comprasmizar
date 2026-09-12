// @vitest-environment jsdom

// Centros de costo (UI, 2026-09-12) + pendiente que dejó otro agente: la lista/ficha de órdenes debe
// mostrar el centro de costo de la requisición dueña, y el tipo (OC/OP) debe leerse como un chip
// "Compra"/"Pago" en vez del código crudo.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
  costCenters: [{ id: "cc-1", name: "Administrativo" }],
};

const orderRows = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    requisitionConsecutive: "RQ-001",
    workId: "work-1",
    costCenterId: "cc-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "pendiente" as const,
  },
  {
    id: "order-2",
    consecutive: "OP-001",
    type: "OP" as const,
    requisitionId: "req-2",
    requisitionConsecutive: "RQ-002",
    workId: "work-1",
    status: "generada",
    adminStatus: "pendiente" as const,
  },
];

function renderOrders() {
  return render(<ConnectedOrders data={{ rows: orderRows, catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
}

describe("órdenes: centro de costo y chip de tipo (Compra/Pago)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("la lista muestra el centro de costo de la requisición dueña de cada orden", () => {
    renderOrders();
    const row1 = screen.getByText("OC-001").closest("tr")!;
    expect(row1).toHaveTextContent("Administrativo");
    const row2 = screen.getByText("OP-001").closest("tr")!;
    expect(row2).toHaveTextContent("—"); // order-2 no trae costCenterId
  });

  it("el tipo se lee como chip 'Compra'/'Pago', no como el código crudo OC/OP", () => {
    renderOrders();
    expect(screen.getByText("Compra")).toBeInTheDocument();
    expect(screen.getByText("Pago")).toBeInTheDocument();
  });

  it("la ficha de la orden muestra el centro de costo", () => {
    // Abrir la ficha dispara, en segundo plano, la carga del expediente del proveedor y el historial
    // de pagos (mismo patrón que tests/unit/connected-orders-admin.test.tsx).
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "order-1", documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    renderOrders();
    fireEvent.click(screen.getByText("OC-001"));
    // "Centro de costo" también es el encabezado de la columna de la tabla, detrás de la ficha.
    expect(screen.getAllByText("Centro de costo").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Administrativo").length).toBeGreaterThan(0);
  });
});
