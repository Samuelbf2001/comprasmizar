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
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedScreen, clearRouteCache } from "../../components/screens/connected";
import { initialLoadState, invalidateCatalogs } from "../../components/screens/connected/data";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * PRECARGA DE dashboard-charts.tsx (recharts). Sin esto, "RF-1105: cache en memoria por
 * ruta" fallaba de forma intermitente SOLO con la suite completa en paralelo (aislado
 * pasaba siempre en <1 s) — el mismo patrón ya diagnosticado y arreglado en
 * connected-dashboard.test.tsx (ver su git log): un `import()` dinámico pesado colándose
 * DENTRO de la ventana del aserto.
 *
 * El dashboard entra por `next/dynamic` (screen.tsx) y, ya montado, dashboard.tsx importa
 * a su vez `dashboard-charts` — el único módulo del árbol que trae recharts (~150 KB con
 * sus dependencias). Medido aquí mismo con `console.time` bajo `npx vitest run
 * --reporter=verbose`: `dashboard`, `requisitions` y `orders` transforman en <1 ms (ya
 * están en caché del worker por los describes anteriores de este archivo), pero
 * `dashboard-charts` tardó 1148 ms en frío. La prueba de la ruta cacheada visita "/" dos
 * veces: la primera dispara ese import (recharts empieza a descargarse en cuanto el
 * dashboard pinta sus KPIs); la segunda hace asertos SÍNCRONOS (sin `waitFor`) porque su
 * propósito es demostrar que la ruta ya visitada no vuelve a pasar por el esqueleto — pero
 * si la suite completa compite por CPU y esa carga tarda de más, puede seguir sin
 * resolver cuando toca esa segunda visita y el test entero se va por encima de su tope.
 *
 * Precargar aquí, una vez por archivo, saca ese coste de cualquier ventana de aserto:
 * cuando corren los tests, `next/dynamic` ya resuelve contra el módulo cacheado y lo que
 * se mide vuelve a ser el render, no el transform de recharts. El camino dinámico real
 * (dashboard.tsx -> dashboard-charts.tsx) se sigue ejercitando igual; no se mockea nada.
 * Subir los timeouts habría escondido el síntoma sin tocar la causa, y de paso habría
 * hecho que un fallo real tardara mucho más en dar la cara.
 */
beforeAll(async () => {
  await import("../../components/screens/connected/dashboard-charts");
}, 30_000);

// El cache de rutas es un singleton de módulo (a propósito: debe sobrevivir a la
// navegación real de la SPA). Entre pruebas hay que vaciarlo para que una no herede
// datos cacheados por la anterior. Fase 3 (H6): los catálogos viven en un slot propio que
// clearRouteCache() NO toca, así que también hay que invalidarlos aquí.
beforeEach(() => {
  clearRouteCache();
  invalidateCatalogs();
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
        // Fase 3 (H2): el detalle llega en un solo GET compuesto (`/detail`) en vez de
        // requisición + historial + adjuntos por separado.
        "/api/requisitions/req-1/detail": () => {
          requisitionCalls += 1;
          return jsonResponse({
            requisition: {
              id: "req-1",
              consecutive: "RQ-001",
              type: "compra",
              workId: "work-1",
              channel: "interno",
              requiredDate: "2026-08-24",
              status: requisitionCalls === 1 ? "en_revision" : "en_aprobacion",
              items: [],
            },
            orders: [],
            expenses: [],
            history: [],
            attachments: [],
          });
        },
        "/api/catalogs": () => jsonResponse(catalogsPayload),
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
      "En revisión",
    );

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));

    // El contenido anterior sigue montado de inmediato (no vuelve el esqueleto)...
    const container = screen
      .getByRole("button", { name: "Actualizar" })
      .closest("[aria-busy]");
    expect(screen.queryByTestId("detail-skeleton")).toBeNull();
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(screen.getByTestId("requisition-status").textContent).toBe(
      "En revisión",
    );
    // ...pero queda marcado como revalidando mientras llega la respuesta fresca.
    expect(container).toHaveClass("is-revalidating");
    expect(container).toHaveAttribute("aria-busy", "true");

    await waitFor(() =>
      expect(screen.getByTestId("requisition-status").textContent).toBe(
        "En aprobación",
      ),
    );
    expect(screen.getByText("RQ-001")).toBeInTheDocument();
    expect(container).not.toHaveClass("is-revalidating");
    // El refresco vuelve a pedir el detalle (dato fresco), pero NO los catálogos: Fase 3 (H6)
    // los sirve de su caché por sesión. Antes esta línea contaba 8 llamadas sueltas.
    expect(requisitionCalls).toBe(2);
    expect(fetchMock.mock.calls.length).toBe(3);
  });
});

