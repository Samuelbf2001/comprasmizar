import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Los dos endpoints que la compuerta del portal necesita, y que sustituyen a `POST/GET
// /api/public/works` (borrado en este mismo cambio, con su prueba).
//
// El reparto entre los dos es la decisión que hay que vigilar, porque es la que cuesta explicar:
//
//   - `GET /api/public/companies` NO pide contraseña. Devuelve nombres de sociedades —Mizar,
//     Ictinos…—, que están en la marca y en las facturas. Pedir la contraseña no escondería nada y
//     crearía un oráculo; el endpoint de obras lo tenía y por eso se fue.
//   - `POST /api/public/access` SÍ es un oráculo de la contraseña, a sabiendas. Existe porque la
//     compuerta solo miraba en el navegador que la contraseña tuviera cuatro caracteres: quien se
//     equivocaba llenaba los dos pasos, pulsaba enviar y recibía el 202 neutro de la radicación. Ni
//     requisición, ni aviso. Fallar en la puerta y decirlo vale ese precio; fallar al final, no.
//
// Lo que estas pruebas fijan es lo que acota ese oráculo: el limitador por IP se consume ANTES de
// tocar la base, y cualquier fallo se resuelve como "no pasa".
const mocks = vi.hoisted(() => ({
  listPublicCompanies: vi.fn(),
  verificarCodigoPublico: vi.fn(),
  consume: vi.fn(() => true),
  configurado: vi.fn(() => true),
}));

vi.mock("../../lib/infrastructure/public-access", () => ({
  listPublicCompanies: mocks.listPublicCompanies,
  verificarCodigoPublico: mocks.verificarCodigoPublico,
}));
vi.mock("../../lib/security/env", () => ({ isPublicConfigured: () => mocks.configurado() }));
vi.mock("../../lib/security/rate-limit", () => ({ publicFormRateLimiter: { consume: mocks.consume } }));

import { POST } from "../../app/api/public/access/route";
import { GET } from "../../app/api/public/companies/route";

const EMPRESAS = [{ id: "20000000-0000-4000-8000-000000000002", name: "Ictinos" }];
const pedirAcceso = (cuerpo: unknown) =>
  new Request("http://localhost/api/public/access", { method: "POST", headers: { "content-type": "application/json" }, body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo) });
const pedirEmpresas = () => new Request("http://localhost/api/public/companies");

beforeEach(() => {
  mocks.listPublicCompanies.mockReset().mockResolvedValue(EMPRESAS);
  mocks.verificarCodigoPublico.mockReset().mockResolvedValue(true);
  mocks.consume.mockReset().mockReturnValue(true);
  mocks.configurado.mockReset().mockReturnValue(true);
});
afterEach(() => { vi.clearAllMocks(); });

describe("POST /api/public/access — la compuerta pregunta al servidor", () => {
  it("con la contraseña correcta responde ok:true", async () => {
    const respuesta = await POST(pedirAcceso({ code: "MIZAR-PRADERA" }));
    expect(mocks.verificarCodigoPublico).toHaveBeenCalledWith("MIZAR-PRADERA");
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ ok: true });
  });

  it("con una incorrecta responde ok:false, con el mismo status", async () => {
    // 200 y no 401 en los dos casos: un status distinto se cuela en registros y en proxies, y
    // convierte el resultado en algo más visible de lo que ya es.
    mocks.verificarCodigoPublico.mockResolvedValue(false);
    const respuesta = await POST(pedirAcceso({ code: "la-que-no-es" }));
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ ok: false });
  });

  it("la contraseña se compara EN LA BASE, no aquí", async () => {
    // `verificar_codigo_publico` es la misma función que usa el endpoint de radicación: el bcrypt no
    // sale de Postgres y no hay dos criterios que puedan divergir. Si algún día alguien compara aquí
    // con `===`, esta prueba no lo ve — pero el mock sí deja constancia de por dónde pasa la decisión.
    await POST(pedirAcceso({ code: "MIZAR-PRADERA" }));
    expect(mocks.verificarCodigoPublico).toHaveBeenCalledTimes(1);
  });

  it("el limitador por IP se consume ANTES de tocar la base", async () => {
    // Es lo único que acota el oráculo. Si se consultara primero la base, cada intento costaría un
    // bcrypt aunque el limitador fuera a rechazarlo.
    mocks.consume.mockReturnValue(false);
    const respuesta = await POST(pedirAcceso({ code: "MIZAR-PRADERA" }));
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ ok: false });
  });

  it("una cadena fuera de 4..64 se rechaza sin gastar un bcrypt", async () => {
    for (const code of ["", "abc", "x".repeat(65)]) {
      await expect((await POST(pedirAcceso({ code }))).json()).resolves.toEqual({ ok: false });
    }
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
  });

  it("un cuerpo ilegible o sin `code` no pasa", async () => {
    await expect((await POST(pedirAcceso("{no es json"))).json()).resolves.toEqual({ ok: false });
    await expect((await POST(pedirAcceso({ clave: "MIZAR-PRADERA" }))).json()).resolves.toEqual({ ok: false });
    await expect((await POST(pedirAcceso({ code: 1234 }))).json()).resolves.toEqual({ ok: false });
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
  });

  it("si la base falla, no pasa: ante la duda, la puerta queda cerrada", async () => {
    mocks.verificarCodigoPublico.mockRejectedValue(new Error("conexión caída"));
    await expect((await POST(pedirAcceso({ code: "MIZAR-PRADERA" }))).json()).resolves.toEqual({ ok: false });
  });

  it("con el portal sin configurar responde 503, que el formulario distingue de una contraseña mala", async () => {
    // El portal lo usa para decir "no está disponible" en vez de "contraseña incorrecta", que
    // mandaría a buscar una contraseña nueva a quien tiene la buena.
    mocks.configurado.mockReturnValue(false);
    const respuesta = await POST(pedirAcceso({ code: "MIZAR-PRADERA" }));
    expect(respuesta.status).toBe(503);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});

describe("GET /api/public/companies — la lista es pública", () => {
  it("devuelve las empresas SIN pedir contraseña ni token", async () => {
    const respuesta = await GET(pedirEmpresas());
    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({ companies: EMPRESAS });
    // Ni siquiera importa el verificador: este endpoint no tiene nada que autorizar.
    expect(mocks.verificarCodigoPublico).not.toHaveBeenCalled();
  });

  it("no se cachea: una sociedad dada de baja no puede seguir ofreciéndose", async () => {
    const respuesta = await GET(pedirEmpresas());
    expect(respuesta.headers.get("Cache-Control")).toBe("no-store");
  });

  it("el limitador por IP se consume ANTES de tocar la base", async () => {
    mocks.consume.mockReturnValue(false);
    const respuesta = await GET(pedirEmpresas());
    expect(mocks.listPublicCompanies).not.toHaveBeenCalled();
    await expect(respuesta.json()).resolves.toEqual({ companies: [] });
  });

  it("si la base falla, lista vacía y no una excepción", async () => {
    // El portal enseña "No hay empresas disponibles" en vez de un selector mudo.
    mocks.listPublicCompanies.mockRejectedValue(new Error("conexión caída"));
    await expect((await GET(pedirEmpresas())).json()).resolves.toEqual({ companies: [] });
  });

  it("con el portal sin configurar responde 503", async () => {
    mocks.configurado.mockReturnValue(false);
    expect((await GET(pedirEmpresas())).status).toBe(503);
    expect(mocks.consume).not.toHaveBeenCalled();
  });
});
