// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";

const baseData = {
  requisition: {
    id: "req-1",
    consecutive: "RQ-001",
    type: "compra" as const,
    workId: "work-1",
    channel: "interno",
    requiredDate: "2026-08-24",
    status: "en_revision",
    items: [
      { id: "item-1", description: "Arena", quantity: 1, unit: "saco" },
    ],
  },
  catalogs: {
    works: [],
    tags: [{ id: "tag-1", name: "Obra" }],
    suppliers: [{ id: "supplier-1", name: "Proveedor existente" }],
    items: [],
    features: {},
  },
  orders: [],
  expenses: [],
  history: [],
  attachments: [],
};

function renderDetail(role: "Revisor" | "Aprobador" = "Revisor") {
  return render(
    <ConnectedRequisitionDetail
      data={baseData}
      role={role}
      go={vi.fn()}
      refresh={vi.fn()}
    />,
  );
}

describe("alta rápida de proveedor desde revisión", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("crea solo con nombre, omite NIT vacío y asigna inmediatamente sin duplicar POST", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "supplier-2", name: "Canteras Norte" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderDetail();
    const trigger = screen.getByRole("button", { name: /Crear proveedor para/ });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Canteras Norte" },
    });
    const submit = screen.getByRole("button", { name: "Crear y asignar" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Canteras Norte" }),
      }),
    );
    expect(screen.getByRole("combobox", { name: "Proveedor final" })).toHaveValue(
      "supplier-2",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Canteras Norte quedó asignado",
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("conserva el diálogo y muestra un conflicto del backend", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "Ya existe un proveedor con el mismo NIT" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Crear proveedor para/ }));
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Duplicado" },
    });
    fireEvent.change(screen.getByLabelText("NIT (opcional)"), {
      target: { value: "900123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear y asignar" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("mismo NIT"),
    );
    expect(screen.getByRole("dialog", { name: "Nuevo proveedor" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("atrapa Tab y Shift+Tab en el diálogo y bloquea la alta para Aprobador", () => {
    renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /Crear proveedor para/ }));
    const close = screen.getByRole("button", { name: "Cerrar alta de proveedor" });
    // El envío solo se habilita con razón social; deshabilitado quedaría fuera
    // de la trampa de foco y nunca sería el último elemento enfocable.
    fireEvent.change(screen.getByLabelText("Razón social *"), {
      target: { value: "Canteras Norte" },
    });
    const submit = screen.getByRole("button", { name: "Crear y asignar" });
    expect(submit).toBeEnabled();
    submit.focus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(submit);

    cleanup();
    renderDetail("Aprobador");
    expect(screen.queryByRole("button", { name: /Crear proveedor para/ })).toBeNull();
  });
});
