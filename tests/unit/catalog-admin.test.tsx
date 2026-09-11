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
const authUserId = "33333333-3333-4333-8333-333333333333";

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

// GRAVE (QA Postgres real): PublicAccessPanel ahora pinta un role="alert" PROMINENTE cuando el portal
// no tiene contraseña configurada (el aviso de "portal cerrado", ver el componente). El default de
// este mock era `configured: false`, así que CUALQUIER prueba de este archivo que esperara un único
// role="alert" (o ninguno) empezaba a competir con ese banner en cuanto el GET de /api/public-access
// resolvía. Como ninguna prueba de este archivo ejercita el panel de acceso público en sí (eso vive en
// tests/unit/public-access-service.test.ts, tests/unit/public-access-route.test.ts y
// tests/unit/public-access.test.ts), el default pasa a `configured: true` — sin alerta — y el caso
// "portal cerrado" tiene su propia prueba dedicada más abajo con su propio mock.
function publicAccessStatusResponse(configured = true): Response {
  return new Response(
    JSON.stringify({ configured, updatedAt: configured ? "2026-09-01T12:00:00.000Z" : null }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * ConnectedCatalogAdmin ahora también monta PublicAccessPanel (pestaña "Acceso público", contraseña
 * GLOBAL del portal público — ver migración 202609070002_acceso_publico_global.sql) para roles
 * admin_mizar/admin_sixteam: ese panel hace su propio GET a /api/public-access al montar. Sin este
 * enrutador esa llamada se colaría en el fetchMock genérico de cada prueba de catálogos (pensado solo
 * para /api/catalogs, escrito antes de que existiera esa pestaña) y rompería sus aserciones de conteo.
 * Cuando `catalogsResponse` se omite, una llamada a /api/catalogs se rechaza — reproduce el
 * comportamiento de las pruebas "no debería llamarse a fetch" de antes de este panel.
 */
function mockFetch(catalogsResponse?: Response, publicAccessConfigured = true) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url === "/api/public-access") return Promise.resolve(publicAccessStatusResponse(publicAccessConfigured));
    return catalogsResponse ? Promise.resolve(catalogsResponse) : Promise.reject(new Error(`unexpected fetch(${url}) in this test`));
  });
}

