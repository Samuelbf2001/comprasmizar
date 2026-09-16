import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "../../lib/security/crypto";
import { normalizeIdentification, type Requisition } from "../../lib/domain";
import type { CatalogSupplier, KapsoWebhookEvent, ServiceDependencies, TransactionRepositories } from "../../lib/services";

// WhatsApp Flow de SOLICITUD DE PAGO (RF-908): un tercer `nfm_reply` que crea una requisición
// `tipo=pago` con beneficiario por identificación. Lo que se vigila aquí: que el webhook lo
// reconozca ANTES que el de captura, que un formulario sin monto se rechace de forma neutra sin crear
// nada (ni requisición ni proveedor), que el beneficiario nazca pendiente de normalizar o se reutilice
// por identificación, y que el Flow generado emita exactamente lo que el adaptador lee.

/** Misma fábrica en memoria que tests/integration/nfm-reply.test.ts, más un catálogo de proveedores
 *  con alta y búsqueda por identificación (lo que `create()` usa para el beneficiario). */
function fakeServiceDependencies(seedSuppliers: CatalogSupplier[] = []): { dependencies: ServiceDependencies; requisitionMap: Map<string, Requisition>; suppliers: Map<string, CatalogSupplier> } {
  const requisitionMap = new Map<string, Requisition>();
  const suppliers = new Map<string, CatalogSupplier>(seedSuppliers.map((supplier) => [supplier.id, supplier]));
  let sequence = 0;
  const unused = async (): Promise<never> => { throw new Error("not exercised by this test"); };
  const requisitions: ServiceDependencies["requisitions"] = {
    get: async (id) => (requisitionMap.has(id) ? structuredClone(requisitionMap.get(id)!) : null),
    save: async (value) => { requisitionMap.set(value.id, structuredClone(value)); },
    list: async () => [...requisitionMap.values()],
    listVisibleTo: async () => [...requisitionMap.values()],
    listVisibleHeaders: unused, dashboardByStatus: unused,
  };
  const catalogs: TransactionRepositories["catalogs"] = {
    create: async (kind, value) => {
      if (kind !== "suppliers") throw new Error("not exercised by this test");
      const supplier: CatalogSupplier = { ...(value as Omit<CatalogSupplier, "id">), id: `sup-${++sequence}` };
      suppliers.set(supplier.id, supplier);
      return supplier;
    },
    get: async (kind, id) => (kind === "suppliers" ? (suppliers.get(id) ?? null) : null),
    findSupplierByIdentification: async (type, identification) => {
      const wanted = normalizeIdentification(identification);
      return [...suppliers.values()].find((supplier) => supplier.identificationType === type && normalizeIdentification(supplier.identification ?? "") === wanted) ?? null;
    },
    update: unused, findSupplierDuplicate: unused, findRequesterDuplicate: unused, isEligibleApprover: unused, hasRequisitionsForWork: unused,
  };
  const repositories: TransactionRepositories = {
    requisitions,
    orders: { save: unused, list: unused, listVisibleTo: unused, listByRequisition: unused, get: unused, listAttentionCandidates: unused, listRecentlyUpdated: unused, dashboardPendingCount: unused },
    expenses: { get: unused, save: unused, markPaid: unused, deleteByReference: unused, saveShares: unused, list: unused, listVisibleTo: unused, listByReference: unused, dashboardAggregates: unused, listRecentlyUpdated: unused },
    orderPayments: { save: unused, listByOrder: unused, get: unused, annul: unused, listCash: unused },
    pettyCash: { save: unused, list: unused },
    incomes: { save: unused, list: unused },
    cashCloses: { get: unused, listByCashBox: unused, sumMovements: unused, previousClosingBalance: unused, upsert: unused, tagMovements: unused, setStatus: unused, listMovementsByCostCenter: unused },
    audit: { append: async () => {}, list: async () => [] },
    consecutives: { take: async (prefix, year) => `${prefix}-${year}-${String(++sequence).padStart(4, "0")}` },
    features: { isEnabled: unused },
    items: { propose: async () => ({ id: `catalog-${++sequence}`, created: true }) },
    catalogs,
    notifications: { enqueue: async () => {} },
  };
  const dependencies: ServiceDependencies = {
    ...repositories,
    publicAccess: { verify: unused, verifySociety: unused },
    transactions: { transaction: async <T>(_lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> => work(repositories) },
    clock: { now: () => new Date("2026-08-24T12:00:00.000Z") },
    ids: { next: () => `id-${++sequence}` },
  };
  return { dependencies, requisitionMap, suppliers };
}

const SOCIEDAD_MIZAR = "22222222-2222-4222-8222-222222222222";

const hoisted = vi.hoisted(() => {
  type Claim = "claimed" | "completed" | "in_progress";
  let storeState: "new" | "processing" | "completed" = "new";
  let storedRequisitionId: string | null = null;
  const claims: unknown[] = [];
  const fakeStore = {
    claim: async (event: unknown): Promise<Claim> => { claims.push(event); if (storeState === "completed") return "completed"; if (storeState === "processing") return "in_progress"; storeState = "processing"; return "claimed"; },
    complete: async (_eventId: string, id?: string): Promise<void> => { storedRequisitionId = id ?? null; storeState = "completed"; },
    release: async (): Promise<void> => { storeState = "new"; },
    findRequisitionId: async (): Promise<string | null> => storedRequisitionId,
  };
  const fakeCopier = { copyAll: async (): Promise<void> => {} };
  const rejections: Array<{ wamid?: string; phone?: string; reason: string; rawPayload: unknown }> = [];
  const fakeRejectionRecorder = { record: async (input: { wamid?: string; phone?: string; reason: string; rawPayload: unknown }): Promise<void> => { rejections.push(input); } };
  let requesterImpl: (phone: string) => Promise<{ name: string } | null> = async () => ({ name: "Maestro de obra" });
  let currentDependencies: ServiceDependencies | null = null;
  return {
    fakeStore, fakeCopier, claims, rejections, fakeRejectionRecorder,
    getDependencies: (): ServiceDependencies | null => currentDependencies,
    setDependencies: (value: ServiceDependencies): void => { currentDependencies = value; },
    resolveRequester: (phone: string) => requesterImpl(phone),
    setRequesterImpl: (impl: (phone: string) => Promise<{ name: string } | null>): void => { requesterImpl = impl; },
    resolveSociety: async (nameOrLabel: string): Promise<string | null> => (nameOrLabel === "Mizar" ? "22222222-2222-4222-8222-222222222222" : null),
    reset: (): void => { storeState = "new"; storedRequisitionId = null; claims.length = 0; rejections.length = 0; requesterImpl = async () => ({ name: "Maestro de obra" }); },
  };
});

vi.mock("../../lib/infrastructure/kapso-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/infrastructure/kapso-store")>();
  return { ...actual, createPostgresKapsoProcessingStore: () => hoisted.fakeStore, createKapsoAttachmentCopier: () => hoisted.fakeCopier };
});
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({ createPostgresDependencies: () => hoisted.getDependencies() }));
vi.mock("../../lib/infrastructure/public-access", () => ({ resolveAuthorizedRequesterName: (phone: string) => hoisted.resolveRequester(phone) }));
// Solo se sustituyen las piezas con efectos externos; la traducción (adaptPaymentReply,
// validateFlowToken, isNfmReplyWebhookPayload) es la real, que es lo que se prueba.
vi.mock("../../lib/infrastructure/nfm-reply-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/infrastructure/nfm-reply-adapter")>();
  return { ...actual, createPostgresNfmReplyRejectionRecorder: () => hoisted.fakeRejectionRecorder, createPostgresSocietyResolver: () => hoisted.resolveSociety };
});

