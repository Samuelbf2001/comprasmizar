import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// H1 (docs/plan-rendimiento.md): requireServerActor() hace UNA sola consulta SQL de perfil por
// `sharedPostgres()`, cacheada 60 s por userId (lib/infrastructure/actor-cache.ts).
//
// Migración a autoalojado (2026-09-10): la verificación de identidad ya no es `getClaims()` contra
// Supabase Auth sino la sesión propia — cookie opaca resuelta contra `public.sesiones`
// (lib/infrastructure/local-auth.ts). Lo que esta prueba vigila NO cambió: que la sesión se
// verifique en CADA llamada (es lo que hace efectivo un cierre de sesión o una baja) y que el perfil
// de negocio se consulte una sola vez por ventana de caché.
//
// Mismo patrón de mocks que tests/unit/public-access-route.test.ts: se sustituyen la cookie, la
// verificación de sesión y `sharedPostgres` para probar SOLO esta capa, sin Postgres real.
const mocks = vi.hoisted(() => ({
  cookieValue: undefined as string | undefined,
  sessionUserId: null as string | null,
  sessionError: null as Error | null,
  sessionCalls: 0,
  sqlRows: [] as unknown[],
  sqlCalls: 0,
  sqlError: null as Error | null,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "mizar_sesion" && mocks.cookieValue ? { value: mocks.cookieValue } : undefined) }),
}));
vi.mock("../../lib/infrastructure/local-auth", () => ({
  SESSION_COOKIE: "mizar_sesion",
  verifySession: async () => {
    mocks.sessionCalls++;
    if (mocks.sessionError) throw mocks.sessionError;
    return mocks.sessionUserId;
  },
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  // La consulta real no importa aquí (se prueba en tests/unit/actor-cache.test.ts y contra Postgres en
  // los adaptadores) — solo se cuenta cuántas veces se llamó, para verificar el caché de 60 s.
  sharedPostgres: () => (...sqlArgs: unknown[]) => {
    void sqlArgs;
    mocks.sqlCalls++;
    if (mocks.sqlError) return Promise.reject(mocks.sqlError);
    return Promise.resolve(mocks.sqlRows);
  },
}));

// El override de permisos por rol (decisión de Ernesto, 2026-09-17) tiene su propia consulta y su
// propio caché, con sus pruebas en tests/unit/role-permissions.test.ts. Aquí se sustituye por la
// resolución pura contra los defaults: esta prueba cuenta consultas de PERFIL, y mezclar las dos
// haría que el contador dijera cosas sobre una caché que no es la que vigila.
vi.mock("../../lib/infrastructure/role-permissions", () => ({
  withEffectivePermissions: async (actor: { roles: Role[] }) => ({ ...actor, permissions: resolveActorPermissions(actor.roles) }),
}));

import { requireServerActor } from "../../lib/infrastructure/auth";
import { invalidateActorCache } from "../../lib/infrastructure/actor-cache";
import { resolveActorPermissions, type Role } from "../../lib/domain";

/** Deja una sesión válida para `sub`: cookie presente y verifySession que la resuelve a ese usuario. */
const sessionFor = (sub: string) => { mocks.cookieValue = `token-de-${sub}`; mocks.sessionUserId = sub; };
const activeRow = (roles: string[]) => ({ estado: "activo", nombre: "Ana", email: "ana@mizar.test", roles });

/** Entorno mínimo que exige `runtimeEnv()`. auth.ts lo valida antes de mirar la cookie (ver abajo). */
const CORE_ENV = { DATABASE_URL: "postgres://u:p@localhost:5432/db", STORAGE_ROOT: "/tmp/mizar", STORAGE_SIGNING_SECRET: "s".repeat(32) };
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [key, value] of Object.entries(CORE_ENV)) { savedEnv[key] = process.env[key]; process.env[key] = value; }
  mocks.cookieValue = undefined;
  mocks.sessionUserId = null;
  mocks.sessionError = null;
  mocks.sessionCalls = 0;
  mocks.sqlRows = [];
  mocks.sqlCalls = 0;
  mocks.sqlError = null;
  invalidateActorCache(); // el caché de perfil es un módulo real (no mockeado): se limpia entre tests
});
afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

