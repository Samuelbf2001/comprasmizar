// @vitest-environment jsdom

// RF-306 (PRD, decisión del cliente 25-sep-2026): tablero tipo pipeline en /revision — selector
// "Lista | Tablero" que alterna la lista de siempre con un tablero por columnas (Enviada → En
// revisión [con "devuelta" marcada] → En aprobación → Aprobada), mismos datos/filtros que la
// lista, sin arrastrar y soltar, con la vista elegida recordada por persona en localStorage.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedRequisitions } from "../../components/screens/connected";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const catalogs = {
  works: [
    { id: "work-1", name: "Obra Norte" },
    { id: "work-2", name: "Obra Sur" },
  ],
  tags: [],
  suppliers: [],
  items: [],
  features: {},
  users: [
    { id: "user-1", name: "Ana Solicitante" },
    { id: "approver-1", name: "Nelson Rincón" },
  ],
};

// Filas de la página de pendientes (lo que ya trae `data.rows`, igual que la lista): enviada,
// en_revision y devuelta — las mismas que /revision ya descarga hoy.
const rows = [
  {
    id: "req-1",
    consecutive: "RQ-001",
    type: "compra" as const,
    channel: "web",
    workId: "work-1",
    requesterId: "user-1",
    status: "enviada",
    items: [{ id: "i-1", quantity: 1, unit: "und", unitBase: 10_000 }],
  },
  {
    id: "req-2",
    consecutive: "RQ-002",
    type: "compra" as const,
    channel: "whatsapp",
    workId: "work-2",
    requesterId: "user-1",
    status: "en_revision",
    items: [{ id: "i-2", quantity: 1, unit: "und", unitBase: 20_000 }],
  },
  {
    id: "req-3",
    consecutive: "RQ-003",
    type: "compra" as const,
    channel: "publico",
    workId: "work-1",
    requesterId: "user-1",
    status: "devuelta",
    items: [{ id: "i-3", quantity: 1, unit: "und", unitBase: 30_000 }],
  },
];

