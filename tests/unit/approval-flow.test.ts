import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildApprovalFlowSendPayload, buildApprovalTemplatePayload, formatCop, issueApprovalFlowToken,
  MAX_APPROVAL_ITEMS, sendApprovalFlow, sendApprovalTemplate, validateApprovalFlowToken,
  type ApprovalFlowContext,
} from "../../lib/infrastructure/approval-flow-sender";
import { adaptApprovalReply, isApprovalNfmReply } from "../../lib/infrastructure/approval-reply-adapter";
import { applyApprovalDecision, DEFAULT_DECLINE_REASON, planApprovalDecision } from "../../lib/infrastructure/approval-processor";
import type { ItemLine, Requisition } from "../../lib/domain";
import { hmacSha256 } from "../../lib/security/crypto";

// ---------------------------------------------------------------------------------------------
// El Flow JSON. Mismas invariantes duras que ya verifica whatsapp-flow.test.ts para el de captura.
// ---------------------------------------------------------------------------------------------

type FlowComponent = { type: string; name?: string; label?: string; required?: boolean; ["data-source"]?: unknown; ["init-value"]?: unknown; ["on-click-action"]?: { name: string; next?: { type: string; name: string }; payload?: Record<string, unknown> } };
type FlowScreen = { id: string; terminal?: boolean; success?: boolean; data?: Record<string, unknown>; layout: { type: string; children: FlowComponent[] } };
type FlowJson = { version: string; screens: FlowScreen[] };

const flowPath = resolve("integrations/whatsapp-flow/aprobacion.flow.json");
const raw = readFileSync(flowPath, "utf8");
const flow = JSON.parse(raw) as FlowJson;
const screenOf = (id: string): FlowScreen => {
  const screen = flow.screens.find((candidate) => candidate.id === id);
  if (!screen) throw new Error(`Pantalla ${id} no encontrada`);
  return screen;
};
const fieldOf = (screen: FlowScreen, name: string): FlowComponent => {
  const field = screen.layout.children.find((component) => component.name === name);
  if (!field) throw new Error(`Campo ${name} no encontrado en ${screen.id}`);
  return field;
};

