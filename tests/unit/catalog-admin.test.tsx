// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectedCatalogAdmin } from "../../components/screens/catalog-admin";

const societyId = "11111111-1111-4111-8111-111111111111";
const approverId = "22222222-2222-4222-8222-222222222222";

function catalogData(overrides: Record<string, unknown> = {}) {
  return {
    works: [],
    tags: [],
    suppliers: [],
    items: [],
    features: { catalogos_admin_mizar: true },
    societies: [{ id: societyId, name: "Sociedad Norte" }],
    approvers: [{ id: approverId, name: "Daniel Revisor" }],
    access: { works: true, tags: true, items: true, suppliers: true },
    ...overrides,
  };
}

describe("ConnectedCatalogAdmin", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => cleanup());

  it("shows a gate when the requested catalog is not authorized", () => {
    render(
      <ConnectedCatalogAdmin
        pathname="/catalogos/obras"
        role="Administrador Mizar"
        initialData={catalogData({
          features: { catalogos_admin_mizar: false },
          access: { works: false, tags: false, items: false, suppliers: false },
        })}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Gestión bloqueada");
    expect(
      screen.queryByRole("button", { name: /Nuevo registro/i }),
    ).toBeNull();
  });

  it("normalizes a pending proposal through reversible activation", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "item-1", active: true, status: "activo" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    render(
      <ConnectedCatalogAdmin
        pathname="/catalogos/items"
        role="Administrador Sixteam"
        initialData={catalogData({
          items: [
            {
              id: "item-1",
              name: "Propuesta de cemento",
              unit: "bulto",
              status: "pendiente_normalizacion",
              active: false,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Pendiente de normalización")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Normalizar Propuesta de cemento" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Propuesta normalizada y activada",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/catalogs",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          kind: "items",
          id: "item-1",
          data: { active: true },
        }),
      }),
    );
  });

  it("submits a tag with an eligible approver id", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ id: "tag-1", name: "Urgente", approverId }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    render(
      <ConnectedCatalogAdmin
        pathname="/catalogos/etiquetas"
        role="Administrador Sixteam"
        initialData={catalogData()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
      target: { value: "Urgente" },
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: /Aprobador elegible/i }),
      {
        target: { value: approverId },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          kind: "tags",
          data: { name: "Urgente", approverId },
        }),
      }),
    );
  });

  it("requires an approver before creating a tag", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <ConnectedCatalogAdmin
        pathname="/catalogos/etiquetas"
        role="Administrador Sixteam"
        initialData={catalogData()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
    fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
      target: { value: "Sin aprobador" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("combobox", { name: /Aprobador elegible/i }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Selecciona un aprobador elegible",
    );
  });

  it("sends null for cleared optional fields when editing", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "item-1",
          name: "Arena",
          unit: "saco",
          active: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(
      <ConnectedCatalogAdmin
        pathname="/catalogos/items"
        role="Administrador Sixteam"
        initialData={catalogData({
          items: [
            {
              id: "item-1",
              name: "Arena",
              unit: "saco",
              specification: "lavada",
              category: "material",
              active: true,
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Editar Arena" }));
    fireEvent.change(screen.getByRole("textbox", { name: /Especificación/i }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Categoría/i }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          kind: "items",
          id: "item-1",
          data: {
            name: "Arena",
            unit: "saco",
            specification: null,
            category: null,
          },
        }),
      }),
    );
  });
});
