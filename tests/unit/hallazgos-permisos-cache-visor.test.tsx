// @vitest-environment jsdom

// ENSAYO DEL 23-SEP-2026 (7 agentes en el mismo navegador): Contabilidad vio «Registrar pago»,
// «Pagar saldo» y «Anular», y un aprobador «Reasignar aprobador». El servidor los rechazaba (403) y la
// interfaz ya decidía por `viewerPermissions`; lo que fallaba era DE QUIÉN eran esos permisos. Viajan
// en el bootstrap de catálogos, que el cliente guarda 5 minutos a nivel de módulo, y cerrar sesión y
// entrar con otra cuenta en la misma pestaña es una navegación suave: la caché sobrevivía y la cuenta
// nueva heredaba los permisos (y el respaldo de sessionStorage, los datos) de la anterior.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";
import type { OrdersBundle } from "../../components/screens/connected/shared";
import { DEFAULT_ROLE_PERMISSIONS } from "../../lib/domain/rules";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const catalogs = { works: [], tags: [], suppliers: [], items: [], features: {} };
// Lo que respondería el servidor a cada cuenta: la cookie decide quién es, no la pestaña.
const permisosDe: Record<string, readonly string[]> = {
  daniel: [...DEFAULT_ROLE_PERMISSIONS.revisor, ...DEFAULT_ROLE_PERMISSIONS.aprobador],
  claudia: DEFAULT_ROLE_PERMISSIONS.contabilidad,
};

async function moduloLimpio() {
  vi.resetModules();
  return import("../../components/screens/connected/data");
}

describe("las cachés de cliente pertenecen a UNA cuenta", () => {
  let sesion = "daniel";
  beforeEach(() => {
    window.sessionStorage.clear();
    sesion = "daniel";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/api/catalogs") return json({ ...catalogs, viewerPermissions: permisosDe[sesion] });
      if (path === "/api/orders") return json([]);
      throw new Error(`Fetch no simulado: ${path}`);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });

  it("cerrar sesión y entrar con otra cuenta en la misma pestaña no hereda los permisos de la anterior", async () => {
    const data = await moduloLimpio();
    data.vincularCachesAlVisor("daniel");
    const deDaniel = (await data.loadRoute("/ordenes", "Revisor")) as OrdersBundle;
    expect(deDaniel.viewerPermissions).toContain("payment:register");

    sesion = "claudia"; // la cookie ya es de Claudia; el módulo sigue cargado (navegación suave)
    data.vincularCachesAlVisor("claudia");
    const deClaudia = (await data.loadRoute("/ordenes", "Contabilidad")) as OrdersBundle;
    expect(deClaudia.viewerPermissions).toEqual(permisosDe.claudia);
    expect(deClaudia.viewerPermissions).not.toContain("payment:register");
  });

  it("el mismo visor conserva la caché: volver a vincularlo no vuelve a pedir los catálogos", async () => {
    const data = await moduloLimpio();
    data.vincularCachesAlVisor("daniel");
    await data.loadRoute("/ordenes", "Revisor");
    data.vincularCachesAlVisor("daniel");
    await data.loadRoute("/ordenes", "Revisor");
    const pedidasCatalogos = vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input).startsWith("/api/catalogs"));
    expect(pedidasCatalogos).toHaveLength(1);
  });

  it("una respuesta de catálogos que salió con la sesión anterior no vuelve a sembrar la caché", async () => {
    const data = await moduloLimpio();
    let liberar: (value: Response) => void = () => {};
    let primera = true;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/api/catalogs" && primera) {
        primera = false;
        return new Promise<Response>((resolve) => { liberar = resolve; });
      }
      if (path === "/api/catalogs") return json({ ...catalogs, viewerPermissions: permisosDe[sesion] });
      return json([]);
    });
    data.vincularCachesAlVisor("daniel");
    const enVuelo = data.loadRoute("/ordenes", "Revisor");
    sesion = "claudia";
    data.vincularCachesAlVisor("claudia");
    liberar(json({ ...catalogs, viewerPermissions: permisosDe.daniel }));
    await enVuelo;
    const deClaudia = (await data.loadRoute("/ordenes", "Contabilidad")) as OrdersBundle;
    expect(deClaudia.viewerPermissions).toEqual(permisosDe.claudia);
  });

  it("tras recargar, el respaldo de sessionStorage solo lo recupera la misma cuenta que lo dejó", async () => {
    let data = await moduloLimpio();
    data.vincularCachesAlVisor("daniel");
    data.setCachedRoute("/aprobaciones", "requisitions", { rows: [{ consecutive: "REQ-2026-0003" }] });

    // Recarga con la misma cuenta: el respaldo (H6) sigue sirviendo.
    data = await moduloLimpio();
    data.vincularCachesAlVisor("daniel");
    expect(data.getPersistedRoute("/aprobaciones")).toBeDefined();

    // Recarga con OTRA cuenta: la bandeja de Daniel no se pinta ni un instante.
    data = await moduloLimpio();
    data.vincularCachesAlVisor("juliana");
    expect(data.getPersistedRoute("/aprobaciones")).toBeUndefined();
  });

  it("un respaldo sin dueño (anterior a este cambio) se descarta: no se sabe de quién era", async () => {
    window.sessionStorage.setItem(
      "mizar-route-cache:v1",
      JSON.stringify({ "/aprobaciones": { kind: "requisitions", data: { rows: [] }, savedAt: Date.now() } }),
    );
    const data = await moduloLimpio();
    data.vincularCachesAlVisor("juliana");
    expect(data.getPersistedRoute("/aprobaciones")).toBeUndefined();
  });

  it("cerrar sesión vacía las cachés y el respaldo de la pestaña", async () => {
    const data = await moduloLimpio();
    data.vincularCachesAlVisor("daniel");
    await data.loadRoute("/ordenes", "Revisor");
    data.setCachedRoute("/ordenes", "orders", { rows: [] });
    data.olvidarCachesDelVisor();
    expect(window.sessionStorage.getItem("mizar-route-cache:v1")).toBeNull();
    expect(window.sessionStorage.getItem("mizar-route-cache-owner:v1")).toBeNull();
    expect(data.initialLoadState("/ordenes", "orders")).toEqual({ state: "loading", kind: "orders" });
  });
});