describe("aprobacion.flow.json — estructura", () => {
  it("declara la misma versión de Flow JSON que el Flow de captura ya validado por Meta", () => {
    expect(flow.version).toBe("7.3");
  });

  it("tiene dos pantallas y solo DECISION es terminal con success", () => {
    expect(flow.screens.map((screen) => screen.id)).toEqual(["REVISION", "DECISION"]);
    const terminals = flow.screens.filter((screen) => screen.terminal);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe("DECISION");
    expect(terminals[0].success).toBe(true);
  });

  it("los id de pantalla solo usan letras y guion bajo (Meta rechaza dígitos)", () => {
    for (const screen of flow.screens) expect(screen.id).toMatch(/^[A-Z_]+$/);
  });

  // Límites verificados en la tabla de componentes de Meta (2026-09-10): el label de
  // TextInput/TextArea/Dropdown admite 20 caracteres, el de CheckboxGroup/RadioButtonsGroup 30.
  // Se comprueba el tope REAL de cada tipo y no el más estricto para todos, para no rechazar
  // mañana un label perfectamente válido de 25 en un CheckboxGroup.
  const LABEL_LIMITS: Record<string, number> = { TextInput: 20, TextArea: 20, Dropdown: 20, DatePicker: 20, PhotoPicker: 20, CheckboxGroup: 30, RadioButtonsGroup: 30 };
  it("ningún label supera el límite de Meta para su tipo de componente", () => {
    const largos: string[] = [];
    for (const screen of flow.screens) {
      for (const component of screen.layout.children) {
        const limit = LABEL_LIMITS[component.type];
        if (limit && component.label && component.label.length > limit) {
          largos.push(`${screen.id}/${component.name}: "${component.label}" (${component.label.length} > ${limit})`);
        }
      }
    }
    expect(largos, `labels fuera de límite: ${largos.join(", ")}`).toEqual([]);
  });

  it("no ofrece más ítems de los que Meta admite en un CheckboxGroup (20)", () => {
    // El Flow no fija el número (los ítems son dinámicos); quien lo garantiza es el emisor. Esta
    // prueba ancla la constante al límite documentado para que nadie la suba sin darse cuenta.
    expect(MAX_APPROVAL_ITEMS).toBeLessThanOrEqual(20);
  });

  it("REVISION recibe los ítems por data dinámica y los trae todos preseleccionados", () => {
    const revision = screenOf("REVISION");
    expect(Object.keys(revision.data ?? {})).toEqual(["requisitionId", "encabezado", "resumen", "items", "preseleccion"]);
    const checkbox = fieldOf(revision, "aprobados");
    expect(checkbox.type).toBe("CheckboxGroup");
    expect(checkbox["data-source"]).toBe("${data.items}");
    expect(checkbox["init-value"]).toBe("${data.preseleccion}");
    // No obligatorio: desmarcarlo todo debe poder llegar al servidor para que este lo rechace con
    // un motivo claro, en vez de bloquear a la persona dentro del Flow.
    expect(checkbox.required).toBe(false);
  });

  it("el complete lleva el discriminador, la requisición y la decisión", () => {
    const footer = screenOf("DECISION").layout.children.find((component) => component.type === "Footer");
    expect(footer?.["on-click-action"]?.name).toBe("complete");
    expect(footer?.["on-click-action"]?.payload).toEqual({
      kind: "aprobacion",
      requisitionId: "${screen.REVISION.data.requisitionId}",
      aprobados: "${screen.REVISION.form.aprobados}",
      accion: "${form.accion}",
      motivo: "${form.motivo}",
    });
  });

  it("la acción es obligatoria y ofrece exactamente aprobar y devolver", () => {
    const accion = fieldOf(screenOf("DECISION"), "accion");
    expect(accion.required).toBe(true);
    expect(accion["data-source"]).toEqual([{ id: "aprobar", title: "Aprobar" }, { id: "devolver", title: "Devolver al revisor" }]);
  });
});

// ---------------------------------------------------------------------------------------------
// flow_token: atado al teléfono Y a la requisición
// ---------------------------------------------------------------------------------------------

const SECRET = "secreto-de-prueba";
const REQ_A = "11111111-1111-4111-8111-111111111111";
const REQ_B = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-10T15:00:00.000Z");

const OTRO_SECRETO = "otro-secreto-distinto";

