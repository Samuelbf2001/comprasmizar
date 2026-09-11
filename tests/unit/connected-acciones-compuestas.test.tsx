// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitionDetail } from "../../components/screens/connected";
import type { RequisitionItem } from "../../components/screens/connected/shared";

// La pantalla separaba "guardar" de "actuar", y actuar usaba el estado VIEJO del servidor. Ernesto se
// topó con los dos síntomas el mismo día:
//
//   1. "Enviar a aprobación" con el formulario lleno respondía "valor cotizado mayor a cero es
//      obligatorio", porque el precio tecleado no se había guardado.
//   2. El aprobador declinó un ítem, escribió el motivo, pulsó el botón grande — y la requisición
//      quedó aprobada CON ese ítem vigente. Las decisiones nunca se persistieron y `approve()` trata
//      "pendiente" como vigente (`approvedLines`, lib/domain/rules.ts).
//
// El segundo es el que duele: **el silencio se interpretaba como aprobación**. Lo que estas pruebas
// fijan es que actuar guarda primero, EN ORDEN, y que si el guardado falla NO se actúa.

const REQ = "req-1";
const ACCIONES = `/api/requisitions/${REQ}/actions`;

function datos(overrides: { status?: string; items?: RequisitionItem[] } = {}) {
  return {
    requisition: {
      id: REQ,
      consecutive: "REQ-2026-0011",
      type: "compra" as const,
      workId: "work-1",
      tagId: "tag-1",
      approverId: "user-1",
      channel: "interno",
      status: overrides.status ?? "en_revision",
      items: overrides.items ?? [
        { id: "item-1", description: "Arena de peña", quantity: 2, unit: "m3", unitBase: 2520 },
      ],
    },
    catalogs: {
      works: [{ id: "work-1", name: "Bodega Ictinos Norte" }],
      tags: [{ id: "tag-1", name: "Materiales" }],
      suppliers: [],
      items: [],
      approvers: [{ id: "user-1", name: "Daniel Demo" }],
      features: {},
    },
    orders: [], expenses: [], history: [], attachments: [],
  };
}

/** Cuerpos JSON enviados a la ruta de acciones, en orden. */
function accionesEnviadas(fetchMock: { mock: { calls: unknown[][] } }) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input) === ACCIONES)
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

function respuestaOk() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function pintar(role: "Revisor" | "Aprobador", overrides: Parameters<typeof datos>[0] = {}, refresh = vi.fn()) {
  render(<ConnectedRequisitionDetail data={datos(overrides)} role={role} go={vi.fn()} refresh={refresh} />);
}

describe("enviar a aprobación guarda la revisión primero", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("manda `review` y DESPUÉS `send_for_approval`, con el precio que hay en pantalla", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    pintar("Revisor");

    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(2));
    const [primera, segunda] = accionesEnviadas(fetchMock);
    expect(primera.action).toBe("review");
    // El precio viaja en el guardado. Sin esta primera llamada, el servidor seguía viendo 0 y
    // respondía REVIEW_INCOMPLETE con el formulario lleno delante del revisor.
    expect(primera.items[0]).toMatchObject({ id: "item-1", unitBase: 2520 });
    expect(segunda).toEqual({ action: "send_for_approval" });
  });

  it("si el guardado falla, NO envía a aprobación", async () => {
    // Es la mitad que importa de "en orden": encadenar sin cortar dejaría una requisición enviada a
    // aprobación con datos que el servidor rechazó.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "REVIEW_INCOMPLETE", message: "Falta algo" }), { status: 422, headers: { "Content-Type": "application/json" } }),
    );
    pintar("Revisor");

    fireEvent.click(screen.getByRole("button", { name: "Enviar a aprobación" }));

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0].action).toBe("review");
    expect(accionesEnviadas(fetchMock).some((cuerpo) => cuerpo.action === "send_for_approval")).toBe(false);
  });
});

