// @vitest-environment jsdom

// BLOQUEANTE 1 (QA 2026-08-31): la ficha de la orden (components/screens/connected.tsx) sumaba
// precios UNITARIOS —`(it.unitBase ?? 0) + (it.unitIva ?? 0)`— ignorando cantidad, descuento y el
// campo legacy `unitIva` (vacío en el modelo nuevo). El PDF de la misma orden
// (app/api/orders/[id]/document/route.ts) ya usaba `calculateLineAmounts` (lib/domain/rules.ts),
// así que 400 bultos a $38.000 se veían como "$38.000" en la ficha y "$18.088.000" en el PDF —
// dos cifras para el mismo documento. Este test reproduce ese escenario exacto (los mismos
// números del reporte de QA) y compara la ficha contra el cálculo canónico que también alimenta
// el PDF, para que esta regresión no pueda repetirse en silencio.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";
import { sumLines } from "../../lib/domain/rules";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
};

// El escenario exacto del reporte de QA: 400 bultos a $38.000, IVA 19%, sin descuento.
const bulkItem = {
  id: "item-1",
  description: "Cemento gris 50kg",
  quantity: 400,
  unit: "bulto",
  unitBase: 38_000,
  ivaRate: 0.19,
};

const orderRows = [
  {
    id: "order-1",
    consecutive: "OC-001",
    type: "OC" as const,
    requisitionId: "req-1",
    supplierId: "supplier-1",
    status: "generada",
    adminStatus: "pendiente" as const,
    itemIds: ["item-1"],
    // H2/H3 (docs/plan-rendimiento.md): ya vienen del servidor en el mismo SELECT — no hace
    // falta descargar TODAS las requisiciones para pintar consecutivo/obra en la tabla.
    requisitionConsecutive: "RQ-001",
    workId: "work-1",
    // Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): `requiredDate`/`lines` viajan
    // directo en la orden (mismo join que resuelve requisitionConsecutive/workId, ver `order(row)`
    // en postgres-repositories.ts) — ya no hace falta cargar la requisición de origen bajo demanda
    // (loadLinkedRequisition) para pintar la ficha, así que el fixture las trae de una vez.
    requiredDate: "2026-08-10",
    lines: [bulkItem],
  },
];

describe("BLOQUEANTE 1: el total de la ficha de la orden coincide con el del PDF", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("400 bultos a $38.000 con IVA 19% dan $18.088.000, no $38.000", async () => {
    // Revisión (corrección tras QA): la ficha ya no pide la requisición de origen — solo el
    // expediente del proveedor (GET /api/suppliers/:id) sigue siendo una carga bajo demanda.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "supplier-1", documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    render(
      <ConnectedOrders data={{ rows: orderRows, catalogs }} role="Revisor" refresh={vi.fn()} go={vi.fn()} />,
    );
    fireEvent.click(screen.getByText("OC-001"));

    // El mismo cálculo canónico que usa app/api/orders/[id]/document/route.ts (calculateLineAmounts)
    // para construir el PDF: si la ficha coincide con esto, coincide con el PDF.
    const expectedTotal = sumLines([bulkItem]);
    expect(expectedTotal).toBe(18_088_000); // ancla el escenario del reporte de QA, no solo la fórmula.

    // Se compara con una expresión regular sobre los dígitos (no el string exacto de
    // Intl.NumberFormat) para no depender de si el espacio entre "$" y el número es un
    // espacio normal o un NBSP — detalle de formato irrelevante para esta regresión.
    await waitFor(() => {
      expect(screen.getByText("Total de la orden")).toBeInTheDocument();
      expect(screen.getAllByText(/18\.088\.000/).length).toBeGreaterThan(0);
    });
    // La cifra vieja (buggy) no debe aparecer en ninguna parte de la ficha: ni "38.000" solo
    // (400 × $38.000 sin cantidad) ni como fragmento del total correcto de arriba.
    expect(screen.queryByText(/^\$\s?38\.000$/)).toBeNull();
  });
});
