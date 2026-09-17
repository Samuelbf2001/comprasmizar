import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DECISIÓN DE ERNESTO (2026-09-17): «que los permisos no estén hardcodeados: que se puedan editar».
// El default vive en lib/domain/rules.ts; el override en `configuracion.permisos_por_rol_v1`. Este
// archivo cubre las dos piezas que el dominio no puede: el servicio que valida/audita el guardado, y
// el cargador de infraestructura que cachea el override y se lo cuelga al actor.
//
// Mismo patrón de mocks que tests/unit/server-actor.test.ts: se sustituye `sharedPostgres` para
// probar SOLO esta capa, sin Postgres real.
const mocks = vi.hoisted(() => ({ rows: [] as unknown[], calls: 0, error: null as Error | null }));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  sharedPostgres: () => (...sqlArgs: unknown[]) => {
    void sqlArgs;
    mocks.calls++;
    if (mocks.error) return Promise.reject(mocks.error);
    return Promise.resolve(mocks.rows);
  },
  PostgresPorts: class {},
}));

import { DEFAULT_ROLE_PERMISSIONS, DomainError, hasPermission, resolveActorPermissions, type Actor, type AuditEvent, type RolePermissionOverrides } from "../../lib/domain";
import { RolePermissionsService, type RolePermissionsRepository } from "../../lib/services";
import { invalidateRolePermissionsCache, loadRolePermissionOverrides, withEffectivePermissions } from "../../lib/infrastructure/role-permissions";

const admin: Actor = { id: "root", roles: ["admin_sixteam"], permissions: resolveActorPermissions(["admin_sixteam"]) };
const conta: Actor = { id: "cont", roles: ["contabilidad"], permissions: resolveActorPermissions(["contabilidad"]) };

function fakeRepository(initial: RolePermissionOverrides = {}) {
  const state = { overrides: initial, audits: [] as AuditEvent[], actorIds: [] as string[] };
  const repository: RolePermissionsRepository = {
    get: async () => state.overrides,
    save: async (overrides, actorId, audit) => { state.overrides = overrides; state.actorIds.push(actorId); state.audits.push(audit); },
  };
  return { repository, state };
}
const service = (repository: RolePermissionsRepository) => new RolePermissionsService({ repository, clock: { now: () => new Date("2026-09-17T12:00:00.000Z") } });