import { POST } from "../../app/api/kapso/route";
import { adaptPaymentReply, CAMPOS_PAGO_LEIDOS, isPaymentNfmReply, parsePaymentAmount, PAYMENT_KIND } from "../../lib/infrastructure/payment-reply-adapter";
import { issueFlowToken, PAYMENT_FLOW_ENTRY_SCREEN } from "../../lib/infrastructure/flow-sender";
import type { RawKapsoWebhookPayload } from "../../lib/infrastructure/nfm-reply-adapter";
import { CAMPOS_PAGO, construirFlowPago, KIND_PAGO, PANTALLA_ENTRADA_PAGO, TIPOS_IDENTIFICACION } from "../../scripts/build-flow-pago";
import type { ComponenteFlow } from "../../scripts/build-flow-captura";
import { SUPPLIER_IDENTIFICATION_TYPE_VALUES } from "../../lib/http/schemas";

const ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  STORAGE_ROOT: "/tmp/mizar-test-storage",
  STORAGE_SIGNING_SECRET: "test-storage-signing-secret-0123456789",
  KAPSO_WEBHOOK_SECRET: "test-kapso-webhook-secret-0123456789",
};
const savedEnv: Record<string, string | undefined> = {};

const fixture = JSON.parse(readFileSync(resolve("fixtures/nfm-reply-pago.json"), "utf8")) as RawKapsoWebhookPayload;
const fixtureCaptura = JSON.parse(readFileSync(resolve("fixtures/nfm-reply.json"), "utf8")) as RawKapsoWebhookPayload;
/** El flow_token horneado en la fixture está firmado para exactamente este instante (edad 0). */
const FIXTURE_TOKEN_ISSUED_AT = new Date("2026-08-24T12:00:00.000Z");

