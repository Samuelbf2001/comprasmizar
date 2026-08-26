import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Candado HTTP del endpoint interno (503/401/200/500), mismo enfoque que
// tests/unit/dispatch-notifications-route.test.ts: se mockea el envío real para no tocar
// Postgres ni Kapso, y se prueba solo el candado + el mapeo de errores a status.
vi.mock("../../lib/infrastructure/flow-sender", () => ({ sendRequisitionFlow: vi.fn() }));

import { sendRequisitionFlow } from "../../lib/infrastructure/flow-sender";
import { POST } from "../../app/api/internal/send-flow/route";

const SECRETO = "secreto-de-prueba-suficientemente-largo";

function peticion(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/internal/send-flow", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("candado del endpoint interno de envío del Flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SEND_FLOW_SECRET;
  });
  afterEach(() => {
    delete process.env.SEND_FLOW_SECRET;
  });

  it("sin secreto configurado responde 503 y jamas envia (cerrado por defecto)", async () => {
    const res = await POST(peticion({ to: "573000000000" }, { "x-dispatch-secret": "cualquier-cosa" }));
    expect(res.status).toBe(503);
    expect(sendRequisitionFlow).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("con secreto configurado pero header ausente responde 401 sin enviar", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    const res = await POST(peticion({ to: "573000000000" }));
    expect(res.status).toBe(401);
    expect(sendRequisitionFlow).not.toHaveBeenCalled();
  });

  it("con header incorrecto responde 401 sin enviar", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    const res = await POST(peticion({ to: "573000000000" }, { "x-dispatch-secret": "secreto-equivocado-del-mismo-largo!!" }));
    expect(res.status).toBe(401);
    expect(sendRequisitionFlow).not.toHaveBeenCalled();
  });

  it("con body invalido (to ausente) responde 400 sin enviar", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    const res = await POST(peticion({}, { "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(400);
    expect(sendRequisitionFlow).not.toHaveBeenCalled();
  });

  it("con el secreto correcto y body valido envia y responde solo { ok, messageId }, sin telefonos", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    vi.mocked(sendRequisitionFlow).mockResolvedValue({ messageId: "wamid.ENVIADO1" });
    const res = await POST(peticion({ to: "573000000000" }, { "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(200);
    expect(sendRequisitionFlow).toHaveBeenCalledWith("573000000000");
    const cuerpo = await res.json();
    expect(cuerpo).toEqual({ ok: true, messageId: "wamid.ENVIADO1" });
    expect(JSON.stringify(cuerpo)).not.toContain("573000000000".slice(0, -1) + "X"); // sanity: no placeholder leak
  });

  it("sin KAPSO_API_KEY o WHATSAPP_FLOW_ID (fallo cerrado del emisor) responde 503 sin detalle", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    vi.mocked(sendRequisitionFlow).mockRejectedValue(new Error("FLOW_SEND_NOT_CONFIGURED"));
    const res = await POST(peticion({ to: "573000000000" }, { "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(503);
  });

  it("si el envio real revienta responde 500 sin filtrar el telefono en el cuerpo", async () => {
    process.env.SEND_FLOW_SECRET = SECRETO;
    vi.mocked(sendRequisitionFlow).mockRejectedValue(new Error("conexion caida con telefono +573001112233"));
    const res = await POST(peticion({ to: "573000000000" }, { "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(500);
    const cuerpo = JSON.stringify(await res.json());
    expect(cuerpo).not.toContain("+573001112233");
  });
});
