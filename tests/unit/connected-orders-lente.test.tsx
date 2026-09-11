// @vitest-environment jsdom

// "Ver como" es una LENTE DE PRESENTACIÓN: cambia lo que se pinta, nunca los permisos (mizar-app.tsx
// resuelve `role` con la lente antes de bajarlo, y el servidor sigue autorizando con el rol de la
// sesión). El efecto secundario es que las pantallas no podían distinguir "no puedes" de "este rol
// no puede", y un Administrador Sixteam mirando Órdenes como Contabilidad leía "Tu rol no puede
// cambiar el estado de entrega de la orden" — que suena a cuenta mal configurada cuando en realidad
// sí puede y solo está mirando prestado.
//
// Esto fija las dos frases de la ficha de la orden en ambos modos.

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedOrders } from "../../components/screens/connected";

const catalogs = {
  works: [{ id: "work-1", name: "Torre Norte" }],
  tags: [],
  suppliers: [{ id: "supplier-1", name: "Ferretería Uno" }],
  items: [],
  features: {},
};

// `generada` + `pendiente`: el único estado en el que ambas frases pueden aparecer, porque en
// cualquier otro la ficha dice "ya está marcada como…" y el permiso deja de ser el motivo.
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
    adminStatus: "pendiente" as const,
  },
];

/** Abre la ficha lateral, que es donde viven las dos frases. */
function abrirFicha(
  role: "Contabilidad" | "Administrador Sixteam",
  viewingAs: "Contabilidad" | null,
  adminStatus: "pendiente" | "contabilizada" = "pendiente",
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ id: "order-1", documents: [] }), { status: 200, headers: { "Content-Type": "application/json" } }),
  );
  const rows = orderRows.map((row) => ({ ...row, adminStatus }));
  render(<ConnectedOrders data={{ rows, catalogs }} role={role} viewingAs={viewingAs} refresh={vi.fn()} go={vi.fn()} />);
  fireEvent.click(screen.getByText("OC-001"));
}

describe("mensajes de permiso en la ficha de la orden", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("sin lente, la frase habla del rol propio", () => {
    // Contabilidad de verdad: no cambia la entrega, y el texto de siempre es el correcto.
    abrirFicha("Contabilidad", null);
    expect(screen.getByText("Tu rol no puede cambiar el estado de entrega de la orden.")).toBeInTheDocument();
  });

  it("con la lente puesta, la frase nombra el rol prestado y no culpa a la cuenta", () => {
    // El caso que confundió a Ernesto: Administrador Sixteam mirando Órdenes como Contabilidad.
    // `role` ya llega siendo "Contabilidad" (la lente se resuelve arriba), así que lo único que
    // distingue este caso del anterior es `viewingAs`.
    abrirFicha("Contabilidad", "Contabilidad");
    expect(screen.getByText("Estás viendo como Contabilidad; ese rol no puede cambiar el estado de entrega de la orden.")).toBeInTheDocument();
    expect(screen.queryByText(/^Tu rol no puede/)).not.toBeInTheDocument();
  });

  // Segunda frase de la ficha, en el eje administrativo: que el cambio no se quedara a medias en
  // una sola de las dos. Hace falta `contabilizada`, no `pendiente`: contabilidad SÍ puede
  // contabilizar desde pendiente (ahí ve el botón), pero el paso a "pagada" es del revisor, así que
  // con la orden ya contabilizada es cuando le sale la frase.
  it("la frase de contabilidad sigue la misma regla bajo la lente", () => {
    abrirFicha("Contabilidad", "Contabilidad", "contabilizada");
    expect(screen.getByText(/^Estás viendo como Contabilidad; ese rol no puede avanzar la contabilidad desde/)).toBeInTheDocument();
  });

  it("y sin lente vuelve a hablar del rol propio", () => {
    abrirFicha("Contabilidad", null, "contabilizada");
    expect(screen.getByText(/^Tu rol no puede avanzar la contabilidad desde/)).toBeInTheDocument();
  });
});