// «Pagar saldo» abre el diálogo que REGISTRA un pago (POST /payments, payment:register) y luego cierra
// la orden (order:pay). Estaba condicionado solo a order:pay: con ese permiso y sin el otro, el botón
// aparecía y el servidor rechazaba el guardado.
describe("«Pagar saldo» exige también poder registrar pagos", () => {
  const orderRows = [
    {
      id: "order-1",
      consecutive: "OP-001",
      type: "OP" as const,
      requisitionId: "req-1",
      requisitionConsecutive: "RQ-001",
      workId: "work-1",
      supplierId: "supplier-1",
      status: "generada",
      adminStatus: "contabilizada" as const,
      lines: [{ id: "item-1", description: "Anticipo", quantity: 1, unit: "und", unitBase: 100_000, ivaRate: 0 }],
    },
  ];
  function abrirFicha(viewerPermissions: readonly string[]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).includes("/payments") ? json([]) : json({ id: "supplier-1", documents: [] }),
    );
    const data: OrdersBundle = { rows: orderRows, catalogs, viewerPermissions };
    render(<ConnectedOrders data={data} role="Revisor" refresh={vi.fn()} go={vi.fn()} />);
    fireEvent.click(screen.getByText("OP-001"));
  }
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("con order:pay pero sin payment:register no lo ofrece y dice por qué", () => {
    abrirFicha(DEFAULT_ROLE_PERMISSIONS.revisor.filter((permiso) => permiso !== "payment:register"));
    expect(screen.queryByRole("button", { name: "Pagar saldo" })).toBeNull();
    expect(screen.getByText(/Quedan .* por pagar\. Tu rol no puede registrar pagos de esta orden\./)).toBeInTheDocument();
  });

  it("con los dos permisos lo sigue ofreciendo", () => {
    abrirFicha(DEFAULT_ROLE_PERMISSIONS.revisor);
    expect(screen.getByRole("button", { name: "Pagar saldo" })).toBeInTheDocument();
  });

  it("Contabilidad por defecto no ve ninguno de los botones de pago", () => {
    abrirFicha(DEFAULT_ROLE_PERMISSIONS.contabilidad);
    for (const name of ["Pagar saldo", "Registrar pago", "Marcar pagada"]) expect(screen.queryByRole("button", { name })).toBeNull();
  });
});
