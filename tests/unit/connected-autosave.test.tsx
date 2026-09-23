// @vitest-environment jsdom

// Autoguardado (rediseño "una acción por estado/rol", reunión 2026-09): reemplaza los botones
// "Guardar revisión"/"Guardar decisiones" — dispara en `blur` de cualquier campo Y a los 1.500 ms
// de inactividad, coalesce un cambio que llega mientras hay un guardado en vuelo, nunca reenvía un
// JSON idéntico al último guardado con éxito, y no autoguarda mientras falte la etiqueta o alguna
// línea tenga un valor a medio teclear.
import "@testing-library/jest-dom/vitest";
import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";

function baseData(requisitionOverrides: Record<string, unknown> = {}) {
  return {
    requisition: {
      id: "req-1",
      consecutive: "RQ-001",
      type: "compra" as const,
      workId: "work-1",
      tagId: "tag-1",
      approverId: "user-1",
      channel: "interno",
      status: "en_revision",
      items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 1000 }],
      ...requisitionOverrides,
    },
    catalogs: {
      works: [{ id: "work-1", name: "Obra" }],
      tags: [{ id: "tag-1", name: "Materiales" }],
      suppliers: [],
      items: [],
      approvers: [{ id: "user-1", name: "Daniel" }],
      features: {},
    },
    orders: [], expenses: [], history: [], attachments: [],
  };
}

function respuestaOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function accionesEnviadas(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === "/api/requisitions/req-1/actions")
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("autoguardado de la revisión", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("se dispara al perder el foco (blur) sin esperar el debounce completo", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const paymentInput = screen.getByLabelText("Forma de pago");
    fireEvent.change(paymentInput, { target: { value: "Contado" } });
    fireEvent.blur(paymentInput);
    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0]).toMatchObject({ action: "review", paymentTerms: "Contado" });
    expect(await screen.findByText(/^Guardado /)).toBeInTheDocument();
  });

  it("se dispara a los 1.500 ms de inactividad aunque no haya blur", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Forma de pago"), { target: { value: "Crédito 30 días" } });
    // Justo antes de los 1.500 ms: todavía no debe haber disparado.
    await vi.advanceTimersByTimeAsync(1400);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0]).toMatchObject({ paymentTerms: "Crédito 30 días" });
  });

  it("no reenvía si el JSON es idéntico al último guardado con éxito", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const paymentInput = screen.getByLabelText("Forma de pago");
    fireEvent.change(paymentInput, { target: { value: "Contado" } });
    fireEvent.blur(paymentInput);
    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));

    // El usuario entra y sale del campo sin cambiar nada: mismo JSON, no debe reenviar.
    fireEvent.focus(paymentInput);
    fireEvent.blur(paymentInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accionesEnviadas(fetchMock)).toHaveLength(1);
  });

  it("no autoguarda sin etiqueta: lo dice el indicador y no llama al servidor", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData({ tagId: undefined })} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    expect(screen.getByText(/Elige la etiqueta para empezar a guardar\./)).toBeInTheDocument();
    const paymentInput = screen.getByLabelText("Forma de pago");
    fireEvent.change(paymentInput, { target: { value: "Contado" } });
    fireEvent.blur(paymentInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accionesEnviadas(fetchMock)).toHaveLength(0);

    // Elegir la etiqueta desbloquea el guardado, y ese mismo cambio dispara el autoguardado.
    fireEvent.change(screen.getByRole("combobox", { name: "Etiqueta" }), { target: { value: "tag-1" } });
    fireEvent.blur(screen.getByRole("combobox", { name: "Etiqueta" }));
    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
  });

  it("no autoguarda mientras una línea vigente tenga cantidad ≤ 0", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const cantidad = screen.getByLabelText("Cantidad de Arena");
    fireEvent.change(cantidad, { target: { value: "0" } });
    fireEvent.blur(cantidad);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(accionesEnviadas(fetchMock)).toHaveLength(0);
    expect(screen.getByText(/Corrige la cantidad, el precio o el descuento/)).toBeInTheDocument();
  });

  // Ensayo 2026-09-23: abrir el detalle disparaba solo un POST de acciones (y un aviso de error) sin
  // que nadie editara nada. Solo se guarda por acción del usuario.
  it("abrir el detalle y pasar el foco por los campos SIN cambiar nada no guarda", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    const paymentInput = screen.getByLabelText("Forma de pago");
    fireEvent.focus(paymentInput);
    fireEvent.blur(paymentInput);
    fireEvent.blur(screen.getByRole("combobox", { name: "Etiqueta" }));
    fireEvent.blur(screen.getByLabelText("Observaciones"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("una requisición recién llegada (enviada) no pasa a revisión solo por abrirla", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData({ status: "enviada" })} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    fireEvent.blur(screen.getByLabelText("Forma de pago"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accionesEnviadas(fetchMock)).toHaveLength(0);

    // Al editar, sí: start_review y luego review, como siempre.
    const paymentInput = screen.getByLabelText("Forma de pago");
    fireEvent.change(paymentInput, { target: { value: "Contado" } });
    fireEvent.blur(paymentInput);
    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(2));
    expect(accionesEnviadas(fetchMock).map((body) => body.action)).toEqual(["start_review", "review"]);
  });

  it("con React StrictMode (doble efecto en desarrollo) tampoco se programa un guardado al montar", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <StrictMode>
        <ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />
      </StrictMode>,
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("el aprobador que abre su requisición en aprobación no decide nada por pasar el foco", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(
      <ConnectedRequisitionDetail
        data={baseData({ status: "en_aprobacion", items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 1000, status: "pendiente" }] })}
        role="Aprobador"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    const cantidad = within(screen.getByTestId("approval-decisions")).getByLabelText("Cantidad aprobada");
    fireEvent.focus(cantidad);
    fireEvent.blur(cantidad);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(accionesEnviadas(fetchMock)).toHaveLength(0);
  });

  // Cabecera (fecha requerida/observaciones): campos inline, sin toggle "Editar cabecera", que se
  // autoguardan vía PATCH /api/requisitions/:id — distinto endpoint del de acciones.
  it("la cabecera (fecha requerida/observaciones) se autoguarda vía PATCH sin botón 'Guardar cambios'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(<ConnectedRequisitionDetail data={baseData()} role="Revisor" go={vi.fn()} refresh={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Editar cabecera" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar cambios" })).toBeNull();
    const observaciones = screen.getByLabelText("Observaciones");
    fireEvent.change(observaciones, { target: { value: "Entregar en bodega 2" } });
    fireEvent.blur(observaciones);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/requisitions/req-1")).toBe(true),
    );
    const patchCall = fetchMock.mock.calls.find(([url]) => String(url) === "/api/requisitions/req-1");
    expect(patchCall?.[1]).toMatchObject({ method: "PATCH" });
    expect(JSON.parse(String((patchCall?.[1] as RequestInit).body))).toMatchObject({ observations: "Entregar en bodega 2" });
  });
});
