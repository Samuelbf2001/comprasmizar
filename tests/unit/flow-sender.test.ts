import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "../../lib/security/crypto";
import {
  MAX_DROPDOWN_OPTIONS,
  buildFlowSendPayload,
  issueFlowToken,
  sendRequisitionFlow,
  type FlowCatalogSource,
  type FlowOption,
} from "../../lib/infrastructure/flow-sender";

const ENV_KEYS = ["KAPSO_API_KEY", "WHATSAPP_FLOW_ID", "KAPSO_PHONE_NUMBER_ID", "KAPSO_WEBHOOK_SECRET", "KAPSO_META_PROXY_URL", "WHATSAPP_FLOW_CTA", "WHATSAPP_FLOW_MODE"] as const;
const SECRETO = "secreto-webhook-de-prueba-bien-largo-32";

function configurarEnvCompleto(): void {
  process.env.KAPSO_API_KEY = "kapso-api-key-de-prueba";
  process.env.WHATSAPP_FLOW_ID = "1972861836748301";
  process.env.KAPSO_PHONE_NUMBER_ID = "1221974497672719";
  process.env.KAPSO_WEBHOOK_SECRET = SECRETO;
  process.env.KAPSO_META_PROXY_URL = "https://proxy.kapso.test/meta/whatsapp/v24.0";
}

/** BD mockeada: nunca toca Postgres. */
function fakeCatalogSource(obras: FlowOption[], catalogo: FlowOption[]): FlowCatalogSource {
  return {
    listActiveWorks: vi.fn(async () => obras),
    listActiveCatalogItems: vi.fn(async () => catalogo),
  };
}

function fakeFetchOk(messageId = "wamid.ABC123"): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ messaging_product: "whatsapp", contacts: [{ input: "573000000000", wa_id: "573000000000" }], messages: [{ id: messageId }] }), { status: 200 })) as unknown as typeof fetch;
}

describe("issueFlowToken — contrato con el receptor del webhook", () => {
  it("produce <timestampISO>.<hex> con el hex = hmac(telefono + '.' + timestampISO)", () => {
    const now = new Date("2026-08-25T12:34:56.789Z");
    const token = issueFlowToken("573000000000", "un-secreto-cualquiera", now);
    const esperado = `2026-08-25T12:34:56.789Z.${hmacSha256("573000000000.2026-08-25T12:34:56.789Z", "un-secreto-cualquiera")}`;
    expect(token).toBe(esperado);
  });

  it("el hex tiene 64 caracteres (sha256) y el timestampISO trae su propio punto interno", () => {
    const token = issueFlowToken("573000000000", "otro-secreto", new Date("2026-01-01T00:00:00.001Z"));
    const hex = token.slice(-64);
    const timestamp = token.slice(0, token.length - 65); // quita ".hex"
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
    expect(timestamp).toBe("2026-01-01T00:00:00.001Z");
    // El timestamp en sí contiene un punto (separador de milisegundos) — partir por el
    // PRIMER punto rompería el parseo; el contrato exige tomar los últimos 64 caracteres.
    expect(timestamp.split(".").length).toBeGreaterThan(1);
  });

  it("depende del teléfono: dos teléfonos distintos con el mismo timestamp producen tokens distintos", () => {
    const now = new Date("2026-08-25T12:34:56.789Z");
    const a = issueFlowToken("573000000000", SECRETO, now);
    const b = issueFlowToken("573000000001", SECRETO, now);
    expect(a).not.toBe(b);
  });
});