describe("flow_token de aprobación", () => {
  it("valida el token que él mismo emite", () => {
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    expect(validateApprovalFlowToken(token, "+57 300 111 2233", REQ_A, SECRET, NOW)).toEqual({ ok: true });
  });

  // Todas las pruebas de este bloque firmaban y validaban con el MISMO secreto. Los casos negativos
  // cubrían teléfono, requisición, caducidad y formato — ninguno el secreto. Es decir: una
  // implementación que IGNORARA el secreto por completo las pasaba todas, y este es el token que
  // autoriza aprobaciones de gasto que llegan por WhatsApp. Si la firma fuera forjable, cualquiera
  // que supiera el teléfono del aprobador y el id de la requisición podría aprobar una compra.
  //
  // Se ancla contra un HMAC calculado aparte, igual que `flow-sender.test.ts` hace con el token de
  // captura: si la construcción de la firma cambia, esto lo dice; comparar el emisor consigo mismo,
  // no.
  it("la firma es HMAC del teléfono normalizado, el timestamp y la requisición, con ESE secreto", () => {
    const token = issueApprovalFlowToken("+57 300 111 2233", REQ_A, SECRET, NOW);
    const esperado = `2026-09-10T15:00:00.000Z.${hmacSha256(`573001112233.2026-09-10T15:00:00.000Z.${REQ_A}`, SECRET)}`;
    expect(token).toBe(esperado);
    // Y con otro secreto la firma es OTRA: si esto fallara, el secreto no estaría entrando en el HMAC.
    expect(issueApprovalFlowToken("+57 300 111 2233", REQ_A, OTRO_SECRETO, NOW)).not.toBe(esperado);
  });

  it("un token firmado con OTRO secreto se rechaza", () => {
    // El caso que ninguna prueba cubría. Es lo que separa "hay firma" de "la firma sirve".
    const token = issueApprovalFlowToken("573001112233", REQ_A, OTRO_SECRETO, NOW);
    expect(validateApprovalFlowToken(token, "573001112233", REQ_A, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("un token válido con un solo carácter cambiado se rechaza", () => {
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    // Se altera el último dígito hex de la firma, manteniendo el formato <iso>.<64 hex> intacto, para
    // que el rechazo venga de la firma y no del patrón.
    const ultimo = token.slice(-1);
    const manipulado = `${token.slice(0, -1)}${ultimo === "a" ? "b" : "a"}`;
    expect(manipulado).toHaveLength(token.length);
    expect(validateApprovalFlowToken(manipulado, "573001112233", REQ_A, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("un secreto vacío no valida un token emitido con secreto de verdad", () => {
    // Cubre el entorno mal configurado: si `KAPSO_WEBHOOK_SECRET` llegara vacío, la validación no
    // puede volverse permisiva — tiene que rechazar, no aceptar cualquier cosa.
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    expect(validateApprovalFlowToken(token, "573001112233", REQ_A, "", NOW)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("un token emitido para otra requisición no sirve para esta", () => {
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    expect(validateApprovalFlowToken(token, "573001112233", REQ_B, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("un token emitido para otro teléfono no sirve", () => {
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    expect(validateApprovalFlowToken(token, "573009998877", REQ_A, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("caduca a los 7 días y tolera un desfase de reloj pequeño", () => {
    const token = issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW);
    const ochoDias = new Date(NOW.getTime() + 8 * 24 * 60 * 60 * 1000);
    expect(validateApprovalFlowToken(token, "573001112233", REQ_A, SECRET, ochoDias)).toEqual({ ok: false, reason: "flow_token_expired" });
    const unMinutoAntes = new Date(NOW.getTime() - 60_000);
    expect(validateApprovalFlowToken(token, "573001112233", REQ_A, SECRET, unMinutoAntes)).toEqual({ ok: true });
  });

  it("rechaza un formato que no sea <iso>.<64 hex>", () => {
    expect(validateApprovalFlowToken("no-es-un-token", "573001112233", REQ_A, SECRET, NOW)).toEqual({ ok: false, reason: "invalid_flow_token_format" });
  });
});

// ---------------------------------------------------------------------------------------------
// Emisor
// ---------------------------------------------------------------------------------------------

const context: ApprovalFlowContext = {
  requisitionId: REQ_A,
  approverPhone: "+57 300 111 2233",
  approverName: "Nelson",
  consecutive: "REQ-2026-0004",
  work: "Obra La Pradera",
  totalText: "$18.088.000",
  heading: "REQ-2026-0004 · Obra La Pradera",
  summary: "Solicita: Daniel Gómez\nTotal vigente: $18.088.000",
  items: [
    { id: "33333333-3333-4333-8333-333333333333", title: "Cemento gris 50kg", description: "400 bulto · $18.088.000" },
    { id: "44444444-4444-4444-8444-444444444444", title: "Varilla 1/2 x 6m", description: "50 unidad · $1.250.000" },
  ],
};

describe("emisor del Flow de aprobación", () => {
  it("formatea pesos con separador de miles y sin decimales", () => {
    expect(formatCop(18088000)).toBe("$18.088.000");
    expect(formatCop(0)).toBe("$0");
    expect(formatCop(999)).toBe("$999");
  });

  it("arma el mensaje con la pantalla de entrada y todos los ítems preseleccionados", () => {
    const payload = buildApprovalFlowSendPayload({ to: "573001112233", flowId: "FID", flowCta: "Revisar", flowToken: "tok", bodyText: "cuerpo", context });
    const parameters = payload.interactive.action.parameters;
    expect(parameters.flow_action_payload.screen).toBe("REVISION");
    expect(parameters.flow_action_payload.data.preseleccion).toEqual(context.items.map((item) => item.id));
    expect(parameters.flow_action_payload.data.requisitionId).toBe(REQ_A);
    // body.text es obligatorio para Meta en todo mensaje interactivo.
    expect(payload.interactive.body.text).toBe("cuerpo");
    expect(parameters.mode).toBeUndefined();
  });

  it("falla cerrado sin configuración y sin consultar la BD", async () => {
    const source = { loadApprovalContext: vi.fn() };
    await expect(sendApprovalFlow(REQ_A, { source })).rejects.toThrow("APPROVAL_FLOW_NOT_CONFIGURED");
    expect(source.loadApprovalContext).not.toHaveBeenCalled();
  });

  it("envía al teléfono del aprobador de la BD, nunca a uno que elija el llamador", async () => {
    vi.stubEnv("KAPSO_API_KEY", "k"); vi.stubEnv("WHATSAPP_APPROVAL_FLOW_ID", "FID");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "PID"); vi.stubEnv("KAPSO_WEBHOOK_SECRET", SECRET);
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 }));
      const result = await sendApprovalFlow(REQ_A, { source: { loadApprovalContext: async () => context }, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
      expect(result).toEqual({ messageId: "wamid.1", to: "573001112233" });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      expect(body.to).toBe("573001112233");
      // El token del mensaje enviado es exactamente el que el receptor validará.
      expect(validateApprovalFlowToken(body.interactive.action.parameters.flow_token, "573001112233", REQ_A, SECRET, NOW)).toEqual({ ok: true });
    } finally { vi.unstubAllEnvs(); }
  });

  it("distingue la ventana de 24 h cerrada (422) de una avería, para poder caer a la plantilla", async () => {
    vi.stubEnv("KAPSO_API_KEY", "k"); vi.stubEnv("WHATSAPP_APPROVAL_FLOW_ID", "FID");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "PID"); vi.stubEnv("KAPSO_WEBHOOK_SECRET", SECRET);
    try {
      const source = { loadApprovalContext: async () => context };
      // Respuesta literal del proxy de Kapso cuando la persona no ha escrito en 24 h.
      const cerrada = vi.fn(async () => new Response(JSON.stringify({ error: "Cannot send non-template messages outside the 24-hour window." }), { status: 422 }));
      await expect(sendApprovalFlow(REQ_A, { source, fetchImpl: cerrada as unknown as typeof fetch })).rejects.toThrow("APPROVAL_FLOW_SESSION_CLOSED");
      // Un fallo de verdad conserva su código con el status, para que la cola lo reintente.
      const rota = vi.fn(async () => new Response("boom", { status: 503 }));
      await expect(sendApprovalFlow(REQ_A, { source, fetchImpl: rota as unknown as typeof fetch })).rejects.toThrow("APPROVAL_FLOW_SEND_FAILED_503");
    } finally { vi.unstubAllEnvs(); }
  });

  it("la plantilla lleva el mismo Flow y los mismos datos, por el camino que sí cruza la ventana", () => {
    const payload = buildApprovalTemplatePayload({ to: "573001112233", templateName: "aprobacion_requisicion", languageCode: "es", flowToken: "tok", context });
    const [body, button] = payload.template.components;
    // El orden posicional debe calzar con {{1}}..{{4}} de la plantilla aprobada en Meta.
    expect(body).toEqual({ type: "body", parameters: [
      { type: "text", text: "Nelson" }, { type: "text", text: "REQ-2026-0004" },
      { type: "text", text: "Obra La Pradera" }, { type: "text", text: "$18.088.000" },
    ] });
    expect(button).toMatchObject({ type: "button", sub_type: "flow", index: "0" });
    // `flow_action_data` es el equivalente de `flow_action_payload.data`: mismos ítems, misma
    // preselección. Si divergieran, el aprobador vería cosas distintas según cómo le llegó.
    const action = (button as { parameters: Array<{ action: { flow_token: string; flow_action_data: Record<string, unknown> } }> }).parameters[0].action;
    expect(action.flow_token).toBe("tok");
    expect(action.flow_action_data).toEqual({
      requisitionId: REQ_A, encabezado: context.heading, resumen: context.summary,
      items: context.items, preseleccion: context.items.map((item) => item.id),
    });
  });

  it("el envío por plantilla no depende de la ventana y usa el teléfono del aprobador", async () => {
    vi.stubEnv("KAPSO_API_KEY", "k"); vi.stubEnv("WHATSAPP_APPROVAL_FLOW_ID", "FID");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "PID"); vi.stubEnv("KAPSO_WEBHOOK_SECRET", SECRET);
    try {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ messages: [{ id: "wamid.2" }] }), { status: 200 }));
      const result = await sendApprovalTemplate(REQ_A, { source: { loadApprovalContext: async () => context }, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW });
      expect(result).toEqual({ messageId: "wamid.2", to: "573001112233" });
      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
      const sent = JSON.parse(String(init.body));
      expect(sent.type).toBe("template");
      expect(sent.to).toBe("573001112233");
      // El token de la plantilla se valida igual que el del mensaje interactivo.
      const token = sent.template.components[1].parameters[0].action.flow_token;
      expect(validateApprovalFlowToken(token, "573001112233", REQ_A, SECRET, NOW)).toEqual({ ok: true });
    } finally { vi.unstubAllEnvs(); }
  });

  it("rechaza una requisición con más ítems de los que caben en el Flow", async () => {
    vi.stubEnv("KAPSO_API_KEY", "k"); vi.stubEnv("WHATSAPP_APPROVAL_FLOW_ID", "FID");
    vi.stubEnv("KAPSO_PHONE_NUMBER_ID", "PID"); vi.stubEnv("KAPSO_WEBHOOK_SECRET", SECRET);
    try {
      const many = { ...context, items: Array.from({ length: MAX_APPROVAL_ITEMS + 1 }, (_, index) => ({ id: `id-${index}`, title: "x", description: "y" })) };
      await expect(sendApprovalFlow(REQ_A, { source: { loadApprovalContext: async () => many } })).rejects.toThrow("APPROVAL_FLOW_TOO_MANY_ITEMS");
    } finally { vi.unstubAllEnvs(); }
  });
});

// ---------------------------------------------------------------------------------------------
// Adaptador de entrada
// ---------------------------------------------------------------------------------------------

const APPROVER = { id: "55555555-5555-4555-8555-555555555555", roles: ["aprobador"] as const };
function webhook(fields: Record<string, unknown>, from = "573001112233") {
  return { message: { id: "wamid.abc", from, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { response_json: JSON.stringify(fields) } } } };
}
function approvalFields(overrides: Record<string, unknown> = {}) {
  return {
    kind: "aprobacion", requisitionId: REQ_A, accion: "aprobar",
    aprobados: [context.items[0].id, context.items[1].id], motivo: "",
    flow_token: issueApprovalFlowToken("573001112233", REQ_A, SECRET, NOW),
    ...overrides,
  };
}
const resolveApprover = async () => ({ id: APPROVER.id, roles: [...APPROVER.roles] });

describe("adaptApprovalReply", () => {
  it("reconoce la respuesta de aprobación por su discriminador, no por sus campos", () => {
    expect(isApprovalNfmReply(webhook(approvalFields()))).toBe(true);
    // Una respuesta del Flow de CAPTURA no debe entrar por este camino.
    expect(isApprovalNfmReply(webhook({ type: "compra", societyId: REQ_A, flow_token: "x" }))).toBe(false);
    expect(isApprovalNfmReply({ message: { id: "x", from: "y", type: "text" } })).toBe(false);
  });

  it("traduce una aprobación válida a una decisión tipada", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields()), { secret: SECRET, now: NOW, resolveApprover });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision).toMatchObject({ requisitionId: REQ_A, action: "aprobar", approver: { id: APPROVER.id }, phone: "+573001112233", wamid: "wamid.abc" });
    expect(result.decision.approvedItemIds).toEqual([context.items[0].id, context.items[1].id]);
    expect(result.decision.reason).toBeUndefined();
  });

  it("rechaza si el payload apunta a otra requisición que la firmada en el token", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields({ requisitionId: REQ_B })), { secret: SECRET, now: NOW, resolveApprover });
    expect(result).toMatchObject({ ok: false, reason: "invalid_flow_token_signature" });
  });

  it("rechaza si el teléfono no resuelve a un aprobador único y activo", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields()), { secret: SECRET, now: NOW, resolveApprover: async () => null });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized_approver" });
  });

  it("no convierte en 500 un fallo al resolver el aprobador: falla cerrado", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields()), { secret: SECRET, now: NOW, resolveApprover: async () => { throw new Error("db caída"); } });
    expect(result).toMatchObject({ ok: false, reason: "unauthorized_approver" });
  });

  it("acepta la lista de ítems como arreglo o como string JSON, pero no inventa formatos", async () => {
    const comoTexto = await adaptApprovalReply(webhook(approvalFields({ aprobados: JSON.stringify([context.items[0].id]) })), { secret: SECRET, now: NOW, resolveApprover });
    expect(comoTexto.ok && comoTexto.decision.approvedItemIds).toEqual([context.items[0].id]);
    const vacio = await adaptApprovalReply(webhook(approvalFields({ aprobados: "" })), { secret: SECRET, now: NOW, resolveApprover });
    expect(vacio.ok && vacio.decision.approvedItemIds).toEqual([]);
    const separadoPorComas = await adaptApprovalReply(webhook(approvalFields({ aprobados: `${context.items[0].id},${context.items[1].id}` })), { secret: SECRET, now: NOW, resolveApprover });
    expect(separadoPorComas).toMatchObject({ ok: false, reason: "invalid_fields" });
  });

  it("un id ilegible invalida el campo entero en vez de aprobar un subconjunto distinto", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields({ aprobados: [context.items[0].id, "no-es-uuid"] })), { secret: SECRET, now: NOW, resolveApprover });
    expect(result).toMatchObject({ ok: false, reason: "invalid_fields" });
  });

  it("rechaza una acción que no sea aprobar o devolver", async () => {
    const result = await adaptApprovalReply(webhook(approvalFields({ accion: "borrar" })), { secret: SECRET, now: NOW, resolveApprover });
    expect(result).toMatchObject({ ok: false, reason: "invalid_fields" });
  });
});

