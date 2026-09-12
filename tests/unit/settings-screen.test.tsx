// @vitest-environment jsdom

// RF-1401 ("en Configuración todavía no lo tenemos listo", 11-sep-2026): cubre el gate de rol (la
// razón de ser de esta pantalla — antes cualquiera con la URL veía un Placeholder inofensivo, ahora
// hay controles reales que NO deben llegar a un rol sin permiso), el enlace del portal público con
// su botón de copiar, y que la contraseña temporal use el endpoint existente
// (POST /api/usuarios/:id/clave) con el body exacto que ese endpoint espera.
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsScreen } from "../../components/screens/settings";

const userId = "11111111-1111-4111-8111-111111111111";

const publicAccessResponse = (configured = true) =>
  new Response(JSON.stringify({ configured, updatedAt: configured ? "2026-09-01T10:00:00.000Z" : null }), {
    status: 200,
  });

const manageResponse = (canManage: boolean) =>
  new Response(
    JSON.stringify({
      userRecords: [
        {
          id: userId,
          name: "Daniel Hernández",
          email: "daniel@mizar.local",
          phone: "3001112233",
          active: true,
          roles: ["revisor"],
        },
      ],
      canReadUsers: true,
      access: { users: canManage },
    }),
    { status: 200 },
  );

const healthResponse = () =>
  new Response(JSON.stringify({ components: { kapso: true }, whatsapp_fallidos_24h: 0 }), { status: 200 });

function mockFetch(canManage: boolean) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/public-access") return Promise.resolve(publicAccessResponse());
    if (url === "/api/catalogs/manage") return Promise.resolve(manageResponse(canManage));
    if (url === "/api/health") return Promise.resolve(healthResponse());
    if (url === `/api/usuarios/${userId}/clave`) return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    return Promise.reject(new Error(`fetch no esperado en la prueba: ${url}`));
  });
}

describe("SettingsScreen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });
  afterEach(() => cleanup());

  it("niega el acceso a un rol sin permiso y no consulta ningún endpoint", () => {
    const fetchMock = mockFetch(true);
    render(<SettingsScreen role="Revisor" go={vi.fn()} />);
    expect(screen.getByText("Sin acceso con este rol")).toBeInTheDocument();
    expect(screen.queryByText("Acceso público")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Administrador Mizar ve la pantalla completa, en modo lectura para usuarios", async () => {
    mockFetch(false);
    render(<SettingsScreen role="Administrador Mizar" go={vi.fn()} />);
    expect(await screen.findByText("Daniel Hernández")).toBeInTheDocument();
    // canManage=false (access.users): ni el botón de restablecer contraseña ni el de activar/desactivar.
    expect(screen.queryByRole("button", { name: /Asignar contraseña temporal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Editar teléfono/i })).toBeNull();
  });

  it("copia el enlace único del portal al portapapeles", async () => {
    mockFetch(true);
    render(<SettingsScreen role="Administrador Sixteam" go={vi.fn()} />);
    await screen.findByLabelText("Enlace del portal público");
    fireEvent.click(screen.getByRole("button", { name: /Copiar/i }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        expect.stringContaining("/requisiciones/publica"),
      ),
    );
    expect(await screen.findByText("Copiado")).toBeInTheDocument();
  });

  it("asigna una contraseña temporal usando POST /api/usuarios/:id/clave", async () => {
    const fetchMock = mockFetch(true);
    render(<SettingsScreen role="Administrador Sixteam" go={vi.fn()} />);
    await screen.findByText("Daniel Hernández");
    fireEvent.click(screen.getByRole("button", { name: /Asignar contraseña temporal a Daniel Hernández/i }));
    const passwordInput = screen.getByLabelText(/Contraseña temporal para Daniel Hernández/i);
    fireEvent.change(passwordInput, { target: { value: "clave-temporal-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Asignar" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/usuarios/${userId}/clave`,
        expect.objectContaining({ method: "POST", body: JSON.stringify({ password: "clave-temporal-1" }) }),
      ),
    );
    expect(await screen.findByText(/Contraseña temporal asignada/i)).toBeInTheDocument();
  });

  it("navega a Catálogos y a Mensajes de WhatsApp con los accesos directos", async () => {
    mockFetch(true);
    const go = vi.fn();
    render(<SettingsScreen role="Administrador Sixteam" go={go} />);
    await screen.findByText("Daniel Hernández");
    fireEvent.click(screen.getByRole("button", { name: "Ver en Catálogos" }));
    expect(go).toHaveBeenCalledWith("/catalogos/usuarios");
    fireEvent.click(screen.getByRole("button", { name: /Mensajes de WhatsApp/i }));
    expect(go).toHaveBeenCalledWith("/mensajes");
    fireEvent.click(screen.getByRole("button", { name: /^Empresas/ }));
    expect(go).toHaveBeenCalledWith("/catalogos/sociedades");
  });
});
