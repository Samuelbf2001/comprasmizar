import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Router de entrantes de WhatsApp (lib/infrastructure/whatsapp-router.ts). Lo que se vigila aquí no
// es el camino feliz sino cuatro cosas que, si se rompen, lo hacen en silencio: que el router no le
// robe el mensaje a las dos ramas de Flow, que la consulta de estado normalice el teléfono por los
// dos lados, que una reentrega no salude dos veces, y que un fallo de envío NUNCA convierta un
// entrante en excepción.
//
// Mismo patrón de mocks que tests/unit/server-actor.test.ts: se sustituye `sharedPostgres` para
// probar solo esta capa, sin Postgres real. Las dos fábricas `createPostgres*` del módulo son
// perezosas (solo se construyen si no se inyecta la dependencia), así que las pruebas inyectan
// siempre y el mock existe únicamente para que el import del módulo no arrastre el driver.
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({ sharedPostgres: () => () => Promise.resolve([]) }));

import { PAYMENT_FLOW_ENTRY_SCREEN, sendPaymentFlow } from "../../lib/infrastructure/flow-sender";
import {
  BOTON_ESTADO_REQUISICIONES,
  BOTON_NUEVA_REQUISICION,
  BOTON_SOLICITAR_PAGO,
  atenderMensajeEntrante,
  construirMenu,
  construirTexto,
  esMensajeEnrutable,
  estaRouterConfigurado,
  formatearRespuestaEstado,
  leerMensajeBoton,
  leerMensajeTexto,
  type RequisicionResumen,
} from "../../lib/infrastructure/whatsapp-router";

const TELEFONO = "573124358315";
const WAMID = "wamid.HBgKMzEyNDM1ODMxNRUCABEYEjBBQkNERUY=";
const LINEA_MIZAR = "1221974497672719";
const LINEA_SIXTEAM = "1109228638946478";

const entranteTexto = (body = "hola") => ({ message: { id: WAMID, from: TELEFONO, type: "text", text: { body } } });
const entranteBoton = (id: string) => ({ message: { id: WAMID, from: TELEFONO, type: "interactive", interactive: { type: "button_reply", button_reply: { id, title: "x" } } } });
const entranteFlow = () => ({ message: { id: WAMID, from: TELEFONO, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: "{}" } } } });

