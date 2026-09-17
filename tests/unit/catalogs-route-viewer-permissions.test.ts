import { beforeEach, describe, expect, it, vi } from "vitest";

// DECISIÓN DE ERNESTO (2026-09-17): la interfaz decide por permiso efectivo, y los permisos le llegan
// en ESTE bootstrap — el único GET que piden todas las rutas conectadas (components/screens/connected/
// data.ts). `/api/orders` y `/api/expenses` responden un array y no tienen dónde colgarlos, así que si
// esta respuesta deja de traerlos, la UI entera vuelve a decidir por nombre de rol sin que nada falle.
// Mismo patrón de mocks que tests/unit/requisitions-route-viewer-id.test.ts.
const mocks = vi.hoisted(() => ({
  actor: { id: "actor-1", roles: ["contabilidad"] as string[], permissions: [] as string[] },
  overrides: {} as Record<string, string[]>,
}));

vi.mock("../../lib/infrastructure/auth", () => ({
  requireServerActor: async () => mocks.actor,
}));
vi.mock("../../lib/security/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/security/env")>()),
  runtimeEnv: () => ({ DATABASE_URL: "postgres://mock" }),
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  // Cualquier `sql\`…\`` de la ruta resuelve en una lista vacía: aquí solo importan los permisos.
  sharedPostgres: () => async () => [],
  createPostgresDependencies: () => ({}),
}));
vi.mock("../../lib/infrastructure/role-permissions", () => ({
  loadRolePermissionOverrides: async () => mocks.overrides,
}));

import { GET } from "../../app/api/catalogs/route";
import { DEFAULT_ROLE_PERMISSIONS } from "../../lib/domain/rules";

type Body = { viewerPermissions?: string[]; rolePermissions?: Record<string, string[]> };

describe("GET /api/catalogs — permisos efectivos para la interfaz", () => {
  beforeEach(() => {
    mocks.actor = { id: "actor-1", roles: ["contabilidad"], permissions: [...DEFAULT_ROLE_PERMISSIONS.contabilidad, "payment:register"] };
    mocks.overrides = {};
  });

  it("devuelve la lista EFECTIVA del visor (override ya aplicado por requireServerActor)", async () => {
    const body = (await (await GET()).json()) as Body;
    expect(body.viewerPermissions).toContain("payment:register");
    expect(body.viewerPermissions).toContain("order:account");
  });

  it("no le manda la matriz por rol a quien no puede editarla (no tiene la lente «Ver como»)", async () => {
    const body = (await (await GET()).json()) as Body;
    expect(body.rolePermissions).toBeUndefined();
  });

  it("y a quien tiene «config:manage» le manda la matriz vigente, con el override aplicado", async () => {
    mocks.actor = { id: "admin-1", roles: ["admin_sixteam"], permissions: ["*"] };
    mocks.overrides = { contabilidad: [...DEFAULT_ROLE_PERMISSIONS.contabilidad, "payment:register"] };
    const body = (await (await GET()).json()) as Body;
    expect(body.rolePermissions?.contabilidad).toContain("payment:register");
    // Un rol sin override conserva su valor por defecto: es lo que la lente debe pintar.
    expect(body.rolePermissions?.aprobador).toEqual([...DEFAULT_ROLE_PERMISSIONS.aprobador]);
  });
});
