// Fase 3 cliente (docs/plan-rendimiento.md, hallazgos H2/H3/H6): cubre el contrato de red que
// `loadRoute`/`mutate` de components/screens/connected/data.ts deben respetar tras consumir los
// endpoints compuestos/paginados de la Fase 3 de servidor:
//   - detalle: UNA llamada a /detail (más catálogos), cero llamadas por ítem.
//   - gastos: UNA llamada de adjuntos por lote para toda la caja menor visible.
//   - bandeja de revisión: `status=...&limit=100` en vez de la colección completa.
//   - catálogos: caché de sesión con TTL, deduplicada entre rutas en paralelo, e invalidada solo
//     por mutaciones de catálogo/proveedor — nunca por una mutación de orden/gasto/requisición.
//
// No usa @vitest-environment jsdom: todos estos tests llaman directo a las funciones de data.ts
// (sin React) contra un `fetch` simulado por URL, al estilo `routedFetch` de
// tests/unit/percepcion-carga.test.tsx (archivo que NO se toca aquí: lo está ajustando el
// revisor en paralelo, ver docs/plan-rendimiento.md).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRouteCache,
  initialLoadState,
  invalidateCatalogs,
  loadMoreRequisitions,
  loadRoute,
  mutate,
  setCachedRoute,
} from "../../components/screens/connected/data";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Mismo espíritu que el `routedFetch` de percepcion-carga.test.tsx: dispatcher por PATH exacto
// (sin query string) — los tests que necesitan inspeccionar la query lo hacen sobre
// `fetchMock.mock.calls` directamente, no sobre el handler.
function routedFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0];
    const handler = handlers[path];
    if (!handler) throw new Error(`Fetch no simulado para "${path}" en esta prueba.`);
    return handler();
  });
}

const catalogsPayload = {
  works: [{ id: "work-1", name: "Obra Norte" }],
  tags: [{ id: "tag-1", name: "Urgente" }],
  suppliers: [],
  items: [],
  features: {},
};

beforeEach(() => {
  clearRouteCache();
  invalidateCatalogs();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("H2: el detalle de una requisición pide /detail + catálogos, sin llamadas por ítem", () => {
  it("hace exactamente 2 llamadas de red y ninguna a /api/orders, /api/expenses, /history ni adjuntos por ítem", async () => {
    const detailPayload = {
      requisition: {
        id: "req-1",
        consecutive: "RQ-001",
        type: "compra",
        workId: "work-1",
        channel: "web",
        status: "aprobada",
        items: [
          { id: "item-1", description: "Cemento", quantity: 10, unit: "bulto" },
          { id: "item-2", description: "Arena", quantity: 5, unit: "m3" },
        ],
      },
      orders: [{ id: "order-1", consecutive: "OC-001", type: "OC", requisitionId: "req-1", status: "generada" }],
      expenses: [{ id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "req-1", orderDate: "2026-08-01", total: 100000 }],
      history: [{ event: "creada", at: "2026-08-01T00:00:00.000Z" }],
      attachments: [
        { id: "att-1", entity: "requisicion", entityId: "req-1", type: "soporte", name: "orden.pdf", mimeType: "application/pdf", sizeBytes: 10 },
        { id: "att-2", entity: "requisicion_item", entityId: "item-1", type: "foto", name: "frente.png", mimeType: "image/png", sizeBytes: 10 },
      ],
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/requisitions/req-1/detail": () => jsonResponse(detailPayload),
        "/api/catalogs": () => jsonResponse(catalogsPayload),
      }),
    );

    const bundle = (await loadRoute("/requisiciones/req-1", "Revisor")) as {
      requisition: { id: string };
      orders: unknown[];
      expenses: unknown[];
      history: unknown[];
      attachments: unknown[];
    };

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calledUrls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(calledUrls).toEqual(
      expect.arrayContaining(["/api/requisitions/req-1/detail", "/api/catalogs"]),
    );
    // routedFetch ya lanzaría si se pidiera cualquier otra URL, pero se deja explícito el
    // contrato que este test protege: nada de /api/orders, /api/expenses, /history sueltos ni
    // una llamada de adjuntos por ítem (antes eran 1+N, una por cada ítem de la requisición).
    expect(calledUrls.some((url) => url.includes("/api/orders"))).toBe(false);
    expect(calledUrls.some((url) => url.includes("/api/expenses"))).toBe(false);
    expect(calledUrls.some((url) => url.includes("/history"))).toBe(false);
    expect(calledUrls.some((url) => url.includes("/api/attachments/requisicion_item"))).toBe(false);

    expect(bundle.requisition.id).toBe("req-1");
    expect(bundle.orders).toHaveLength(1);
    expect(bundle.expenses).toHaveLength(1);
    expect(bundle.history).toHaveLength(1);
    expect(bundle.attachments).toHaveLength(2);
  });

  // QA H3 (adenda de pagos): el servidor ya mandaba quién mira, pero esta normalización lo tiraba y
  // «Aprobar yo mismo» nunca se pintaba. Las pruebas de detail.tsx inyectaban ambos campos a mano y
  // por eso no lo vieron; esta mira el bundle tal como lo arma loadRoute.
  it("conserva viewerId y viewerRoles del payload del servidor", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/requisitions/req-1/detail": () =>
          jsonResponse({
            requisition: { id: "req-1", consecutive: "RQ-001", type: "compra", channel: "web", status: "en_revision", items: [] },
            orders: [], expenses: [], history: [], attachments: [],
            viewerId: "daniel-1",
            viewerRoles: ["revisor", "aprobador"],
          }),
        "/api/catalogs": () => jsonResponse(catalogsPayload),
      }),
    );

    const bundle = (await loadRoute("/requisiciones/req-1", "Revisor")) as { viewerId?: string; viewerRoles?: string[] };

    expect(bundle.viewerId).toBe("daniel-1");
    expect(bundle.viewerRoles).toEqual(["revisor", "aprobador"]);
  });
});