describe("requireServerActor — sesión propia + una sola consulta SQL cacheada (H1)", () => {
  it("sesión válida + usuario activo con roles reconocidos -> actor", async () => {
    sessionFor("user-1");
    mocks.sqlRows = [activeRow(["revisor", "solicitante"])];
    // `permissions` es la lista EFECTIVA que resuelve withEffectivePermissions (decisión de Ernesto,
    // 2026-09-17: permisos editables): sin fila en `configuracion` son exactamente los defaults.
    await expect(requireServerActor()).resolves.toEqual({ id: "user-1", roles: ["revisor", "solicitante"], permissions: resolveActorPermissions(["revisor", "solicitante"]) });
    expect(mocks.sqlCalls).toBe(1);
  });

  it("sin entorno configurado falla con ZodError ANTES de leer la cookie (503, no 500)", async () => {
    // Regresión real de la migración: al pasar de Supabase a sesión propia, la primera línea dejó de
    // leer el entorno y pasó a leer la cookie. En un servidor sin configurar eso convertía el 503
    // "service_unavailable" de toda la API en un 500 "internal_error" — indistinguible de un bug.
    // tests/integration/routes.test.ts lo detectó de punta a punta; esta prueba lo fija en la unidad.
    delete process.env.DATABASE_URL;
    mocks.cookieValue = "token-que-nunca-se-lee";
    await expect(requireServerActor()).rejects.toThrow();
    expect(mocks.sessionCalls).toBe(0);
  });

  it("sin cookie de sesión -> UNAUTHENTICATED, sin tocar la sesión ni SQL", async () => {
    await expect(requireServerActor()).rejects.toThrow("UNAUTHENTICATED");
    expect(mocks.sessionCalls).toBe(0);
    expect(mocks.sqlCalls).toBe(0);
  });

  it("cookie presente pero sesión vencida o revocada -> UNAUTHENTICATED, sin tocar SQL", async () => {
    // El caso que justifica el token opaco: cerrar sesión o dar de baja borra la fila y la siguiente
    // petición ya no entra, sin esperar a que venza nada.
    mocks.cookieValue = "token-de-una-sesion-borrada";
    mocks.sessionUserId = null;
    await expect(requireServerActor()).rejects.toThrow("UNAUTHENTICATED");
    expect(mocks.sessionCalls).toBe(1);
    expect(mocks.sqlCalls).toBe(0);
  });

  it("usuario inactivo o sin fila en usuarios -> ACCOUNT_INACTIVE", async () => {
    sessionFor("user-2");
    mocks.sqlRows = []; // fila ausente
    await expect(requireServerActor()).rejects.toThrow("ACCOUNT_INACTIVE");
    invalidateActorCache();
    mocks.sqlRows = [{ ...activeRow([]), estado: "inactivo" }];
    await expect(requireServerActor()).rejects.toThrow("ACCOUNT_INACTIVE");
  });

  it("fallo de la consulta SQL de perfil -> AUTHZ_LOOKUP_FAILED", async () => {
    sessionFor("user-3");
    mocks.sqlError = new Error("connection reset");
    await expect(requireServerActor()).rejects.toThrow("AUTHZ_LOOKUP_FAILED");
  });

  it("fallo al resolver la sesión -> AUTHZ_LOOKUP_FAILED, no UNAUTHENTICATED", async () => {
    // Distinguirlos importa: si la base está caída, el usuario debe ver un error del servidor, no
    // "tu sesión expiró", que lo mandaría a reintentar un login que tampoco va a funcionar.
    sessionFor("user-3b");
    mocks.sessionError = new Error("connection reset");
    await expect(requireServerActor()).rejects.toThrow("AUTHZ_LOOKUP_FAILED");
  });

  it("sin roles reconocidos (ALL_ROLES) -> ROLE_REQUIRED", async () => {
    sessionFor("user-4");
    mocks.sqlRows = [activeRow([])];
    await expect(requireServerActor()).rejects.toThrow("ROLE_REQUIRED");
    invalidateActorCache();
    mocks.sqlRows = [activeRow(["rol_inventado"])];
    await expect(requireServerActor()).rejects.toThrow("ROLE_REQUIRED");
  });

  it("una segunda llamada para el mismo usuario dentro del TTL no vuelve a consultar el perfil, pero sí revalida la sesión", async () => {
    sessionFor("user-5");
    mocks.sqlRows = [activeRow(["revisor"])];
    await requireServerActor();
    await requireServerActor();
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(1);
    expect(mocks.sessionCalls).toBe(3); // la sesión se comprueba siempre; el perfil no
  });

  it("invalidateActorCache(userId) fuerza una nueva consulta en la siguiente llamada", async () => {
    sessionFor("user-6");
    mocks.sqlRows = [activeRow(["revisor"])];
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(1);
    invalidateActorCache("user-6");
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(2);
  });

  it("expira por TTL (60 s) y vuelve a consultar, con reloj falso vía vi.useFakeTimers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-10T12:00:00.000Z"));
    sessionFor("user-7");
    mocks.sqlRows = [activeRow(["revisor"])];
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(1);
    vi.setSystemTime(new Date("2026-09-10T12:00:59.000Z")); // +59 s: aún dentro del TTL
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(1);
    vi.setSystemTime(new Date("2026-09-10T12:01:01.000Z")); // +61 s: TTL cumplido
    await requireServerActor();
    expect(mocks.sqlCalls).toBe(2);
  });
});
