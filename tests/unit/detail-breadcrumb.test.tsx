// @vitest-environment jsdom

// Ensayo 2026-09-23 (CAT-08: nunca ids internos a la vista): en /requisiciones/{uuid} la migaja de la
// barra superior mostraba el UUID crudo de la URL — la primera línea visible de la pantalla, antes
// del consecutivo. Ahora muestra el consecutivo que declara el detalle y, mientras carga, el nombre
// de la bandeja padre.
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const UUID = "9966df9b-3b47-4181-b92e-37804df7bd5a";

vi.mock("next/navigation", () => ({
  usePathname: () => `/requisiciones/${UUID}`,
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../app/auth-actions", () => ({ logout: vi.fn() }));
// La pantalla conectada real carga datos por red; aquí basta un doble que, como el detalle, declare
// su consecutivo cuando "termina de cargar".
const declarar = { listo: false };
vi.mock("../../components/screens/connected/screen", async () => {
  const { useDetailCrumb } = await import("../../components/layout/breadcrumb-context");
  return {
    ConnectedScreen: function DetalleDoble() {
      useDetailCrumb(declarar.listo ? "REQ-2026-0047" : undefined);
      return <p>detalle</p>;
    },
  };
});

import MizarApp from "../../components/mizar-app";
import { detailCrumbLabel } from "../../components/layout/breadcrumb-context";

afterEach(() => {
  cleanup();
  declarar.listo = false;
});

describe("migaja del detalle de requisición", () => {
  it("nunca muestra el UUID de la URL: la bandeja padre mientras carga, el consecutivo al cargar", () => {
    const { rerender } = render(<MizarApp initialRole="Revisor" />);
    const barra = document.querySelector(".breadcrumbs") as HTMLElement;
    expect(barra).not.toHaveTextContent(UUID);
    expect(barra).toHaveTextContent("Revisión");

    declarar.listo = true;
    act(() => rerender(<MizarApp initialRole="Revisor" />));
    expect(screen.getByText("REQ-2026-0047", { selector: ".breadcrumbs b" })).toBeInTheDocument();
    expect(barra).not.toHaveTextContent(UUID);
  });

  it("el detalle conectado declara su consecutivo a la barra", async () => {
    const { ConnectedRequisitionDetail } = await import("../../components/screens/connected/detail");
    const { DetailCrumbContext } = await import("../../components/layout/breadcrumb-context");
    const setCrumb = vi.fn();
    render(
      <DetailCrumbContext.Provider value={setCrumb}>
        <ConnectedRequisitionDetail
          data={{
            requisition: { id: UUID, consecutive: "REQ-2026-0047", type: "compra", channel: "web", status: "aprobada", items: [] },
            catalogs: { works: [], tags: [], suppliers: [], items: [], features: {} },
            orders: [], expenses: [], history: [], attachments: [],
          }}
          role="Solicitante"
          go={vi.fn()}
          refresh={vi.fn()}
        />
      </DetailCrumbContext.Provider>,
    );
    expect(setCrumb).toHaveBeenCalledWith("REQ-2026-0047");
  });

  it("detailCrumbLabel: el consecutivo declarado gana; un UUID nunca se muestra; un consecutivo en la URL (demo) sí", () => {
    expect(detailCrumbLabel(UUID, "REQ-2026-0047", "Revisión")).toBe("REQ-2026-0047");
    expect(detailCrumbLabel(UUID, null, "Revisión")).toBe("Revisión");
    expect(detailCrumbLabel("REQ-2026-0001", null, "Revisión")).toBe("REQ-2026-0001");
    expect(detailCrumbLabel("", null, "Requisición")).toBe("Requisición");
  });
});