// Adenda de pagos (A10): /gastos es "Cierre de caja" y consulta los pagos por caja bajo demanda desde
// la pantalla; la carga de ruta ya no pide caja menor, ingresos ni el lote de adjuntos (rutas retiradas
// con 410 — pedirlas tumbaría la pantalla entera).
describe("A10: /gastos solo carga el libro de gastos y los catálogos", () => {
  it("no pide /api/petty-cash, /api/incomes ni adjuntos de caja_menor, y deja esos campos vacíos", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/expenses": () => jsonResponse([{ id: "exp-1", workId: "work-1", origin: "requisicion", referenceId: "r-1", orderDate: "2026-09-01", total: 1000 }]),
        "/api/catalogs": () => jsonResponse(catalogsPayload),
      }),
    );
    const bundle = (await loadRoute("/gastos", "Contabilidad")) as {
      expenses: Array<{ id: string }>;
      pettyCash: unknown[];
      pettyAttachments: Record<string, unknown[]>;
      incomes?: unknown[];
    };
    const calledPaths = fetchMock.mock.calls.map(([input]) => String(input).split("?")[0]);
    expect(calledPaths.sort()).toEqual(["/api/catalogs", "/api/expenses"]);
    expect(bundle.expenses).toHaveLength(1);
    expect(bundle.pettyCash).toEqual([]);
    expect(bundle.pettyAttachments).toEqual({});
    expect(bundle.incomes).toEqual([]);
  });
});

