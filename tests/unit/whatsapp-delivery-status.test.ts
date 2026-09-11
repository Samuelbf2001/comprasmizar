import { describe, expect, it, vi } from "vitest";

// Acuses de entrega de WhatsApp. Lo que se vigila aquí es lo que la documentación de Kapso advierte
// y que, si se ignora, produce datos que MIENTEN en vez de faltar: "Deliveries are at-least-once and
// are not guaranteed to arrive in order".
//
// Es decir, dos cosas que no son casos raros sino el funcionamiento normal:
//  - el mismo acuse puede llegar dos veces;
//  - `sent` puede llegar DESPUÉS de `delivered`, y no puede hacer retroceder el estado.
//
// El módulo no toca Postgres para leer el evento, así que la traducción se prueba de verdad; solo se
// sustituye `sharedPostgres` para que el import no arrastre el driver.
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({ sharedPostgres: () => () => Promise.resolve([]) }));

import { esAcuseEntrega, leerAcuseEntrega } from "../../lib/infrastructure/whatsapp-delivery-status";

const WAMID = "wamid.HBgMNTczMDAyNDA4NzQzFQIAERgSN0Y2QzE5";

const acuse = (status: string, extra: Record<string, unknown> = {}) => ({
  message: { id: WAMID, timestamp: "1730092860", kapso: { direction: "outbound", status, ...extra } },
  conversation: { id: "c-1", phone_number: "573002408743", phone_number_id: "1221974497672719" },
});

describe("lectura de los cuatro eventos de estado", () => {
  it("sent y delivered se traducen a enviado y entregado", () => {
    expect(leerAcuseEntrega(acuse("sent"))).toEqual({ wamid: WAMID, estado: "enviado" });
    expect(leerAcuseEntrega(acuse("delivered"))).toEqual({ wamid: WAMID, estado: "entregado" });
  });

  it("read se guarda como entregado, no como un estado propio", () => {
    // El enum `estado_envio` no tiene `leido`, y para lo que la plataforma necesita saber —si el
    // aviso llegó— "leído" y "entregado" responden lo mismo. Añadir un valor obligaría a migración y
    // a revisar cada lectura del campo a cambio de un matiz que nadie pidió.
    expect(leerAcuseEntrega(acuse("read"))).toEqual({ wamid: WAMID, estado: "entregado" });
  });

  it("failed trae el motivo con el código de Meta por delante", () => {
    // El código es lo que sirve para buscar en la documentación cuando alguien pregunte por qué no
    // le llegó nada; el título solo, ambiguo entre versiones de la API.
    const payload = acuse("failed", {
      statuses: [{ errors: [{ code: 131047, title: "Re-engagement message", message: "More than 24 hours have passed since the recipient last replied" }] }],
    });
    expect(leerAcuseEntrega(payload)).toEqual({ wamid: WAMID, estado: "fallido", motivo: "131047 · Re-engagement message" });
  });

  it("el texto largo del error NO se guarda", () => {
    // Puede traer el teléfono, y esto acaba en una columna que se lee sin pensar.
    const payload = acuse("failed", { statuses: [{ errors: [{ code: 470, title: "Fuera de ventana", message: "El número 573001234567 no responde" }] }] });
    expect(leerAcuseEntrega(payload)?.motivo).not.toContain("573001234567");
  });

  it("un failed sin detalle de error se acepta igual, sin motivo", () => {
    expect(leerAcuseEntrega(acuse("failed"))).toEqual({ wamid: WAMID, estado: "fallido", motivo: undefined });
  });
});

describe("qué NO es un acuse", () => {
  it("un mensaje ENTRANTE no se confunde con uno, aunque traiga status", () => {
    // Es el riesgo real de la detección: `message.kapso` existe también en los entrantes. Si esto
    // fallara, un "hola" se tragaría por la rama de acuses y nadie recibiría el menú.
    const entrante = { message: { id: WAMID, from: "573002408743", type: "text", text: { body: "hola" }, kapso: { direction: "inbound", status: "delivered" } } };
    expect(esAcuseEntrega(entrante)).toBe(false);
  });

  it("un status desconocido se ignora en vez de inventarse un estado", () => {
    for (const status of ["queued", "accepted", "deleted", ""]) expect(esAcuseEntrega(acuse(status))).toBe(false);
  });

  it("sin wamid no hay nada que correlacionar", () => {
    expect(esAcuseEntrega({ message: { id: "", kapso: { direction: "outbound", status: "sent" } } })).toBe(false);
    expect(esAcuseEntrega({ message: { kapso: { direction: "outbound", status: "sent" } } })).toBe(false);
  });

  it("basura variada no revienta", () => {
    for (const basura of [null, undefined, {}, { message: {} }, { message: { id: WAMID } }, "texto", 42, []]) {
      expect(esAcuseEntrega(basura)).toBe(false);
    }
  });

  it("sin `direction` informada se acepta, para no quedarse sordo ante un cambio de formato", () => {
    // El filtro descarta lo marcado como entrante; la ausencia del campo no puede dejar el canal sin
    // acuses, que es el fallo que este trabajo viene a arreglar.
    expect(leerAcuseEntrega({ message: { id: WAMID, kapso: { status: "delivered" } } })).toEqual({ wamid: WAMID, estado: "entregado" });
  });
});
