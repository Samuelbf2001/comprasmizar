import { beforeEach, describe, expect, it, vi } from "vitest";

// Hallazgo de auditoría adversarial (ver AGENTS.md): en app/api/public/requisitions/route.ts la lista
// blanca de teléfonos (isAuthorizedPublicRequester, que consulta la BD) se evaluaba ANTES del token HMAC
// del enlace y del código secreto de la obra (publicAccess.verify). Eso permitía a un atacante sin token
// válido (a) forzar consultas a BD gratis mandando cualquier cadena como x-public-link-token, y (b) usar
// el timing de esa consulta de teléfonos para enumerar solicitantes autorizados en una obra. Estas pruebas
// fijan el orden correcto: primero lo barato/criptográfico (verify), después la consulta de teléfonos.
const mocks = vi.hoisted(() => ({
  isAuthorizedPublicRequester: vi.fn(),
  createPostgresDependencies: vi.fn(),
}));

vi.mock("../../lib/infrastructure/public-access", () => ({
  isAuthorizedPublicRequester: mocks.isAuthorizedPublicRequester,
}));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: mocks.createPostgresDependencies,
}));
vi.mock("../../lib/security/env", () => ({
  isPublicConfigured: () => true,
}));
vi.mock("../../lib/security/rate-limit", () => ({
  publicFormRateLimiter: { consume: () => true },
  publicWorkRateLimiter: { consume: () => true },
  publicWorkAggregateRateLimiter: { consume: () => true },
}));

import { POST } from "../../app/api/public/requisitions/route";
import { ProcurementService } from "../../lib/services";

const workId = "11111111-1111-4111-8111-111111111111";
const societyId = "22222222-2222-4222-8222-222222222222";
/**
 * `token` nulo = ruta pública, sin enlace firmado (decisión del 2026-09-11).
 *
 * `campos` sustituye partes del cuerpo; una clave con `undefined` la QUITA, que es como se prueban
 * el teléfono ausente y el destino ausente — no es lo mismo mandar el campo vacío que no mandarlo.
 */
function requestFor(token: string | null, campos: Record<string, unknown> = {}): Request {
  const body: Record<string, unknown> = {
    workId,
    code: "1234",
    type: "compra",
    requiredDate: "2026-08-30",
    name: "Maestro de obra",
    phone: "+573001234567",
    items: [{ description: "Cemento", quantity: 1, unit: "und" }],
    ...campos,
  };
  for (const [clave, valor] of Object.entries(body)) if (valor === undefined) delete body[clave];
  return new Request("http://localhost/api/public/requisitions", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { "x-public-link-token": token }) },
    body: JSON.stringify(body),
  });
}

