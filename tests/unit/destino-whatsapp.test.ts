import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destinatarioWhatsApp } from "../../lib/infrastructure/phone";
import { buildTextTemplatePayload, sendKapsoTemplate } from "../../lib/infrastructure/kapso";
import { normalizeApprovalPhone } from "../../lib/infrastructure/approval-flow-sender";

// TODO aviso dirigido a un USUARIO de la plataforma salía a un número inválido y Meta lo descartaba.
// `usuarios.telefono` guarda el número local ("3002408743") y los emisores lo mandaban sin tocar.
// Kapso ACEPTA la llamada y devuelve un `wamid` —así que la cola lo marcaba `enviado`— pero Meta
// responde después `failed`, por un evento de estado al que el webhook no está suscrito. El aviso no
// llegaba y el sistema decía que sí.
//
// Medido el 11-sep-2026 contra la API de Kapso: cinco envíos a "3002408743" ese día terminaron en
// `failed` (el Flow de aprobación, el `pendiente_aprobador` de REQ-2026-0011 y su
// `requisicion_aprobada`), mientras que los dirigidos a "+573002408743" —portal y router, que toman
// el número del `from` de Meta— llegaron. Kapso tenía DOS conversaciones para la misma persona.

const LOCAL = "3002408743";
const E164 = "573002408743";

describe("destinatarioWhatsApp — la forma canónica del destino", () => {
  it("un móvil colombiano local gana el indicativo", () => {
    expect(destinatarioWhatsApp(LOCAL)).toBe(E164);
  });

  it("con '+' y espacios queda igual de canónico", () => {
    expect(destinatarioWhatsApp("+57 300 240 8743")).toBe(E164);
  });

  it("uno ya en E.164 no se toca", () => {
    expect(destinatarioWhatsApp(E164)).toBe(E164);
  });

  it("un número que NO es de 10 dígitos no se maquilla", () => {
    // Siete dígitos: un fijo antiguo, o un dato mal cargado. Inventarle un indicativo lo mandaría a
    // otra persona. Se deja como está y que Meta lo rechace, que es visible.
    expect(destinatarioWhatsApp("1234567")).toBe("1234567");
    expect(destinatarioWhatsApp("+1 415 555 0100")).toBe("14155550100");
  });
});

describe("el emisor de plantillas manda el destino canónico", () => {
  beforeEach(() => {
    vi.stubEnv("KAPSO_API_KEY", "clave-de-prueba");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "1221974497672719");
    vi.stubEnv("KAPSO_META_PROXY_URL", "https://api.kapso.ai/meta/whatsapp/v24.0");
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const respuestaOk = () => new Response(JSON.stringify({ messages: [{ id: "wamid.T" }] }), { status: 200, headers: { "Content-Type": "application/json" } });

  async function destinoEnviado(to: string): Promise<string> {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(respuestaOk());
    await sendKapsoTemplate({ to, template: "requisicion_recibida", payload: { consecutive: "REQ-2026-0011" } });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    return JSON.parse(String(init.body)).to;
  }

  it("convierte el número local antes de mandarlo", async () => {
    // Es EXACTAMENTE el caso que falló: `pendiente_aprobador` y `requisicion_aprobada` de la
    // REQ-2026-0011 salieron a "3002408743" y Meta las descartó.
    await expect(destinoEnviado(LOCAL)).resolves.toBe(E164);
  });

  it("deja intacto uno que ya venga en E.164", async () => {
    await expect(destinoEnviado(E164)).resolves.toBe(E164);
  });

  it("no maquilla un número de otro largo", async () => {
    await expect(destinoEnviado("1234567")).resolves.toBe("1234567");
  });

  it("el cuerpo puro también lo refleja", () => {
    // `buildTextTemplatePayload` recibe el destino YA canónico; se fija aquí para que se vea que el
    // `to` del cuerpo es el que viaja, sin otra transformación intermedia.
    expect(buildTextTemplatePayload({ to: E164, template: "requisicion_recibida", payload: { consecutive: "REQ-2026-0011" } }).to).toBe(E164);
  });
});

describe("el teléfono del aprobador: el que se envía es el que se firma", () => {
  it("normalizeApprovalPhone canoniza igual que el destino", () => {
    // Antes era solo "quita los no-dígitos", y eso rompía DOS cosas a la vez: el envío salía sin
    // indicativo, y el token se firmaba sobre el número local.
    expect(normalizeApprovalPhone(LOCAL)).toBe(E164);
    expect(normalizeApprovalPhone("+57 300 240 8743")).toBe(E164);
    expect(normalizeApprovalPhone(E164)).toBe(E164);
  });

  it("el número guardado y el `from` que devuelve Meta resuelven al MISMO valor", () => {
    // La segunda mitad del defecto, y la que no se veía: cuando el aprobador contesta, Meta entrega
    // `message.from` en E.164. `validateApprovalFlowToken` normaliza ese `from` con esta función y lo
    // compara contra una firma hecha sobre el teléfono de `usuarios.telefono`. Si los dos no
    // resuelven igual, la firma no valida y la aprobación del aprobador se rechaza — aunque el
    // mensaje hubiera llegado.
    expect(normalizeApprovalPhone(LOCAL)).toBe(normalizeApprovalPhone(E164));
  });
});
