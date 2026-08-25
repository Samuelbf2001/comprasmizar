// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedDashboard } from "../../components/screens/connected";

afterEach(() => cleanup());

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

  it("renders the expense-by-work chart's accessible text alternative with the exact totals", () => {
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
      screen.getByRole("img", { name: /Gasto por obra/ }),
    ).toBeInTheDocument();
    const rows = screen.getAllByRole("row");
    expect(rows.some((row) => row.textContent?.includes("Obra Norte"))).toBe(
      true,
    );
    expect(screen.getByText(/1\.500\.000/)).toBeInTheDocument();
  });

  it("resolves a missing tag as 'Sin etiqueta' in the expense-by-tag breakdown", () => {
    render(
      <ConnectedDashboard
        data={{
          metrics: { byStatus: {}, expenseByTag: [{ key: "", total: 200_000 }] },
          catalogs,
        }}
        go={vi.fn()}
      />,
    );
    expect(screen.getByText("Sin etiqueta")).toBeInTheDocument();
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