describe("endurecimiento del portal público — orden de validaciones", () => {
  beforeEach(() => {
    mocks.isAuthorizedPublicRequester.mockReset();
    mocks.createPostgresDependencies.mockReset();
  });

  it("nunca consulta la lista blanca de teléfonos cuando el enlace/código es inválido", async () => {
    const verify = vi.fn().mockResolvedValue(false);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true); // aunque autorizaría, no debe ni ejecutarse

    const response = await POST(requestFor("token-invalido"));

    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(workId, "token-invalido", "1234");
    expect(mocks.isAuthorizedPublicRequester).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true }); // respuesta neutra: no filtra cuál validación falló
  });

  it("la lista blanca de teléfonos YA NO se consulta, ni siquiera con el enlace y el código válidos", async () => {
    // Decisión de Ernesto (11-sep-2026): la contraseña es la llave —«para ingresar solo una
    // contraseña válida»— y el teléfono pasó a ser OPCIONAL. Una lista blanca de teléfonos no puede
    // autorizar a quien no da ninguno, así que dejó de ser una compuerta: quedaba un control que
    // parecía existir y no decidía nada.
    //
    // `obra_solicitantes_autorizados` sigue viva y la sigue usando el canal de WhatsApp, donde el
    // número SÍ es la identidad del remitente. Lo que esta prueba fija es que este endpoint no la
    // toca: si alguien la reintroduce aquí, vuelve a bloquear a quien radica sin teléfono.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockResolvedValue(false); // rechazaría a este número, y da igual

    const response = await POST(requestFor("token-valido"));

    expect(verify).toHaveBeenCalledWith(workId, "token-valido", "1234");
    expect(mocks.isAuthorizedPublicRequester).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("SIN teléfono se radica igual: el campo es opcional y ni siquiera llega al esquema", async () => {
    // El riesgo del cambio no es que se acepte sin teléfono, es que se acepte con uno VACÍO: `phone:
    // ""` lo rechaza el esquema (min 7) y, con el 202 neutro, ese rechazo se vería exactamente igual
    // que un envío correcto que nunca llega a la bandeja. Por eso el portal lo omite y aquí se
    // comprueba que el endpoint acepta la omisión.
    const verify = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({ id: "req-1" });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);

    const response = await POST(requestFor("token-valido", { phone: undefined }));

    expect(response.status).toBe(202);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].externalRequester).toEqual({ name: "Maestro de obra" });
    vi.restoreAllMocks();
  });

  it("por EMPRESA usa verifySociety, no el verificador de obra", async () => {
    // Son dos caminos con exigencias distintas: `verify` pide que la OBRA esté abierta; `verifySociety`
    // que la EMPRESA esté activa y que, si viene token, sea el general — un token firmado para una obra
    // no puede autorizar una sociedad cualquiera.
    const verify = vi.fn().mockResolvedValue(true), verifySociety = vi.fn().mockResolvedValue(false);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify, verifySociety } });

    const response = await POST(requestFor(null, { workId: undefined, societyId }));

    expect(verifySociety).toHaveBeenCalledWith(societyId, null, "1234");
    expect(verify).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
  });

  it("obra Y empresa a la vez se rechaza antes de tocar la base", async () => {
    // Con las dos no está claro cuál manda, y el 202 neutro haría ese desacuerdo invisible: la
    // requisición se cargaría a un centro de costo que nadie eligió. El esquema lo corta antes, así
    // que `createPostgresDependencies` no llega ni a llamarse.
    const response = await POST(requestFor(null, { societyId }));

    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("ni obra ni empresa tampoco: sin destino no hay requisición que radicar", async () => {
    const response = await POST(requestFor(null, { workId: undefined }));

    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
  });

  it("SIN token entra igual y la contraseña pasa a ser la llave", async () => {
    // Decisión de Ernesto (2026-09-11): «que el enlace no necesite un token, sea ruta pública».
    // El token llega como `null` a `verify`, que entonces se salta el HMAC y decide solo con la
    // contraseña y el estado de la obra.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true);

    const response = await POST(requestFor(null));

    expect(verify).toHaveBeenCalledWith(workId, null, "1234");
    expect(response.status).toBe(202);
  });

  it("SIN token y con contraseña incorrecta no crea nada, y responde igual de neutro", async () => {
    // La única señal que recibe quien prueba contraseñas es… ninguna. Mismo 202 que el acierto.
    const verify = vi.fn().mockResolvedValue(false);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true);

    const response = await POST(requestFor(null));

    expect(verify).toHaveBeenCalledWith(workId, null, "1234");
    expect(mocks.isAuthorizedPublicRequester).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("un token PRESENTE pero inválido sigue rechazándose, no se degrada a ruta pública", async () => {
    // El riesgo del cambio: que "sin token" y "con token malo" se confundieran, y un enlace acotado a
    // una obra se convirtiera en acceso general con solo estropear el token. `verify` recibe la
    // cadena tal cual, no `null`, así que el HMAC se comprueba y falla.
    const verify = vi.fn().mockResolvedValue(false);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    const response = await POST(requestFor("token-estropeado"));
    expect(verify).toHaveBeenCalledWith(workId, "token-estropeado", "1234");
    expect(response.status).toBe(202);
  });

  it("responde neutro incluso cuando ambas verificaciones pasan pero la creación falla más adelante", async () => {
    // No exponemos por status/cuerpo si el fallo fue de enlace, código, teléfono o infraestructura.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } }); // deps incompletas a propósito
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true);

    const response = await POST(requestFor("token-valido"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });
});