// Las columnas "En aprobación"/"Aprobada" se piden aparte (loadRequisitionsByStatus, su propio
// cursor) — se simula con un fetch que responde según el status pedido.
function mockBoardFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(String(input), "http://localhost");
    const status = url.searchParams.get("status");
    if (status === "en_aprobacion") {
      return new Response(
        JSON.stringify({
          rows: [
            {
              id: "req-4",
              consecutive: "RQ-004",
              type: "compra",
              channel: "web",
              workId: "work-1",
              requesterId: "user-1",
              approverId: "approver-1",
              status: "en_aprobacion",
              items: [{ id: "i-4", quantity: 1, unit: "und", unitBase: 40_000 }],
            },
          ],
          nextCursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (status === "aprobada") {
      return new Response(
        JSON.stringify({
          rows: [
            {
              id: "req-5",
              consecutive: "RQ-005",
              type: "compra",
              channel: "web",
              workId: "work-2",
              requesterId: "user-1",
              status: "aprobada",
              items: [{ id: "i-5", quantity: 1, unit: "und", unitBase: 50_000 }],
            },
          ],
          nextCursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    throw new Error(`fetch inesperado en la prueba: ${url.toString()}`);
  });
}

describe("RF-306: selector Lista/Tablero en la bandeja de revisión", () => {
  it("por defecto muestra la lista; el tablero solo aparece al elegirlo", () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Lista/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Tablero/ })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.queryByText("En aprobación")).toBeNull();
  });

  it("coloca cada tarjeta en su columna, marca 'Devuelta' dentro de 'En revisión' y muestra el aprobador solo en 'En aprobación'", async () => {
    const fetchMock = mockBoardFetch();
    try {
      render(
        <ConnectedRequisitions
          data={{ rows, catalogs, viewerId: "viewer-1" }}
          pathname="/revision"
          go={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
      expect(screen.getByRole("button", { name: /Tablero/ })).toHaveAttribute("aria-pressed", "true");

      // Columna "Enviada".
      const enviada = screen.getByRole("region", { name: "Enviada" });
      expect(within(enviada).getByText("RQ-001")).toBeInTheDocument();

      // Columna "En revisión": en_revision + devuelta, solo la devuelta lleva la marca.
      const enRevision = screen.getByRole("region", { name: "En revisión" });
      expect(within(enRevision).getByText("RQ-002")).toBeInTheDocument();
      expect(within(enRevision).getByText("RQ-003")).toBeInTheDocument();
      expect(within(enRevision).getByText("Devuelta")).toBeInTheDocument();
      expect(within(enRevision).queryAllByText("Devuelta")).toHaveLength(1);

      // Columna "En aprobación" (fetch aparte) — trae el aprobador.
      const enAprobacion = await screen.findByRole("region", { name: "En aprobación" });
      expect(within(enAprobacion).getByText("RQ-004")).toBeInTheDocument();
      expect(within(enAprobacion).getByText(/Aprobador: Nelson Rincón/)).toBeInTheDocument();

      // Columna "Aprobada" (fetch aparte, propio cursor).
      const aprobada = await screen.findByRole("region", { name: "Aprobada" });
      expect(within(aprobada).getByText("RQ-005")).toBeInTheDocument();

      // Ninguna columna muestra el aprobador salvo "En aprobación".
      expect(within(enviada).queryByText(/Aprobador:/)).toBeNull();
      expect(within(aprobada).queryByText(/Aprobador:/)).toBeNull();

      const url = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
      expect(url.pathname).toBe("/api/requisitions");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("aplica los mismos filtros (obra) que la lista", async () => {
    const fetchMock = mockBoardFetch();
    try {
      render(
        <ConnectedRequisitions
          data={{ rows, catalogs, viewerId: "viewer-1" }}
          pathname="/revision"
          go={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
      await screen.findByRole("region", { name: "En aprobación" });

      fireEvent.change(screen.getByLabelText("Obra"), { target: { value: "work-1" } });

      const enRevision = screen.getByRole("region", { name: "En revisión" });
      // RQ-002 es de "Obra Sur" (work-2): sale del filtro; RQ-003 (devuelta, Obra Norte) se queda.
      expect(within(enRevision).queryByText("RQ-002")).toBeNull();
      expect(within(enRevision).getByText("RQ-003")).toBeInTheDocument();

      const aprobada = screen.getByRole("region", { name: "Aprobada" });
      // RQ-005 es de "Obra Sur": también sale.
      expect(within(aprobada).queryByText("RQ-005")).toBeNull();
      void fetchMock;
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("el filtro de Estado desaparece en el tablero (sus columnas ya son el estado)", () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Estado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
    expect(screen.queryByLabelText("Estado")).toBeNull();
  });

  it("clic en una tarjeta abre el mismo detalle que la fila de la lista", () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    const go = vi.fn();
    cleanup();
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={go}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
    fireEvent.click(screen.getByText("RQ-001"));
    expect(go).toHaveBeenCalledWith("/requisiciones/req-1");
  });

  it("recuerda la vista elegida por persona (localStorage) en la próxima visita", async () => {
    const { unmount } = render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
    expect(screen.getByRole("button", { name: /Tablero/ })).toHaveAttribute("aria-pressed", "true");
    unmount();

    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    // El primer render (SSR-safe) arranca en "list"; el efecto adopta lo guardado tras montar.
    expect(await screen.findByRole("button", { name: /Tablero/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("otra persona en el mismo navegador no hereda la vista elegida", async () => {
    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-1" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Tablero/ }));
    cleanup();

    render(
      <ConnectedRequisitions
        data={{ rows, catalogs, viewerId: "viewer-2" }}
        pathname="/revision"
        go={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Lista/ })).toHaveAttribute("aria-pressed", "true");
  });
});