describe("completar la aprobación guarda las decisiones primero", () => {
  const conDeclinado = {
    status: "en_aprobacion",
    items: [
      { id: "item-1", description: "Alambre de amarre", quantity: 25, unit: "kg", unitBase: 9500, status: "declinado" as const, declineReason: "No se necesita" },
      { id: "item-2", description: "Guantes de seguridad", quantity: 30, unit: "par", unitBase: 8000 },
    ],
  };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("manda `decide_items` con lo declinado y DESPUÉS `approve`", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    pintar("Aprobador", conDeclinado);

    fireEvent.click(screen.getByRole("button", { name: /Completar aprobación/ }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(2));
    const [primera, segunda] = accionesEnviadas(fetchMock);
    expect(primera.action).toBe("decide_items");
    // LO QUE FALLÓ EN LA REQ-2026-0002: sin esta llamada, el ítem declinado seguía "pendiente" en la
    // base y `approvedLines` lo daba por vigente, así que la requisición se aprobaba con él dentro.
    expect(primera.decisions).toEqual([
      { itemId: "item-1", status: "declinado", declineReason: "No se necesita", quantity: 25 },
      { itemId: "item-2", status: "aprobado", quantity: 30 },
    ]);
    expect(segunda).toEqual({ action: "approve" });
  });

  it("el resumen de la confirmación dice cuántos se aprueban y cuántos se declinan", async () => {
    // Última oportunidad de ver que la decisión no es la que se creía: "2 aprobados, 0 declinados"
    // delata a quien pensó que había declinado uno.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    pintar("Aprobador", conDeclinado);

    fireEvent.click(screen.getByRole("button", { name: /Completar aprobación/ }));
    expect(await screen.findByText(/1 ítem aprobado, 1 declinado/)).toBeInTheDocument();
  });

  it("si guardar las decisiones falla, NO aprueba", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "INVALID_INPUT", message: "Motivo obligatorio" }), { status: 422, headers: { "Content-Type": "application/json" } }),
    );
    pintar("Aprobador", conDeclinado);

    fireEvent.click(screen.getByRole("button", { name: /Completar aprobación/ }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock)).toHaveLength(1));
    expect(accionesEnviadas(fetchMock)[0].action).toBe("decide_items");
    expect(accionesEnviadas(fetchMock).some((cuerpo) => cuerpo.action === "approve")).toBe(false);
  });
});

describe("la pantalla no dice 'listo' antes de tener los datos nuevos", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("el botón sigue deshabilitado hasta que `refresh` resuelve", async () => {
    // El tercer síntoma: `run()` llamaba a `refresh()` sin esperarla y soltaba `busy` en el
    // `finally`, así que el botón se rehabilitaba con el estado ANTERIOR todavía en pantalla.
    // Ernesto lo leyó como "no cambia de estado ni dice ok, ya aprobaste" — y volvió a pulsar.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    let resolverRefresh: () => void = () => {};
    const refresh = vi.fn(() => new Promise<void>((resolve) => { resolverRefresh = resolve; }));
    pintar("Revisor", {}, refresh);

    const boton = screen.getByRole("button", { name: "Enviar a aprobación" });
    fireEvent.click(boton);

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    // La recarga sigue en vuelo: el botón NO puede estar disponible todavía.
    expect(boton).toBeDisabled();
    expect(screen.queryByText("Requisición enviada a aprobación.")).not.toBeInTheDocument();

    resolverRefresh();
    // Y el aviso de éxito aparece DESPUÉS, cuando lo que se ve ya es el estado nuevo.
    expect(await screen.findByText("Requisición enviada a aprobación.")).toBeInTheDocument();
    await waitFor(() => expect(boton).not.toBeDisabled());
  });
});

