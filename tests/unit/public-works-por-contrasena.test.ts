import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `POST /api/public/works` — la lista de obras para quien entra por la ruta PÚBLICA, sin enlace
// firmado (decisión de Ernesto, 2026-09-11: «que el enlace no necesite un token, sea ruta pública»).
//
// Lo que se vigila aquí es el compromiso que ese cambio acepta y sus límites. El endpoint ES un
// oráculo de la contraseña —lista con obras = acertaste— y no hay forma de evitarlo sin token: sin
// lista no se puede elegir obra ni radicar. Lo que sí tiene que cumplirse es que no dé NINGUNA señal
// de más: misma forma de respuesta, mismo status, y el limitador por IP aplicado antes de tocar la
// base.
const mocks = vi.hoisted(() => ({
  listPublicWorks: vi.fn(),
  verificarCodigoPublico: vi.fn(),
  consume: vi.fn(() => true),
}));

vi.mock("../../lib/infrastructure/public-access", () => ({
  listPublicWorks: mocks.listPublicWorks,
  verificarCodigoPublico: mocks.verificarCodigoPublico,
}));
vi.mock("../../lib/security/env", () => ({ isPublicConfigured: () => true, publicEnv: () => ({ PUBLIC_FORM_CODE_PEPPER: "p".repeat(32) }) }));
vi.mock("../../lib/security/rate-limit", () => ({ publicFormRateLimiter: { consume: mocks.consume } }));

import { POST } from "../../app/api/public/works/route";

const OBRAS = [{ id: "30000000-0000-4000-8000-000000000001", name: "Torre Misar Etapa 1" }];
const peticion = (cuerpo: unknown) =>
  new Request("http://localhost/api/public/works", { method: "POST", headers: { "content-type": "application/json" }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) });

beforeEach(() => {
  mocks.listPublicWorks.mockReset().mockResolvedValue(OBRAS);
  mocks.verificarCodigoPublico.mockReset().mockResolvedValue(true);
  mocks.consume.mockReset().mockReturnValue(true);
});
afterEach(() => { vi.clearAllMocks(); });

describe("POST /api/public/works", () => {
  it("con la contraseña correcta devuelve las obras", async () => {
    const respuesta = await POST(peticion({ code: "MIZAR-PRADERA" }));
    expect(mocks.verificarCodigoPublico).toHaveBeenCalledWith("MIZAR-PRADERA");
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ works: OBRAS });
  });

  it("con la contraseña incorrecta devuelve lista vacía, mismo status y misma forma", async () => {
    // Sin 401 ni mensaje: la única diferencia observable es la longitud de la lista, que es el
    // mínimo inevitable. Un status distinto lo convertiría en un oráculo más cómodo todavía.
    mocks.verificarCodigoPublico.mockResolvedValue(false);
    const respuesta = await POST(peticion({ code: "no-es" }));
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ works: [] });
    expect(mocks.listPublicWorks).not.toHaveBeenCalled();
  });

  it("el limitador por IP se aplica ANTES de tocar la base", async () => {
    // Es LA defensa contra probar contraseñas a lo bruto desde que la ruta es pública. Si se
    // consultara primero la base, cada intento rechazado seguiría costándonos una consulta.
    mocks.consume.mockReturnValue(false);
    const respuesta = await POST(peticion({ code: "MIZAR-PRADERA" }));
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
    expect(mocks.listPublicWorks).not.toHaveBeenCalled();
    await expect(respuesta.json()).resolves.toEqual({ works: [] });
  });

  it("una contraseña ausente, corta o larguísima ni llega a la base", async () => {
    for (const cuerpo of [{}, { code: "" }, { code: "abc" }, { code: "x".repeat(65) }, { code: 42 }]) {
      await expect((await POST(peticion(cuerpo))).json()).resolves.toEqual({ works: [] });
    }
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
  });

  it("un cuerpo que no es JSON, o enorme, se descarta sin reventar", async () => {
    await expect((await POST(peticion("{no es json"))).json()).resolves.toEqual({ works: [] });
    await expect((await POST(peticion({ code: "x".repeat(5_000) }))).json()).resolves.toEqual({ works: [] });
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
  });

  it("si la base falla, lista vacía y no una excepción", async () => {
    mocks.listPublicWorks.mockRejectedValue(new Error("conexión caída"));
    await expect((await POST(peticion({ code: "MIZAR-PRADERA" }))).json()).resolves.toEqual({ works: [] });
  });
});
