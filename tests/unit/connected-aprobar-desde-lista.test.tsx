// @vitest-environment jsdom

// «Aprobar desde la lista» (reunión 11-sep-2026, patrón Precoro pedido por Ernesto tras la
// reunión de presentación del 11-sep): antes había que abrir CADA requisición en "Mis
// aprobaciones" solo para aprobarla o declinarla. Estas pruebas fijan:
//   1. Las acciones solo aparecen en filas `en_aprobacion` donde el actor tiene ítems propios
//      pendientes (cabecera o por ítem) — nunca en otro estado ni cuando decide otra persona.
//   2. El body EXACTO que manda cada botón: "Aprobar" -> decide_items (aprobado) + approve;
//      "Declinar" -> SOLO decide_items (declinado) con el motivo, sin approve.
//   3. APPROVAL_PENDING_OTHERS tras "Aprobar" es éxito parcial, igual que en detail.tsx.
//   4. "Aprobar seleccionadas" ejecuta en SECUENCIA (una fila completa antes de la siguiente) y
//      resume aprobadas/pendientes/fallidas.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitions } from "../../components/screens/connected";

const VIEWER = "user-1";

function accionesUrl(id: string) {
  return `/api/requisitions/${id}/actions`;
}

function respuestaOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Cuerpos JSON enviados a la ruta de acciones de UNA requisición, en orden. */
function accionesEnviadas(fetchMock: { mock: { calls: unknown[][] } }, id: string) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === accionesUrl(id))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

const catalogs = {
  works: [{ id: "work-1", name: "Obra Norte" }],
  tags: [],
  suppliers: [],
  items: [],
  features: {},
};

function fila(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    consecutive: "RQ-201",
    type: "compra" as const,
    workId: "work-1",
    channel: "web",
    approverId: VIEWER,
    status: "en_aprobacion",
    items: [{ id: "item-1", description: "Cemento gris", quantity: 10, unit: "bulto", unitBase: 30_000 }],
    ...overrides,
  };
}

afterEach(() => cleanup());

