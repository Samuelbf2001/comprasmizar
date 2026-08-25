import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Se prueba el CANDADO HTTP del endpoint interno (503/401/200/500), no la
// logica de despacho: esa ya tiene su propia suite en
// tests/integration/notification-dispatcher.test.ts. Los modulos de
// infraestructura se mockean para no tocar Postgres ni Kapso.
vi.mock("../../lib/infrastructure/notification-dispatcher", () => ({
  dispatchPendingNotifications: vi.fn(),
  createPostgresNotificationDispatchStore: vi.fn(() => ({})),
}));
vi.mock("../../lib/infrastructure/kapso", () => ({ sendKapsoTemplate: vi.fn() }));

import { dispatchPendingNotifications } from "../../lib/infrastructure/notification-dispatcher";
import { POST } from "../../app/api/internal/dispatch-notifications/route";

const SECRETO = "secreto-de-prueba-suficientemente-largo";

function peticion(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/internal/dispatch-notifications", { method: "POST", headers });
}

describe("candado del endpoint interno de notificaciones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NOTIFICATION_DISPATCH_SECRET;
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DISPATCH_SECRET;
  });

  it("sin secreto configurado responde 503 y jamas toca la cola (cerrado por defecto)", async () => {
    const res = await POST(peticion({ "x-dispatch-secret": "cualquier-cosa" }));
    expect(res.status).toBe(503);
    expect(dispatchPendingNotifications).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("con secreto configurado pero header ausente responde 401 sin tocar la cola", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    const res = await POST(peticion());
    expect(res.status).toBe(401);
    expect(dispatchPendingNotifications).not.toHaveBeenCalled();
  });

  it("con header incorrecto responde 401 sin tocar la cola", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    const res = await POST(peticion({ "x-dispatch-secret": "secreto-equivocado-del-mismo-largo!!" }));
    expect(res.status).toBe(401);
    expect(dispatchPendingNotifications).not.toHaveBeenCalled();
  });

  it("con el secreto correcto despacha y responde solo conteos, nunca telefonos ni contenido", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    vi.mocked(dispatchPendingNotifications).mockResolvedValue({ enviadas: 2, fallidas: 1, pendientes: 0 } as never);
    const res = await POST(peticion({ "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(200);
    expect(dispatchPendingNotifications).toHaveBeenCalledTimes(1);
    const cuerpo = JSON.stringify(await res.json());
    expect(cuerpo).toContain("enviadas");
    for (const prohibido of ["telefono", "phone", "plantilla_payload", "+57", "mensaje"]) {
      expect(cuerpo).not.toContain(prohibido);
    }
  });

  it("si el despacho revienta responde 500 sin filtrar detalles del error", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    vi.mocked(dispatchPendingNotifications).mockRejectedValue(new Error("conexion caida con telefono +573001112233"));
    const res = await POST(peticion({ "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(500);
    const cuerpo = JSON.stringify(await res.json());
    expect(cuerpo).not.toContain("+573001112233");
    expect(cuerpo).toContain("dispatch_failed");
  });
});
