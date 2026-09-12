// @vitest-environment jsdom

// Centros de costo (UI, reunión 2026-09-12, dueño del producto): «en la requisición sale
// PREDETERMINADO el centro asociado a la obra y se puede cambiar». Cubre la precarga desde la obra
// (sin pisar una elección ya hecha), que viaje en reviewBody() (autoguardado y "Enviar a aprobación"),
// la cabecera de solo lectura, y el rótulo "Concepto" para requisiciones tipo "pago" (pendiente que
// dejó otro agente).

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";

const catalogs = {
  works: [
    { id: "work-1", name: "Torre Norte", societyId: "soc-1", costCenterId: "cc-1" },
    { id: "work-2", name: "Torre Sur", societyId: "soc-1", costCenterId: "cc-2" },
    { id: "work-3", name: "Bodega Sin Centro", societyId: "soc-1" },
  ],
  tags: [{ id: "tag-1", name: "Materiales" }],
  suppliers: [],
  items: [],
  approvers: [{ id: "approver-1", name: "Nelson Aprobador" }],
  costCenters: [
    { id: "cc-1", name: "Administrativo" },
    { id: "cc-2", name: "Obra civil" },
  ],
  features: {},
};

function baseRequisition(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    consecutive: "RQ-001",
    type: "compra" as const,
    societyId: "soc-1",
    channel: "interno",
    status: "en_revision",
    items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 100000 }],
    ...overrides,
  };
}

function renderDetail(requisitionOverrides: Record<string, unknown> = {}, role: "Revisor" | "Contabilidad" = "Revisor") {
  return render(
    <ConnectedRequisitionDetail
      data={{
        requisition: baseRequisition(requisitionOverrides),
        catalogs,
        orders: [],
        expenses: [],
        history: [],
        attachments: [],
      }}
      role={role}
      go={vi.fn()}
      refresh={vi.fn()}
    />,
  );
}

describe("centro de costo: precarga desde la obra, editable, viaja en el body", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("al elegir obra, precarga el centro de costo DEFAULT de esa obra", () => {
    renderDetail();
    const costCenterSelect = screen.getByRole("combobox", { name: "Centro de costo" });
    expect(costCenterSelect).toHaveValue("");
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-1" } });
    expect(costCenterSelect).toHaveValue("cc-1");
  });

  it("no pisa un centro de costo ya elegido al cambiar de obra", () => {
    renderDetail();
    const costCenterSelect = screen.getByRole("combobox", { name: "Centro de costo" });
    // El revisor elige un centro por su cuenta ANTES de tocar obra.
    fireEvent.change(costCenterSelect, { target: { value: "cc-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-1" } });
    // work-1 trae "cc-1" como default, pero la elección manual ya hecha no se pisa.
    expect(costCenterSelect).toHaveValue("cc-2");
  });

  it("una obra sin centro configurado no cambia la selección (sigue vacía)", () => {
    renderDetail();
    const costCenterSelect = screen.getByRole("combobox", { name: "Centro de costo" });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-3" } });
    expect(costCenterSelect).toHaveValue("");
  });

  it("el centro de costo elegido viaja en reviewBody() al pulsar Enviar a aprobación", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    renderDetail();
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "tag-1" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Obra" }), { target: { value: "work-2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Aprobador" }), { target: { value: "approver-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [primera] = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(primera.action).toBe("review");
    // work-2 trae "cc-2" como default, precargado sin que el revisor lo haya tocado a mano.
    expect(primera.costCenterId).toBe("cc-2");
  });

  it("el centro de costo se autoguarda (mismo cuerpo que review()), sin esperar a Enviar a aprobación", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderDetail({ status: "en_revision", tagId: "tag-1", workId: "work-1" });
    fireEvent.change(screen.getByRole("combobox", { name: "Centro de costo" }), { target: { value: "cc-2" } });
    await vi.advanceTimersByTimeAsync(1600);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    vi.useRealTimers();
    const body = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(body.costCenterId).toBe("cc-2");
  });

  it("muestra el centro de costo en la cabecera de solo lectura", () => {
    renderDetail({ costCenterId: "cc-1", status: "aprobada" }, "Contabilidad");
    expect(screen.getByTestId("requisition-cost-center")).toHaveTextContent("Administrativo");
  });

  it("sin centro de costo asignado, la cabecera de solo lectura lo dice honestamente", () => {
    renderDetail({ status: "aprobada" }, "Contabilidad");
    expect(screen.getByTestId("requisition-cost-center")).toHaveTextContent("Sin centro asignado");
  });
});

describe("pendiente que dejó otro agente: 'Concepto' en vez de 'Ítems' para requisiciones tipo pago", () => {
  afterEach(() => cleanup());

  it("una requisición tipo pago rotula la sección 'Concepto y cotización'", () => {
    renderDetail({ type: "pago" }, "Revisor");
    expect(screen.getByRole("heading", { name: "Concepto y cotización" })).toBeInTheDocument();
  });

  it("una requisición tipo compra conserva 'Ítems y cotización'", () => {
    renderDetail({ type: "compra" }, "Revisor");
    expect(screen.getByRole("heading", { name: "Ítems y cotización" })).toBeInTheDocument();
  });
});
