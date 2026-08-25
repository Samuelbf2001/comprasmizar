// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectedExpenses,
  ConnectedNewRequisition,
  ConnectedRequisitionDetail,
  DemoRequisitionScreen,
} from "../../components/screens/connected";
import { ExpensesScreen } from "../../components/screens/operations";

describe("superficies demo de adjuntos operativos", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("valida metadata de soporte general y foto por ítem antes de guardar", () => {
    render(<DemoRequisitionScreen />);
    const support = new File(["pdf"], "soporte.pdf", { type: "application/pdf" });
    const photo = new File(["png"], "frente.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Soporte general (opcional)"), {
      target: { files: [support] },
    });
    fireEvent.change(screen.getByLabelText("Foto del ítem (opcional)"), {
      target: { files: [photo] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar borrador" }));
    expect(screen.getByRole("status")).toHaveTextContent("archivos cumplen");
    expect(screen.getByText(/soporte\.pdf/)).toBeInTheDocument();
    expect(screen.getByText(/frente\.png/)).toBeInTheDocument();
  });

  it("mantiene caja menor sin carga para Contabilidad", () => {
    render(<ExpensesScreen role="Contabilidad" />);
    expect(screen.queryByRole("button", { name: "Registrar caja menor" })).toBeNull();
    expect(screen.queryByLabelText("Recibo o soporte (opcional)")).toBeNull();
  });

  it("muestra descarga privada detrás del endpoint de download", () => {
    render(
      <ConnectedRequisitionDetail
        role="Contabilidad"
        go={() => undefined}
        refresh={() => undefined}
        data={{
          requisition: {
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            channel: "interno",
            requiredDate: "2026-08-24",
            status: "en_revision",
            items: [
              { id: "item-1", description: "Arena", quantity: 1, unit: "saco" },
            ],
          },
          catalogs: { works: [], tags: [], suppliers: [], items: [], features: {} },
          orders: [],
          expenses: [],
          history: [],
          attachments: [
            {
              id: "att-1",
              entity: "requisicion",
              entityId: "req-1",
              type: "soporte",
              name: "orden.pdf",
              mimeType: "application/pdf",
              sizeBytes: 10,
            },
          ],
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /orden\.pdf/ });
    expect(link).toHaveAttribute(
      "href",
      "/api/attachments/requisicion/req-1/att-1/download",
    );
    expect(link).not.toHaveAttribute("href", expect.stringContaining("signed"));
  });

  it("no duplica la requisición si falla prepare después de crearla", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/requisitions") {
        return new Response(
          JSON.stringify({
            id: "req-1",
            items: [{ id: "item-1" }],
          }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ message: "prepare rechazado" }), { status: 500 });
    });
    render(
      <ConnectedNewRequisition
        catalogs={{
          works: [{ id: "work-1", name: "Torre Norte" }],
          tags: [], suppliers: [], items: [], features: {},
        }}
        go={() => undefined}
      />,
    );
    fireEvent.change(screen.getByLabelText("Soporte general (opcional)"), {
      target: { files: [new File(["pdf"], "soporte.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("Descripción nueva"), {
      target: { value: "Material de obra" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Crear requisición/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("sí fue creada"));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/requisitions")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ver requisición" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Crear requisición/ }));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/requisitions")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Crear requisición/ })).toBeDisabled();
  });

  it("no duplica caja menor si falla el recibo y deja actualizar la lista", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "/api/petty-cash") {
        return new Response(
          JSON.stringify({ entry: { id: "petty-1", workId: "work-1", tagId: "tag-1", date: "2026-08-24", concept: "Caja", amount: 1000 } }),
          { status: 201 },
        );
      }
      return new Response(JSON.stringify({ message: "prepare rechazado" }), { status: 500 });
    });
    const refresh = vi.fn();
    render(
      <ConnectedExpenses
        role="Revisor"
        pathname="/gastos"
        refresh={refresh}
        data={{
          expenses: [],
          pettyCash: [],
          pettyAttachments: {},
          catalogs: {
            works: [{ id: "work-1", name: "Torre Norte" }],
            tags: [{ id: "tag-1", name: "Operación" }],
            suppliers: [], items: [], features: {},
          },
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Concepto"), { target: { value: "Caja" } });
    fireEvent.change(screen.getByLabelText("Valor COP"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Recibo o soporte (opcional)"), {
      target: { files: [new File(["pdf"], "recibo.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Registrar gasto" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("sí fue creada"));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/petty-cash")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Actualizar lista" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Registrar gasto" })).toBeDisabled();
  });
});
