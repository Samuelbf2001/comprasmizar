// @vitest-environment jsdom

// Reunión 2026-08-31: la orden gana un eje administrativo (pendiente → contabilizada →
// pagada), independiente del eje de cumplimiento que ya existía (generada → cumplida/no
// cumplida/no necesario). Este archivo cubre que ambos ejes se lean a la vez (no como una
// sola secuencia) y que "Marcar contabilizada"/"Marcar pagada" respeten el rol.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
};
const requisitions = [
  {
    id: "req-1",
    consecutive: "RQ-001",
    type: "compra" as const,
    workId: "work-1",
    channel: "web",
    requiredDate: "2026-08-10",
    status: "aprobada",
    items: [],
  },
];
const orderRows = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "contabilizada" as const,
  },
];

function renderOrders(role: "Revisor" | "Contabilidad" | "Administrador Sixteam") {
  return render(
    <ConnectedOrders data={{ rows: orderRows, requisitions, catalogs }} role={role} refresh={vi.fn()} go={vi.fn()} />,
  );
}

describe("dos ejes de estado de la orden, visibles a la vez", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("muestra cumplimiento y eje administrativo como columnas independientes en la tabla", () => {
    renderOrders("Contabilidad");
    // "Generada" (cumplimiento) y "Contabilizada" (administrativo) deben leerse juntas: dos
    // ejes, no una secuencia donde uno reemplaza al otro. getAllByText porque "Generada"
    // también aparece como opción del filtro de estado.
    expect(screen.getAllByText("Generada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Contabilizada").length).toBeGreaterThan(0);
  });

  it("en la ficha de la orden, contabilidad puede marcar pagada solo cuando ya está contabilizada", async () => {
    // Abrir la ficha también dispara, en segundo plano, la carga del expediente del
    // proveedor (GET /api/suppliers/:id) — se filtra por URL en vez de contar llamadas totales.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "order-1", documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    renderOrders("Revisor");
    fireEvent.click(screen.getByText("OC-001"));
    // El eje de cumplimiento y el administrativo aparecen juntos en la ficha.
    expect(screen.getAllByText("Generada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Contabilizada").length).toBeGreaterThan(0);
    // Contabilizada -> pagada es del revisor (order:pay), no de contabilidad.
    const payButton = screen.getByRole("button", { name: "Marcar pagada" });
    fireEvent.click(payButton);
    // MENOR: el confirm nativo se reemplazó por un diálogo accesible propio
    // (useConfirmDialog en screen-primitives.tsx) — se confirma haciendo clic en su botón.
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/orders/order-1/status")).toBe(true),
    );
    const call = fetchMock.mock.calls.find(([input]) => String(input) === "/api/orders/order-1/status")!;
    const init = call[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ adminStatus: "pagada" });
  });

  it("un aprobador (sin order:account ni order:pay) no ve botones del eje administrativo", () => {
    renderOrders("Contabilidad");
    fireEvent.click(screen.getByText("OC-001"));
    // adminStatus ya es "contabilizada": contabilidad no puede volver a contabilizar,
    // y tampoco tiene order:pay para marcar pagada.
    expect(screen.queryByRole("button", { name: "Marcar contabilizada" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Marcar pagada" })).toBeNull();
  });
});