// APROBADOR POR ÍTEM EN LA PANTALLA (Ernesto, 11-sep-2026). Lo que se vigila aquí es que la pantalla y
// el servicio digan lo mismo: el servicio rechaza decidir ítems ajenos, así que si "Completar
// aprobación" siguiera mandando todas las líneas, el botón dejaría de funcionar en cuanto alguien
// repartiera ítems — sin que nadie hubiera tocado esta pantalla.
describe("aprobador por ítem en la ficha", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const REPARTIDOS: RequisitionItem[] = [
    { id: "item-1", description: "Arena de peña", quantity: 2, unit: "m3", unitBase: 2520 }, // hereda a user-1
    { id: "item-2", description: "Cemento gris", quantity: 20, unit: "bulto", unitBase: 3000, approverId: "user-2" },
  ];

  function pintarConVisor(role: "Revisor" | "Aprobador", viewerId: string | undefined, items: RequisitionItem[], refresh = vi.fn()) {
    const base = datos({ status: "en_aprobacion", items });
    const data = {
      ...base,
      viewerId,
      catalogs: { ...base.catalogs, approvers: [{ id: "user-1", name: "Daniel Demo" }, { id: "user-2", name: "Juliana Demo" }] },
    };
    render(<ConnectedRequisitionDetail data={data} role={role} go={vi.fn()} refresh={refresh} />);
  }

  it("el aprobador solo ve SUS ítems, y se le dice cuántos decide otro", async () => {
    // Enseñarle los del otro sería invitarle a decidir lo que el servicio le va a rechazar, y de paso
    // enseñarle cifras que no le tocan. Pero callar cuántos faltan es peor: cuenta dos materiales en
    // el WhatsApp del solicitante, ve uno aquí y cree que se perdió algo.
    pintarConVisor("Aprobador", "user-1", REPARTIDOS);
    expect(await screen.findByText(/Arena de peña/)).toBeInTheDocument();
    expect(screen.queryByText(/Cemento gris/)).not.toBeInTheDocument();
    expect(screen.getByText(/Ves 1 de 2 ítems/)).toBeInTheDocument();
  });

  it("«Completar aprobación» manda SOLO las decisiones propias", async () => {
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    pintarConVisor("Aprobador", "user-2", REPARTIDOS);

    fireEvent.click(await screen.findByRole("button", { name: /Completar aprobación/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock).length).toBeGreaterThanOrEqual(1));
    const [decisiones] = accionesEnviadas(fetchMock);
    expect(decisiones.action).toBe("decide_items");
    expect(decisiones.decisions.map((d: { itemId: string }) => d.itemId)).toEqual(["item-2"]);
  });

  it("sin reparto y sin saber quién mira, se comporta como siempre: manda todas", async () => {
    // Respaldo para el hueco de un despliegue (página nueva con payload viejo). Con todas las líneas
    // heredando, todas son del aprobador de cabecera y mandarlas es exactamente lo de antes.
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    pintarConVisor("Aprobador", undefined, [
      { id: "item-1", description: "Arena de peña", quantity: 2, unit: "m3", unitBase: 2520 },
      { id: "item-3", description: "Varilla", quantity: 5, unit: "und", unitBase: 1000 },
    ]);

    fireEvent.click(await screen.findByRole("button", { name: /Completar aprobación/i }));
    fireEvent.click(await screen.findByTestId("confirm-dialog-confirm"));

    await waitFor(() => expect(accionesEnviadas(fetchMock).length).toBeGreaterThanOrEqual(1));
    expect(accionesEnviadas(fetchMock)[0].decisions.map((d: { itemId: string }) => d.itemId)).toEqual(["item-1", "item-3"]);
  });

  it("el revisor asigna aprobador por ítem y viaja en `review`", async () => {
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    const base = datos({ status: "en_revision" });
    render(
      <ConnectedRequisitionDetail
        data={{ ...base, viewerId: "user-9", catalogs: { ...base.catalogs, approvers: [{ id: "user-1", name: "Daniel Demo" }, { id: "user-2", name: "Juliana Demo" }] } }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/Aprobador de Arena de peña/i), { target: { value: "user-2" } });
    fireEvent.click(screen.getByRole("button", { name: /Guardar revisión/i }));

    await waitFor(() => expect(accionesEnviadas(fetchMock).length).toBeGreaterThanOrEqual(1));
    const [revision] = accionesEnviadas(fetchMock);
    expect(revision.action).toBe("review");
    expect(revision.items[0].approverId).toBe("user-2");
  });

  it("«Aprobador para todos» rellena los vacíos y NO pisa lo ya asignado sin permiso", async () => {
    // Al revés que las otras acciones masivas, y a propósito: un IVA de más se ve en el total y se
    // corrige; pisar un aprobador manda el ítem a otra persona y no se nota hasta que llega el
    // WhatsApp equivocado.
    const fetchMock = vi.fn(async () => respuestaOk());
    vi.stubGlobal("fetch", fetchMock);
    const confirmar = vi.fn(() => false); // el revisor dice "no" a pisar lo ya asignado
    vi.stubGlobal("confirm", confirmar);
    const base = datos({ status: "en_revision", items: REPARTIDOS });
    render(
      <ConnectedRequisitionDetail
        data={{ ...base, viewerId: "user-9", catalogs: { ...base.catalogs, approvers: [{ id: "user-1", name: "Daniel Demo" }, { id: "user-2", name: "Juliana Demo" }] } }}
        role="Revisor"
        go={vi.fn()}
        refresh={vi.fn()}
      />,
    );

    fireEvent.change(await screen.findByLabelText(/Aplicar un aprobador a todos los ítems vigentes/i), { target: { value: "user-1" } });
    expect(confirmar).toHaveBeenCalledTimes(1); // había uno asignado: se pregunta
    fireEvent.click(screen.getByRole("button", { name: /Guardar revisión/i }));

    await waitFor(() => expect(accionesEnviadas(fetchMock).length).toBeGreaterThanOrEqual(1));
    const [revision] = accionesEnviadas(fetchMock);
    expect(revision.items.find((i: { id: string }) => i.id === "item-1").approverId).toBe("user-1"); // estaba vacío: se rellena
    expect(revision.items.find((i: { id: string }) => i.id === "item-2").approverId).toBe("user-2"); // ya tenía: se respeta
  });
});
