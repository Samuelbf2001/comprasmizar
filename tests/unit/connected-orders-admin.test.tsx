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
    // 4, no 2: reunión agosto 2026 sumó la columna "Pagado / Total", que repite el mismo total
    // ("$0 / $11.900") junto a la columna "Valor" ya existente — una aparición más por fila.
    expect(screen.getAllByText(/11\.900/).length).toBe(4);
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

// Reunión agosto 2026 (pedido del cliente): "saber cuánto se ha pagado de cada orden" con pagos
// parciales, sin romper el marcado de "pagada" existente (ver los describe de arriba, sin tocar).
describe("panel de Pagos — columna 'Pagado / Total' y formulario de la ficha", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // 1 × $100.000, sin IVA, ya con $50.000 pagados (Order.paidAmount, servido por el mismo SELECT).
  const rowWithPayment = {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    requisitionConsecutive: "RQ-001",
    workId: "work-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "contabilizada" as const,
    paidAmount: 50_000,
    lines: [{ id: "item-1", description: "Cemento", quantity: 1, unit: "bulto", unitBase: 100_000, ivaRate: 0 }],
  };

  /** Enruta por método/URL: GET/POST de /api/orders/:id/payments, y el resto (expediente del proveedor) con una respuesta neutra. */
  function mockFetch(history: unknown[] = []) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input), method = init?.method ?? "GET";
      if (url === "/api/orders/order-1/payments" && method === "GET") {
        return new Response(JSON.stringify(history), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/orders/order-1/payments" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({ payment: { id: "pago-nuevo", orderId: "order-1", ...body }, order: { ...rowWithPayment, paidAmount: rowWithPayment.paidAmount + body.amount } }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ id: "supplier-1", documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it('la tabla muestra "Pagado / Total" junto a "Valor" (Order.paidAmount, sin llamada aparte)', () => {
    render(<ConnectedOrders data={{ rows: [rowWithPayment], catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
    expect(screen.getByText("Pagado / Total")).toBeInTheDocument();
    const row = screen.getByText("OC-001").closest("tr")!;
    expect(row.textContent).toMatch(/50\.000/); // pagado
    expect(row.textContent).toMatch(/100\.000/); // total
  });

  it("una orden sin pagos muestra $0 de pagado (nunca en blanco), y sin lines el total también es 0", () => {
    render(<ConnectedOrders data={{ rows: [{ ...rowWithPayment, paidAmount: undefined, lines: undefined }], catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
    const row = screen.getByText("OC-001").closest("tr")!;
    expect(row.textContent).toMatch(/\$\s?0\s?\/\s?\$\s?0/);
  });

  it("al abrir la ficha, el panel Pagos carga el historial (GET) y contabilidad puede registrar un pago (POST)", async () => {
    const fetchMock = mockFetch([{ id: "pago-0", orderId: "order-1", date: "2026-08-01", amount: 50_000, method: "efectivo" }]);
    const refresh = vi.fn();
    render(<ConnectedOrders data={{ rows: [rowWithPayment], catalogs }} role="Contabilidad" refresh={refresh} go={vi.fn()} />);
    fireEvent.click(screen.getByText("OC-001"));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/orders/order-1/payments")).toBe(true),
    );
    // El historial ya cargado se ve en la ficha (medio de pago, vía estadoLabel). getAllByText
    // porque "Efectivo" también es una opción del <select> del formulario, más abajo.
    await waitFor(() => expect(screen.getAllByText("Efectivo").length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("Fecha"), { target: { value: "2026-08-20" } });
    fireEvent.change(screen.getByLabelText("Valor"), { target: { value: "20000" } });
    fireEvent.change(screen.getByLabelText("Medio"), { target: { value: "transferencia" } });
    fireEvent.click(screen.getByRole("button", { name: "Registrar pago" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => String(input) === "/api/orders/order-1/payments" && init?.method === "POST"),
      ).toBe(true),
    );
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/orders/order-1/payments" && init?.method === "POST")!;
    expect(JSON.parse(String(postCall[1]?.body))).toEqual({ date: "2026-08-20", amount: 20_000, method: "transferencia" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("un aprobador (sin payment:register) ve el historial pero no el formulario de registro", async () => {
    mockFetch([]);
    render(<ConnectedOrders data={{ rows: [rowWithPayment], catalogs }} role="Aprobador" refresh={vi.fn()} go={vi.fn()} />);
    fireEvent.click(screen.getByText("OC-001"));
    expect(await screen.findByText("Sin pagos registrados todavía.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar pago" })).toBeNull();
  });

  it("una orden ya pagada no ofrece el formulario, ni siquiera a contabilidad", async () => {
    mockFetch([]);
    render(<ConnectedOrders data={{ rows: [{ ...rowWithPayment, adminStatus: "pagada" }], catalogs }} role="Contabilidad" refresh={vi.fn()} go={vi.fn()} />);
    fireEvent.click(screen.getByText("OC-001"));
    expect(await screen.findByText("Esta orden ya está pagada; no admite más pagos.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Registrar pago" })).toBeNull();
  });
});