// ---------------------------------------------------------------------------------------------
// Planificación y aplicación de la decisión
// ---------------------------------------------------------------------------------------------

function line(id: string, status?: ItemLine["status"]): ItemLine {
  return { id, description: "algo", quantity: 1, unit: "unidad", unitBase: 1000, status };
}
function requisition(items: ItemLine[], status: Requisition["status"] = "en_aprobacion") {
  return { status, items };
}
const decision = (overrides: Partial<Parameters<typeof planApprovalDecision>[1]> = {}) => ({ action: "aprobar" as const, approvedItemIds: [] as string[], reason: undefined as string | undefined, ...overrides });

describe("planApprovalDecision", () => {
  it("ignora una requisición que ya no está en aprobación (reintento del webhook o respuesta tardía)", () => {
    const plan = planApprovalDecision(requisition([line("a")], "aprobada"), decision({ approvedItemIds: ["a"] }));
    expect(plan).toEqual({ kind: "skip", reason: "not_in_approval" });
  });

  it("aprueba marcando cada línea vigente, sin declinadas cuando están todas marcadas", () => {
    const plan = planApprovalDecision(requisition([line("a"), line("b")]), decision({ approvedItemIds: ["a", "b"] }));
    expect(plan).toEqual({ kind: "approve", declined: 0, decisions: [{ itemId: "a", status: "aprobado" }, { itemId: "b", status: "aprobado" }] });
  });

  it("declina lo desmarcado con el motivo escrito por el aprobador", () => {
    const plan = planApprovalDecision(requisition([line("a"), line("b")]), decision({ approvedItemIds: ["a"], reason: "El segundo ya está en obra" }));
    expect(plan).toEqual({ kind: "approve", declined: 1, decisions: [{ itemId: "a", status: "aprobado" }, { itemId: "b", status: "declinado", declineReason: "El segundo ya está en obra" }] });
  });

  it("usa un motivo por defecto veraz cuando desmarca sin escribir nada", () => {
    const plan = planApprovalDecision(requisition([line("a"), line("b")]), decision({ approvedItemIds: ["a"] }));
    expect(plan).toMatchObject({ kind: "approve", decisions: [{ itemId: "a" }, { itemId: "b", declineReason: DEFAULT_DECLINE_REASON }] });
  });

  it("no reabre lo que el revisor ya había declinado", () => {
    const plan = planApprovalDecision(requisition([line("a"), line("viejo", "declinado")]), decision({ approvedItemIds: ["a"] }));
    expect(plan).toEqual({ kind: "approve", declined: 0, decisions: [{ itemId: "a", status: "aprobado" }] });
  });

  it("desmarcarlo todo no es una forma de declinar la requisición: pide devolver", () => {
    const plan = planApprovalDecision(requisition([line("a")]), decision({ approvedItemIds: [] }));
    expect(plan).toEqual({ kind: "reject", reason: "no_approved_items" });
  });

  it("devolver exige comentario", () => {
    expect(planApprovalDecision(requisition([line("a")]), decision({ action: "devolver" }))).toEqual({ kind: "reject", reason: "missing_reason" });
    expect(planApprovalDecision(requisition([line("a")]), decision({ action: "devolver", reason: "Falta la cotización" }))).toEqual({ kind: "return", comment: "Falta la cotización" });
  });
});

