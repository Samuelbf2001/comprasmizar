// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});

describe("RF-506: filtros en el panel de órdenes", () => {
  const requisitions = [
    {
      id: "req-1",
      consecutive: "RQ-001",
      type: "compra" as const,
      workId: "work-1",
      channel: "web",
      requiredDate: "2026-08-05",
      status: "aprobada",
      items: [],
    },
    {
      id: "req-2",
      consecutive: "RQ-002",
      type: "compra" as const,
      workId: "work-2",
      channel: "web",
      requiredDate: "2026-08-15",
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
    },
    {
      id: "order-2",
      consecutive: "OC-002",
      type: "OC" as const,
      requisitionId: "req-2",
      supplierId: "supplier-2",
      status: "no_cumplida",
    },
  ];

  it("filtra por obra usando la requisición vinculada (la orden no guarda obra propia)", () => {
    render(
      <ConnectedOrders
        data={{ rows: orderRows, requisitions, catalogs }}
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
        data={{ rows: orderRows, requisitions, catalogs }}
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
        data={{ rows: orderRows, requisitions, catalogs }}
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
  const expenseData = {
    expenses: [
      {
        id: "exp-1",
        workId: "work-1",
        origin: "requisicion",
        referenceId: "req-1",
        date: "2026-07-15",
        total: 100000,
        period: "2026-07",
      },
      {
        id: "exp-2",
        workId: "work-2",
        origin: "caja_menor",
        referenceId: "petty-1",
        date: "2026-08-15",
        total: 50000,
        period: "2026-08",
      },
    ],
    catalogs,
    pettyCash: [
      {
        id: "petty-1",
        workId: "work-2",
        date: "2026-08-20",
        concept: "Compra menor",
        tagId: "tag-1",
        amount: 20000,
      },
    ],
    pettyAttachments: {},
  };

  it("filtra por obra ocultando filas de gastos y de caja menor de otras obras", () => {
    render(
      <ConnectedExpenses
        data={expenseData}
        pathname="/gastos"
        role="Contabilidad"
        refresh={vi.fn()}
      />,
    );
    expect(screen.getByText("2026-07-15")).toBeInTheDocument();
    expect(screen.getByText("2026-08-15")).toBeInTheDocument();
    expect(screen.getByText("Compra menor")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filtrar por obra"), {
      target: { value: "work-1" },
    });

    expect(screen.getByText("2026-07-15")).toBeInTheDocument();
    expect(screen.queryByText("2026-08-15")).toBeNull();
    // La caja menor de work-2 desaparece y queda un estado vacío por filtros.
    expect(screen.queryByText("Compra menor")).toBeNull();
    expect(
      screen.getAllByText("Sin resultados para estos filtros").length,
    ).toBeGreaterThan(0);
  });

  it("filtra por periodo (corte mensual)", () => {
    render(
      <ConnectedExpenses
        data={expenseData}
        pathname="/gastos"
        role="Contabilidad"
        refresh={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Periodo"), {
      target: { value: "2026-08" },
    });
    expect(screen.queryByText("2026-07-15")).toBeNull();
    expect(screen.getByText("2026-08-15")).toBeInTheDocument();
    // La caja menor del 2026-08-20 también cae en el periodo 2026-08.
    expect(screen.getByText("Compra menor")).toBeInTheDocument();
  });
});