describe("RF-1105: cache en memoria por ruta", () => {
  it("volver a una ruta ya visitada pinta su contenido de inmediato, sin pasar otra vez por el esqueleto", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/dashboard": () => jsonResponse({ byStatus: { en_revision: 3 } }),
        "/api/catalogs": () => jsonResponse(catalogsPayload),
        // Fase 3 (H3): la bandeja se pide paginada (`?status=...&limit=100`) y responde
        // `{ rows, nextCursor }`, ya no un array plano.
        "/api/requisitions": () => jsonResponse({ rows: [], nextCursor: null }),
        // BLOQUEANTE 2: /revision ahora también pide /api/orders (mismo permiso que /ordenes)
        // para saber qué "aprobada" ya generó su orden y separar el grupo "Listas para
        // generar orden" — sin este handler, routedFetch tumbaría la carga con un error.
        "/api/orders": () => jsonResponse([]),
      }),
    );

    const { rerender } = render(
      <ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />,
    );
    expect(screen.getByTestId("dashboard-skeleton")).toBeInTheDocument();
    // Fase 2 (H4): cada pantalla llega por next/dynamic, así que la primera visita a una ruta
    // espera además la resolución de su chunk. En aislamiento tarda ~400 ms, pero con toda la
    // suite en paralelo superaba el segundo por defecto de findBy y el test fallaba de forma
    // intermitente. El margen alto no cambia lo que se afirma: solo evita el falso rojo.
    await screen.findByText("3", {}, { timeout: 8_000 });

    rerender(<ConnectedScreen pathname="/revision" role="Revisor" go={vi.fn()} />);
    // Ruta nunca visitada: sí debe pasar por su propio esqueleto.
    expect(screen.getByTestId("requisitions-skeleton")).toBeInTheDocument();
    await screen.findByText("0 visibles", {}, { timeout: 8_000 });

    rerender(<ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />);
    // De vuelta al dashboard, ya cacheado: el contenido real aparece de inmediato, sin
    // pasar de nuevo por el esqueleto (aunque siga revalidando en segundo plano).
    expect(screen.queryByTestId("dashboard-skeleton")).toBeNull();
    expect(screen.getByText("3")).toBeInTheDocument();

    // Dashboard (dashboard + catálogos) + revisión (requisiciones + órdenes; catálogos ya en
    // caché de sesión) + revalidación del dashboard al volver = 5 llamadas. Antes eran 6 porque
    // los catálogos se pedían en cada ruta (Fase 3, H6).
    await waitFor(() =>
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5),
    );
  }, 20_000);
});

// Fase 3 (H6): el respaldo en sessionStorage no puede participar en el render inicial. El
// servidor no tiene sessionStorage y pinta el esqueleto; si el cliente pintara el contenido
// persistido en su PRIMER render, React reportaría "Hydration failed" y descartaría el HTML del
// servidor (reproducido en el navegador el 2026-09-10). El primer render del cliente debe ser
// idéntico al del servidor y el respaldo se adopta en un efecto, ya montados.
describe("H6: el respaldo en sessionStorage no rompe la hidratación", () => {
  it("con una entrada persistida, el primer render sigue siendo el esqueleto y el contenido llega tras montar", async () => {
    window.sessionStorage.setItem(
      "mizar-route-cache:v1",
      JSON.stringify({
        "/": {
          kind: "dashboard",
          savedAt: Date.now(),
          data: { metrics: { byStatus: { en_revision: 7 } }, catalogs: catalogsPayload },
        },
      }),
    );
    try {
      vi.spyOn(globalThis, "fetch").mockImplementation(pendingForever);
      // Lo mismo que calcula el servidor: sin nada en memoria, la ruta arranca en "loading".
      expect(initialLoadState("/", "dashboard").state).toBe("loading");

      render(<ConnectedScreen pathname="/" role="Revisor" go={vi.fn()} />);
      // Ya montado, el efecto adopta el respaldo: contenido persistido + revalidación en curso.
      await screen.findByText("7", {}, { timeout: 8_000 });
      const container = screen.getByText("7").closest("[aria-busy]");
      expect(container).toHaveAttribute("aria-busy", "true");
      expect(screen.queryByTestId("dashboard-skeleton")).toBeNull();
    } finally {
      window.sessionStorage.clear();
    }
  });
});