/** Aísla las llamadas a /api/catalogs entre el ruido del GET automático de PublicAccessPanel. */
function catalogsCalls(fetchMock: { mock: { calls: unknown[][] } }): unknown[][] {
  return fetchMock.mock.calls.filter((call) => call[0] === "/api/catalogs");
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
          // RF-002/RF-004: sociedades/usuarios también deben excluirse explícitamente aquí; de lo
          // contrario "societies" cae al valor por defecto de canManageKind (admin_mizar siempre
          // puede) y la pestaña seleccionada automáticamente deja de ser la que este caso prueba.
          access: {
            works: false,
            tags: false,
            items: false,
            suppliers: false,
            societies: false,
            users: false,
          },
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
    const fetchMock = mockFetch(
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

    await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
    expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
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
    const fetchMock = mockFetch();
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

    expect(catalogsCalls(fetchMock)).toHaveLength(0);
    expect(
      screen.getByRole("combobox", { name: /Aprobador elegible/i }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Selecciona un aprobador elegible",
    );
  });

  it("sends null for cleared optional fields when editing", async () => {
    const fetchMock = mockFetch(
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

    await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
    expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
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

  describe("RF-002: pestaña de Sociedades", () => {
    it("lets Administrador Mizar manage sociedades unconditionally, even with catalogos_admin_mizar disabled", () => {
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/sociedades"
          role="Administrador Mizar"
          initialData={catalogData({
            features: { catalogos_admin_mizar: false },
            societyRecords: [
              { id: societyId, name: "Sociedad Norte", nit: "900123456", active: true },
            ],
          })}
        />,
      );
      expect(screen.queryByRole("alert")).toBeNull();
      expect(
        screen.getByRole("button", { name: /Nuevo registro/i }),
      ).toBeInTheDocument();
      expect(screen.getByText("Sociedad Norte")).toBeInTheDocument();
    });

    it("creates a society with an optional NIT", async () => {
      const fetchMock = mockFetch(
        new Response(
          JSON.stringify({ id: "society-1", name: "Sociedad Sur", nit: "900999888", active: true }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/sociedades"
          role="Administrador Sixteam"
          initialData={catalogData({ societyRecords: [] })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
        target: { value: "Sociedad Sur" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: /^NIT/i }), {
        target: { value: "900999888" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

      await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
      expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            kind: "societies",
            data: { name: "Sociedad Sur", nit: "900999888" },
          }),
        }),
      );
    });
  });

  describe("RF-004: pestaña de Usuarios", () => {
    it("blocks the tab entirely for a role with neither read nor manage access", () => {
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/items"
          role="Revisor"
          initialData={catalogData({ access: { items: true } })}
        />,
      );
      expect(
        screen.getByRole("tab", { name: /Usuarios/ }),
      ).toBeDisabled();
    });

    it("shows Administrador Mizar a read-only Usuarios table: no create button and no edit/toggle actions", () => {
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/usuarios"
          role="Administrador Mizar"
          initialData={catalogData({
            canReadUsers: true,
            userRecords: [
              {
                id: authUserId,
                name: "Nelson Aprobador",
                email: "nelson@mizar.test",
                active: true,
                roles: ["aprobador"],
              },
            ],
          })}
        />,
      );
      expect(screen.getByText("Nelson Aprobador")).toBeInTheDocument();
      expect(screen.getByText("Aprobador")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Nuevo registro/i }),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Editar Nelson Aprobador/i }),
      ).toBeNull();
      expect(screen.getByText("Solo lectura")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(
        "administración de usuarios es exclusiva",
      );
    });

    it("creates the access account with name, initial password, email and at least one role", async () => {
      const fetchMock = mockFetch(
        new Response(
          JSON.stringify({
            id: authUserId,
            name: "Nueva Revisora",
            email: "revisora@mizar.test",
            active: true,
            roles: ["revisor"],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/usuarios"
          role="Administrador Sixteam"
          initialData={catalogData({ canReadUsers: true, userRecords: [] })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
        target: { value: "Nueva Revisora" },
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: /Contraseña inicial/i }),
        { target: { value: "clave-inicial-123" } },
      );
      fireEvent.change(screen.getByRole("textbox", { name: /^Correo/i }), {
        target: { value: "revisora@mizar.test" },
      });
      fireEvent.click(screen.getByRole("checkbox", { name: "Revisor" }));
      fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

      await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
      expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            kind: "users",
            data: {
              name: "Nueva Revisora",
              password: "clave-inicial-123",
              email: "revisora@mizar.test",
              roles: ["revisor"],
            },
          }),
        }),
      );
    });

    it("requires selecting at least one role before creating a user", () => {
      const fetchMock = mockFetch();
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/usuarios"
          role="Administrador Sixteam"
          initialData={catalogData({ canReadUsers: true, userRecords: [] })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
        target: { value: "Sin Rol" },
      });
      fireEvent.change(
        screen.getByRole("textbox", { name: /Contraseña inicial/i }),
        { target: { value: "clave-inicial-123" } },
      );
      fireEvent.change(screen.getByRole("textbox", { name: /^Correo/i }), {
        target: { value: "sinrol@mizar.test" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

      expect(catalogsCalls(fetchMock)).toHaveLength(0);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Selecciona al menos un rol",
      );
    });
  });

  // HUECO 1 (reunión 2026-08-31, QA): CRUD de solicitantes autorizados por WhatsApp.
  describe("HUECO 1: pestaña de Solicitantes WhatsApp", () => {
    it("permite consultar en modo lectura a Revisor (sin botón de alta ni acciones)", () => {
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/solicitantes-whatsapp"
          role="Revisor"
          initialData={catalogData({
            canReadRequesters: true,
            requesters: [
              { id: "req-1", name: "Maestro Pérez", phone: "+573001112233", active: true },
            ],
          })}
        />,
      );
      expect(screen.getByText("Maestro Pérez")).toBeInTheDocument();
      expect(screen.getByText("+573001112233")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Nuevo registro/i }),
      ).toBeNull();
      expect(screen.getByText("Solo lectura")).toBeInTheDocument();
      expect(screen.getByRole("note")).toHaveTextContent(
        "quién puede pedir por WhatsApp",
      );
    });

    it("blocks the tab entirely for a role with neither read nor manage access", () => {
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/items"
          role="Aprobador"
          initialData={catalogData({ access: { items: true } })}
        />,
      );
      expect(
        screen.getByRole("tab", { name: /Solicitantes WhatsApp/ }),
      ).toBeDisabled();
    });

    it("creates an authorized requester with name and phone", async () => {
      const fetchMock = mockFetch(
        new Response(
          JSON.stringify({ id: "req-1", name: "Maestro Gómez", phone: "3001112233", active: true }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/solicitantes-whatsapp"
          role="Administrador Sixteam"
          initialData={catalogData({ canReadRequesters: true, requesters: [] })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
        target: { value: "Maestro Gómez" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: /Teléfono/i }), {
        target: { value: "3001112233" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

      await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
      expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            kind: "requesters",
            data: { name: "Maestro Gómez", phone: "3001112233" },
          }),
        }),
      );
    });

    it("requires a phone number before creating an authorized requester", () => {
      const fetchMock = mockFetch();
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/solicitantes-whatsapp"
          role="Administrador Sixteam"
          initialData={catalogData({ canReadRequesters: true, requesters: [] })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: /Nuevo registro/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /^Nombre/ }), {
        target: { value: "Sin teléfono" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Crear registro" }));

      expect(catalogsCalls(fetchMock)).toHaveLength(0);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "El teléfono es obligatorio",
      );
    });

    it("deactivates a requester reversibly (logical deactivation, not deletion)", async () => {
      const fetchMock = mockFetch(
        new Response(JSON.stringify({ id: "req-1", active: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/solicitantes-whatsapp"
          role="Administrador Sixteam"
          initialData={catalogData({
            canReadRequesters: true,
            requesters: [
              { id: "req-1", name: "Maestro Pérez", phone: "+573001112233", active: true },
            ],
          })}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Desactivar Maestro Pérez" }));

      await waitFor(() => expect(catalogsCalls(fetchMock)).toHaveLength(1));
      expect(catalogsCalls(fetchMock)[0]?.[1]).toEqual(
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            kind: "requesters",
            id: "req-1",
            data: { active: false },
          }),
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("status")).toHaveTextContent(
          "desactivado de forma reversible",
        ),
      );
      expect(screen.getByText("Inactivo")).toBeInTheDocument();
    });
  });

  describe("Acceso público — portal cerrado (GRAVE, QA Postgres real)", () => {
    it("muestra un role=\"alert\" prominente cuando no hay contraseña configurada", async () => {
      mockFetch(undefined, false);
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/etiquetas"
          role="Administrador Sixteam"
          initialData={catalogData()}
        />,
      );

      const alert = await waitFor(() => screen.getByRole("alert"));
      expect(alert).toHaveTextContent("El portal de requisiciones está cerrado");
      expect(alert).toHaveTextContent("Nadie puede radicar por el enlace hasta que la fijes");
    });

    it("no muestra la alerta cuando la contraseña ya está configurada", async () => {
      mockFetch(undefined, true);
      render(
        <ConnectedCatalogAdmin
          pathname="/catalogos/etiquetas"
          role="Administrador Sixteam"
          initialData={catalogData()}
        />,
      );

      await waitFor(() =>
        expect(screen.getByText(/Contraseña configurada/)).toBeInTheDocument(),
      );
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
