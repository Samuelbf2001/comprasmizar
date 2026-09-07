import { describe, expect, it, vi } from "vitest";

// GRAVE 2 (QA Postgres real): antes solo se quitaban los no-dígitos del teléfono, así que
// "3001112233" (10 dígitos, sin indicativo) y "+57 300 111 2233"/"573001112233" (con indicativo)
// resolvían a valores distintos contra `solicitantes_autorizados.telefono_normalizado` — y WhatsApp
// siempre entrega el remitente en E.164 (con indicativo), así que un número cargado sin "+57" quedaba
// fuera del canal en silencio (unauthorized_requester). Este arnés no toca Postgres: sustituye
// `sharedPostgres` por un capturador de parámetros (mismo patrón que `fakeSql` en
// postgres-repositories.test.ts) para verificar el valor EXACTO que viaja como filtro de la consulta.
// Los tests de createPublicAccessAdminRepository (más abajo) reutilizan este mismo mock configurable.
type SqlResult = unknown[];
let nextResult: SqlResult = [{ nombre: "Ana" }];
const calls: unknown[][] = [];
const textCalls: string[] = [];
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  sharedPostgres: () => (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); textCalls.push(strings.join("?")); return Promise.resolve(nextResult); },
}));

import { createPublicAccessAdminRepository, resolveAuthorizedRequesterName } from "../../lib/infrastructure/public-access";

describe("resolveAuthorizedRequesterName — normalización E.164 colombiana (GRAVE 2)", () => {
  it("un número local de 10 dígitos, uno con '+57' y espacios, y uno ya en E.164 sin '+' resuelven al MISMO valor normalizado", async () => {
    for (const raw of ["3001112233", "+57 300 111 2233", "573001112233"]) {
      calls.length = 0;
      const result = await resolveAuthorizedRequesterName(raw, "postgres://test");
      expect(calls[0]).toEqual(["573001112233"]);
      expect(result).toEqual({ name: "Ana" });
    }
  });

  it("un número de otro largo (no 10 ni con indicativo colombiano reconocible) solo pierde los no-dígitos, sin inventar un indicativo", async () => {
    calls.length = 0;
    await resolveAuthorizedRequesterName("+1 415 555 0100", "postgres://test"); // EE.UU., 11 dígitos
    expect(calls[0]).toEqual(["14155550100"]);
  });
});

// Reunión: la contraseña del portal público pasó de ser por obra a GLOBAL (configuracion.acceso_publico_v1,
// migración 202609070002_acceso_publico_global.sql). Este repositorio nunca ve el hash en JS: getStatus
// solo lee si hay uno configurado y cuándo, setPassword delega el cálculo a extensions.crypt en la base.
describe("createPublicAccessAdminRepository — contraseña global del portal (nunca en claro en JS)", () => {
  it("getStatus lee configured/updatedAt sin exponer el hash", async () => {
    calls.length = 0; textCalls.length = 0;
    nextResult = [{ configured: true, updated_at: "2026-09-07T12:00:00.000Z" }];
    const repository = createPublicAccessAdminRepository("postgres://test");
    await expect(repository.getStatus()).resolves.toEqual({ configured: true, updatedAt: "2026-09-07T12:00:00.000Z" });
    expect(textCalls[0]).toMatch(/from configuracion where clave = 'acceso_publico_v1'/);
    // Las únicas columnas devueltas son "configured" (booleano) y "updated_at": el hash NUNCA viaja
    // como valor de retorno, solo se usa dentro de un "is not null" que jamás sale de la base.
    expect(textCalls[0]).toMatch(/is not null as configured/);
  });

  it("getStatus informa 'sin configurar' cuando no hay fila o el hash es null", async () => {
    nextResult = [{ configured: false, updated_at: null }];
    const repository = createPublicAccessAdminRepository("postgres://test");
    await expect(repository.getStatus()).resolves.toEqual({ configured: false, updatedAt: null });
    nextResult = [];
    await expect(repository.getStatus()).resolves.toEqual({ configured: false, updatedAt: null });
  });

  it("setPassword calcula el hash EN LA BASE (extensions.crypt + gen_salt) y nunca envía el código sin cifrar como columna", async () => {
    calls.length = 0; textCalls.length = 0;
    nextResult = [];
    const repository = createPublicAccessAdminRepository("postgres://test");
    await repository.setPassword("clave-de-prueba-larga", "actor-1");
    const [text, values] = [textCalls[0], calls[0]];
    expect(text).toMatch(/extensions\.crypt\(.*extensions\.gen_salt\('bf'\)\)/);
    expect(text).toMatch(/update configuracion/);
    expect(text).toMatch(/where clave = 'acceso_publico_v1'/);
    // El código y el actor viajan como PARÁMETROS (placeholders `?`), nunca interpolados en el texto SQL.
    expect(values).toContain("clave-de-prueba-larga");
    expect(values).toContain("actor-1");
  });
});
