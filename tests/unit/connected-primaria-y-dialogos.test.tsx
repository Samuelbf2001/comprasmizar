// @vitest-environment jsdom

// Rediseño "una acción por estado/rol" (dueño del producto, reunión 2026-09): fija dos cosas que
// no tenían prueba propia en los demás archivos —
//   1. el motivo de una acción irreversible (declinar/devolver) viaja DENTRO del diálogo de
//      confirmación (`ConfirmOptions.reason`) hasta el body de la petición, ya sin las
//      `<textarea>` siempre visibles de antes;
//   2. la primaria de la barra pegajosa es la correcta para cada combinación de estado y rol de
//      la tabla del diseño aprobado.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";

function respuestaOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}
function accionesEnviadas(fetchMock: { mock: { calls: unknown[][] } }, id = "req-1") {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === `/api/requisitions/${id}/actions`)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("el motivo del diálogo viaja en la petición", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Declinar toda la requisición: sin motivo el diálogo no deja confirmar, y el motivo escrito viaja en `reason`", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(
      <ConnectedRequisitionDetail
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: {
            id: "req-1", consecutive: "RQ-001", type: "compra", workId: "work-1", tagId: "tag-1",
            approverId: "user-1", channel: "interno", status: "en_revision",
            items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 1000 }],
          },
          catalogs: { works: [{ id: "work-1", name: "Obra" }], tags: [{ id: "tag-1", name: "Materiales" }], suppliers: [], items: [], approvers: [{ id: "user-1", name: "Daniel" }], features: {} },
          orders: [], expenses: [], history: [], attachments: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Declinar toda la requisición" }));
    const confirmar = screen.getByTestId("confirm-dialog-confirm");
    // Sin motivo (campo requerido dentro del propio diálogo): no deja confirmar.
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo para declinar"), { target: { value: "Ya no se necesita el material" } });
    expect(confirmar).toBeEnabled();
    fireEvent.click(confirmar);

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0]).toEqual({ action: "decline", reason: "Ya no se necesita el material" });
  });

  it("Devolver a revisión: el comentario escrito en el diálogo viaja como `comment`", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    render(
      <ConnectedRequisitionDetail
        role="Aprobador"
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: {
            id: "req-1", consecutive: "RQ-001", type: "compra", workId: "work-1", tagId: "tag-1",
            approverId: "user-1", channel: "interno", status: "en_aprobacion",
            items: [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 1000 }],
          },
          catalogs: { works: [{ id: "work-1", name: "Obra" }], tags: [{ id: "tag-1", name: "Materiales" }], suppliers: [], items: [], approvers: [{ id: "user-1", name: "Daniel" }], features: {} },
          orders: [], expenses: [], history: [], attachments: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Devolver a revisión" }));
    fireEvent.change(screen.getByLabelText("Comentario de devolución"), { target: { value: "Falta el soporte de la cotización" } });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0]).toEqual({ action: "return", comment: "Falta el soporte de la cotización" });
  });
});

describe("la primaria de la barra pegajosa es la correcta por estado y rol", () => {
  afterEach(() => cleanup());

  const catalogs = { works: [{ id: "work-1", name: "Obra" }], tags: [{ id: "tag-1", name: "Materiales" }], suppliers: [{ id: "supplier-1", name: "Proveedor Uno" }], items: [], approvers: [{ id: "user-1", name: "Daniel" }], features: {} };
  const itemsBase = [{ id: "item-1", description: "Arena", quantity: 1, unit: "saco", unitBase: 1000, status: "aprobado" as const, finalSupplierId: "supplier-1" }];

  function pintar(status: string, role: "Revisor" | "Aprobador", extra: Record<string, unknown> = {}) {
    render(
      <ConnectedRequisitionDetail
        role={role}
        go={vi.fn()}
        refresh={vi.fn()}
        data={{
          requisition: { id: "req-1", consecutive: "RQ-001", type: "compra", workId: "work-1", tagId: "tag-1", approverId: "user-1", channel: "interno", status, items: itemsBase, ...extra },
          catalogs,
          orders: [], expenses: [], history: [], attachments: [],
        }}
      />,
    );
  }

  it("enviada · revisor: 'Enviar a aprobación', sin botón 'Iniciar revisión'", () => {
    pintar("enviada", "Revisor");
    expect(screen.getByRole("button", { name: "Enviar a aprobación" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Iniciar revisión" })).toBeNull();
    expect(screen.getByText("Al editar, la requisición pasa a revisión.")).toBeInTheDocument();
  });

  it("en_revision · revisor: 'Enviar a aprobación', sin 'Guardar revisión'", () => {
    pintar("en_revision", "Revisor");
    expect(screen.getByRole("button", { name: "Enviar a aprobación" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar revisión" })).toBeNull();
  });

  it("en_aprobacion · aprobador (sin reparto): 'Aprobar requisición', sin 'Guardar decisiones'", () => {
    pintar("en_aprobacion", "Aprobador");
    expect(screen.getByRole("button", { name: "Aprobar requisición" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Guardar decisiones" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Completar aprobación" })).toBeNull();
  });

  it("en_aprobacion · revisor: sin primaria, solo «Más» con Reasignar aprobador (el bloque lateral fijo desaparece)", () => {
    pintar("en_aprobacion", "Revisor");
    expect(screen.queryByRole("button", { name: /Aprobar/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Devolver/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Más" }));
    expect(screen.getByRole("menuitem", { name: "Reasignar aprobador" })).toBeInTheDocument();
  });

  it("aprobada sin órdenes · revisor: 'Generar órdenes (K)', sin botón 'Asignar proveedor(es)' aparte", () => {
    pintar("aprobada", "Revisor");
    expect(screen.getByRole("button", { name: "Generar órdenes (1)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Asignar proveedor/ })).toBeNull();
  });
});
