// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedRequisitions,
  ConnectedOrders,
  ConnectedExpenses,
} from "../../components/screens/connected";

afterEach(() => cleanup());

const catalogs = {
  works: [
    { id: "work-1", name: "Obra Norte" },
    { id: "work-2", name: "Obra Sur" },
  ],
  tags: [
    { id: "tag-1", name: "Urgente" },
    { id: "tag-2", name: "Programado" },
  ],
  suppliers: [
    { id: "supplier-1", name: "Proveedor A" },
    { id: "supplier-2", name: "Proveedor B" },
  ],
  items: [],
  features: {},
};

// QA H5 (adenda de pagos): el pago que llega del portal o de WhatsApp con beneficiario nuevo no se
// distinguía en la bandeja de uno normal; ahora la fila lo marca y el revisor va directo a su ficha.
describe("QA H5: beneficiario pendiente de completar en la bandeja", () => {
  const pago = {
    id: "req-9",
    consecutive: "REQ-2026-0011",
    type: "pago" as const,
    channel: "publico",
    status: "enviada",
    beneficiaryPendingNormalization: true,
    items: [{ id: "item-9", description: "Levantamiento topográfico", quantity: 1, unit: "servicio", unitBase: 1_250_000, finalSupplierId: "supplier-9" }],
  };
  const compra = { id: "req-8", consecutive: "REQ-2026-0010", type: "compra" as const, channel: "web", status: "enviada", items: [] };

  it("marca solo la fila del pago pendiente y enlaza a la ficha del beneficiario para el revisor", () => {
    const go = vi.fn();
    render(<ConnectedRequisitions data={{ rows: [pago, compra], catalogs }} pathname="/revision" go={go} role="Revisor" />);
    const marcas = screen.getAllByTestId("beneficiary-pending");
    expect(marcas).toHaveLength(1);
    expect(marcas[0]).toHaveTextContent("Beneficiario pendiente de completar");
    const enlace = screen.getByRole("link", { name: "Completar la ficha del beneficiario de REQ-2026-0011" });
    expect(enlace).toHaveAttribute("href", "/proveedores?proveedor=supplier-9");
    fireEvent.click(enlace);
    expect(go).toHaveBeenCalledWith("/proveedores?proveedor=supplier-9");
  });

  it("un aprobador ve la marca pero no el enlace: no tiene acceso a Proveedores", () => {
    render(<ConnectedRequisitions data={{ rows: [{ ...pago, status: "en_aprobacion" }], catalogs }} pathname="/aprobaciones" go={vi.fn()} role="Aprobador" />);
    expect(screen.getByTestId("beneficiary-pending")).toHaveTextContent("Beneficiario pendiente de completar");
    expect(screen.queryByRole("link", { name: /Completar la ficha/ })).toBeNull();
  });
});

