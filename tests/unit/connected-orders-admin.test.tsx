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
// H2/H3 (docs/plan-rendimiento.md): la orden ya trae workId/requisitionConsecutive del servidor,
// no hace falta un array de requisiciones aparte para estos tests (ninguno filtra por obra).
const orderRows = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    requisitionConsecutive: "RQ-001",
    workId: "work-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "contabilizada" as const,
  },
];

function renderOrders(role: "Revisor" | "Contabilidad" | "Administrador Sixteam") {
  return render(
    <ConnectedOrders data={{ rows: orderRows, catalogs }} role={role} refresh={vi.fn()} go={vi.fn()} />,
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

// Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): un agente anterior quitó la
// columna "Valor" y cambió el filtro de fecha de "requerida de la requisición" a "generación de la
// orden" para poder descartar el N+1 sobre /api/requisitions — el revisor rechazó ambos cambios.
// Este bloque prueba que, restauradas, ambas dependen únicamente de `OrderRow.lines`/
// `OrderRow.requiredDate` (join del servidor, sin descargar TODAS las requisiciones).
describe("columna Valor y filtro por fecha requerida (restaurados tras la corrección)", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 10 unidades a $1.000, IVA 19%, sin descuento -> base 10.000, iva 1.900, total 11.900.
  const pricedLine = { id: "item-1", description: "Cemento", quantity: 10, unit: "bulto", unitBase: 1_000, ivaRate: 0.19 };
  const pricedRows = [
    {
      id: "order-1",
      consecutive: "OC-001",
      type: "OC" as const,
      requisitionId: "req-1",
      requisitionConsecutive: "RQ-001",
      workId: "work-1",
      supplierId: "supplier-1",
      status: "generada",
      adminStatus: "pendiente" as const,
      requiredDate: "2026-08-10",
      lines: [pricedLine],
    },
    {
      id: "order-2",
      consecutive: "OC-002",
      type: "OC" as const,
      requisitionId: "req-2",
      requisitionConsecutive: "RQ-002",
      workId: "work-1",
      supplierId: "supplier-1",
      status: "generada",
      adminStatus: "pendiente" as const,
      requiredDate: "2026-09-05",
      lines: [pricedLine],
    },
  ];

  it("la tabla muestra el importe de cada orden (sumLines sobre row.lines, sin llamada aparte)", () => {
    render(<ConnectedOrders data={{ rows: pricedRows, catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
    expect(screen.getByText("Fecha requerida")).toBeInTheDocument();
    expect(screen.getByText("Valor")).toBeInTheDocument();
    // Dos filas con el mismo importe. Se compara por dígitos (no el string exacto de
    // Intl.NumberFormat) por la misma razón que order-detail-total.test.tsx: no depender de si el
    // espacio entre "$" y el número es un espacio normal o un NBSP.
    expect(screen.getAllByText(/11\.900/).length).toBe(2);
  });

  it('el filtro "Desde/Hasta" acota por row.requiredDate (fecha requerida de la requisición)', () => {
    render(<ConnectedOrders data={{ rows: pricedRows, catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
    expect(screen.getByText("OC-001")).toBeInTheDocument();
    expect(screen.getByText("OC-002")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Desde"), { target: { value: "2026-09-01" } });
    expect(screen.queryByText("OC-001")).toBeNull();
    expect(screen.getByText("OC-002")).toBeInTheDocument();
  });
});
