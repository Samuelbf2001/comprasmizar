import { describe, expect, it, vi } from "vitest";

// GRAVE 2 (QA Postgres real): antes solo se quitaban los no-dígitos del teléfono, así que
// "3001112233" (10 dígitos, sin indicativo) y "+57 300 111 2233"/"573001112233" (con indicativo)
// resolvían a valores distintos contra `solicitantes_autorizados.telefono_normalizado` — y WhatsApp
// siempre entrega el remitente en E.164 (con indicativo), así que un número cargado sin "+57" quedaba
// fuera del canal en silencio (unauthorized_requester). Este arnés no toca Postgres: sustituye
// `sharedPostgres` por un capturador de parámetros (mismo patrón que `fakeSql` en
// postgres-repositories.test.ts) para verificar el valor EXACTO que viaja como filtro de la consulta.
const calls: unknown[][] = [];
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  sharedPostgres: () => (_strings: TemplateStringsArray, ...values: unknown[]) => { calls.push(values); return Promise.resolve([{ nombre: "Ana" }]); },
}));

import { resolveAuthorizedRequesterName } from "../../lib/infrastructure/public-access";

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