const ENV = { KAPSO_API_KEY: "k".repeat(32), KAPSO_PHONE_NUMBER_ID: LINEA_MIZAR, DATABASE_URL: "postgres://u:p@localhost:5432/db", STORAGE_ROOT: "/tmp/mizar", STORAGE_SIGNING_SECRET: "s".repeat(32) };
const guardado: Record<string, string | undefined> = {};

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) { guardado[k] = process.env[k]; process.env[k] = v; } });
afterEach(() => { for (const [k, v] of Object.entries(guardado)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

/** Registro en memoria: reclama una sola vez por wamid, igual que el índice único de Postgres. */
function registroEspia() {
  const reclamados = new Set<string>();
  const cerrados: { clase: string; resultado: string }[] = [];
  return {
    cerrados,
    registro: {
      reclamar: async ({ wamid }: { wamid: string }) => (reclamados.has(wamid) ? false : (reclamados.add(wamid), true)),
      cerrar: async (input: { clase: string; resultado: string }) => { cerrados.push({ clase: input.clase, resultado: input.resultado }); },
    },
  };
}

/** Captura lo que se habría enviado a Meta, sin red. */
function fetchEspia(respuesta: { status?: number } = {}) {
  const enviados: unknown[] = [];
  const impl = (async (_url: string, init?: RequestInit) => {
    enviados.push(JSON.parse(String(init?.body)));
    return { ok: respuesta.status ? respuesta.status < 400 : true, status: respuesta.status ?? 200, json: async () => ({ messages: [{ id: "wamid.SALIDA" }] }) } as Response;
  }) as unknown as typeof fetch;
  return { enviados, impl };
}

describe("reconocimiento del entrante", () => {
  it("lee un mensaje de texto y una pulsación de botón", () => {
    expect(leerMensajeTexto(entranteTexto("Buenas"))).toEqual({ wamid: WAMID, from: TELEFONO, texto: "Buenas" });
    expect(leerMensajeBoton(entranteBoton(BOTON_NUEVA_REQUISICION))).toEqual({ wamid: WAMID, from: TELEFONO, botonId: BOTON_NUEVA_REQUISICION });
  });

  it("NO reclama las respuestas de Flow: son de las otras dos ramas del webhook", () => {
    // Si esto fallara, el router se quedaría con los envíos del Flow de captura y del de aprobación
    // —que sí crean y deciden requisiciones— y los contestaría con un menú. Es la regresión más
    // cara posible de este archivo, y por eso está fijada aquí.
    expect(esMensajeEnrutable(entranteFlow())).toBe(false);
    expect(leerMensajeBoton(entranteFlow())).toBeNull();
    expect(leerMensajeTexto(entranteFlow())).toBeNull();
  });

  it("rechaza basura sin reventar", () => {
    for (const basura of [null, undefined, {}, { message: {} }, { message: { id: "", from: TELEFONO, type: "text" } }, { message: { id: WAMID, from: "", type: "text" } }, "texto", 42]) {
      expect(esMensajeEnrutable(basura)).toBe(false);
    }
  });
});

describe("mensajes que se construyen", () => {
  it("el menú lleva exactamente los tres botones del contrato, y tres es el tope de WhatsApp", () => {
    // RF-902 modificado (adenda de pagos): "Montar requisición" Y "Solicitar un pago". Un cuarto
    // botón no cabe: WhatsApp rechaza el mensaje interactivo de tipo button con más de tres.
    const menu = construirMenu(TELEFONO) as unknown as { interactive: { type: string; action: { buttons: { reply: { id: string; title: string } }[] } } };
    expect(menu.interactive.type).toBe("button");
    expect(menu.interactive.action.buttons.map((b) => b.reply.id)).toEqual([BOTON_NUEVA_REQUISICION, BOTON_SOLICITAR_PAGO, BOTON_ESTADO_REQUISICIONES]);
    expect(menu.interactive.action.buttons.length).toBeLessThanOrEqual(3);
  });

  it("ningún título de botón pasa de 20 caracteres", () => {
    // WhatsApp no rechaza el mensaje: lo TRUNCA. Un título cortado a mitad de palabra solo se
    // descubre mirando el chat en un móvil real, así que se fija aquí.
    const menu = construirMenu(TELEFONO) as unknown as { interactive: { action: { buttons: { reply: { title: string } }[] } } };
    for (const boton of menu.interactive.action.buttons) expect(boton.reply.title.length).toBeLessThanOrEqual(20);
  });

  it("el interactivo lleva body.text, que Meta exige", () => {
    // Omitirlo es un 400 real de Meta, no un aviso.
    const menu = construirMenu(TELEFONO) as unknown as { interactive: { body: { text: string } } };
    expect(menu.interactive.body.text.length).toBeGreaterThan(0);
  });

  it("el texto no pide vista previa de enlaces", () => {
    const texto = construirTexto(TELEFONO, "hola") as unknown as { text: { preview_url: boolean; body: string } };
    expect(texto.text).toEqual({ preview_url: false, body: "hola" });
  });
});

describe("respuesta de estado", () => {
  const fila = (consecutivo: string, estado: string): RequisicionResumen => ({ consecutivo, estado, fecha: "2026-09-11" });

  it("sin requisiciones responde algo accionable, no un vacío", () => {
    expect(formatearRespuestaEstado([])).toContain("Montar requisición");
  });

  it("traduce el enum a algo legible", () => {
    const salida = formatearRespuestaEstado([fila("REQ-2026-0002", "en_revision"), fila("REQ-2026-0003", "en_aprobacion")]);
    expect(salida).toContain("En revisión");
    expect(salida).toContain("Esperando aprobación");
    expect(salida).not.toContain("en_revision");
    expect(salida).not.toContain("_");
  });

  it("un estado desconocido se muestra tal cual en vez de desaparecer", () => {
    expect(formatearRespuestaEstado([fila("REQ-2026-0004", "estado_nuevo")])).toContain("estado_nuevo");
  });

  it("una solicitud de pago se distingue en la lista: las dos llevan consecutivo REQ-", () => {
    const salida = formatearRespuestaEstado([{ ...fila("REQ-2026-0005", "enviada"), tipo: "pago" }, { ...fila("REQ-2026-0006", "enviada"), tipo: "compra" }]);
    const lineas = salida.split("\n").slice(1);
    expect(lineas[0]).toContain("Pago · Enviada");
    expect(lineas[1]).not.toContain("Pago");
  });
});

describe("atenderMensajeEntrante", () => {
  it("un texto suelto recibe el menú", async () => {
    const { enviados, impl } = fetchEspia();
    const resultado = await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl, registro: registroEspia().registro });
    expect(resultado).toEqual({ atendido: true, accion: "menu", resultado: "ok" });
    expect((enviados[0] as { interactive: { type: string } }).interactive.type).toBe("button");
  });

  it("el botón de montar requisición dispara el Flow, no un texto", async () => {
    // Los dos mensajes son necesarios porque WhatsApp no admite un Flow y botones de respuesta en
    // el mismo mensaje; esta prueba fija que el segundo paso sea REALMENTE el Flow.
    const { enviados, impl } = fetchEspia();
    const flows: string[] = [];
    const resultado = await atenderMensajeEntrante(entranteBoton(BOTON_NUEVA_REQUISICION), {
      fetchImpl: impl, registro: registroEspia().registro,
      enviarFlow: async (to) => { flows.push(to); return { messageId: "wamid.FLOW" }; },
    });
    expect(resultado.atendido && resultado.accion).toBe("flow");
    expect(flows).toEqual([TELEFONO]);
    expect(enviados).toHaveLength(0);
  });

  it("el botón de solicitar un pago dispara el Flow de PAGO: ni el de captura ni un texto", async () => {
    const { enviados, impl } = fetchEspia();
    const capturas: string[] = [];
    const pagos: string[] = [];
    const espia = registroEspia();
    const resultado = await atenderMensajeEntrante(entranteBoton(BOTON_SOLICITAR_PAGO), {
      fetchImpl: impl, registro: espia.registro,
      enviarFlow: async (to) => { capturas.push(to); return { messageId: "wamid.CAPTURA" }; },
      enviarFlowPago: async (to) => { pagos.push(to); return { messageId: "wamid.PAGO" }; },
    });
    expect(resultado).toEqual({ atendido: true, accion: "flow_pago", resultado: "ok" });
    expect(pagos).toEqual([TELEFONO]);
    expect(capturas).toEqual([]);
    expect(enviados).toHaveLength(0);
    expect(espia.cerrados).toEqual([{ clase: "flow_pago", resultado: "ok" }]);
  });

  it("el Flow de pago sale con el id de WHATSAPP_FLOW_PAGO_ID (no el de captura) y abre en su pantalla de entrada", async () => {
    // Aquí el emisor es el real (`sendPaymentFlow`), con la BD y la red sustituidas: es la única
    // prueba que ata el botón del menú al Flow correcto de Meta. Con el id de captura, el maestro
    // vería el formulario de materiales al pedir un pago.
    process.env.KAPSO_WEBHOOK_SECRET = "secreto-webhook-de-prueba-bien-largo-32";
    process.env.WHATSAPP_FLOW_ID = "1111111111111111";
    process.env.WHATSAPP_FLOW_PAGO_ID = "2222222222222222";
    try {
      const { enviados, impl } = fetchEspia();
      const sociedades = [{ id: "Mizar", title: "Mizar" }];
      const catalogSource = { listActiveSocieties: async () => sociedades, listActiveCatalogItems: async () => { throw new Error("el Flow de pago no lleva catálogo"); } };
      const resultado = await atenderMensajeEntrante(entranteBoton(BOTON_SOLICITAR_PAGO), {
        registro: registroEspia().registro,
        enviarFlowPago: (to) => sendPaymentFlow(to, { catalogSource, fetchImpl: impl }),
      });
      expect(resultado).toEqual({ atendido: true, accion: "flow_pago", resultado: "ok" });
      expect(enviados).toHaveLength(1);
      const mensaje = enviados[0] as { to: string; interactive: { type: string; action: { parameters: { flow_id: string; flow_token: string; flow_action_payload: { screen: string; data: Record<string, unknown> } } } } };
      expect(mensaje.to).toBe(TELEFONO);
      expect(mensaje.interactive.type).toBe("flow");
      expect(mensaje.interactive.action.parameters.flow_id).toBe("2222222222222222");
      expect(mensaje.interactive.action.parameters.flow_token).toMatch(/\.[0-9a-f]{64}$/);
      expect(mensaje.interactive.action.parameters.flow_action_payload).toEqual({ screen: PAYMENT_FLOW_ENTRY_SCREEN, data: { sociedades } });
    } finally {
      delete process.env.KAPSO_WEBHOOK_SECRET;
      delete process.env.WHATSAPP_FLOW_ID;
      delete process.env.WHATSAPP_FLOW_PAGO_ID;
    }
  });

  it("sin WHATSAPP_FLOW_PAGO_ID el botón de pago falla cerrado, no lanza y queda registrado con su código", async () => {
    process.env.KAPSO_WEBHOOK_SECRET = "secreto-webhook-de-prueba-bien-largo-32";
    delete process.env.WHATSAPP_FLOW_PAGO_ID;
    try {
      const { enviados, impl } = fetchEspia();
      const espia = registroEspia();
      const resultado = await atenderMensajeEntrante(entranteBoton(BOTON_SOLICITAR_PAGO), { fetchImpl: impl, registro: espia.registro, enviarFlowPago: (to) => sendPaymentFlow(to, { fetchImpl: impl }) });
      expect(resultado).toEqual({ atendido: true, accion: "flow_pago", resultado: "error:PAYMENT_FLOW_NOT_CONFIGURED" });
      expect(enviados).toHaveLength(0);
      expect(espia.cerrados).toEqual([{ clase: "flow_pago", resultado: "error:PAYMENT_FLOW_NOT_CONFIGURED" }]);
    } finally {
      delete process.env.KAPSO_WEBHOOK_SECRET;
    }
  });

  it("el botón de estado consulta con el teléfono NORMALIZADO y responde el resumen", async () => {
    const { enviados, impl } = fetchEspia();
    const consultados: string[] = [];
    await atenderMensajeEntrante(entranteBoton(BOTON_ESTADO_REQUISICIONES), {
      fetchImpl: impl, registro: registroEspia().registro,
      fuenteEstado: { listarPorTelefono: async (telefono) => { consultados.push(telefono); return [{ consecutivo: "REQ-2026-0007", estado: "aprobada", fecha: "2026-09-11" }]; } },
    });
    expect(consultados).toEqual([TELEFONO]);
    expect((enviados[0] as { text: { body: string } }).text.body).toContain("REQ-2026-0007");
  });

  it("un número local de 10 dígitos se homologa antes de consultar", async () => {
    // El espejo exacto de `public.normalizar_telefono_co`. Sin esto, un teléfono guardado a mano
    // como "3124358315" nunca casaría con el "573124358315" que entrega WhatsApp, y la persona
    // vería "no encuentro requisiciones" teniendo varias.
    const { impl } = fetchEspia();
    const consultados: string[] = [];
    await atenderMensajeEntrante(
      { message: { id: WAMID, from: "3124358315", type: "interactive", interactive: { type: "button_reply", button_reply: { id: BOTON_ESTADO_REQUISICIONES, title: "x" } } } },
      { fetchImpl: impl, registro: registroEspia().registro, fuenteEstado: { listarPorTelefono: async (t) => { consultados.push(t); return []; } } },
    );
    expect(consultados).toEqual(["573124358315"]);
  });

  it("un botón desconocido devuelve el menú, y queda registrado como tal", async () => {
    // El caso real: alguien conserva en el chat un menú de una versión anterior y lo pulsa meses
    // después. Devolver el menú actual es más útil que ignorarlo. Se asserta también el registro
    // porque si `cerrar` dejara de llamarse en esta rama, la fila se quedaría en 'pendiente' para
    // siempre y nadie lo notaría.
    const { enviados, impl } = fetchEspia();
    const espia = registroEspia();
    const resultado = await atenderMensajeEntrante(entranteBoton("boton_de_una_version_vieja"), { fetchImpl: impl, registro: espia.registro });
    expect(resultado.atendido && resultado.accion).toBe("menu");
    expect(enviados).toHaveLength(1);
    expect(espia.cerrados).toEqual([{ clase: "menu", resultado: "ok" }]);
  });

  it("una reentrega del MISMO mensaje no vuelve a saludar", async () => {
    // Kapso reentrega cuando el webhook tarda. Sin reclamar el wamid ANTES de enviar, la persona
    // recibiría el saludo dos o tres veces por haber escrito una.
    const { enviados, impl } = fetchEspia();
    const espia = registroEspia();
    const primera = await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl, registro: espia.registro });
    const segunda = await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl, registro: espia.registro });
    expect(primera.atendido && primera.resultado).toBe("ok");
    expect(segunda.atendido && segunda.resultado).toBe("duplicado");
    expect(enviados).toHaveLength(1);
  });

  it("si la reclamación falla se responde igual: mejor saludar dos veces que dejar a alguien sin respuesta", async () => {
    const { enviados, impl } = fetchEspia();
    await atenderMensajeEntrante(entranteTexto(), {
      fetchImpl: impl,
      registro: { reclamar: async () => { throw new Error("base caída"); }, cerrar: async () => {} },
    });
    expect(enviados).toHaveLength(1);
  });

  it("también se descarta si la otra línea viene solo en conversation", async () => {
    // La raíz es lo normal, pero si algún día llegara un evento que solo informe la línea dentro de
    // `conversation`, el filtro tiene que seguir cerrando. Con el respaldo apuntando a `metadata`
    // —que no existe en la envoltura v2— este caso pasaba de largo.
    const { enviados, impl } = fetchEspia();
    const espia = registroEspia();
    const resultado = await atenderMensajeEntrante({ ...entranteTexto(), conversation: { phone_number_id: LINEA_SIXTEAM } }, { fetchImpl: impl, registro: espia.registro });
    expect(resultado).toEqual({ atendido: false, motivo: "otra_linea" });
    expect(enviados).toHaveLength(0);
    expect(espia.cerrados).toHaveLength(0);
  });

  it("un mensaje a la línea interna de Sixteam se ignora sin responder ni registrar", async () => {
    // Decisión de Ernesto (2026-09-11): la plataforma opera solo con la línea de Mizar. Si ambas
    // líneas apuntaran al mismo webhook, un "hola" a la interna de Sixteam dispararía el menú de
    // compras de Mizar a alguien que no tiene nada que ver con la obra.
    const { enviados, impl } = fetchEspia();
    const espia = registroEspia();
    const resultado = await atenderMensajeEntrante({ ...entranteTexto(), phone_number_id: LINEA_SIXTEAM }, { fetchImpl: impl, registro: espia.registro });
    expect(resultado).toEqual({ atendido: false, motivo: "otra_linea" });
    expect(enviados).toHaveLength(0);
    expect(espia.cerrados).toHaveLength(0);
  });

  it("la línea de Mizar sí pasa, venga en la raíz o en conversation", async () => {
    // Los dos sitios donde la envoltura v2 informa la línea. El respaldo miraba antes en
    // `metadata.phone_number_id`, que en esa envoltura no existe.
    for (const payload of [{ ...entranteTexto(), phone_number_id: LINEA_MIZAR }, { ...entranteTexto(), conversation: { phone_number_id: LINEA_MIZAR } }]) {
      const { enviados, impl } = fetchEspia();
      const resultado = await atenderMensajeEntrante(payload, { fetchImpl: impl, registro: registroEspia().registro });
      expect(resultado.atendido).toBe(true);
      expect(enviados).toHaveLength(1);
    }
  });

  it("si el payload no informa la línea, se acepta en vez de quedarse mudo", async () => {
    // Rechazar por ausencia dejaría el canal muerto ante un cambio de formato de Kapso. El filtro
    // descarta solo lo que viene marcado como de OTRA línea.
    const { enviados, impl } = fetchEspia();
    expect((await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl, registro: registroEspia().registro })).atendido).toBe(true);
    expect(enviados).toHaveLength(1);
  });

  it("un fallo de envío NO lanza: queda en el resultado y se registra", async () => {
    // Es la garantía que sostiene el 200 del webhook. Si esto lanzara, Kapso reintentaría el mismo
    // "hola" en bucle.
    const { impl } = fetchEspia({ status: 500 });
    const espia = registroEspia();
    const resultado = await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl, registro: espia.registro });
    expect(resultado.atendido).toBe(true);
    expect(resultado.atendido && resultado.resultado).toContain("error:");
    expect(espia.cerrados[0]).toMatchObject({ clase: "menu" });
    expect(espia.cerrados[0].resultado).toContain("ROUTER_SEND_FAILED_500");
  });

  it("si falla el cierre del registro, la persona ya recibió su respuesta igual", async () => {
    const { enviados, impl } = fetchEspia();
    const resultado = await atenderMensajeEntrante(entranteTexto(), {
      fetchImpl: impl, registro: { reclamar: async () => true, cerrar: async () => { throw new Error("base caída"); } },
    });
    expect(resultado).toEqual({ atendido: true, accion: "menu", resultado: "ok" });
    expect(enviados).toHaveLength(1);
  });

  it("sin credenciales no se intenta nada y se dice por qué", async () => {
    delete process.env.KAPSO_API_KEY;
    expect(estaRouterConfigurado()).toBe(false);
    const { enviados, impl } = fetchEspia();
    expect(await atenderMensajeEntrante(entranteTexto(), { fetchImpl: impl })).toEqual({ atendido: false, motivo: "no_configurado" });
    expect(enviados).toHaveLength(0);
  });

  it("un payload que no es de conversación se declara no enrutable, sin tocar nada", async () => {
    const { enviados, impl } = fetchEspia();
    expect(await atenderMensajeEntrante(entranteFlow(), { fetchImpl: impl })).toEqual({ atendido: false, motivo: "no_enrutable" });
    expect(enviados).toHaveLength(0);
  });
});
