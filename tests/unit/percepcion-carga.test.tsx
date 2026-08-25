// @vitest-environment jsdom

// RF-1105 (percepción de carga): "la lentitud no se siente" — la primera carga de una
// ruta muestra el esqueleto de ESA ruta (no un spinner genérico), un refresco con datos
// previos no desmonta el contenido (stale-while-revalidate), el esqueleto nunca contiene
// cifras ni texto de demostración, y volver a una ruta ya visitada pinta contenido de
// inmediato gracias al cache en memoria por ruta.

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedScreen, clearRouteCache } from "../../components/screens/connected";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// El cache de rutas es un singleton de módulo (a propósito: debe sobrevivir a la
// navegación real de la SPA). Entre pruebas hay que vaciarlo para que una no herede
// datos cacheados por la anterior.
beforeEach(() => {
  clearRouteCache();
});

const catalogsPayload = {
  works: [{ id: "work-1", name: "Obra Norte" }],
  tags: [{ id: "tag-1", name: "Urgente" }],
  suppliers: [],
  items: [],
  features: {},
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Nunca resuelve: sirve para inspeccionar el estado de "primera carga" sin que la
// promesa de datos interfiera con la aserción.
function pendingForever(): Promise<Response> {
  return new Promise(() => {});
}

function routedFetch(
  handlers: Record<string, () => Response | Promise<Response>>,
) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0];
    const handler = handlers[path];
    if (!handler) {
      throw new Error(`Fetch no simulado para "${path}" en esta prueba.`);
    }
    return handler();
  });
}

describe("RF-1105: esqueleto por tipo de ruta en la primera carga", () => {
  it("el dashboard muestra su propio esqueleto, no el spinner genérico anterior", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(pendingForever);
    render(<ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />);
    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("Cargando operación")).toBeNull();
    expect(screen.queryByText("Conectando con el servicio")).toBeNull();
  });

  it("una bandeja muestra su propia cabecera de tabla con filas fantasma, no el mismo esqueleto del dashboard", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(pendingForever);
    render(<ConnectedScreen pathname="/revision" role="Revisor" go={vi.fn()} />);
    const skeleton = screen.getByTestId("requisitions-skeleton");
    expect(skeleton).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-skeleton")).toBeNull();
    // La cabecera real de la bandeja ya es visible aunque los datos no hayan llegado.
    expect(within(skeleton).getByText("Requisición")).toBeInTheDocument();
    expect(within(skeleton).getByText("Estado")).toBeInTheDocument();
    expect(
      skeleton.querySelectorAll(".skeleton.skeleton-row").length,
    ).toBeGreaterThan(0);
  });

  it("el esqueleto no contiene cifras ni texto de demostración, solo formas vacías", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(pendingForever);
    render(<ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />);
    const skeleton = screen.getByTestId("dashboard-skeleton");
    expect(skeleton).toHaveAttribute("aria-busy", "true");
    // Ninguna cifra (ni sintética ni real) puede aparecer antes de que responda la API.
    expect(skeleton.textContent ?? "").not.toMatch(/\d/);
    // Pero sí debe anunciarse a lectores de pantalla con texto real, no puro adorno.
    const status = within(skeleton).getByRole("status");
    expect(status.textContent?.trim().length).toBeGreaterThan(0);
    expect(status.textContent).toMatch(/cargando/i);
  });
});

describe("RF-1105: stale-while-revalidate", () => {
  it("un refresco con datos previos no desmonta el contenido; sigue visible y marcado como revalidando", async () => {
    let requisitionCalls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/requisitions/req-1": () => {
          requisitionCalls += 1;
          return jsonResponse({
            id: "req-1",
            consecutive: "RQ-001",
            type: "compra",
            workId: "work-1",
            channel: "interno",
            requiredDate: "2026-08-24",
            status: requisitionCalls === 1 ? "en_revision" : "en_aprobacion",
            items: [],
          });
        },
        "/api/catalogs": () => jsonResponse(catalogsPayload),
        "/api/requisitions/req-1/history": () => jsonResponse([]),
        "/api/attachments/requisicion/req-1": () =>
          jsonResponse({ attachments: [] }),
      }),
    );

    render(
      <ConnectedScreen
        pathname="/requisiciones/req-1"
        role="Solicitante"
        go={vi.fn()}
      />,
    );

    await screen.findByText("RQ-001");
    expect(screen.getByTestId("requisition-status").textContent).toBe(
      "en revision",
    );

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));

    // El contenido anterior sigue montado de inmediato (no vuelve el esqueleto)...
    const container = screen
      .getByRole("button", { name: "Actualizar" })
      .closest("[aria-busy]");
    expect(screen.queryByTestId("detail-skeleton")).toBeNull();
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.getByTestId("requisition-status").textContent).toBe(
      "en revision",
    );
    // ...pero queda marcado como revalidando mientras llega la respuesta fresca.
    expect(container).toHaveClass("is-revalidating");
    expect(container).toHaveAttribute("aria-busy", "true");

    await waitFor(() =>
      expect(screen.getByTestId("requisition-status").textContent).toBe(
        "en aprobacion",
      ),
    );
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(container).not.toHaveClass("is-revalidating");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
});

describe("RF-1105: cache en memoria por ruta", () => {
  it("volver a una ruta ya visitada pinta su contenido de inmediato, sin pasar otra vez por el esqueleto", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/dashboard": () => jsonResponse({ byStatus: { en_revision: 3 } }),
        "/api/catalogs": () => jsonResponse(catalogsPayload),
        "/api/requisitions": () => jsonResponse([]),
      }),
    );

    const { rerender } = render(
      <ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />,
    );
    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
    await screen.findByText("3");

    rerender(<ConnectedScreen pathname="/revision" role="Revisor" go={vi.fn()} />);
    // Ruta nunca visitada: sí debe pasar por su propio esqueleto.
    expect(screen.getByTestId("requisitions-skeleton")).toBeInTheDocument();
    await screen.findByText("0 visibles");

    rerender(<ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />);
    // De vuelta al dashboard, ya cacheado: el contenido real aparece de inmediato, sin
    // pasar de nuevo por el esqueleto (aunque siga revalidando en segundo plano).
    expect(screen.queryByTestId("dashboard-skeleton")).toBeNull();
    expect(screen.getByText("3")).toBeInTheDocument();

    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6),
    );
  });
});
