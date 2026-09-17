// @vitest-environment jsdom

// DECISIÓN DE ERNESTO (2026-09-17): los permisos por rol se editan desde Configuración. El servidor ya
// autorizaba por permiso efectivo, pero la INTERFAZ seguía decidiendo qué pinta comparando el NOMBRE
// del rol, así que devolverle "payment:register" a Contabilidad no hacía aparecer ningún botón (el
// servidor lo habría aceptado) y quitárselo al Revisor no hacía desaparecer ninguno (el servidor lo
// habría rechazado). Esto fija las dos direcciones.
//
// Fija además que el bundle que arma `loadRoute` no vuelva a tirar los permisos por el camino: es
// exactamente el hallazgo H3, que ya pasó una vez con `viewerId`/`viewerRoles` en la normalización del
// detalle.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";
import { conLaLente, type OrdersBundle } from "../../components/screens/connected/shared";
import { clearRouteCache, invalidateCatalogs, loadRoute } from "../../components/screens/connected/data";
import { DEFAULT_ROLE_PERMISSIONS } from "../../lib/domain/rules";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
};
// `contabilizada` con saldo pendiente: el estado en el que la ficha ofrece "Registrar pago" a quien
// tenga el permiso, y la frase "no puede registrar pagos" a quien no.
const orderRows = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    requisitionConsecutive: "RQ-001",
    workId: "work-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "contabilizada" as const,
    lines: [{ id: "item-1", description: "Cemento", quantity: 1, unit: "bulto", unitBase: 100_000, ivaRate: 0 }],
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Historial de pagos vacío y expediente de proveedor neutro: nada de eso decide el botón. */
function mockFichaFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/payments")) return json([]);
    return json({ id: "supplier-1", documents: [] });
  });
}

/** Abre la ficha lateral de la orden, que es donde vive "Registrar pago". */
function abrirFicha(data: OrdersBundle, role: Parameters<typeof ConnectedOrders>[0]["role"], viewingAs: Parameters<typeof ConnectedOrders>[0]["viewingAs"] = null) {
  mockFichaFetch();
  render(<ConnectedOrders data={data} role={role} viewingAs={viewingAs} refresh={vi.fn()} go={vi.fn()} />);
  fireEvent.click(screen.getByText("OC-001"));
}

describe("la ficha de la orden obedece al permiso efectivo, no al nombre del rol", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("con «payment:register» devuelto a Contabilidad por override, ofrece «Registrar pago»", () => {
    abrirFicha(
      { rows: orderRows, catalogs, viewerPermissions: [...DEFAULT_ROLE_PERMISSIONS.contabilidad, "payment:register"] },
      "Contabilidad",
    );
    expect(screen.getByRole("button", { name: "Registrar pago" })).toBeInTheDocument();
  });

  it("sin el permiso no lo ofrece, aunque el rol sea Revisor", () => {
    abrirFicha(
      { rows: orderRows, catalogs, viewerPermissions: DEFAULT_ROLE_PERMISSIONS.revisor.filter((permiso) => permiso !== "payment:register") },
      "Revisor",
    );
    expect(screen.queryByRole("button", { name: "Registrar pago" })).toBeNull();
    expect(screen.getByText("Tu rol no puede registrar pagos de esta orden.")).toBeInTheDocument();
  });

  it("la lente «Ver como» usa los permisos EFECTIVOS del rol prestado, no el comodín de quien mira", () => {
    // Administrador Sixteam (comodín "*") mirando como Contabilidad: lo que decide es la matriz
    // vigente de Contabilidad, que en esta instalación tiene el permiso devuelto.
    const prestado = conLaLente(
      {
        rows: orderRows,
        catalogs,
        viewerPermissions: ["*"],
        rolePermissions: { contabilidad: [...DEFAULT_ROLE_PERMISSIONS.contabilidad, "payment:register"] },
      },
      "Contabilidad",
    ) as OrdersBundle;
    abrirFicha(prestado, "Contabilidad", "Contabilidad");
    expect(screen.getByRole("button", { name: "Registrar pago" })).toBeInTheDocument();
  });

  it("y sin ese permiso en la matriz del rol prestado, la lente lo niega y nombra el rol", () => {
    const prestado = conLaLente(
      { rows: orderRows, catalogs, viewerPermissions: ["*"], rolePermissions: { contabilidad: DEFAULT_ROLE_PERMISSIONS.contabilidad } },
      "Contabilidad",
    ) as OrdersBundle;
    abrirFicha(prestado, "Contabilidad", "Contabilidad");
    expect(screen.queryByRole("button", { name: "Registrar pago" })).toBeNull();
    expect(screen.getByText("Estás viendo como Contabilidad; ese rol no puede registrar pagos de esta orden.")).toBeInTheDocument();
  });
});

// H3: el servidor manda los permisos en el bootstrap de catálogos y `loadRoute` los sube al nivel del
// bundle. La normalización del DETALLE rearma el objeto campo a campo, que es justo donde se perdieron
// `viewerId`/`viewerRoles` la vez anterior.
describe("el bundle que arma loadRoute conserva los permisos del visor", () => {
  const viewerPermissions = ["order:read", "payment:register", "expense:read", "report:read"];
  const rolePermissions = { contabilidad: ["order:read", "order:account"] };
  const catalogsPayload = { ...catalogs, viewerPermissions, rolePermissions };

  function routedFetch(handlers: Record<string, () => Response>) {
    return vi.fn(async (input: string | URL | Request) => {
      const path = String(input).split("?")[0];
      const handler = handlers[path];
      if (!handler) throw new Error(`Fetch no simulado para "${path}" en esta prueba.`);
      return handler();
    });
  }

  beforeEach(() => {
    clearRouteCache();
    invalidateCatalogs();
    vi.restoreAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());

  it("los conserva en el detalle, junto a viewerId y viewerRoles", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/requisitions/req-1/detail": () =>
          json({
            requisition: { id: "req-1", consecutive: "RQ-001", type: "compra", channel: "web", status: "en_revision", items: [] },
            orders: [],
            expenses: [],
            history: [],
            attachments: [],
            viewerId: "daniel-1",
            viewerRoles: ["revisor"],
          }),
        "/api/catalogs": () => json(catalogsPayload),
      }),
    );

    const bundle = (await loadRoute("/requisiciones/req-1", "Revisor")) as OrdersBundle & { viewerId?: string; viewerRoles?: string[] };

    expect(bundle.viewerPermissions).toEqual(viewerPermissions);
    expect(bundle.rolePermissions).toEqual(rolePermissions);
    expect(bundle.viewerId).toBe("daniel-1");
    expect(bundle.viewerRoles).toEqual(["revisor"]);
  });

  it("y también en órdenes, gastos y reportes, cuyas listas no tienen dónde traerlos", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      routedFetch({
        "/api/orders": () => json([]),
        "/api/expenses": () => json([]),
        "/api/reports": () => json({ rows: [] }),
        "/api/catalogs": () => json(catalogsPayload),
      }),
    );

    for (const pathname of ["/ordenes", "/gastos", "/reportes"]) {
      const bundle = (await loadRoute(pathname, "Contabilidad")) as OrdersBundle;
      expect(bundle.viewerPermissions).toEqual(viewerPermissions);
      expect(bundle.rolePermissions).toEqual(rolePermissions);
    }
  });
});