describe("buildFlowSendPayload — shape exacto del mensaje interactive.type=flow", () => {
  const obras: FlowOption[] = [{ id: "obra-1", title: "Obra La Pradera" }];
  const catalogo: FlowOption[] = [{ id: "item-1", title: "Cemento gris 50kg" }];

  it("arma flow_message_version 3, flow_action navigate y flow_action_payload.screen TIPO_Y_OBRA", () => {
    const payload = buildFlowSendPayload({ to: "573000000000", flowId: "1972861836748301", flowCta: "Solicitar", flowToken: "tok", bodyText: "Solicita materiales o pagos.", obras, catalogo, telefonoRemitente: "573000000000" });
    expect(payload).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "573000000000",
      type: "interactive",
      interactive: {
        type: "flow",
        body: { text: "Solicita materiales o pagos." },
        action: {
          name: "flow",
          parameters: {
            flow_message_version: "3",
            flow_id: "1972861836748301",
            flow_cta: "Solicitar",
            flow_action: "navigate",
            flow_token: "tok",
            flow_action_payload: {
              screen: "TIPO_Y_OBRA",
              data: { obras, catalogo, telefono_remitente: "573000000000" },
            },
          },
        },
      },
    });
  });

  it("incluye mode solo cuando se pasa explícitamente (el Flow real hoy es DRAFT)", () => {
    const conModo = buildFlowSendPayload({ to: "573000000000", flowId: "f", flowCta: "Solicitar", flowToken: "tok", mode: "draft", bodyText: "Texto", obras, catalogo, telefonoRemitente: "573000000000" });
    expect(conModo.interactive.action.parameters.mode).toBe("draft");
    const sinModo = buildFlowSendPayload({ to: "573000000000", flowId: "f", flowCta: "Solicitar", flowToken: "tok", bodyText: "Texto", obras, catalogo, telefonoRemitente: "573000000000" });
    expect(sinModo.interactive.action.parameters.mode).toBeUndefined();
  });

  it("siempre incluye interactive.body.text: Meta lo exige para todo tipo interactivo salvo location_request_message", () => {
    const payload = buildFlowSendPayload({ to: "573000000000", flowId: "f", flowCta: "Solicitar", flowToken: "tok", bodyText: "Solicita materiales o pagos.", obras, catalogo, telefonoRemitente: "573000000000" });
    expect(payload.interactive.body).toEqual({ text: "Solicita materiales o pagos." });
  });
});

describe("sendRequisitionFlow — fallo cerrado", () => {
  beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });
  afterEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });

  it("sin KAPSO_API_KEY responde con FLOW_SEND_NOT_CONFIGURED y no toca la BD mockeada", async () => {
    configurarEnvCompleto();
    delete process.env.KAPSO_API_KEY;
    const catalogSource = fakeCatalogSource([], []);
    const fetchImpl = fakeFetchOk();
    await expect(sendRequisitionFlow("573000000000", { catalogSource, fetchImpl })).rejects.toThrow("FLOW_SEND_NOT_CONFIGURED");
    expect(catalogSource.listActiveWorks).not.toHaveBeenCalled();
    expect(catalogSource.listActiveCatalogItems).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sin WHATSAPP_FLOW_ID responde con FLOW_SEND_NOT_CONFIGURED y no toca la BD mockeada", async () => {
    configurarEnvCompleto();
    delete process.env.WHATSAPP_FLOW_ID;
    const catalogSource = fakeCatalogSource([], []);
    await expect(sendRequisitionFlow("573000000000", { catalogSource, fetchImpl: fakeFetchOk() })).rejects.toThrow("FLOW_SEND_NOT_CONFIGURED");
    expect(catalogSource.listActiveWorks).not.toHaveBeenCalled();
  });

  it("sin KAPSO_PHONE_NUMBER_ID (no hay URL de envío posible) también falla cerrado", async () => {
    configurarEnvCompleto();
    delete process.env.KAPSO_PHONE_NUMBER_ID;
    await expect(sendRequisitionFlow("573000000000", { catalogSource: fakeCatalogSource([], []), fetchImpl: fakeFetchOk() })).rejects.toThrow("FLOW_SEND_NOT_CONFIGURED");
  });

  it("sin KAPSO_WEBHOOK_SECRET (no hay con qué firmar flow_token) también falla cerrado", async () => {
    configurarEnvCompleto();
    delete process.env.KAPSO_WEBHOOK_SECRET;
    await expect(sendRequisitionFlow("573000000000", { catalogSource: fakeCatalogSource([], []), fetchImpl: fakeFetchOk() })).rejects.toThrow("FLOW_SEND_NOT_CONFIGURED");
  });
});

