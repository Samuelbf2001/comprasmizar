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

// «Permisos por rol» (decisión de Ernesto, 2026-09-17): el catálogo, los defaults y el permiso
// bloqueado los manda el servidor — la pantalla no conoce ninguna regla, así que la prueba se apoya
// en un payload mínimo con los dos roles y los dos permisos que hacen falta para ver el mecanismo.
const permissionsPayload = (overrides: Record<string, string[]> = {}) => ({
  roles: [{ key: "contabilidad", label: "Contabilidad" }, { key: "admin_sixteam", label: "Administrador Sixteam" }],
  permissions: [
    { key: "payment:register", label: "Registrar y anular pagos", group: "Órdenes y pagos" },
    { key: "config:manage", label: "Configurar la plataforma", group: "Catálogos y administración" },
  ],
  defaults: { contabilidad: [], admin_sixteam: ["*"] },
  effective: { contabilidad: overrides.contabilidad ?? [], admin_sixteam: overrides.admin_sixteam ?? ["*"] },
  overridden: Object.keys(overrides),
  lockedPermission: "config:manage",
});

function mockFetch(canManage: boolean, onPermissionsPut?: (body: unknown) => void) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/public-access") return Promise.resolve(publicAccessResponse());
    if (url === "/api/catalogs/manage") return Promise.resolve(manageResponse(canManage));
    if (url === "/api/health") return Promise.resolve(healthResponse());
    if (url === "/api/config/permissions") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { overrides: Record<string, string[]> };
        onPermissionsPut?.(body);
        return Promise.resolve(new Response(JSON.stringify(permissionsPayload(body.overrides)), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify(permissionsPayload()), { status: 200 }));
    }
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

// DECISIÓN DE ERNESTO (2026-09-17): los permisos por rol se editan aquí, y SOLO Administrador Sixteam
// los ve. La pantalla manda únicamente los roles que difieren del default (así «Restaurar valores por
// defecto» devuelve también los cambios futuros de rules.ts en vez de congelar una copia).
describe("SettingsScreen — Permisos por rol", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => cleanup());

  it("Administrador Mizar no ve la sección ni consulta su endpoint", async () => {
    mockFetch(false);
    render(<SettingsScreen role="Administrador Mizar" go={vi.fn()} />);
    await screen.findByText("Daniel Hernández");
    expect(screen.queryByRole("heading", { name: "Permisos por rol" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Guardar permisos" })).toBeNull();
  });

  it("marca lo vigente, señala lo distinto del default y guarda solo los roles que cambian", async () => {
    const enviados: unknown[] = [];
    mockFetch(true, (body) => enviados.push(body));
    render(<SettingsScreen role="Administrador Sixteam" go={vi.fn()} />);
    const casilla = await screen.findByRole("checkbox", { name: "Registrar y anular pagos — Contabilidad" });
    expect(casilla).not.toBeChecked();
    // El comodín de Administrador Sixteam se ve como "todo marcado".
    expect(screen.getByRole("checkbox", { name: "Registrar y anular pagos — Administrador Sixteam" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Guardar permisos" })).toBeDisabled();
    fireEvent.click(casilla);
    expect(casilla).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Guardar permisos" }));
    await waitFor(() => expect(enviados).toHaveLength(1));
    expect(enviados[0]).toEqual({ overrides: { contabilidad: ["payment:register"] } });
    expect(await screen.findByText(/Permisos guardados/)).toBeInTheDocument();
  });

  it("no deja desmarcar «Configurar la plataforma» a Administrador Sixteam (candado anti-pie)", async () => {
    mockFetch(true);
    render(<SettingsScreen role="Administrador Sixteam" go={vi.fn()} />);
    const bloqueada = await screen.findByRole("checkbox", { name: "Configurar la plataforma — Administrador Sixteam" });
    expect(bloqueada).toBeDisabled();
    expect(bloqueada).toBeChecked();
  });

  it("«Restaurar valores por defecto» vuelve a dejar el rol sin excepción", async () => {
    const enviados: unknown[] = [];
    mockFetch(true, (body) => enviados.push(body));
    render(<SettingsScreen role="Administrador Sixteam" go={vi.fn()} />);
    const casilla = await screen.findByRole("checkbox", { name: "Registrar y anular pagos — Contabilidad" });
    fireEvent.click(casilla);
    const [restaurarContabilidad] = screen.getAllByRole("button", { name: "Restaurar valores por defecto" });
    expect(restaurarContabilidad).toBeEnabled();
    fireEvent.click(restaurarContabilidad);
    expect(casilla).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Guardar permisos" })).toBeDisabled();
    expect(enviados).toHaveLength(0);
  });
});
