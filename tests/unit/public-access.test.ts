import { describe, expect, it, vi } from "vitest";

// GRAVE 2 (QA Postgres real): antes solo se quitaban los no-dígitos del teléfono, así que
// "3001112233" (10 dígitos, sin indicativo) y "+57 300 111 2233"/"573001112233" (con indicativo)
// resolvían a valores distintos contra `solicitantes_autorizados.telefono_normalizado` — y WhatsApp
// siempre entrega el remitente en E.164 (con indicativo), así que un número cargado sin "+57" quedaba
// fuera del canal en silencio (unauthorized_requester). Este arnés no toca Postgres: sustituye
// `sharedPostgres` por un capturador de parámetros (mismo patrón que `fakeSql` en
// postgres-repositories.test.ts) para verificar el valor EXACTO que viaja como filtro de la consulta.
// Los tests de createPublicAccessAdminRepository (más abajo) reutilizan este mismo mock configurable.
type SqlResult = unknown[] & { count?: number };
let nextResult: SqlResult = [{ nombre: "Ana" }];
const calls: unknown[][] = [];
const textCalls: string[] = [];
/** Eventos que el repositorio manda a auditoría DENTRO de la transacción de setPassword. */
const auditCalls: unknown[] = [];
vi.mock("../../lib/infrastructure/postgres-repositories", () => {
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); textCalls.push(strings.join("?")); return Promise.resolve(nextResult); };
  return {
    // `begin` ejecuta el trabajo con la MISMA etiqueta, así que las consultas de dentro de la
    // transacción quedan capturadas en `textCalls`/`calls` igual que las de fuera.
    sharedPostgres: () => Object.assign(tag, { begin: (work: (tx: typeof tag) => Promise<unknown>) => work(tag) }),
    // El repositorio reutiliza PostgresPorts para el insert de auditoría, atado a la transacción.
    PostgresPorts: class { async append(event: unknown) { auditCalls.push(event); } },
  };
});

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

// Reunión: la contraseña del portal público pasó de ser por obra a GLOBAL, guardada en la tabla
// singleton `acceso_publico` (migración 202609070002_acceso_publico_global.sql — GRAVE del QA contra
// Postgres real: NO vive en `configuracion.valor`, porque esa columna compartida no está redactada por
// nombre en `auditoria_campo_sensible` y el hash quedaba en claro en `auditoria`; `acceso_publico.public_code_hash`
// sí hereda esa redacción). Este repositorio nunca ve el hash en JS: getStatus solo lee si hay uno
// configurado y cuándo, setPassword delega el cálculo a extensions.crypt en la base.
describe("createPublicAccessAdminRepository — contraseña global del portal (nunca en claro en JS)", () => {
  it("getStatus lee configured/updatedAt sin exponer el hash", async () => {
    calls.length = 0; textCalls.length = 0;
    nextResult = [{ configured: true, updated_at: "2026-09-07T12:00:00.000Z" }];
    const repository = createPublicAccessAdminRepository("postgres://test");
    await expect(repository.getStatus()).resolves.toEqual({ configured: true, updatedAt: "2026-09-07T12:00:00.000Z" });
    expect(textCalls[0]).toMatch(/from acceso_publico where id/);
    // Las únicas columnas devueltas son "configured" (booleano) y "updated_at": el hash NUNCA viaja
    // como valor de retorno, solo se usa dentro de un "is not null" que jamás sale de la base.
    expect(textCalls[0]).toMatch(/public_code_hash is not null as configured/);
  });

  it("getStatus informa 'sin configurar' cuando no hay fila o el hash es null", async () => {
    nextResult = [{ configured: false, updated_at: null }];
    const repository = createPublicAccessAdminRepository("postgres://test");
    await expect(repository.getStatus()).resolves.toEqual({ configured: false, updatedAt: null });
    nextResult = [];
    await expect(repository.getStatus()).resolves.toEqual({ configured: false, updatedAt: null });
  });

  const evento = {
    entity: "acceso_publico",
    entityId: "00000000-0000-0000-0000-000000000001",
    event: "contrasena_actualizada",
    actorId: "actor-1",
    at: new Date("2026-09-11T12:00:00.000Z"),
    origin: "web" as const,
  };

  it("setPassword calcula el hash EN LA BASE (extensions.crypt + gen_salt con coste explícito) y nunca envía el código sin cifrar como columna", async () => {
    calls.length = 0; textCalls.length = 0; auditCalls.length = 0;
    nextResult = Object.assign([], { count: 1 });
    const repository = createPublicAccessAdminRepository("postgres://test");
    await repository.setPassword("clave-de-prueba-larga", "actor-1", evento);
    const [text, values] = [textCalls[0], calls[0]];
    expect(text).toMatch(/extensions\.crypt\(.*extensions\.gen_salt\('bf', 12\)\)/);
    expect(text).toMatch(/update acceso_publico/);
    expect(text).toMatch(/where id/);
    // El código y el actor viajan como PARÁMETROS (placeholders `?`), nunca interpolados en el texto SQL.
    expect(values).toContain("clave-de-prueba-larga");
    expect(values).toContain("actor-1");
  });

  // GRAVE (QA Postgres real): antes no se comprobaban las filas afectadas, así que un UPDATE que no
  // tocara ninguna fila (la singleton ausente/borrada) devolvía éxito silencioso.
  it("setPassword falla si el UPDATE no afecta ninguna fila (la fila singleton no existe)", async () => {
    auditCalls.length = 0;
    nextResult = Object.assign([], { count: 0 });
    const repository = createPublicAccessAdminRepository("postgres://test");
    await expect(repository.setPassword("clave-de-prueba-larga", "actor-1", evento)).rejects.toThrow();
    // Y no audita un cambio que no ocurrió: el throw corta antes, dentro de la transacción.
    expect(auditCalls).toHaveLength(0);
  });

  // La contraseña y su evento se escriben JUNTOS. Antes eran dos llamadas encadenadas desde el
  // servicio: el update commiteaba y la auditoría iba después, así que un fallo entre ambas dejaba
  // una contraseña de portal cambiada sin rastro de quién. Eso es lo que se cierra aquí.
  it("setPassword escribe la contraseña y su auditoría en UNA transacción", async () => {
    calls.length = 0; textCalls.length = 0; auditCalls.length = 0;
    nextResult = Object.assign([], { count: 1 });
    const repository = createPublicAccessAdminRepository("postgres://test");
    await repository.setPassword("clave-de-prueba-larga", "actor-1", evento);
    // El update viaja por la conexión de la transacción (la misma etiqueta que captura textCalls)...
    expect(textCalls[0]).toMatch(/update acceso_publico/);
    // ...y el evento se escribe con PostgresPorts atado a esa misma transacción, no por un puerto aparte.
    expect(auditCalls).toEqual([evento]);
  });
});