describe("applyApprovalDecision", () => {
  const commands = () => ({ decideItems: vi.fn(async () => undefined), approve: vi.fn(async () => undefined), returnForCorrection: vi.fn(async () => undefined) });
  const fullDecision = (overrides: Record<string, unknown> = {}) => ({
    requisitionId: REQ_A, approver: { id: APPROVER.id, roles: [...APPROVER.roles] }, action: "aprobar" as const,
    approvedItemIds: ["a"], reason: undefined, phone: "+573001112233", wamid: "wamid.abc", ...overrides,
  });

  it("decide los ítems y luego aprueba, siempre con origin kapso y el actor real", async () => {
    const spy = commands();
    const outcome = await applyApprovalDecision(spy, requisition([line("a")]), fullDecision());
    expect(outcome).toEqual({ status: "applied", action: "aprobada", declined: 0 });
    const expectedContext = { actor: { id: APPROVER.id, roles: ["aprobador"] }, origin: "kapso" };
    expect(spy.decideItems).toHaveBeenCalledWith(REQ_A, [{ itemId: "a", status: "aprobado" }], expectedContext);
    expect(spy.approve).toHaveBeenCalledWith(REQ_A, expectedContext);
    expect(spy.returnForCorrection).not.toHaveBeenCalled();
  });

  it("devuelve sin tocar los ítems", async () => {
    const spy = commands();
    const outcome = await applyApprovalDecision(spy, requisition([line("a")]), fullDecision({ action: "devolver", reason: "Falta cotización" }));
    expect(outcome).toEqual({ status: "applied", action: "devuelta", declined: 0 });
    expect(spy.returnForCorrection).toHaveBeenCalledWith(REQ_A, "Falta cotización", { actor: { id: APPROVER.id, roles: ["aprobador"] }, origin: "kapso" });
    expect(spy.decideItems).not.toHaveBeenCalled();
    expect(spy.approve).not.toHaveBeenCalled();
  });

  it("no escribe nada cuando el plan es ignorar o rechazar", async () => {
    const ignorado = commands();
    expect(await applyApprovalDecision(ignorado, requisition([line("a")], "aprobada"), fullDecision())).toEqual({ status: "ignored", reason: "not_in_approval" });
    const rechazado = commands();
    expect(await applyApprovalDecision(rechazado, requisition([line("a")]), fullDecision({ approvedItemIds: [] }))).toEqual({ status: "rejected", reason: "no_approved_items" });
    for (const spy of [ignorado, rechazado]) {
      expect(spy.decideItems).not.toHaveBeenCalled();
      expect(spy.approve).not.toHaveBeenCalled();
      expect(spy.returnForCorrection).not.toHaveBeenCalled();
    }
  });
});
