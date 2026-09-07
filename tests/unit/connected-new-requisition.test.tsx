// @vitest-environment jsdom

// Reunión 2026-08-31: el solicitante elige EMPRESA, no obra (la asigna el revisor en la
// revisión), y la fecha requerida pasa a opcional (sin default de hoy ni bloqueo por fecha
// pasada). Este archivo cubre ambos cambios contra el payload real enviado a la API.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedNewRequisition } from "../../components/screens/connected";

const catalogs = {
  works: [],
  tags: [],
  suppliers: [],
  items: [],
  features: {},
  societies: [{ id: "soc-1", name: "Constructora Ejemplo" }],
};

describe("alta de requisición: empresa obligatoria, fecha requerida opcional", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("no ofrece un select de obra; el de empresa viene preseleccionado", () => {
    render(<ConnectedNewRequisition catalogs={catalogs} go={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Empresa" })).toHaveValue("soc-1");
    expect(screen.queryByRole("combobox", { name: "Obra" })).toBeNull();
  });

  it("envía la requisición con societyId y sin requiredDate cuando la fecha queda vacía", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-1", items: [{ id: "item-1" }] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const go = vi.fn();
    render(<ConnectedNewRequisition catalogs={catalogs} go={go} />);
    // La fecha requerida arranca vacía (no hay default "hoy") y no bloquea el envío.
    expect(screen.getByLabelText("Fecha requerida (opcional)")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Descripción nueva"), {
      target: { value: "Material de obra" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Crear requisición/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.societyId).toBe("soc-1");
    expect(body).not.toHaveProperty("workId");
    expect(body).not.toHaveProperty("requiredDate");
    expect(body).not.toHaveProperty("destination");
    await waitFor(() => expect(go).toHaveBeenCalledWith("/requisiciones/req-1"));
  });

  it("deshabilita el envío sin ninguna empresa disponible", () => {
    render(
      <ConnectedNewRequisition
        catalogs={{ works: [], tags: [], suppliers: [], items: [], features: {}, societies: [] }}
        go={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Crear requisición/ })).toBeDisabled();
  });
});
