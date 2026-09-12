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

// feat/solicitud-de-pago (ítem 3 del encargo): el conmutador «Compra de materiales / Solicitud de
// pago» arma, por debajo, la línea única del modelo (item_id NULL vía descripción libre, cantidad
// 1, unidad "servicio", finalSupplierId = beneficiario, unitBase/ivaRate = valor cotizado) sin
// cambiar el contrato de una compra.
describe("solicitud de pago: conmutador, captura y payload de una sola línea", () => {
  const catalogsWithSuppliers = {
    works: [],
    tags: [],
    suppliers: [{ id: "sup-1", name: "Contratista ABC" }],
    items: [],
    features: {},
    societies: [{ id: "soc-1", name: "Constructora Ejemplo" }],
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("por defecto arranca en modo compra y muestra la sección de Ítems", () => {
    render(<ConnectedNewRequisition catalogs={catalogsWithSuppliers} go={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Compra de materiales" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Ítems" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Solicitud de pago" })).toBeNull();
  });

  it("cambiar a Solicitud de pago oculta Ítems y muestra beneficiario/concepto/valor", () => {
    render(<ConnectedNewRequisition catalogs={catalogsWithSuppliers} go={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Solicitud de pago" }));
    expect(screen.getByRole("button", { name: "Solicitud de pago" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { name: "Ítems" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Solicitud de pago" })).toBeInTheDocument();
    expect(screen.getByLabelText("Beneficiario")).toBeInTheDocument();
    expect(screen.getByLabelText("Concepto")).toBeInTheDocument();
    expect(screen.getByLabelText("Valor base")).toBeInTheDocument();
  });

  it("exige beneficiario, concepto y valor > 0 antes de enviar", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<ConnectedNewRequisition catalogs={catalogsWithSuppliers} go={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Solicitud de pago" }));
    fireEvent.click(screen.getByRole("button", { name: /Crear requisición/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("beneficiario");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("envía una única línea con item_id ausente, cantidad 1, unidad servicio y el valor/beneficiario capturados", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "req-pago-1", items: [{ id: "item-1" }] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const go = vi.fn();
    render(<ConnectedNewRequisition catalogs={catalogsWithSuppliers} go={go} />);
    fireEvent.click(screen.getByRole("button", { name: "Solicitud de pago" }));
    fireEvent.change(screen.getByLabelText("Beneficiario"), { target: { value: "sup-1" } });
    fireEvent.change(screen.getByLabelText("Concepto"), { target: { value: "Pago acta 3 - Contratista ABC" } });
    fireEvent.change(screen.getByLabelText("Valor base"), { target: { value: "500000" } });
    fireEvent.click(screen.getByRole("button", { name: /Crear requisición/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.type).toBe("pago");
    expect(body.items).toEqual([
      {
        description: "Pago acta 3 - Contratista ABC",
        quantity: 1,
        unit: "servicio",
        finalSupplierId: "sup-1",
        unitBase: 500_000,
        ivaRate: 0.19,
      },
    ]);
    expect(body.items[0]).not.toHaveProperty("itemId");
    await waitFor(() => expect(go).toHaveBeenCalledWith("/requisiciones/req-pago-1"));
  });
});