describe("H3: la bandeja de revisión pide status+limit al servidor y 'Cargar más' anexa la segunda página", () => {
  it("/revision pide status=enviada,en_revision,devuelta,aprobada&limit=100", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.split("?")[0];
      if (path === "/api/requisitions") return jsonResponse({ rows: [], nextCursor: null });
      if (path === "/api/catalogs") return jsonResponse(catalogsPayload);
      if (path === "/api/orders") return jsonResponse([]);
      throw new Error(`Fetch no simulado para "${path}"`);
    });
    await loadRoute("/revision", "Revisor");
    const requisitionsCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.startsWith("/api/requisitions?"));
    expect(requisitionsCall).toBeDefined();
    const params = new URL(requisitionsCall as string, "http://localhost").searchParams;
    expect(params.get("status")).toBe("enviada,en_revision,devuelta,aprobada");
    expect(params.get("limit")).toBe("100");
    expect(params.has("cursor")).toBe(false);
  });

  it("/aprobaciones pide solo status=en_aprobacion y NO pide /api/orders", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.split("?")[0];
      if (path === "/api/requisitions") return jsonResponse({ rows: [], nextCursor: null });
      if (path === "/api/catalogs") return jsonResponse(catalogsPayload);
      throw new Error(`Fetch no simulado para "${path}" (¿pidió /api/orders de más?)`);
    });
    await loadRoute("/aprobaciones", "Aprobador");
    const requisitionsCall = fetchMock.mock.calls
      .map(([input]) => String(input))
      .find((url) => url.startsWith("/api/requisitions?"));
    const params = new URL(requisitionsCall as string, "http://localhost").searchParams;
    expect(params.get("status")).toBe("en_aprobacion");
  });

  it("'Cargar más' (loadMoreRequisitions) pide el cursor de la página siguiente y setCachedRoute dejó la caché con las filas anexadas", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.split("?")[0];
      if (path === "/api/requisitions") {
        const params = new URL(url, "http://localhost").searchParams;
        if (params.get("cursor") === "cursor-1") {
          return jsonResponse({ rows: [{ id: "req-2", consecutive: "RQ-002" }], nextCursor: null });
        }
        throw new Error(`cursor inesperado: ${params.get("cursor")}`);
      }
      throw new Error(`Fetch no simulado para "${path}"`);
    });

    const page = await loadMoreRequisitions("/revision", "cursor-1");
    expect(page.rows).toEqual([{ id: "req-2", consecutive: "RQ-002" }]);
    expect(page.nextCursor).toBeNull();

    // Simula lo que requisitions.tsx hace tras "Cargar más": anexa a la página ya cacheada y
    // vuelve a guardar la caché de ruta con la lista completa + el cursor nuevo.
    const firstPage = { rows: [{ id: "req-1", consecutive: "RQ-001" }], nextCursor: "cursor-1", catalogs: catalogsPayload };
    setCachedRoute("/revision", "requisitions", firstPage);
    const merged = { ...firstPage, rows: [...firstPage.rows, ...page.rows], nextCursor: page.nextCursor };
    setCachedRoute("/revision", "requisitions", merged);

    const state = initialLoadState("/revision", "requisitions");
    expect(state.state).toBe("ready");
    expect(state.state === "ready" && (state.data as typeof merged).rows).toEqual([
      { id: "req-1", consecutive: "RQ-001" },
      { id: "req-2", consecutive: "RQ-002" },
    ]);
    expect(state.state === "ready" && (state.data as typeof merged).nextCursor).toBeNull();
  });
});

describe("H6: mutate invalida por afectación, no toda la caché", () => {
  it("mutar /api/orders no borra la caché de catálogos ni la de /requisiciones/nueva (kind 'new')", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.split("?")[0];
      if (path === "/api/catalogs") return jsonResponse(catalogsPayload);
      if (path === "/api/orders/order-1/status" && init?.method === "PATCH") {
        return jsonResponse({ id: "order-1", status: "cumplida" });
      }
      throw new Error(`Fetch no simulado para "${path}"`);
    });

    // Calienta la caché de catálogos (una sola llamada a /api/catalogs) y la caché de ruta
    // "new" (/requisiciones/nueva).
    const catalogsFirstLoad = await loadRoute("/requisiciones/nueva", "Solicitante");
    setCachedRoute("/requisiciones/nueva", "new", catalogsFirstLoad);
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(1);

    await mutate("/api/orders/order-1/status", "PATCH", { status: "cumplida" });

    // La caché de ruta "new" sigue viva: /api/orders no está en su tabla de invalidación.
    const cachedNew = initialLoadState("/requisiciones/nueva", "new");
    expect(cachedNew.state).toBe("ready");

    // Y los catálogos siguen calientes: volver a pedirlos no dispara un segundo fetch.
    await loadRoute("/requisiciones/nueva", "Solicitante");
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(1);
  });
});

describe("H2/H6: caché de catálogos por sesión", () => {
  it("invalidateCatalogs() fuerza una recarga en el siguiente loadRoute", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({ "/api/catalogs": () => jsonResponse(catalogsPayload) }),
    );
    await loadRoute("/requisiciones/nueva", "Solicitante");
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(1);
    await loadRoute("/requisiciones/nueva", "Solicitante");
    // TTL de 5 min todavía vigente: segunda lectura no dispara otro fetch.
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(1);

    invalidateCatalogs();
    await loadRoute("/requisiciones/nueva", "Solicitante");
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(2);
  });

  it("dos rutas que cargan catálogos en paralelo comparten UNA sola llamada (dedup en vuelo)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.split("?")[0];
      if (path === "/api/catalogs") {
        // Resuelve en un microtask posterior para simular una respuesta real (no instantánea) y
        // dejar una ventana en la que dos llamadas concurrentes deban compartir la misma promesa.
        await Promise.resolve();
        return jsonResponse(catalogsPayload);
      }
      if (path === "/api/dashboard") return jsonResponse({ byStatus: {} });
      throw new Error(`Fetch no simulado para "${path}"`);
    });

    await Promise.all([
      loadRoute("/requisiciones/nueva", "Solicitante"),
      loadRoute("/", "Solicitante"),
    ]);

    expect(fetchMock.mock.calls.filter(([i]) => String(i) === "/api/catalogs")).toHaveLength(1);
  });
});