/** Entorno mínimo que exige `runtimeEnv()` al resolver la URL de la base por defecto. */
const CORE_ENV = { DATABASE_URL: "postgres://u:p@localhost:5432/db", STORAGE_ROOT: "/tmp/mizar", STORAGE_SIGNING_SECRET: "s".repeat(32) };
const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [key, value] of Object.entries(CORE_ENV)) { savedEnv[key] = process.env[key]; process.env[key] = value; }
  mocks.rows = []; mocks.calls = 0; mocks.error = null; invalidateRolePermissionsCache();
});
afterEach(() => { for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe("RolePermissionsService", () => {
  it("exige config:manage: solo admin_sixteam entra a la pantalla y guarda", async () => {
    const { repository } = fakeRepository();
    await expect(service(repository).getSettings(conta)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service(repository).save(conta, { revisor: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service(repository).getSettings(admin)).resolves.toMatchObject({ lockedPermission: "config:manage" });
  });
  it("devuelve defaults, lo efectivo y qué roles tienen override", async () => {
    const { repository } = fakeRepository({ contabilidad: ["order:read", "payment:register"] });
    const settings = await service(repository).getSettings(admin);
    expect(settings.defaults.contabilidad).toEqual(DEFAULT_ROLE_PERMISSIONS.contabilidad);
    expect(settings.effective.contabilidad).toEqual(["order:read", "payment:register"]);
    expect(settings.effective.revisor).toEqual(DEFAULT_ROLE_PERMISSIONS.revisor); // rol sin override: su default
    expect(settings.overridden).toEqual(["contabilidad"]);
    expect(settings.roles.map((role) => role.key)).toContain("admin_sixteam");
    expect(settings.permissions.find((permission) => permission.key === "payment:register")?.label).toBe("Registrar y anular pagos");
  });
  it("guarda con auditoría de quién, con qué rol y el antes/después", async () => {
    const { repository, state } = fakeRepository({ revisor: ["order:read"] });
    await service(repository).save(admin, { contabilidad: ["payment:register"] });
    expect(state.overrides).toEqual({ contabilidad: ["payment:register"] });
    expect(state.actorIds).toEqual(["root"]);
    expect(state.audits[0]).toMatchObject({
      entity: "configuracion", event: "permisos_por_rol_actualizados", actorId: "root", origin: "web",
      data: { roles: ["admin_sixteam"], antes: { revisor: ["order:read"] }, despues: { contabilidad: ["payment:register"] } },
    });
    // `auditoria.entidad_id` es uuid: escribir aquí la clave de configuración sería un 22P02 y un 500
    // con el cambio ya guardado (el fallo que vivió el endpoint de acceso público).
    expect(state.audits[0].entityId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("«Restaurar valores por defecto» es quitar la clave del rol, no congelar una copia del default", async () => {
    const { repository, state } = fakeRepository({ contabilidad: ["payment:register"], revisor: ["order:read"] });
    const settings = await service(repository).save(admin, { revisor: ["order:read"] });
    expect(state.overrides).toEqual({ revisor: ["order:read"] });
    expect(settings.effective.contabilidad).toEqual(DEFAULT_ROLE_PERMISSIONS.contabilidad);
    expect(settings.overridden).toEqual(["revisor"]);
  });
  it("no guarda nada si el override es inválido o dejaría a admin_sixteam sin config:manage", async () => {
    const { repository, state } = fakeRepository();
    await expect(service(repository).save(admin, { admin_sixteam: ["order:read"] })).rejects.toThrow(DomainError);
    await expect(service(repository).save(admin, { revisor: ["no-existe"] })).rejects.toThrow(DomainError);
    expect(state.audits).toHaveLength(0);
    expect(state.overrides).toEqual({});
  });
});

describe("carga del override (infraestructura)", () => {
  it("sin fila en configuracion son los defaults, y el actor sale con su lista efectiva", async () => {
    const actor = await withEffectivePermissions({ id: "cont", roles: ["contabilidad"] as const });
    expect(hasPermission(actor, "payment:register")).toBe(false);
    expect(hasPermission(actor, "order:account")).toBe(true);
  });
  it("con override, el actor llega con lo que el administrador decidió", async () => {
    mocks.rows = [{ valor: { contabilidad: ["order:read", "payment:register"] } }];
    const actor = await withEffectivePermissions({ id: "cont", roles: ["contabilidad"] as const });
    expect(hasPermission(actor, "payment:register")).toBe(true);
    expect(hasPermission(actor, "expense:read")).toBe(false); // el override REEMPLAZA la lista del rol
  });
  it("una fila corrupta se ignora y se sigue con los defaults, en vez de dejar a medio mundo sin permisos", async () => {
    mocks.rows = [{ valor: { contabilidad: ["permiso:inventado"] } }];
    expect(await loadRolePermissionOverrides()).toEqual({});
    invalidateRolePermissionsCache();
    mocks.rows = [{ valor: ["no", "es", "un", "objeto"] }];
    expect(await loadRolePermissionOverrides()).toEqual({});
  });
  it("una consulta caída no tumba la autenticación: el actor sale con defaults", async () => {
    mocks.error = new Error("conexión perdida");
    const actor = await withEffectivePermissions({ id: "daniel", roles: ["revisor"] as const });
    expect(hasPermission(actor, "payment:register")).toBe(true);
  });
  it("se cachea: una consulta por ventana, no una por comprobación de permiso", async () => {
    mocks.rows = [{ valor: { revisor: ["order:read"] } }];
    await loadRolePermissionOverrides();
    await loadRolePermissionOverrides();
    await withEffectivePermissions({ id: "daniel", roles: ["revisor"] as const });
    expect(mocks.calls).toBe(1);
    // Guardar desde la pantalla invalida el caché: el cambio no espera al TTL.
    invalidateRolePermissionsCache();
    await loadRolePermissionOverrides();
    expect(mocks.calls).toBe(2);
  });
});
