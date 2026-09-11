import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTextTemplatePayload, sendKapsoTemplate } from "../../lib/infrastructure/kapso";
import { PLANTILLAS_WHATSAPP } from "../../lib/infrastructure/plantillas-whatsapp";

// El emisor de plantillas de texto apuntaba a `{KAPSO_API_URL}/v1/whatsapp/messages/templates`, un
// endpoint que NO EXISTE en Kapso (404 de enrutado, página HTML de Django). Ninguna plantilla de
// texto salió nunca, y el 404 se leyó durante horas como "Meta no tiene la plantilla" — tanto que
// `requisicion_recibida` siguió fallando igual DESPUÉS de que Meta la aprobara.
//
// Ahora va por el proxy de Meta, el mismo transporte que `sendApprovalTemplate`. Estas pruebas fijan
// el CUERPO EXACTO, sin red: es lo único que separa un mensaje que llega de uno que Meta rechaza, y
// el primer envío real es a una persona, no a un entorno de pruebas.

const PROXY = "https://api.kapso.ai/meta/whatsapp/v24.0";
const PHONE_ID = "1221974497672719";

function respuestaOk() {
  return new Response(JSON.stringify({ messages: [{ id: "wamid.TEST" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
}
/** Cuerpo JSON de la primera llamada del espía. Tipado laxo a propósito: la firma de `fetch` tiene
 *  sobrecargas y no encaja con el genérico de MockInstance. */
function cuerpoEnviado(spy: { mock: { calls: unknown[][] } }) {
  const [, init] = spy.mock.calls[0] as [string, RequestInit];
  return JSON.parse(String(init.body));
}

describe("buildTextTemplatePayload — el cuerpo que Meta recibe", () => {
  it("usa parámetros CON NOMBRE, no posicionales", () => {
    // Es la diferencia con aprobacion_requisicion (posicional, {{1}}..{{4}}): las cinco de texto se
    // crearon con parameter_format NAMED, y en ese formato Meta NO interpola por posición.
    const payload = buildTextTemplatePayload({ to: "573001112233", template: "requisicion_recibida", payload: { consecutive: "REQ-2026-0011" } });
    expect(payload.template.components[0].parameters).toEqual([
      { type: "text", parameter_name: "consecutive", text: "REQ-2026-0011" },
    ]);
  });

  it("el nombre del parámetro coincide letra por letra con la variable declarada", () => {
    // El fallo que esto evita es mudo: Meta acepta el envío y entrega el mensaje con el hueco sin
    // rellenar. Se compara contra la definición, que es la que se mandó a aprobar.
    for (const nombre of Object.keys(PLANTILLAS_WHATSAPP) as Array<keyof typeof PLANTILLAS_WHATSAPP>) {
      const payload = buildTextTemplatePayload({ to: "573001112233", template: nombre, payload: { consecutive: "REQ-2026-0001" } });
      expect(payload.template.components[0].parameters.map((p) => p.parameter_name)).toEqual([...PLANTILLAS_WHATSAPP[nombre].variables]);
    }
  });

  it("declara plantilla, idioma y destinatario como espera la Cloud API", () => {
    const payload = buildTextTemplatePayload({ to: "573001112233", template: "pendiente_aprobador", payload: { consecutive: "REQ-2026-0007" } });
    expect(payload).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573001112233",
      type: "template",
      template: { name: "pendiente_aprobador", language: { code: "es" }, components: [{ type: "body" }] },
    });
  });

  it("una variable ausente viaja vacía en vez de como 'undefined'", () => {
    const payload = buildTextTemplatePayload({ to: "573001112233", template: "requisicion_recibida", payload: {} });
    expect(payload.template.components[0].parameters[0].text).toBe("");
  });
});

describe("sendKapsoTemplate — transporte", () => {
  beforeEach(() => {
    vi.stubEnv("KAPSO_API_KEY", "clave-de-prueba");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", PHONE_ID);
    vi.stubEnv("KAPSO_META_PROXY_URL", PROXY);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("publica en el proxy de Meta con X-API-Key, no en el endpoint inexistente de Kapso", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    await sendKapsoTemplate({ to: "573001112233", template: "requisicion_recibida", payload: { consecutive: "REQ-2026-0011" } });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PROXY}/${PHONE_ID}/messages`);
    expect(url).not.toContain("/v1/whatsapp/messages/templates");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("clave-de-prueba");
    // El emisor viejo mandaba `Authorization: Bearer`; el proxy no lo usa.
    expect(headers.authorization).toBeUndefined();
    expect(cuerpoEnviado(fetchSpy)).toMatchObject({ template: { name: "requisicion_recibida", language: { code: "es" } } });
  });

  it("lee el id del mensaje del formato de la Cloud API", async () => {
    // `{ messages: [{ id }] }`, no `{ id }` como asumía el emisor contra el endpoint inexistente.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    await expect(sendKapsoTemplate({ to: "573001112233", template: "requisicion_aprobada", payload: { consecutive: "REQ-2026-0001" } })).resolves.toEqual({ messageId: "wamid.TEST" });
  });

  it("una plantilla no declarada falla de forma visible y sin tocar la red", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(sendKapsoTemplate({ to: "573001112233", template: "plantilla_inventada", payload: {} })).rejects.toThrow("KAPSO_TEMPLATE_NOT_DECLARED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sin KAPSO_PHONE_NUMBER_ID falla cerrado, como sin API key", async () => {
    // El despachador trata KAPSO_NOT_CONFIGURED como "déjala pendiente, no gastes intento": sin
    // número de teléfono el proxy no tiene ni URL a la que ir, así que es el mismo caso.
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(sendKapsoTemplate({ to: "573001112233", template: "requisicion_recibida", payload: {} })).rejects.toThrow("KAPSO_NOT_CONFIGURED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("conserva el código de error de Meta, no solo el HTTP", async () => {
    // El despachador decide con ESE código si difiere sin gastar intento (plantilla ausente) o si
    // reintenta con backoff (cualquier otro 400). Con solo el HTTP no podría distinguirlos.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 132001, message: "Template name does not exist" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
    );
    await expect(sendKapsoTemplate({ to: "573001112233", template: "requisicion_recibida", payload: {} })).rejects.toThrow("KAPSO_SEND_FAILED_400_132001");
  });

  it("sin código de Meta se queda con el HTTP a secas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html>Page not found</html>", { status: 404 }));
    await expect(sendKapsoTemplate({ to: "573001112233", template: "requisicion_recibida", payload: {} })).rejects.toThrow("KAPSO_SEND_FAILED_404");
  });

  it("el error nunca repite el teléfono ni el contenido del mensaje", async () => {
    // `ultimo_error` se lee sin ceremonia desde la base; el mensaje de Meta puede traer el destino.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 131009, message: "Parameter value is not valid: 573001112233" } }), { status: 400, headers: { "Content-Type": "application/json" } }),
    );
    await expect(sendKapsoTemplate({ to: "573001112233", template: "requisicion_recibida", payload: { consecutive: "REQ-2026-0011" } }))
      .rejects.toThrow(/^KAPSO_SEND_FAILED_400_131009$/);
  });
});
