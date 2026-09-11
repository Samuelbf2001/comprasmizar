import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDispatchStore, PendingNotification } from "../../lib/infrastructure/notification-dispatcher";

// Se prueba el CANDADO HTTP del endpoint interno (503/401/200/500). La lógica de despacho tiene su
// propia suite en tests/integration/notification-dispatcher.test.ts; aquí solo se mockea lo que
// tocaría Postgres o Kapso de verdad.
//
// EXCEPCIÓN DELIBERADA: la prueba de privacidad de abajo corre el despachador REAL. Antes mockeaba su
// resultado con `{ enviadas, fallidas, pendientes } as never` — claves que no existen: `DispatchOutcome`
// es `{ claimed, sent, retried, failed, deferred }`. Dos consecuencias, y la segunda es la grave:
//   1. afirmaba `cuerpo).toContain("enviadas")` sobre un cuerpo que en producción nunca dice eso, y el
//      `as never` silenció justo el error de tipos que lo habría cazado;
//   2. el bucle de "nunca teléfonos ni contenido" —el PROPÓSITO de la prueba— recorría un objeto
//      inventado de tres números, donde un teléfono no podía aparecer ni queriendo. Es decir: no
//      existía ninguna comprobación real de que esta ruta no filtre datos personales.
const real = vi.hoisted(() => ({ dispatch: null as unknown as typeof import("../../lib/infrastructure/notification-dispatcher")["dispatchPendingNotifications"] }));
vi.mock("../../lib/infrastructure/notification-dispatcher", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/infrastructure/notification-dispatcher")>();
  real.dispatch = original.dispatchPendingNotifications;
  return { ...original, dispatchPendingNotifications: vi.fn(), createPostgresNotificationDispatchStore: vi.fn(() => ({})) };
});
// `META_ERRORES_PLANTILLA_AUSENTE` se reexporta porque el despachador REAL lo importa de aquí.
vi.mock("../../lib/infrastructure/kapso", () => ({ sendKapsoTemplate: vi.fn(), META_ERRORES_PLANTILLA_AUSENTE: new Set([132001]) }));

import { sendKapsoTemplate } from "../../lib/infrastructure/kapso";
import { createPostgresNotificationDispatchStore, dispatchPendingNotifications } from "../../lib/infrastructure/notification-dispatcher";
import { POST } from "../../app/api/internal/dispatch-notifications/route";

const SECRETO = "secreto-de-prueba-suficientemente-largo";

function peticion(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/internal/dispatch-notifications", { method: "POST", headers });
}

/**
 * Notificaciones con PII de verdad: teléfono real en `phone` y texto del mensaje en `payload`.
 * Si la ruta filtrara algo, tendría que salir de aquí.
 */
const TELEFONO = "+573001112233";
const CONTENIDO = "Cemento gris 50 kg para la obra de Juliana";
function notificacionesConPii(): PendingNotification[] {
  return [
    { id: "n-1", phone: TELEFONO, template: "requisicion_recibida", payload: { requisitionId: "11111111-1111-4111-8111-111111111111", consecutive: "REQ-2026-0011", descripcion: CONTENIDO }, attempts: 0 },
    { id: "n-2", phone: "+573109998877", template: "requisicion_aprobada", payload: { requisitionId: "22222222-2222-4222-8222-222222222222", consecutive: "REQ-2026-0012", descripcion: CONTENIDO }, attempts: 0 },
  ];
}

/** Almacén de mentira con lease: `claimBatch` vacía la cola, como el real. */
function almacenFalso(pendientes: PendingNotification[]): NotificationDispatchStore {
  const cola = [...pendientes];
  return {
    claimBatch: async (limit) => cola.splice(0, limit),
    markSent: async () => {},
    markRetry: async () => {},
    markFailed: async () => {},
    release: async () => {},
  };
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

  it("responde el DispatchOutcome real, con sus claves y nada más", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    vi.mocked(createPostgresNotificationDispatchStore).mockReturnValue(almacenFalso(notificacionesConPii()));
    vi.mocked(dispatchPendingNotifications).mockImplementation(real.dispatch);
    vi.mocked(sendKapsoTemplate).mockResolvedValue({ messageId: "wamid.1" });

    const res = await POST(peticion({ "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(200);
    const cuerpo = (await res.json()) as Record<string, unknown>;
    // Las claves EXACTAS, no un `toContain` sobre el texto: así se ve enseguida si alguien añade al
    // resultado algo que no son conteos (ids, errores, destinatarios).
    expect(Object.keys(cuerpo).sort()).toEqual(["claimed", "deferred", "failed", "ok", "retried", "sent"]);
    expect(cuerpo).toMatchObject({ ok: true, claimed: 2, sent: 2, retried: 0, failed: 0, deferred: 0 });
  });

  it("nunca deja salir el telefono ni el contenido del mensaje", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    const pendientes = notificacionesConPii();
    vi.mocked(createPostgresNotificationDispatchStore).mockReturnValue(almacenFalso(pendientes));
    vi.mocked(dispatchPendingNotifications).mockImplementation(real.dispatch);
    vi.mocked(sendKapsoTemplate).mockResolvedValue({ messageId: "wamid.1" });

    const res = await POST(peticion({ "x-dispatch-secret": SECRETO }));
    const cuerpo = JSON.stringify(await res.json());

    // AUTOCOMPROBACIÓN: los datos de entrada TIENEN que contener lo prohibido, o el bucle de abajo
    // no prueba nada. Es exactamente el fallo que tenía esta prueba: afirmaba "no hay teléfonos"
    // sobre un objeto donde no podía haberlos. Si alguien limpia estos fixtures, esto lo avisa.
    const entrada = JSON.stringify(pendientes);
    for (const prohibido of [TELEFONO, CONTENIDO, "REQ-2026-0011", "11111111-1111-4111-8111-111111111111"]) {
      expect(entrada, `el fixture debe contener "${prohibido}" para que la prueba signifique algo`).toContain(prohibido);
      expect(cuerpo, `la ruta filtró "${prohibido}"`).not.toContain(prohibido);
    }
    // Y que sí llegó a enviarse: sin esto, una ruta que no despachara nada pasaría el bucle de arriba.
    expect(sendKapsoTemplate).toHaveBeenCalledTimes(2);
  });

  it("si el despacho revienta responde 500 sin filtrar detalles del error", async () => {
    process.env.NOTIFICATION_DISPATCH_SECRET = SECRETO;
    vi.mocked(dispatchPendingNotifications).mockRejectedValue(new Error(`conexion caida con telefono ${TELEFONO}`));
    const res = await POST(peticion({ "x-dispatch-secret": SECRETO }));
    expect(res.status).toBe(500);
    const cuerpo = JSON.stringify(await res.json());
    expect(cuerpo).not.toContain(TELEFONO);
    expect(cuerpo).toContain("dispatch_failed");
  });
});