function responseFields(payload: RawKapsoWebhookPayload): Record<string, unknown> {
  return JSON.parse(payload.message.interactive!.nfm_reply!.response_json) as Record<string, unknown>;
}
function withResponseFields(payload: RawKapsoWebhookPayload, overrides: Record<string, unknown>): RawKapsoWebhookPayload {
  const clone = structuredClone(payload);
  const fields = { ...responseFields(payload), ...overrides };
  for (const [clave, valor] of Object.entries(overrides)) if (valor === undefined) delete fields[clave];
  clone.message.interactive!.nfm_reply!.response_json = JSON.stringify(fields);
  return clone;
}
function sign(raw: string): string { return `sha256=${hmacSha256(raw, ENV.KAPSO_WEBHOOK_SECRET)}`; }
function postPayload(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload);
  return POST(new Request("http://localhost/api/kapso", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-kapso-signature": sign(raw) } }));
}

describe("payment-reply-adapter — traducción pura (sin HTTP, sin Postgres)", () => {
  const secret = ENV.KAPSO_WEBHOOK_SECRET;
  const okRequester = async () => ({ name: "Maestro de obra" });
  const config = { secret, resolveRequester: okRequester, resolveSocietyId: hoisted.resolveSociety, now: FIXTURE_TOKEN_ISSUED_AT };

  it("la fixture lleva un flow_token del MISMO contrato que el Flow de captura (issueFlowToken)", () => {
    // El emisor `sendPaymentFlow` firma igual que `sendRequisitionFlow`: teléfono + timestamp. Si
    // esto dejara de ser cierto, la fixture caducaría en silencio y todo lo de abajo fallaría por
    // un motivo que no es el que vigila.
    expect(responseFields(fixture).flow_token).toBe(issueFlowToken("573001234567", secret, FIXTURE_TOKEN_ISSUED_AT));
  });

  it("isPaymentNfmReply reconoce solo la respuesta con kind=pago: ni la de captura ni un payload normalizado", () => {
    expect(isPaymentNfmReply(fixture)).toBe(true);
    expect(isPaymentNfmReply(fixtureCaptura)).toBe(false);
    expect(isPaymentNfmReply(withResponseFields(fixture, { kind: "aprobacion" }))).toBe(false);
    expect(isPaymentNfmReply(JSON.parse(readFileSync(resolve("fixtures/kapso-flow.json"), "utf8")))).toBe(false);
    expect(isPaymentNfmReply(null)).toBe(false);
  });

  it("traduce la fixture a una requisición tipo pago: una línea con el concepto y el valor, y el beneficiario por identificación", async () => {
    const result = await adaptPaymentReply(fixture, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({ eventId: fixture.message.id, type: "flow_submission" });
    expect(result.event.submission).toEqual({
      eventId: fixture.message.id,
      phone: "+573001234567",
      societyId: SOCIEDAD_MIZAR,
      type: "pago",
      requesterName: "Maestro de obra",
      beneficiary: { identificationType: "CC", identification: "1020304050", name: "Juan Camilo Topógrafo", phone: "+573001234567" },
      items: [{ quantity: 1, unit: "unidad", proposedDescription: "Levantamiento topográfico lote 4", unitBase: 1500000 }],
    });
  });

  it("sin monto: invalid_amount (también vacío, cero, negativo, letras o decimales)", async () => {
    for (const monto of [undefined, "", "0", "-5", "abc", "12abc", "1500000.50"]) {
      const result = await adaptPaymentReply(withResponseFields(fixture, { monto }), config);
      expect(result, `monto=${String(monto)}`).toMatchObject({ ok: false, reason: "invalid_amount", wamid: fixture.message.id, phone: "573001234567" });
    }
  });

  it("parsePaymentAmount acepta puntos o espacios SOLO como separadores de miles y rechaza lo demás", () => {
    expect(parsePaymentAmount("1500000")).toBe(1500000);
    expect(parsePaymentAmount("1.500.000")).toBe(1500000);
    expect(parsePaymentAmount("1 500 000")).toBe(1500000);
    // Un punto que no separa miles es un decimal: quitarlo en silencio multiplicaría por cien.
    expect(parsePaymentAmount("1500000.50")).toBeNull();
    expect(parsePaymentAmount("1.5")).toBeNull();
    expect(parsePaymentAmount("15.00000")).toBeNull();
    expect(parsePaymentAmount("0")).toBeNull();
    expect(parsePaymentAmount("1,5")).toBeNull();
    expect(parsePaymentAmount("9".repeat(14))).toBeNull();
  });

  it("un tipo de identificación fuera de NIT/CC/CE/PAS, una identificación corta o un nombre vacío: invalid_fields", async () => {
    expect(await adaptPaymentReply(withResponseFields(fixture, { tipo_identificacion: "XX" }), config)).toMatchObject({ ok: false, reason: "invalid_fields" });
    expect(await adaptPaymentReply(withResponseFields(fixture, { identificacion: "12" }), config)).toMatchObject({ ok: false, reason: "invalid_fields" });
    expect(await adaptPaymentReply(withResponseFields(fixture, { nombre: "" }), config)).toMatchObject({ ok: false, reason: "invalid_fields" });
    expect(await adaptPaymentReply(withResponseFields(fixture, { concepto: "" }), config)).toMatchObject({ ok: false, reason: "invalid_fields" });
  });

  it("la empresa llega como NOMBRE (valor del Dropdown) y se resuelve al uuid; un nombre desconocido se rechaza", async () => {
    expect(await adaptPaymentReply(withResponseFields(fixture, { empresa: "Sociedad Que No Existe" }), config)).toMatchObject({ ok: false, reason: "invalid_fields" });
    const uuidCrudo = await adaptPaymentReply(withResponseFields(fixture, { empresa: SOCIEDAD_MIZAR }), { ...config, resolveSocietyId: async () => { throw new Error("no debería consultarse"); } });
    expect(uuidCrudo.ok && uuidCrudo.event.submission?.societyId).toBe(SOCIEDAD_MIZAR);
  });

  it("número fuera de la lista blanca: unauthorized_requester, aunque el formulario esté perfecto", async () => {
    expect(await adaptPaymentReply(fixture, { ...config, resolveRequester: async () => null })).toMatchObject({ ok: false, reason: "unauthorized_requester" });
  });

  it("token firmado para otro teléfono o caducado: rechazo con el motivo del token", async () => {
    const tampered = withResponseFields(fixture, { flow_token: `2026-08-24T12:00:00.000Z.${"0".repeat(64)}` });
    expect(await adaptPaymentReply(tampered, config)).toMatchObject({ ok: false, reason: "invalid_flow_token_signature" });
    expect(await adaptPaymentReply(fixture, { ...config, now: new Date(FIXTURE_TOKEN_ISSUED_AT.getTime() + 25 * 60 * 60 * 1000) })).toMatchObject({ ok: false, reason: "flow_token_expired" });
  });
});

describe("POST /api/kapso — nfm_reply del Flow de solicitud de pago", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  beforeEach(() => { hoisted.reset(); hoisted.setDependencies(fakeServiceDependencies().dependencies); vi.useFakeTimers(); vi.setSystemTime(FIXTURE_TOKEN_ISSUED_AT); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("crea la requisición tipo pago con el beneficiario PENDIENTE de normalizar y el teléfono del remitente como contacto", async () => {
    const { dependencies, requisitionMap, suppliers } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await postPayload(fixture);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, status: "created" });

    expect(requisitionMap.size).toBe(1);
    const [requisition] = [...requisitionMap.values()];
    expect(requisition).toMatchObject({ type: "pago", channel: "whatsapp", societyId: SOCIEDAD_MIZAR, kapsoEventId: fixture.message.id, status: "enviada" });
    expect(requisition.externalRequester).toEqual({ name: "Maestro de obra", phone: "+573001234567" });
    expect(requisition.items).toHaveLength(1);
    expect(requisition.items[0]).toMatchObject({ description: "Levantamiento topográfico lote 4", quantity: 1, unit: "unidad", unitBase: 1500000, itemId: undefined });

    expect(suppliers.size).toBe(1);
    const [supplier] = [...suppliers.values()];
    expect(requisition.items[0].finalSupplierId).toBe(supplier.id);
    expect(supplier).toMatchObject({ name: "Juan Camilo Topógrafo", identificationType: "CC", identification: "1020304050", nit: null, pendingNormalization: true, phone: "+573001234567", active: true });
  });

  it("registra el evento por el mismo camino que la captura: el store reclama un flow_submission con beneficiario y valor", async () => {
    await postPayload(fixture);
    expect(hoisted.claims).toHaveLength(1);
    const [claimed] = hoisted.claims as KapsoWebhookEvent[];
    expect(claimed).toMatchObject({ eventId: fixture.message.id, type: "flow_submission" });
    expect(claimed.submission?.beneficiary).toMatchObject({ identificationType: "CC", identification: "1020304050" });
    expect(claimed.submission?.items[0].unitBase).toBe(1500000);
  });

  it("una identificación que YA existe en el catálogo se reutiliza aunque el nombre venga distinto", async () => {
    const existente: CatalogSupplier = { id: "p-existente", name: "Juan Camilo Topografía S.A.S.", identificationType: "CC", identification: "1.020.304.050", pendingNormalization: false, active: true };
    const { dependencies, requisitionMap, suppliers } = fakeServiceDependencies([existente]);
    hoisted.setDependencies(dependencies);

    await expect((await postPayload(fixture)).json()).resolves.toEqual({ received: true, status: "created" });
    expect(suppliers.size).toBe(1);
    expect([...requisitionMap.values()][0].items[0].finalSupplierId).toBe("p-existente");
  });

  it("sin monto: error controlado (200 rejected/invalid_amount), NO crea requisición ni proveedor, y queda en whatsapp_eventos", async () => {
    const { dependencies, requisitionMap, suppliers } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await postPayload(withResponseFields(fixture, { monto: "" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, status: "rejected", reason: "invalid_amount" });
    expect(requisitionMap.size).toBe(0);
    expect(suppliers.size).toBe(0);
    expect(hoisted.claims).toHaveLength(0);
    expect(hoisted.rejections).toHaveLength(1);
    expect(hoisted.rejections[0]).toMatchObject({ wamid: fixture.message.id, phone: "573001234567", reason: "invalid_amount" });
  });

  it("monto no numérico: mismo rechazo neutro", async () => {
    const { requisitionMap } = fakeServiceDependencies();
    await expect((await postPayload(withResponseFields(fixture, { monto: "un millón y medio" }))).json()).resolves.toEqual({ received: true, status: "rejected", reason: "invalid_amount" });
    expect(requisitionMap.size).toBe(0);
  });

  it("número no autorizado: rechazo neutro sin crear nada", async () => {
    hoisted.setRequesterImpl(async () => null);
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    await expect((await postPayload(fixture)).json()).resolves.toEqual({ received: true, status: "rejected", reason: "unauthorized_requester" });
    expect(requisitionMap.size).toBe(0);
  });

  it("reintento del mismo wamid no duplica la requisición", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    expect((await (await postPayload(fixture)).json()).status).toBe("created");
    expect((await (await postPayload(fixture)).json()).status).toBe("duplicate");
    expect(requisitionMap.size).toBe(1);
  });

  it("el Flow de CAPTURA viejo con tipo_solicitud=pago ya no llega a create(): se rechaza como invalid_fields", async () => {
    // Antes esto moría en `create()` con PAYMENT_BENEFICIARY_REQUIRED (503) y Kapso lo reintentaba.
    // Mientras el v3 publicado siga en producción, un maestro que elija "pago" allí recibe este
    // rechazo neutro; la opción desaparece del Flow en el v4.
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const response = await postPayload(withResponseFields(fixtureCaptura, { type: "pago" }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, status: "rejected", reason: "invalid_fields" });
    expect(requisitionMap.size).toBe(0);
  });

  it("un evento normalizado tipo pago sin beneficiario o sin valor no pasa el esquema (400), nunca llega a create()", async () => {
    const base = { eventId: "evt-pago-1", type: "flow_submission" as const, receivedAt: "2026-08-24T12:00:00.000Z", submission: { eventId: "evt-pago-1", phone: "+573001234567", societyId: SOCIEDAD_MIZAR, type: "pago" as const, requesterName: "Maestro", items: [{ quantity: 1, unit: "unidad", proposedDescription: "Corte", unitBase: 1000 }], beneficiary: { identificationType: "CC" as const, identification: "1020304050", name: "Juan" } } };
    const sinBeneficiario = { ...base, submission: { ...base.submission, beneficiary: undefined } };
    const sinValor = { ...base, submission: { ...base.submission, items: [{ quantity: 1, unit: "unidad", proposedDescription: "Corte" }] } };
    expect((await postPayload(sinBeneficiario)).status).toBe(400);
    expect((await postPayload(sinValor)).status).toBe(400);
    expect(hoisted.claims).toHaveLength(0);
    expect((await postPayload(base)).status).toBe(200);
  });
});

// El Flow generado (scripts/build-flow-pago.ts) y lo que Meta NO avisa en tiempo de validación.
describe("solicitud-pago.flow.json — estructura", () => {
  type ConAccion = ComponenteFlow & { "on-click-action"?: { name?: string; next?: { name: string }; payload?: Record<string, string> } };
  const flow = construirFlowPago();
  const pantalla = (id: string) => flow.screens.find((s) => s.id === id)!;
  const resumen = pantalla("RESUMEN");
  const footer = resumen.layout.children.at(-1) as ConAccion;

  it("el JSON commiteado coincide con el generador", () => {
    const enDisco = readFileSync(resolve(__dirname, "../../integrations/whatsapp-flow/solicitud-pago.flow.json"), "utf8").replace(/\r\n/g, "\n");
    expect(enDisco).toBe(`${JSON.stringify(flow, null, 2)}\n`);
  });

  it("tres pantallas, sin PhotoPicker, ids solo con letras y guion bajo, y la de entrada es la que espera el emisor", () => {
    expect(flow.screens.map((s) => s.id)).toEqual([PANTALLA_ENTRADA_PAGO, "PAGO", "RESUMEN"]);
    for (const s of flow.screens) expect(s.id).toMatch(/^[A-Z_]+$/);
    expect(JSON.stringify(flow)).not.toMatch(/PhotoPicker|DocumentPicker/);
    expect(PANTALLA_ENTRADA_PAGO).toBe(PAYMENT_FLOW_ENTRY_SCREEN);
    expect(Object.keys(pantalla(PANTALLA_ENTRADA_PAGO).data!)).toEqual(["sociedades"]);
  });

  it("solo RESUMEN es terminal (con success) y es la única que completa", () => {
    const terminales = flow.screens.filter((s) => s.terminal);
    expect(terminales.map((s) => s.id)).toEqual(["RESUMEN"]);
    expect(terminales[0].success).toBe(true);
    expect(footer["on-click-action"]?.name).toBe("complete");
    for (const s of flow.screens.filter((s) => !s.terminal)) expect((s.layout.children.at(-1) as ConAccion)["on-click-action"]?.name).toBe("navigate");
  });

  it("respeta los topes de etiqueta de Meta: 20 en TextInput/Dropdown, 30 en RadioButtonsGroup", () => {
    for (const s of flow.screens) for (const c of s.layout.children) {
      const label = typeof c.label === "string" ? c.label : "";
      if (["TextInput", "TextArea", "Dropdown", "DatePicker"].includes(c.type)) expect(label.length, `${s.id}/${String(c.name)}: "${label}"`).toBeLessThanOrEqual(20);
      if (["RadioButtonsGroup", "CheckboxGroup"].includes(c.type)) expect(label.length, `${s.id}/${String(c.name)}: "${label}"`).toBeLessThanOrEqual(30);
      const helper = typeof c["helper-text"] === "string" ? c["helper-text"] : "";
      expect(helper.length, `${s.id}/${String(c.name)} helper-text`).toBeLessThanOrEqual(80);
    }
  });

  it("cada navigate entrega TODAS las claves que declara el data de la pantalla destino", () => {
    // "Following fields are expected in the next screen's data model but missing in payload": la
    // regla 2 del README, aprendida a golpes en el Flow de captura.
    for (const s of flow.screens) for (const c of s.layout.children as ConAccion[]) {
      const accion = c["on-click-action"];
      if (accion?.name !== "navigate") continue;
      const destino = pantalla(accion.next!.name);
      for (const clave of Object.keys(destino.data ?? {})) expect(Object.keys(accion.payload ?? {}), `${s.id} → ${destino.id}: falta ${clave}`).toContain(clave);
    }
  });

  it("el resumen pinta bindings PUROS bajo rótulos estáticos; declara todo lo que pinta; nunca mira a otra pantalla", () => {
    const textos = resumen.layout.children.filter((c) => c.type !== "Footer").map((c) => String(c.text));
    const declaradas = new Set(Object.keys(resumen.data!));
    for (const texto of textos) {
      if (!texto.includes("${")) continue;
      // O es exactamente un binding, o es una concatenación entre acentos graves de bindings
      // separados por espacios: nada de ":" ni paréntesis dentro (regla 5 del README).
      expect(texto).toMatch(/^(\$\{data\.[a-z_]+\}|`\$\{data\.[a-z_]+\}( \$\{data\.[a-z_]+\})*`)$/);
      for (const clave of texto.match(/\$\{data\.([a-z_]+)\}/g)!.map((m) => m.slice(7, -1))) expect(declaradas, `falta declarar ${clave}`).toContain(clave);
    }
    expect(JSON.stringify(flow.screens.flatMap((s) => s.layout.children.filter((c) => typeof c.text === "string")))).not.toContain("${screen.");
  });

  it("el complete entrega kind=pago y EXACTAMENTE las claves que el adaptador lee, todas encadenadas desde data", () => {
    const payload = footer["on-click-action"]!.payload!;
    expect(payload.kind).toBe(KIND_PAGO);
    expect(KIND_PAGO).toBe(PAYMENT_KIND);
    const emitidas = Object.keys(payload).filter((clave) => clave !== "kind").sort();
    expect(emitidas).toEqual([...CAMPOS_PAGO_LEIDOS].sort());
    expect(emitidas).toEqual([...CAMPOS_PAGO].sort());
    for (const clave of emitidas) expect(payload[clave]).toBe(`\${data.${clave}}`);
  });

  it("el tipo de identificación ofrece los mismos valores que el catálogo de proveedores, con CC por defecto", () => {
    const tipo = pantalla(PANTALLA_ENTRADA_PAGO).layout.children.find((c) => c.name === "tipo_identificacion")!;
    expect(tipo.type).toBe("RadioButtonsGroup");
    expect(tipo["init-value"]).toBe("CC");
    expect([...TIPOS_IDENTIFICACION.map((t) => t.id)].sort()).toEqual([...SUPPLIER_IDENTIFICATION_TYPE_VALUES].sort());
  });

  it("empresa y monto son obligatorios; el monto solo admite dígitos, sin puntos ni signo", () => {
    const pago = pantalla("PAGO");
    const empresa = pago.layout.children.find((c) => c.name === "empresa")!;
    expect(empresa).toMatchObject({ type: "Dropdown", required: true, "data-source": "${data.sociedades}" });
    const monto = pago.layout.children.find((c) => c.name === "monto")!;
    expect(monto.required).toBe(true);
    const patron = new RegExp(String(monto.pattern));
    expect(patron.test("1500000")).toBe(true);
    for (const invalido of ["0", "1.500.000", "$1500", "-5", ""]) expect(patron.test(invalido), invalido).toBe(false);
  });
});