describe("RF-302: filtros en la bandeja de revisión", () => {
  const rows = [
    {
      id: "req-1",
      consecutive: "RQ-001",
      type: "compra" as const,
      workId: "work-1",
      channel: "web",
      requiredDate: "2026-08-10",
      tagId: "tag-1",
      status: "en_revision",
      items: [],
    },
    {
      id: "req-2",
      consecutive: "RQ-002",
      type: "compra" as const,
      workId: "work-2",
      channel: "whatsapp",
      requiredDate: "2026-08-20",
      tagId: "tag-2",
      status: "enviada",
      items: [],
    },
  ];

  it("filtra por obra ocultando filas de otras obras", () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.getByText("RQ-002")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Obra"), {
      target: { value: "work-1" },
    });

    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.queryByText("RQ-002")).toBeNull();
  });

  it("filtra por etiqueta y muestra un estado vacío claro cuando no hay resultados", () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Etiqueta"), {
      target: { value: "tag-2" },
    });
    expect(screen.queryByText("RQ-001")).toBeNull();
    expect(screen.getByText("RQ-002")).toBeInTheDocument();

    // Combinar con una obra que no tiene esa etiqueta: sin resultados.
    fireEvent.change(screen.getByLabelText("Obra"), {
      target: { value: "work-1" },
    });
    expect(screen.queryByText("RQ-001")).toBeNull();
    expect(screen.queryByText("RQ-002")).toBeNull();
    expect(
      screen.getByText("Sin resultados para estos filtros"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Limpiar filtros" }));
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.getByText("RQ-002")).toBeInTheDocument();
  });

  // Ensayo 2026-09-23: el filtro de estado de /revision solo ofrecía Todos/Devuelta/En revisión/
  // Enviada; las declinadas solo se veían desde "Mis requisiciones" del solicitante. PRD: "declinada
  // es terminal, consultable en su propio filtro".
  it("ofrece Aprobada y Declinada, y al elegir Declinada las pide al servidor con su propio filtro", async () => {
    const declinada = { id: "req-7", consecutive: "RQ-007", type: "compra" as const, channel: "web", status: "declinada", declineReason: "No procede", items: [] };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ rows: [declinada], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    try {
      render(<ConnectedRequisitions data={{ rows, catalogs }} pathname="/revision" go={vi.fn()} role="Revisor" />);
      const estado = screen.getByLabelText("Estado");
      const opciones = within(estado).getAllByRole("option").map((option) => option.textContent);
      expect(opciones).toEqual(expect.arrayContaining(["Aprobada", "Declinada"]));

      fireEvent.change(estado, { target: { value: "declinada" } });
      expect(await screen.findByText("RQ-007")).toBeInTheDocument();
      // Las activas no se mezclan con la consulta de declinadas.
      expect(screen.queryByText("RQ-001")).toBeNull();
      const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
      expect(url.pathname).toBe("/api/requisitions");
      expect(url.searchParams.get("status")).toBe("declinada");

      // Volver a "Por atender" devuelve la bandeja de siempre.
      fireEvent.change(estado, { target: { value: "" } });
      expect(screen.getByText("RQ-001")).toBeInTheDocument();
      expect(screen.queryByText("RQ-007")).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("con la bandeja vacía, el filtro sigue disponible para consultar las declinadas", () => {
    render(<ConnectedRequisitions data={{ rows: [], catalogs }} pathname="/revision" go={vi.fn()} role="Revisor" />);
    expect(within(screen.getByLabelText("Estado")).getByRole("option", { name: "Declinada" })).toBeInTheDocument();
  });
});

describe("RF-506: filtros en el panel de órdenes", () => {
  // H2/H3 (docs/plan-rendimiento.md): la orden ya no se une en cliente con TODAS las
  // requisiciones para saber su obra — `workId`/`requisitionConsecutive` ya viajan en cada fila
  // (join del servidor, ver OrderRow en shared.tsx), así que el fixture los trae directo.
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
    },
    {
      id: "order-2",
      consecutive: "OC-002",
      type: "OC" as const,
      requisitionId: "req-2",
      requisitionConsecutive: "RQ-002",
      workId: "work-2",
      supplierId: "supplier-2",
      status: "no_cumplida",
    },
  ];

  it("filtra por obra usando el workId que ya viaja en la orden (join del servidor)", () => {
    render(
      <ConnectedOrders
        data={{ rows: orderRows, catalogs }}
        role="Contabilidad"
        refresh={vi.fn()}
       go={vi.fn()} />,
    );
    expect(screen.getByText("OC-001")).toBeInTheDocument();
    expect(screen.getByText("OC-002")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Obra"), {
      target: { value: "work-2" },
    });
    expect(screen.queryByText("OC-001")).toBeNull();
    expect(screen.getByText("OC-002")).toBeInTheDocument();
  });

  it("RF-505: el acceso directo a pendientes muestra solo no_cumplida sin perder ninguna", () => {
    render(
      <ConnectedOrders
        data={{ rows: orderRows, catalogs }}
        role="Contabilidad"
        refresh={vi.fn()}
       go={vi.fn()} />,
    );
    fireEvent.click(
      screen.getByLabelText("Solo pendientes (no cumplida)"),
    );
    expect(screen.queryByText("OC-001")).toBeNull();
    expect(screen.getByText("OC-002")).toBeInTheDocument();

    fireEvent.click(
      screen.getByLabelText("Solo pendientes (no cumplida)"),
    );
    expect(screen.getByText("OC-001")).toBeInTheDocument();
    expect(screen.getByText("OC-002")).toBeInTheDocument();
  });

  it("filtra por proveedor", () => {
    render(
      <ConnectedOrders
        data={{ rows: orderRows, catalogs }}
        role="Contabilidad"
        refresh={vi.fn()}
       go={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Proveedor"), {
      target: { value: "supplier-1" },
    });
    expect(screen.getByText("OC-001")).toBeInTheDocument();
    expect(screen.queryByText("OC-002")).toBeNull();
  });
});

describe("RF-703: filtros de gastos por obra y periodo", () => {
  // A10: la pantalla abre en "Cierre de caja" (consulta /api/reports/cash-close); el libro de gastos
  // vive en la segunda pestaña y ya no lista movimientos de caja menor aparte.
  const openLedger = () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ from: "2026-09-14", to: "2026-09-18", rows: [], total: 0 }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <ConnectedExpenses
        data={expenseData}
        role="Contabilidad"
        refresh={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Libro de gastos" }));
  };
  const expenseData = {
    expenses: [
      {
        id: "exp-1",
        workId: "work-1",
        origin: "requisicion",
        referenceId: "req-1",
        // orderDate (generación) distinto de date (pago), a propósito: exercita las dos columnas.
        orderDate: "2026-07-14",
        date: "2026-07-15",
        total: 100000,
        period: "2026-07",
      },
      {
        id: "exp-2",
        workId: "work-2",
        origin: "caja_menor",
        referenceId: "petty-1",
        orderDate: "2026-08-16",
        date: "2026-08-15",
        total: 50000,
        period: "2026-08",
      },
    ],
    catalogs,
    pettyCash: [],
    pettyAttachments: {},
  };

  it("filtra por obra ocultando filas de gastos de otras obras, con estado vacío si nada queda", () => {
    openLedger();
    expect(screen.getByText("2026-07-15")).toBeInTheDocument();
    expect(screen.getByText("2026-08-15")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filtrar por obra"), {
      target: { value: "work-1" },
    });
    expect(screen.getByText("2026-07-15")).toBeInTheDocument();
    expect(screen.queryByText("2026-08-15")).toBeNull();

    fireEvent.change(screen.getByLabelText("Periodo"), {
      target: { value: "2026-08" },
    });
    expect(screen.queryByText("2026-07-15")).toBeNull();
    expect(screen.getByText("Sin resultados para estos filtros")).toBeInTheDocument();
  });

  it("filtra por periodo (corte mensual)", () => {
    openLedger();
    fireEvent.change(screen.getByLabelText("Periodo"), {
      target: { value: "2026-08" },
    });
    expect(screen.queryByText("2026-07-15")).toBeNull();
    expect(screen.getByText("2026-08-15")).toBeInTheDocument();
  });
});
