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

const workId = "11111111-1111-4111-8111-111111111111";
/** `token` nulo = ruta pública, sin enlace firmado (decisión del 2026-09-11). */
function requestFor(token: string | null): Request {
  const body = {
    workId,
    code: "1234",
    type: "compra",
    requiredDate: "2026-08-30",
    name: "Maestro de obra",
    phone: "+573001234567",
    items: [{ description: "Cemento", quantity: 1, unit: "und" }],
  };
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

  it("solo consulta la lista blanca de teléfonos después de validar el enlace y el código", async () => {
    const order: string[] = [];
    const verify = vi.fn().mockImplementation(async () => { order.push("verify"); return true; });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockImplementation(async () => { order.push("phoneAllowlist"); return false; });

    const response = await POST(requestFor("token-valido"));

    expect(order).toEqual(["verify", "phoneAllowlist"]);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
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