describe("Aprobar desde la lista: las acciones solo aparecen donde deben", () => {
  it("solo en filas en_aprobacion donde el actor decide algún ítem (cabecera o por ítem)", () => {
    const rows = [
      fila(), // RQ-201: aprobador de cabecera, en_aprobacion -> SÍ
      fila({
        id: "req-2",
        consecutive: "RQ-202",
        approverId: "user-9",
        items: [{ id: "item-2", description: "Arena", quantity: 5, unit: "m3", unitBase: 20_000 }],
      }), // decide otro aprobador -> NO
      fila({ id: "req-3", consecutive: "RQ-203", status: "aprobada" }), // ya no está en_aprobacion -> NO
      fila({
        id: "req-4",
        consecutive: "RQ-204",
        approverId: "user-9",
        items: [{ id: "item-4", description: "Varilla", quantity: 3, unit: "und", unitBase: 5_000, approverId: VIEWER }],
      }), // cabecera de otro, pero ESTE ítem es del actor -> SÍ
    ];
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Aprobar" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Declinar" })).toHaveLength(2);
    expect(screen.getByLabelText("Seleccionar RQ-201")).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar RQ-204")).toBeInTheDocument();
    expect(screen.queryByLabelText("Seleccionar RQ-202")).toBeNull();
    expect(screen.queryByLabelText("Seleccionar RQ-203")).toBeNull();
  });

  it("sin viewerId (payload viejo) no muestra ninguna acción — nunca se adivina quién decide", () => {
    render(
      <ConnectedRequisitions
        data={{ rows: [fila()], catalogs }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
    expect(screen.queryByTestId("bulk-approve-bar")).toBeNull();
  });

  it("fuera de /aprobaciones (p. ej. /revision) nunca aparecen estas columnas", () => {
    render(
      <ConnectedRequisitions
        data={{ rows: [fila({ status: "en_revision" })], catalogs, viewerId: VIEWER }}
        pathname="/revision"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Aprobar" })).toBeNull();
  });
});

describe("Aprobar desde la lista: body exacto por fila", () => {
  it("«Aprobar» manda decide_items (aprobado, con la cantidad vigente) y DESPUÉS approve", async () => {
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    const refresh = vi.fn();
    render(
      <ConnectedRequisitions
        data={{ rows: [fila()], catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={refresh}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock, "req-1")).toHaveLength(2));
    const [primera, segunda] = accionesEnviadas(fetchMock, "req-1");
    expect(primera).toEqual({
      action: "decide_items",
      decisions: [{ itemId: "item-1", status: "aprobado", quantity: 10 }],
    });
    expect(segunda).toEqual({ action: "approve" });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(await screen.findByText(/RQ-201: quedó aprobada\./)).toBeInTheDocument();
  });

  it("«Declinar» exige motivo, manda SOLO decide_items (declinado) y nunca approve", async () => {
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConnectedRequisitions
        data={{ rows: [fila()], catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Declinar" }));
    const confirmar = await screen.findByTestId("confirm-dialog-confirm");
    // Sin motivo el diálogo no deja confirmar — el motivo es obligatorio.
    expect(confirmar).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Motivo para declinar"), {
      target: { value: "No se necesita este material" },
    });
    expect(confirmar).not.toBeDisabled();
    fireEvent.click(confirmar);

    await waitFor(() => expect(accionesEnviadas(fetchMock, "req-1")).toHaveLength(1));
    expect(accionesEnviadas(fetchMock, "req-1")[0]).toEqual({
      action: "decide_items",
      decisions: [{ itemId: "item-1", status: "declinado", quantity: 10, declineReason: "No se necesita este material" }],
    });
    // Nunca se manda approve: declinar desde la lista solo registra la decisión (ver el
    // comentario de handleDeclineRow en requisitions.tsx sobre quién cierra la requisición).
    expect(accionesEnviadas(fetchMock, "req-1").some((body) => body.action === "approve")).toBe(false);
    expect(await screen.findByText(/RQ-201: tus 1 ítem quedó declinado\./)).toBeInTheDocument();
  });

  it("APPROVAL_PENDING_OTHERS al aprobar se muestra como éxito parcial, no como error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (body?.action === "approve") {
        return new Response(
          JSON.stringify({ error: "approval_pending_others", message: "Faltan 1 aprobador(es) por decidir sus ítems" }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      return respuestaOk();
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConnectedRequisitions
        data={{ rows: [fila()], catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    expect(await screen.findByText(/quedaron decididos; falta 1 aprobador\./)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("si falla decide_items, NO manda approve", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "INVALID_STATE", message: "La requisición no está en aprobación" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ConnectedRequisitions
        data={{ rows: [fila()], catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Aprobar" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock, "req-1")).toHaveLength(1));
    expect(accionesEnviadas(fetchMock, "req-1")[0].action).toBe("decide_items");
    expect(await screen.findByRole("alert")).toHaveTextContent("La requisición no está en aprobación");
  });
});

describe("Aprobar desde la lista: selección múltiple", () => {
  it("«Aprobar seleccionadas» ejecuta en SECUENCIA y resume aprobadas/pendientes/fallidas", async () => {
    const orden: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      orden.push(`${url}::${body?.action}`);
      if (url === accionesUrl("req-2") && body?.action === "approve") {
        return new Response(
          JSON.stringify({ error: "approval_pending_others", message: "Faltan 1 aprobador(es) por decidir sus ítems" }),
          { status: 422, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === accionesUrl("req-3")) {
        return new Response(JSON.stringify({ error: "INVALID_STATE", message: "La requisición no está en aprobación" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return respuestaOk();
    });
    vi.stubGlobal("fetch", fetchMock);

    const rows = [
      fila({ id: "req-1", consecutive: "RQ-201" }),
      fila({ id: "req-2", consecutive: "RQ-202", items: [{ id: "item-2", description: "Arena", quantity: 4, unit: "m3", unitBase: 10_000 }] }),
      fila({ id: "req-3", consecutive: "RQ-203", items: [{ id: "item-3", description: "Grava", quantity: 3, unit: "m3", unitBase: 9_000 }] }),
    ];
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText("Seleccionar RQ-201"));
    fireEvent.click(screen.getByLabelText("Seleccionar RQ-202"));
    fireEvent.click(screen.getByLabelText("Seleccionar RQ-203"));

    fireEvent.click(screen.getByRole("button", { name: "Aprobar seleccionadas (3)" }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    const resumen = await screen.findByTestId("bulk-approve-summary");
    expect(resumen).toHaveTextContent("1 aprobada");
    expect(resumen).toHaveTextContent("1 pendiente");
    expect(resumen).toHaveTextContent("1 fallida");
    expect(resumen).toHaveTextContent("RQ-203: no se pudo aprobar — La requisición no está en aprobación");

    // EN SECUENCIA: las dos llamadas de req-1 (decide_items + approve) terminan antes de que
    // empiece la primera de req-2 — nunca en paralelo.
    const indiceUltimaReq1 = orden.lastIndexOf(`${accionesUrl("req-1")}::approve`);
    const indicePrimeraReq2 = orden.indexOf(`${accionesUrl("req-2")}::decide_items`);
    expect(indiceUltimaReq1).toBeGreaterThanOrEqual(0);
    expect(indicePrimeraReq2).toBeGreaterThan(indiceUltimaReq1);

    // La selección se limpia tras el lote.
    expect(screen.queryByLabelText("Seleccionar RQ-201")).not.toBeChecked();
  });

  it("la casilla solo aparece en filas donde el actor tiene algo propio pendiente", () => {
    const rows = [
      fila(),
      fila({ id: "req-2", consecutive: "RQ-202", approverId: "user-9", items: [{ id: "item-2", description: "Arena", quantity: 1, unit: "m3", unitBase: 1000 }] }),
    ];
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: VIEWER }}
        pathname="/aprobaciones"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Aprobar seleccionadas (0)" })).toBeInTheDocument();
    expect(screen.getByLabelText("Seleccionar RQ-201")).toBeInTheDocument();
    expect(screen.queryByLabelText("Seleccionar RQ-202")).toBeNull();
  });
});
