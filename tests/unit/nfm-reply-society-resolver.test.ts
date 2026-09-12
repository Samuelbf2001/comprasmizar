import { describe, expect, it, vi } from "vitest";

// Mismo patrón que tests/unit/public-access.test.ts: sustituye `sharedPostgres` por un capturador
// de parámetros para verificar la consulta EXACTA sin tocar Postgres real. Mock local a este
// archivo (no afecta a tests/integration/nfm-reply.test.ts, que mockea el mismo módulo distinto).
type SqlResult = { id: string }[];
let nextResult: SqlResult = [];
const calls: unknown[][] = [];
vi.mock("../../lib/infrastructure/postgres-repositories", () => {
  const tag = (_strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); return Promise.resolve(nextResult); };
  return { sharedPostgres: () => tag };
});

import { createPostgresSocietyResolver } from "../../lib/infrastructure/nfm-reply-adapter";

describe("createPostgresSocietyResolver — contraparte receptora de buildSocietyOptions (flow-sender.ts)", () => {
  it("resuelve al uuid cuando hay exactamente una coincidencia por nombre", async () => {
    nextResult = [{ id: "22222222-2222-4222-8222-222222222222" }];
    const resolve = createPostgresSocietyResolver("postgres://test");
    await expect(resolve("Mizar")).resolves.toBe("22222222-2222-4222-8222-222222222222");
  });

  it("pasa el mismo valor dos veces al filtro (coincide por nombre exacto O por 'nombre (nit)')", async () => {
    calls.length = 0;
    nextResult = [{ id: "uuid-1" }];
    const resolve = createPostgresSocietyResolver("postgres://test");
    await resolve("Mizar (900123456-7)");
    expect(calls[0]).toEqual(["Mizar (900123456-7)", "Mizar (900123456-7)"]);
  });

  it("devuelve null cuando ninguna sociedad activa calza (nombre desconocido)", async () => {
    nextResult = [];
    const resolve = createPostgresSocietyResolver("postgres://test");
    await expect(resolve("Sociedad Que No Existe")).resolves.toBeNull();
  });

  it("devuelve null (ambiguo, fail-closed) si hay más de una coincidencia — no debería pasar dado el UNIQUE de sociedades.nombre", async () => {
    nextResult = [{ id: "uuid-1" }, { id: "uuid-2" }];
    const resolve = createPostgresSocietyResolver("postgres://test");
    await expect(resolve("Mizar")).resolves.toBeNull();
  });

  it("un nombre vacío (o solo espacios) devuelve null sin tocar la BD", async () => {
    calls.length = 0;
    const resolve = createPostgresSocietyResolver("postgres://test");
    await expect(resolve("   ")).resolves.toBeNull();
    expect(calls).toHaveLength(0);
  });
});
