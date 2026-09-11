import { describe, expect, it, vi } from "vitest";

// `markSent` tiene que dejar el wamid en `notificaciones.kapso_message_id`.
//
// Es la ÚNICA clave que enlaza un acuse de entrega de WhatsApp con la fila de la cola
// (lib/infrastructure/whatsapp-delivery-status.ts). Si se pierde, todo lo demás sigue pareciendo que
// funciona —los acuses llegan, `whatsapp_eventos` se actualiza— pero la cola se queda diciendo
// `enviado` para mensajes que Meta descartó. Es decir, el fallo vuelve exactamente a donde estaba,
// una capa más arriba, y sin ningún síntoma que lo delate.
//
// Por eso esta prueba es de caja blanca y mira la CONSULTA: no hay forma de observar la columna
// desde fuera sin Postgres, y una prueba que no la mire no protege de que alguien la quite al
// refactorizar el `update`.
const consultas: { texto: string; valores: unknown[] }[] = [];

vi.mock("../../lib/infrastructure/postgres-repositories", () => {
  /** Tag de plantilla que registra la consulta en vez de ejecutarla. */
  const registrar = (strings: TemplateStringsArray | string[], ...valores: unknown[]) => {
    consultas.push({ texto: Array.isArray(strings) ? strings.join("?") : String(strings), valores });
    return Promise.resolve([]);
  };
  // `sql.begin(fn)` ejecuta la transacción pasando el mismo tag como `tx`.
  const sql = Object.assign(registrar, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql), json: (v: unknown) => v });
  return { sharedPostgres: () => sql };
});
vi.mock("../../lib/security/env", () => ({ runtimeEnv: () => ({ DATABASE_URL: "postgres://u:p@localhost:5432/db" }) }));

import { createPostgresNotificationDispatchStore } from "../../lib/infrastructure/notification-dispatcher";

describe("markSent deja la clave que enlaza el acuse con la cola", () => {
  it("el update de `notificaciones` incluye kapso_message_id con el wamid", async () => {
    consultas.length = 0;
    const store = createPostgresNotificationDispatchStore();
    const wamid = "wamid.HBgMNTczMDAyNDA4NzQzFQIAERgSN0Y2QzE5";
    await store.markSent("n-1", { messageId: wamid, phone: "573002408743", template: "requisicion_recibida", payload: {} }, new Date("2026-09-11T18:00:00Z"));

    const update = consultas.find((c) => c.texto.includes("update notificaciones"));
    expect(update, "no se encontró el update de notificaciones").toBeDefined();
    expect(update!.texto).toContain("kapso_message_id");
    expect(update!.valores).toContain(wamid);
  });

  it("la fila de whatsapp_eventos sigue llevando el mismo wamid", async () => {
    // Las dos escrituras tienen que coincidir: el acuse busca por `whatsapp_eventos.kapso_message_id`
    // para actualizar el evento, y por `notificaciones.kapso_message_id` para la cola. Si una llevara
    // el wamid y la otra no, se actualizaría media verdad.
    consultas.length = 0;
    const store = createPostgresNotificationDispatchStore();
    const wamid = "wamid.OTRO";
    await store.markSent("n-2", { messageId: wamid, phone: "573002408743", template: "pendiente_aprobador", payload: {} }, new Date("2026-09-11T18:00:00Z"));

    const evento = consultas.find((c) => c.texto.includes("insert into whatsapp_eventos"));
    expect(evento, "no se encontró el insert de whatsapp_eventos").toBeDefined();
    expect(evento!.valores).toContain(wamid);
  });
});