describe("sendRequisitionFlow — envío real (fetch mockeado, BD mockeada)", () => {
  beforeEach(() => { for (const key of ENV_KEYS) delete process.env[key]; configurarEnvCompleto(); });
  afterEach(() => { for (const key of ENV_KEYS) delete process.env[key]; });

  it("llama al proxy de Kapso con el shape completo, incluidas obras/catalogo desde la BD mockeada y el flow_token", async () => {
    const obras: FlowOption[] = [{ id: "obra-1", title: "Obra La Pradera" }, { id: "obra-2", title: "Obra El Roble" }];
    const catalogo: FlowOption[] = [{ id: "item-1", title: "Cemento gris 50kg" }];
    const catalogSource = fakeCatalogSource(obras, catalogo);
    const fetchImpl = fakeFetchOk("wamid.ENVIADO1");
    const now = () => new Date("2026-08-25T10:00:00.000Z");

    const result = await sendRequisitionFlow("+57 300 000 0000", { catalogSource, fetchImpl, now });

    expect(result).toEqual({ messageId: "wamid.ENVIADO1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proxy.kapso.test/meta/whatsapp/v24.0/1221974497672719/messages");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("kapso-api-key-de-prueba");

    const body = JSON.parse(String(init.body));
    expect(body.to).toBe("573000000000"); // normalizado: solo dígitos
    expect(body.type).toBe("interactive");
    expect(body.interactive.type).toBe("flow");
    expect(typeof body.interactive.body.text).toBe("string");
    expect(body.interactive.body.text.length).toBeGreaterThan(0);
    expect(body.interactive.action.parameters.flow_id).toBe("1972861836748301");
    expect(body.interactive.action.parameters.flow_action_payload.data.obras).toEqual(obras);
    expect(body.interactive.action.parameters.flow_action_payload.data.catalogo).toEqual(catalogo);
    expect(body.interactive.action.parameters.flow_action_payload.data.telefono_remitente).toBe("573000000000");

    const esperadoToken = issueFlowToken("573000000000", SECRETO, now());
    expect(body.interactive.action.parameters.flow_token).toBe(esperadoToken);
  });

  it("respeta WHATSAPP_FLOW_MODE=draft (el Flow real hoy no está publicado)", async () => {
    process.env.WHATSAPP_FLOW_MODE = "draft";
    const fetchImpl = fakeFetchOk();
    await sendRequisitionFlow("573000000000", { catalogSource: fakeCatalogSource([], []), fetchImpl });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.interactive.action.parameters.mode).toBe("draft");
  });

  it("pide como máximo MAX_DROPDOWN_OPTIONS a cada dropdown (tope de Meta: 200 sin imágenes)", async () => {
    expect(MAX_DROPDOWN_OPTIONS).toBe(200);
    const catalogSource = fakeCatalogSource([], []);
    await sendRequisitionFlow("573000000000", { catalogSource, fetchImpl: fakeFetchOk() });
    expect(catalogSource.listActiveWorks).toHaveBeenCalledWith(MAX_DROPDOWN_OPTIONS);
    expect(catalogSource.listActiveCatalogItems).toHaveBeenCalledWith(MAX_DROPDOWN_OPTIONS);
  });

  it("propaga un status de Kapso distinto de 2xx como error sin filtrar el cuerpo de la respuesta", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: "algo con el telefono +573000000000" }), { status: 400 })) as unknown as typeof fetch;
    await expect(sendRequisitionFlow("573000000000", { catalogSource: fakeCatalogSource([], []), fetchImpl })).rejects.toThrow("FLOW_SEND_FAILED_400");
  });

  it("sin mensajes en la respuesta de Kapso falla con FLOW_SEND_RESPONSE_INVALID", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messaging_product: "whatsapp" }), { status: 200 })) as unknown as typeof fetch;
    await expect(sendRequisitionFlow("573000000000", { catalogSource: fakeCatalogSource([], []), fetchImpl })).rejects.toThrow("FLOW_SEND_RESPONSE_INVALID");
  });

  it("un 'to' sin dígitos falla con FLOW_SEND_INVALID_PHONE antes de tocar la BD o la red", async () => {
    const catalogSource = fakeCatalogSource([], []);
    const fetchImpl = fakeFetchOk();
    await expect(sendRequisitionFlow("no-es-un-telefono", { catalogSource, fetchImpl })).rejects.toThrow("FLOW_SEND_INVALID_PHONE");
    expect(catalogSource.listActiveWorks).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
