import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hallazgo de auditoría adversarial (ver AGENTS.md): en app/api/public/requisitions/route.ts la lista
// blanca de teléfonos (isAuthorizedPublicRequester, que consulta la BD) se evaluaba ANTES del token HMAC
// del enlace y del código secreto de la obra (publicAccess.verify). Eso permitía a un atacante sin token
// válido (a) forzar consultas a BD gratis mandando cualquier cadena como x-public-link-token, y (b) usar
// el timing de esa consulta de teléfonos para enumerar solicitantes autorizados en una obra. Estas pruebas
// fijan el orden correcto: primero lo barato/criptográfico (verify), después la consulta de teléfonos.
//
// Adenda de pagos (S3, RF-108): el 202 NEUTRO se reserva desde ahora para la ruta anti-enumeración
// —límites de abuso, contraseña y enlace—. Un cuerpo mal formado responde 400 con motivo y un error
// de dominio tras verificar responde con su código: antes ambos recibían el 202 y la solicitud se
// perdía en silencio, que es justo lo que le pasaba a una solicitud de pago. Las pruebas de abajo
// fijan las dos cosas a la vez: qué sigue siendo neutro y qué dejó de serlo.
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
import { DomainError } from "../../lib/domain";
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
  afterEach(() => { vi.restoreAllMocks(); });
  /** Radicación que llega al servicio y sale bien: desde S3 un `create` que revienta ya no se
   *  disfraza de 202, así que las pruebas que solo miran el ORDEN de verificación lo resuelven. */
  const creacionCorrecta = () => vi.spyOn(ProcurementService.prototype, "create").mockResolvedValue({ id: "req-1", items: [] } as never);

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
    creacionCorrecta();

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

  it("obra Y empresa a la vez se rechaza antes de tocar la base, con un 400 que lo dice", async () => {
    // Con las dos no está claro cuál manda: la requisición se cargaría a un centro de costo que
    // nadie eligió. El esquema lo corta antes, así que `createPostgresDependencies` no llega ni a
    // llamarse — y como pasa ANTES de verificar nada, decirlo no filtra nada del acceso.
    const response = await POST(requestFor(null, { societyId }));

    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_input" });
  });

  it("ni obra ni empresa tampoco: sin destino no hay requisición que radicar", async () => {
    const response = await POST(requestFor(null, { workId: undefined }));

    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
  });

  it("un JSON malformado responde 400, no un 202 que finge que se radicó", async () => {
    const response = await POST(new Request("http://localhost/api/public/requisitions", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));

    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("SIN token entra igual y la contraseña pasa a ser la llave", async () => {
    // Decisión de Ernesto (2026-09-11): «que el enlace no necesite un token, sea ruta pública».
    // El token llega como `null` a `verify`, que entonces se salta el HMAC y decide solo con la
    // contraseña y el estado de la obra.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true);
    creacionCorrecta();

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

  it("una falla de infraestructura DESPUÉS de verificar responde 503, no un 202 que finge que se radicó", async () => {
    // Antes esto era neutro "para no exponer si el fallo fue de enlace, código o infraestructura".
    // Pero a este punto solo se llega con la contraseña correcta —y eso ya lo dice la puerta,
    // `POST /api/public/access`—, así que el 202 no protegía nada: solo escondía que la base estaba
    // caída y la persona se quedaba esperando una requisición que nunca existió. El 503 no lleva
    // detalle y el portal ofrece reintentar.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } }); // deps incompletas a propósito
    mocks.isAuthorizedPublicRequester.mockResolvedValue(true);

    const response = await POST(requestFor("token-valido"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
  });

  it("si la base falla al VERIFICAR, también es 503: todavía no se sabe si la contraseña era buena", async () => {
    const verify = vi.fn().mockRejectedValue(new Error("connection refused"));
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });

    const response = await POST(requestFor("token-valido"));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
  });
});

/**
 * Solicitud de pago por el portal (RF-108, adenda de pagos). `pagoFor` parte del cuerpo de compra y
 * QUITA lo que un pago no lleva (`name`, `requiredDate`, `items`): quien radica es el beneficiario y
 * el concepto + monto son la única línea, que arma el endpoint.
 */
function pagoFor(token: string | null, campos: Record<string, unknown> = {}): Request {
  return requestFor(token, {
    type: "pago", name: undefined, requiredDate: undefined, items: undefined,
    beneficiary: { identificationType: "CC", identification: "1020304050", name: "Ana Topógrafa" },
    amount: 1_250_000, concept: "Levantamiento topográfico lote 3",
    ...campos,
  });
}

describe("solicitud de pago por el portal (RF-108) — forma, creación y qué sigue siendo neutro", () => {
  beforeEach(() => { mocks.createPostgresDependencies.mockReset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("un pago SIN monto responde 400 señalando el campo — no 202 — y no toca la base", async () => {
    // El caso que motivó S3: el portal ofrecía "Solicitud de pago", el esquema no tenía monto ni
    // beneficiario, y el 202 neutro se tragaba el rechazo. Ahora el 400 llega ANTES de verificar
    // nada (ni `createPostgresDependencies` se llama), así que no filtra nada del acceso.
    const response = await POST(pagoFor(null, { amount: undefined }));

    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; issues: { path: string; code: string }[] };
    expect(body.error).toBe("invalid_input");
    expect(body.issues.map((issue) => issue.path)).toContain("amount");
    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
  });

  it("monto cero, negativo o con decimales también es 400: el valor es un entero en pesos", async () => {
    for (const amount of [0, -5, 10.5]) expect((await POST(pagoFor(null, { amount }))).status).toBe(400);
  });

  it("el concepto es obligatorio y de hasta 120 caracteres; el beneficiario exige identificación y nombre", async () => {
    expect((await POST(pagoFor(null, { concept: "" }))).status).toBe(400);
    expect((await POST(pagoFor(null, { concept: "x".repeat(121) }))).status).toBe(400);
    expect((await POST(pagoFor(null, { beneficiary: { identificationType: "CC", name: "Ana Topógrafa" } }))).status).toBe(400);
    expect((await POST(pagoFor(null, { beneficiary: { identificationType: "DNI", identification: "1020304050", name: "Ana" } }))).status).toBe(400);
    expect(mocks.createPostgresDependencies).not.toHaveBeenCalled();
  });

  it("un pago no admite ítems ni los campos de compra: el esquema es estricto por tipo", async () => {
    expect((await POST(pagoFor(null, { items: [{ description: "Cemento", quantity: 1, unit: "und" }] }))).status).toBe(400);
    expect((await POST(pagoFor(null, { name: "Maestro de obra" }))).status).toBe(400);
    // Y una compra tampoco acepta los de pago.
    expect((await POST(requestFor(null, { amount: 1000 }))).status).toBe(400);
  });

  it("un pago completo llega a create() como UNA línea de concepto con el monto como valor y el beneficiario por identificación", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({ id: "req-1", items: [{ id: "item-1" }] });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);

    const response = await POST(pagoFor("token-valido", { phone: "+57 300 123 4567" }));

    expect(response.status).toBe(202);
    expect(verify).toHaveBeenCalledWith(workId, "token-valido", "1234");
    expect(create).toHaveBeenCalledTimes(1);
    const input = create.mock.calls[0][0];
    expect(input).toMatchObject({
      type: "pago", workId, channel: "publico", publicCode: "1234", publicLinkToken: "token-valido",
      // Quien radica ES el beneficiario: mismo nombre y mismo teléfono (normalizado) en los dos sitios.
      externalRequester: { name: "Ana Topógrafa", phone: "+573001234567" },
      beneficiary: { identificationType: "CC", identification: "1020304050", name: "Ana Topógrafa", phone: "+573001234567" },
    });
    expect(input.items).toHaveLength(1);
    // Misma forma que arma el formulario interno para un pago (`unit: "servicio"`, cantidad 1).
    expect(input.items[0]).toMatchObject({ description: "Levantamiento topográfico lote 3", quantity: 1, unit: "servicio", unitBase: 1_250_000, unitIva: 0 });
    expect(typeof input.items[0].id).toBe("string");
  });

  it("la fecha del gasto llega con el día de hoy en Colombia aunque en UTC ya sea mañana (QA H9)", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({ id: "req-1", items: [{ id: "item-1" }] });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T03:30:00.000Z")); // 22:30 del 15 en Bogotá
    try {
      const response = await POST(pagoFor("token-valido"));
      expect(response.status).toBe(202);
      expect(create.mock.calls[0][0].requiredDate).toBe("2026-09-15");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sin teléfono, ni el solicitante ni el beneficiario lo llevan", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({ id: "req-1", items: [{ id: "item-1" }] });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);

    const response = await POST(pagoFor("token-valido", { phone: undefined }));

    expect(response.status).toBe(202);
    expect(create.mock.calls[0][0].externalRequester).toEqual({ name: "Ana Topógrafa" });
    expect(create.mock.calls[0][0].beneficiary).toEqual({ identificationType: "CC", identification: "1020304050", name: "Ana Topógrafa" });
  });

  it("con la contraseña incorrecta un pago recibe el MISMO 202 neutro que una compra, y no se crea nada", async () => {
    // La garantía anti-enumeración no cambia con el tipo: quien prueba contraseñas ve lo mismo
    // radique compra o pago, y lo mismo que quien acierta.
    const verify = vi.fn().mockResolvedValue(false);
    const create = vi.fn();
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);

    const response = await POST(pagoFor(null));

    expect(verify).toHaveBeenCalledWith(workId, null, "1234");
    expect(create).not.toHaveBeenCalled();
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
  });

  it("un error de dominio tras verificar se dice con su código: beneficiario homónimo con otra identificación → 409", async () => {
    // Es lo que devuelve `resolveBeneficiary` cuando `razon_social` (única) ya existe con otra
    // identificación. Con el 202 neutro, la persona creía que había radicado y Daniel nunca recibía
    // nada; ahora el portal muestra este mensaje tal cual.
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockRejectedValue(new DomainError("CONFLICT", "Ya existe un proveedor con ese nombre y otra identificación"));

    const response = await POST(pagoFor("token-valido"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "conflict", message: "Ya existe un proveedor con ese nombre y otra identificación" });
  });

  it("un rechazo de dominio genérico (INVALID_INPUT) responde 422 con el mensaje", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockRejectedValue(new DomainError("INVALID_INPUT", "El beneficiario existe en el catálogo pero está inactivo"));

    const response = await POST(pagoFor("token-valido"));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ error: "invalid_input", message: "El beneficiario existe en el catálogo pero está inactivo" });
  });

  it("si el SERVICIO niega el acceso después de que la ruta lo verificó, es una inconsistencia interna: 503, no 202", async () => {
    // Hoy pasa en la ruta general por empresa: `ProcurementService.create` verifica solo por obra y
    // nunca llama a `verifySociety`. Un 202 aquí volvería a perder la solicitud en silencio; el 503
    // no filtra nada (la contraseña ya se verificó y la puerta ya lo dijo) y deja reintentar.
    const verify = vi.fn().mockResolvedValue(true), verifySociety = vi.fn().mockResolvedValue(true);
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify, verifySociety } });
    vi.spyOn(ProcurementService.prototype, "create").mockRejectedValue(new DomainError("PUBLIC_ACCESS_DENIED", "Enlace o código público inválido"));

    const response = await POST(pagoFor(null, { workId: undefined, societyId }));

    expect(verifySociety).toHaveBeenCalledWith(societyId, null, "1234");
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "service_unavailable" });
  });

  it("una compra bien formada sigue recibiendo el 202 de siempre", async () => {
    const verify = vi.fn().mockResolvedValue(true);
    const create = vi.fn().mockResolvedValue({ id: "req-1", items: [{ id: "item-1" }] });
    mocks.createPostgresDependencies.mockReturnValue({ publicAccess: { verify } });
    vi.spyOn(ProcurementService.prototype, "create").mockImplementation(create);

    const response = await POST(requestFor("token-valido"));

    expect(response.status).toBe(202);
    expect(create.mock.calls[0][0]).toMatchObject({ type: "compra", requiredDate: "2026-08-30", externalRequester: { name: "Maestro de obra", phone: "+573001234567" } });
    expect(create.mock.calls[0][0]).not.toHaveProperty("beneficiary");
  });
});
