// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectedDashboard } from "../../components/screens/connected";

afterEach(() => cleanup());

/**
 * PRECARGA DEL MÓDULO DE GRÁFICOS. Sin esto, este archivo fallaba de forma intermitente.
 *
 * Los gráficos entran por `next/dynamic` con `ssr:false` (ver dashboard.tsx) y `dashboard-charts`
 * es el único módulo que importa `recharts` (~150 KB, con su árbol de dependencias). En el navegador
 * eso es justo lo que se quiere: el gráfico se descarga solo cuando se ve el dashboard. En la prueba,
 * en cambio, ese import se disparaba DENTRO de la ventana de espera de `findByRole`, así que lo que
 * medía el aserto no era el render de React sino cuánto tarda vitest en transformar recharts. Con la
 * suite entera en paralelo eso se iba por encima del segundo por defecto de `findBy*`, y alguna vez
 * por encima de los 5 s del propio test: main salía rojo al azar.
 *
 * Subir el tope de espera habría escondido el problema sin quitarlo, y de paso habría hecho que un
 * fallo real tardara 30 s en dar la cara. Precargar el módulo aquí mueve ese coste FUERA del aserto
 * y lo paga una sola vez por archivo: cuando el test corre, `next/dynamic` resuelve contra el módulo
 * ya cargado y `findByRole` vuelve a medir lo que dice medir. El camino dinámico se sigue ejercitando
 * igual, no se sustituye por nada.
 *
 * El tope de 30 s es de la PRECARGA, no de los asertos: es lo que puede tardar transformar recharts
 * en una máquina cargada, y los tests conservan su tope estricto.
 */
beforeAll(async () => {
  await import("../../components/screens/connected/dashboard-charts");
}, 30_000);

const catalogs = {
  works: [
    { id: "work-1", name: "Obra Norte" },
    { id: "work-2", name: "Obra Sur" },
  ],
  tags: [{ id: "tag-1", name: "Urgente" }],
  suppliers: [],
  items: [],
  features: {},
};

describe("RF-1102: cola de atención y actividad reciente en el dashboard conectado", () => {
  it("shows an empty state instead of a synthetic queue/activity when the service returns none", () => {
    render(
      <ConnectedDashboard
        data={{ metrics: { byStatus: {} }, catalogs }}
        go={vi.fn()}
      />,
    );
    expect(screen.getByText("Sin pendientes")).toBeInTheDocument();
    expect(screen.getByText("Sin movimientos")).toBeInTheDocument();
  });

  it("renders the attention queue resolving work names from the catalog and navigates on click", () => {
    const go = vi.fn();
    render(
      <ConnectedDashboard
        data={{
          metrics: {
            byStatus: {},
            attentionQueue: [
              {
                kind: "requisicion",
                id: "req-1",
                consecutive: "REQ-2026-0007",
                workId: "work-1",
                status: "en_revision",
                action: "Revisar",
              },
              {
                kind: "orden",
                id: "order-1",
                consecutive: "OC-2026-0003",
                workId: "work-2",
                status: "generada",
                action: "Confirmar cumplimiento",
              },
            ],
          },
          catalogs,
        }}
        go={go}
      />,
    );
    expect(
      screen.getByText("REQ-2026-0007 · Revisar"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Obra Norte/)).toBeInTheDocument();
    expect(screen.getByText(/Obra Sur/)).toBeInTheDocument();

    fireEvent.click(screen.getByText("REQ-2026-0007 · Revisar"));
    expect(go).toHaveBeenCalledWith("/requisiciones/req-1");

    fireEvent.click(
      screen.getByText("OC-2026-0003 · Confirmar cumplimiento"),
    );
    expect(go).toHaveBeenCalledWith("/ordenes");
  });

  it("renders recent activity ordered as received and navigates to the right screen per document kind", () => {
    const go = vi.fn();
    render(
      <ConnectedDashboard
        data={{
          metrics: {
            byStatus: {},
            recentActivity: [
              {
                kind: "gasto",
                id: "exp-1",
                consecutive: "exp-1",
                workId: "work-1",
                status: "requisicion",
                at: "2026-08-23",
              },
            ],
          },
          catalogs,
        }}
        go={go}
      />,
    );
    fireEvent.click(screen.getByText("exp-1"));
    expect(go).toHaveBeenCalledWith("/gastos");
  });

  // Fase 2 (rendimiento, H4): DashboardBarChart/DashboardPeriodChart ahora se cargan con
  // next/dynamic (recharts diferido, ver components/screens/connected/dashboard.tsx) — en
  // jsdom/vitest esa resolución es asíncrona, así que el primer assert que depende del
  // gráfico pasa de `getBy...` a `findBy...` (los asserts posteriores, ya con el gráfico
  // montado, se quedan síncronos).
  it("renders the expense-by-work chart's accessible text alternative with the exact totals", async () => {
    render(
      <ConnectedDashboard
        data={{
          metrics: {
            byStatus: {},
            expenseByWork: [
              { key: "work-1", total: 1_500_000 },
              { key: "work-2", total: 500_000 },
            ],
          },
          catalogs,
        }}
        go={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("img", { name: /Gasto por obra/ }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows.some((row) => row.textContent?.includes("Obra Norte"))).toBe(
      true,
    );
    expect(screen.getByText(/1\.500\.000/)).toBeInTheDocument();
  });

  it("resolves a missing tag as 'Sin etiqueta' in the expense-by-tag breakdown", async () => {
    render(
      <ConnectedDashboard
        data={{
          metrics: { byStatus: {}, expenseByTag: [{ key: "", total: 200_000 }] },
          catalogs,
        }}
        go={vi.fn()}
      />,
    );
    expect(await screen.findByText("Sin etiqueta")).toBeInTheDocument();
  });

  // Centros de costo (UI, 2026-09-12): serie ejecutiva "Gasto por centro de costo", ADEMÁS de la de
  // obra (no en su lugar) — mismo patrón de accesibilidad (texto alternativo con los totales exactos).
  it("renders the expense-by-cost-center chart's accessible text alternative with the exact totals", async () => {
    render(
      <ConnectedDashboard
        data={{
          metrics: {
            byStatus: {},
            expenseByCostCenter: [
              { key: "cc-1", total: 700_000 },
              { key: "", total: 100_000 },
            ],
          },
          catalogs: { ...catalogs, costCenters: [{ id: "cc-1", name: "Administrativo" }] },
        }}
        go={vi.fn()}
      />,
    );
    expect(
      await screen.findByRole("img", { name: /Gasto por centro de costo/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Administrativo")).toBeInTheDocument();
    expect(screen.getByText("Sin centro de costo")).toBeInTheDocument();
    expect(screen.getByText(/700\.000/)).toBeInTheDocument();
  });

  it("still renders the four scoped stat cards unchanged", () => {
    render(
      <ConnectedDashboard
        data={{
          metrics: {
            byStatus: { en_revision: 3, en_aprobacion: 1 },
            inProcessValue: 100000,
            pendingOrders: 2,
            periodExpense: 900000,
          },
          catalogs,
        }}
        go={vi.fn()}
      />,
    );
    expect(screen.getByText("En revisión")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
