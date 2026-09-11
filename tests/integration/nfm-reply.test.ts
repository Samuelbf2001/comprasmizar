import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "../../lib/security/crypto";
import type { Requisition } from "../../lib/domain";
import type { ServiceDependencies, TransactionRepositories } from "../../lib/services";

// Misma fábrica de dependencias en memoria que tests/integration/kapso-attachments.test.ts, para
// ejercitar ProcurementService.create real (sin Postgres) desde POST /api/kapso.
function fakeServiceDependencies(): { dependencies: ServiceDependencies; requisitionMap: Map<string, Requisition> } {
  const requisitionMap = new Map<string, Requisition>();
  let sequence = 0;
  const unused = async (): Promise<never> => { throw new Error("not exercised by this test"); };
  const requisitions: ServiceDependencies["requisitions"] = {
    get: async (id) => (requisitionMap.has(id) ? structuredClone(requisitionMap.get(id)!) : null),
    save: async (value) => { requisitionMap.set(value.id, structuredClone(value)); },
    list: async () => [...requisitionMap.values()],
    listVisibleTo: async () => [...requisitionMap.values()],
    // H3 (docs/plan-rendimiento.md): no ejercitados por este arnés (solo lo usa el dashboard), pero
    // requeridos por el shape de RequisitionRepository.
    listVisibleHeaders: unused, dashboardByStatus: unused,
  };
  const consecutives: ServiceDependencies["consecutives"] = { take: async (prefix, year) => `${prefix}-${year}-${String(++sequence).padStart(4, "0")}` };
  const items: ServiceDependencies["items"] = { propose: async () => ({ id: `catalog-${++sequence}`, created: true }) };
  const audit: ServiceDependencies["audit"] = { append: async () => {}, list: async () => [] };
  const notifications: ServiceDependencies["notifications"] = { enqueue: async () => {} };
  const repositories: TransactionRepositories = {
    requisitions,
    orders: { save: unused, list: unused, listVisibleTo: unused, listByRequisition: unused, get: unused, listAttentionCandidates: unused, listRecentlyUpdated: unused, dashboardPendingCount: unused },
    expenses: { get: unused, save: unused, markPaid: unused, deleteByReference: unused, saveShares: unused, list: unused, listVisibleTo: unused, listByReference: unused, dashboardAggregates: unused, listRecentlyUpdated: unused },
    pettyCash: { save: unused, list: unused },
    audit, consecutives,
    features: { isEnabled: unused },
    items,
    catalogs: { create: unused, get: unused, update: unused, findSupplierDuplicate: unused, findRequesterDuplicate: unused, isEligibleApprover: unused, hasRequisitionsForWork: unused },
    notifications,
  };
  const dependencies: ServiceDependencies = {
    ...repositories,
    publicAccess: { verify: unused },
    transactions: { transaction: async <T>(_lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> => work(repositories) },
    clock: { now: () => new Date("2026-08-24T12:00:00.000Z") },
    ids: { next: () => `id-${++sequence}` },
  };
  return { dependencies, requisitionMap };
}

const FAKE_ATTACHMENT_URL = "https://api.kapso.ai/meta/whatsapp/media_download?token=fake-test-token";

const hoisted = vi.hoisted(() => {
  type Claim = "claimed" | "completed" | "in_progress";
  let storeState: "new" | "processing" | "completed" = "new";
  let storedRequisitionId: string | null = null;
  const fakeStore = {
    claim: async (): Promise<Claim> => { if (storeState === "completed") return "completed"; if (storeState === "processing") return "in_progress"; storeState = "processing"; return "claimed"; },
    complete: async (_eventId: string, id?: string): Promise<void> => { storedRequisitionId = id ?? null; storeState = "completed"; },
    release: async (): Promise<void> => { storeState = "new"; },
    findRequisitionId: async (): Promise<string | null> => storedRequisitionId,
  };
  const copyAllCalls: Array<{ requisitionId: string; sources: Array<{ itemId: string; attachmentUrl: string }> }> = [];
  const fakeCopier = {
    copyAll: async (_event: unknown, requisitionId: string, sources: readonly { itemId: string; attachmentUrl: string }[]): Promise<void> => {
      copyAllCalls.push({ requisitionId, sources: [...sources] });
    },
  };
  const rejections: Array<{ wamid?: string; phone?: string; reason: string; rawPayload: unknown }> = [];
  const fakeRejectionRecorder = { record: async (input: { wamid?: string; phone?: string; reason: string; rawPayload: unknown }): Promise<void> => { rejections.push(input); } };
  let resolveAttachmentImpl: (mediaId: string) => Promise<string | null> = async () => null;
  let currentDependencies: ServiceDependencies | null = null;
  return {
    fakeStore, fakeCopier, copyAllCalls, rejections, fakeRejectionRecorder,
    getDependencies: (): ServiceDependencies | null => currentDependencies,
    setDependencies: (value: ServiceDependencies): void => { currentDependencies = value; },
    resolveAttachment: (mediaId: string): Promise<string | null> => resolveAttachmentImpl(mediaId),
    setResolveAttachmentImpl: (impl: (mediaId: string) => Promise<string | null>): void => { resolveAttachmentImpl = impl; },
    reset: (): void => { storeState = "new"; storedRequisitionId = null; copyAllCalls.length = 0; rejections.length = 0; resolveAttachmentImpl = async () => null; },
  };
});

vi.mock("../../lib/infrastructure/kapso-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/infrastructure/kapso-store")>();
  return { ...actual, createPostgresKapsoProcessingStore: () => hoisted.fakeStore, createKapsoAttachmentCopier: () => hoisted.fakeCopier };
});
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({ createPostgresDependencies: () => hoisted.getDependencies() }));
// La ruta resuelve la identidad del solicitante contra la lista blanca (Postgres real); aquí se
// autoriza el número de prueba con un nombre fijo para ejercitar el camino feliz sin BD.
vi.mock("../../lib/infrastructure/public-access", () => ({ resolveAuthorizedRequesterName: async () => ({ name: "Maestro de obra" }) }));
// Solo se reemplazan las dos piezas con efectos externos (resolver de media real, escritura en
// Postgres del rechazo); toda la traducción/validación pura (adaptNfmReply, validateFlowToken,
// isNfmReplyWebhookPayload) es la implementación real — es lo que este archivo prueba.
vi.mock("../../lib/infrastructure/nfm-reply-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/infrastructure/nfm-reply-adapter")>();
  return { ...actual, resolveKapsoMediaDownloadUrl: (mediaId: string) => hoisted.resolveAttachment(mediaId), createPostgresNfmReplyRejectionRecorder: () => hoisted.fakeRejectionRecorder };
});

import { POST } from "../../app/api/kapso/route";
import {
  adaptNfmReply, isNfmReplyWebhookPayload, normalizePhoneForToken, validateFlowToken,
  type RawKapsoWebhookPayload,
} from "../../lib/infrastructure/nfm-reply-adapter";
// Contraparte real del receptor: el mismo `issueFlowToken` que usa el emisor real
// (lib/infrastructure/flow-sender.ts) para construir tokens que validateFlowToken debe aceptar.
import { issueFlowToken } from "../../lib/infrastructure/flow-sender";

const ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  STORAGE_ROOT: "/tmp/mizar-test-storage",
  STORAGE_SIGNING_SECRET: "test-storage-signing-secret-0123456789",
  KAPSO_WEBHOOK_SECRET: "test-kapso-webhook-secret-0123456789",
};
const savedEnv: Record<string, string | undefined> = {};

const FIXTURE_PATH = resolve("fixtures/nfm-reply.json");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as RawKapsoWebhookPayload;
// El flow_token horneado en el fixture está firmado para exactamente este instante (edad 0) — ver
// el comentario en fixtures/nfm-reply.json / el script que lo generó.
const FIXTURE_TOKEN_ISSUED_AT = new Date("2026-08-24T12:00:00.000Z");

function responseFields(payload: RawKapsoWebhookPayload): Record<string, unknown> {
  return JSON.parse(payload.message.interactive!.nfm_reply!.response_json) as Record<string, unknown>;
}
function withResponseFields(payload: RawKapsoWebhookPayload, overrides: Record<string, unknown>): RawKapsoWebhookPayload {
  const clone = structuredClone(payload);
  const fields = { ...responseFields(payload), ...overrides };
  clone.message.interactive!.nfm_reply!.response_json = JSON.stringify(fields);
  return clone;
}
function sign(raw: string): string { return `sha256=${hmacSha256(raw, ENV.KAPSO_WEBHOOK_SECRET)}`; }
function postPayload(payload: unknown): Promise<Response> {
  const raw = JSON.stringify(payload);
  return POST(new Request("http://localhost/api/kapso", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-kapso-signature": sign(raw) } }));
}

describe("nfm-reply-adapter — traducción pura (sin HTTP, sin Postgres)", () => {
  describe("validateFlowToken", () => {
    const secret = "un-secreto-de-prueba-cualquiera";
    const phone = "573001234567";
    it("acepta un token recién firmado para el mismo teléfono verificado", () => {
      const now = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, now);
      expect(validateFlowToken(token, phone, secret, now)).toEqual({ ok: true });
    });
    it("acepta el mismo teléfono aunque el remitente verificado del webhook venga formateado distinto (con '+', espacios)", () => {
      // issueFlowToken firma sobre el teléfono ya normalizado (contrato: solo dígitos, como lo
      // deja `sendRequisitionFlow` antes de llamarlo) — lo que puede variar es el formato de
      // `message.from` que reporte el webhook; normalizePhoneForToken debe absorber eso del lado
      // del validador.
      const now = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, now);
      expect(validateFlowToken(token, "+57 300 123 4567", secret, now)).toEqual({ ok: true });
    });
    it("rechaza un formato sin el sufijo hex de 64 caracteres", () => {
      expect(validateFlowToken("no-es-un-token-valido", phone, secret, new Date())).toEqual({ ok: false, reason: "invalid_flow_token_format" });
    });
    it("rechaza una marca de tiempo que no parsea como fecha", () => {
      const bogus = `no-es-fecha.${"a".repeat(64)}`;
      expect(validateFlowToken(bogus, phone, secret, new Date())).toEqual({ ok: false, reason: "invalid_flow_token_format" });
    });
    it("rechaza un token más viejo que 24 horas", () => {
      const issuedAt = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, issuedAt);
      const now = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000 + 1);
      expect(validateFlowToken(token, phone, secret, now)).toEqual({ ok: false, reason: "flow_token_expired" });
    });
    it("acepta un token justo en el límite de 24 horas", () => {
      const issuedAt = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, issuedAt);
      const now = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
      expect(validateFlowToken(token, phone, secret, now)).toEqual({ ok: true });
    });
    it("rechaza cuando el hex no corresponde al HMAC del teléfono verificado (firma inválida)", () => {
      const now = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, now);
      expect(validateFlowToken(token, "573009999999", secret, now)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
    });
    it("rechaza cuando el secreto no coincide", () => {
      const now = new Date("2026-08-24T12:00:00.000Z");
      const token = issueFlowToken(phone, secret, now);
      expect(validateFlowToken(token, phone, "otro-secreto-distinto", now)).toEqual({ ok: false, reason: "invalid_flow_token_signature" });
    });
  });

  describe("isNfmReplyWebhookPayload", () => {
    it("reconoce el fixture crudo de Kapso", () => { expect(isNfmReplyWebhookPayload(fixture)).toBe(true); });
    it("no confunde el contrato ya normalizado (fixtures/kapso-flow.json) con un nfm_reply crudo", () => {
      const normalized = JSON.parse(readFileSync(resolve("fixtures/kapso-flow.json"), "utf8"));
      expect(isNfmReplyWebhookPayload(normalized)).toBe(false);
    });
    it("rechaza payloads sin la forma esperada", () => {
      expect(isNfmReplyWebhookPayload(null)).toBe(false);
      expect(isNfmReplyWebhookPayload({})).toBe(false);
      expect(isNfmReplyWebhookPayload({ message: { type: "text" } })).toBe(false);
    });
  });

  describe("adaptNfmReply", () => {
    const secret = ENV.KAPSO_WEBHOOK_SECRET;
    // El Flow ya no envia nombre: la identidad la resuelve la lista blanca por telefono. Stub que
    // autoriza con el mismo nombre que el fixture esperaba, para conservar las aserciones previas.
    const okRequester = async () => ({ name: "Maestro de obra" });
    it("traduce el fixture válido: 1 ítem (franjas 2 y 3 vacías se ignoran, no invalidan el evento)", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.eventId).toBe(fixture.message.id);
      expect(result.event.type).toBe("flow_submission");
      expect(result.event.submission?.eventId).toBe(fixture.message.id);
      expect(result.event.submission?.phone).toBe("+573001234567");
      // Reunión 2026-08-31: el solicitante elige empresa, no obra. societyId es el campo real y
      // obligatorio; workId se conserva solo como compatibilidad (ver nfm-reply-adapter.ts).
      expect((result.event.submission as { societyId?: string } | undefined)?.societyId).toBe("22222222-2222-4222-8222-222222222222");
      expect(result.event.submission?.workId).toBe("11111111-1111-4111-8111-111111111111");
      // "destination" desaparece del contrato: su sentido ya se fusiona en observaciones desde el Flow.
      expect(result.event.submission?.observations).toBe("Urgente para la fundida del viernes");
      expect(result.event.submission?.items).toHaveLength(1);
      expect(result.event.submission?.items[0]).toMatchObject({ itemId: "33333333-3333-4333-8333-333333333333", quantity: 10, unit: "bulto", possibleSupplier: "Ferretería El Roble" });
    });

    it("usa el remitente verificado (message.from) como identidad, no el 'phone' editable del Flow", async () => {
      const tampered = withResponseFields(fixture, { phone: "+570000000000" });
      const result = await adaptNfmReply(tampered, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.phone).toBe("+573001234567");
    });

    it("compacta 3 ítems cuando las 3 franjas vienen completas", async () => {
      const withThreeItems = withResponseFields(fixture, {
        item_2_descripcion: "Varilla 1/2\" x 6m", item_2_cantidad: "20", item_2_unidad: "unidad",
        item_3_descripcion: "Arena de peña", item_3_cantidad: "2.5", item_3_unidad: "m3",
      });
      const result = await adaptNfmReply(withThreeItems, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.items).toHaveLength(3);
    });

    it("rechaza (invalid_item) cuando una franja presente trae cantidad <= 0", async () => {
      const invalidQuantity = withResponseFields(fixture, { item_1_cantidad: "0" });
      const result = await adaptNfmReply(invalidQuantity, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_item" });
    });

    it("rechaza (invalid_item) cuando la cantidad no es numérica", async () => {
      const invalidQuantity = withResponseFields(fixture, { item_1_cantidad: "no-es-un-numero" });
      const result = await adaptNfmReply(invalidQuantity, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_item" });
    });

    it("rechaza (no_items) cuando ninguna franja tiene descripción ni catálogo", async () => {
      const noItems = withResponseFields(fixture, { item_1_catalogo: "", item_1_descripcion: "" });
      const result = await adaptNfmReply(noItems, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "no_items" });
    });

    it("rechaza (invalid_fields) un societyId que no es un UUID", async () => {
      // societyId es el campo real y obligatorio ahora (reunión 2026-08-31: empresa, no obra).
      const badSocietyId = withResponseFields(fixture, { societyId: "no-es-un-uuid" });
      const result = await adaptNfmReply(badSocietyId, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_fields" });
    });

    it("un workId con formato inválido se descarta en silencio, no invalida el evento (campo de compatibilidad, ya no exigido por el Flow)", async () => {
      const badWorkId = withResponseFields(fixture, { workId: "no-es-un-uuid" });
      const result = await adaptNfmReply(badWorkId, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.workId).toBeUndefined();
    });

    it("acepta una respuesta SIN fecha requerida (opcional en los tres canales, reunión 2026-08-31)", async () => {
      const sinFecha = withResponseFields(fixture, { requiredDate: "" });
      const result = await adaptNfmReply(sinFecha, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.requiredDate).toBeUndefined();
    });

    it("rechaza (invalid_fields) una fecha requerida presente pero con formato inválido", async () => {
      const fechaInvalida = withResponseFields(fixture, { requiredDate: "no-es-una-fecha" });
      const result = await adaptNfmReply(fechaInvalida, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_fields" });
    });

    it("rechaza (invalid_flow_token_signature) cuando el hex del token no calza con el teléfono", async () => {
      const tampered = withResponseFields(fixture, { flow_token: `2026-08-24T12:00:00.000Z.${"0".repeat(64)}` });
      const result = await adaptNfmReply(tampered, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_flow_token_signature" });
    });

    it("rechaza (flow_token_expired) cuando ya pasaron más de 24h desde la emisión", async () => {
      const later = new Date(FIXTURE_TOKEN_ISSUED_AT.getTime() + 25 * 60 * 60 * 1000);
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: okRequester, now: later });
      expect(result).toMatchObject({ ok: false, reason: "flow_token_expired" });
    });

    it("rechaza (invalid_response_json) cuando response_json no es JSON válido", async () => {
      const broken = structuredClone(fixture);
      broken.message.interactive!.nfm_reply!.response_json = "{ esto no es json";
      const result = await adaptNfmReply(broken, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result).toMatchObject({ ok: false, reason: "invalid_response_json" });
    });

    it("resuelve la foto del ítem que la trae (adjunto por ítem, no una evidencia global)", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT, resolveAttachmentUrl: async (mediaId) => (mediaId === "3631120727156756" ? FAKE_ATTACHMENT_URL : null) });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.items[0].attachmentUrl).toBe(FAKE_ATTACHMENT_URL);
    });

    it("la foto de un segundo ítem se adjunta a ESE ítem, no al primero", async () => {
      // fixture con dos ítems: el segundo trae la foto; el primero no.
      const raw = JSON.parse(fixture.message.interactive!.nfm_reply!.response_json) as Record<string, unknown>;
      delete raw.item_1_foto;
      raw.item_2_catalogo = ""; raw.item_2_descripcion = "Arena de río"; raw.item_2_cantidad = "3"; raw.item_2_unidad = "m3";
      raw.item_2_foto = [{ file_name: "arena.jpg", mime_type: "image/jpeg", sha256: "x", id: "media-arena-2" }];
      const dosItems = { ...fixture, message: { ...fixture.message, interactive: { ...fixture.message.interactive!, nfm_reply: { ...fixture.message.interactive!.nfm_reply!, response_json: JSON.stringify(raw) } } } };
      const result = await adaptNfmReply(dosItems, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT, resolveAttachmentUrl: async (id) => (id === "media-arena-2" ? "https://cdn.example/arena.jpg" : null) });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.submission?.items).toHaveLength(2);
      expect(result.event.submission?.items[0].attachmentUrl).toBeUndefined();
      expect(result.event.submission?.items[1].attachmentUrl).toBe("https://cdn.example/arena.jpg");
    });

    it("nunca bloquea la traducción si el resolver de evidencia lanza", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT, resolveAttachmentUrl: async () => { throw new Error("kapso caído"); } });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.items[0].attachmentUrl).toBeUndefined();
    });

    it("sin resolver inyectado, no intenta adjuntar evidencia", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.items[0].attachmentUrl).toBeUndefined();
    });

    it("rechaza como no autorizado si el número no está en la lista blanca GLOBAL (reunión 2026-08-31: ya no es por obra)", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: async () => null, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unauthorized_requester");
    });

    it("resolveRequester ya no recibe la obra: solo el teléfono verificado (lista blanca global)", async () => {
      const seen: string[] = [];
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: async (phone) => { seen.push(phone); return { name: "Maestro de obra" }; }, now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      expect(seen).toEqual(["573001234567"]);
    });

    it("usa el nombre resuelto de la lista blanca, no un campo del formulario", async () => {
      const result = await adaptNfmReply(fixture, { secret, resolveRequester: async () => ({ name: "Nelson Materiales" }), now: FIXTURE_TOKEN_ISSUED_AT });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.event.submission?.requesterName).toBe("Nelson Materiales");
    });

    // Flow v2 (2026-09-11): las franjas de artículo pasaron de 3 a 8 porque Ernesto, probando desde
    // su celular, avisó de que tres se le quedaban cortos. Las ocho pantallas existen siempre pero
    // solo se visitan bajo demanda, así que lo NORMAL es que lleguen casi todas vacías — y encima
    // rellenas de cadenas vacías a propósito, porque Meta exige que el payload de un `navigate`
    // traiga todas las claves que declara la pantalla destino.
    describe("ocho franjas de artículo (Flow v2)", () => {
      /** Rellena las franjas `desde`..8 con cadenas vacías, como hace el Flow al saltar al resumen. */
      const enBlanco = (desde: number) => {
        const campos: Record<string, unknown> = {};
        for (let n = desde; n <= 8; n += 1) {
          for (const campo of ["catalogo", "descripcion", "cantidad", "unidad", "proveedor", "link"]) campos[`item_${n}_${campo}`] = "";
        }
        return campos;
      };
      /** Una franja completa y válida. */
      const franja = (n: number, descripcion: string) => ({
        [`item_${n}_catalogo`]: "", [`item_${n}_descripcion`]: descripcion,
        [`item_${n}_cantidad`]: "2", [`item_${n}_unidad`]: "bulto",
        [`item_${n}_proveedor`]: "", [`item_${n}_link`]: "",
      });
      const descripciones = async (payload: Parameters<typeof adaptNfmReply>[0]) => {
        const result = await adaptNfmReply(payload, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
        expect(result.ok, "el evento debería ser válido").toBe(true);
        return result.ok ? result.event.submission!.items.map((item) => item.proposedDescription) : [];
      };

      it("un solo artículo, con las otras siete franjas vacías", async () => {
        const payload = withResponseFields(fixture, { ...franja(1, "Cemento gris"), ...enBlanco(2) });
        expect(await descripciones(payload)).toEqual(["Cemento gris"]);
      });

      it("tres artículos, como el Flow v1", async () => {
        const payload = withResponseFields(fixture, { ...franja(1, "Cemento"), ...franja(2, "Arena"), ...franja(3, "Varilla"), ...enBlanco(4) });
        expect(await descripciones(payload)).toEqual(["Cemento", "Arena", "Varilla"]);
      });

      it("los ocho, que es el tope nuevo", async () => {
        const campos = Object.assign({}, ...Array.from({ length: 8 }, (_, i) => franja(i + 1, `Material ${i + 1}`)));
        expect(await descripciones(withResponseFields(fixture, campos))).toHaveLength(8);
      });

      it("las franjas vacías INTERMEDIAS se descartan sin desplazar a las siguientes", async () => {
        // El caso que rompería en silencio: si un hueco intermedio cortara el recorrido, el
        // artículo 8 se perdería y nadie se enteraría — la requisición llegaría incompleta y
        // parecería correcta.
        const payload = withResponseFields(fixture, { ...franja(1, "Cemento"), ...enBlanco(2), ...franja(5, "Arena"), ...franja(8, "Varilla") });
        expect(await descripciones(payload)).toEqual(["Cemento", "Arena", "Varilla"]);
      });

      it("una franja tardía con cantidad inválida invalida el evento entero", async () => {
        // No se manda media requisición: la regla del v1 sigue valiendo en las franjas nuevas.
        const payload = withResponseFields(fixture, { ...franja(1, "Cemento"), ...enBlanco(2), ...franja(7, "Arena"), item_7_cantidad: "cero" });
        const result = await adaptNfmReply(payload, { secret, resolveRequester: okRequester, now: FIXTURE_TOKEN_ISSUED_AT });
        expect(result).toMatchObject({ ok: false, reason: "invalid_item" });
      });
    });
  });

  describe("normalizePhoneForToken", () => {
    it("reduce cualquier formato al mismo string de solo dígitos (forma que firma issueFlowToken)", () => {
      expect(normalizePhoneForToken("573001234567")).toBe("573001234567");
      expect(normalizePhoneForToken("+57 300 123 4567")).toBe("573001234567");
      expect(normalizePhoneForToken("(57) 300-123-4567")).toBe("573001234567");
    });
  });
});

describe("POST /api/kapso — nfm_reply real de WhatsApp Flows", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  beforeEach(() => { hoisted.reset(); hoisted.setDependencies(fakeServiceDependencies().dependencies); vi.useFakeTimers(); vi.setSystemTime(FIXTURE_TOKEN_ISSUED_AT); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("acepta fixtures/nfm-reply.json firmado y crea exactamente 1 requisición con el ítem compactado", async () => {
    hoisted.setResolveAttachmentImpl(async (mediaId) => (mediaId === "3631120727156756" ? FAKE_ATTACHMENT_URL : null));
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await postPayload(fixture);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, status: "created" });
    expect(requisitionMap.size).toBe(1);
    const [requisition] = [...requisitionMap.values()];
    expect(requisition.items).toHaveLength(1);
    expect(requisition.kapsoEventId).toBe(fixture.message.id);
    expect(requisition.externalRequester).toEqual({ name: "Maestro de obra", phone: "+573001234567" });
    // Reunión 2026-08-31: el solicitante elige empresa, no obra — societyId llega al servicio.
    expect(requisition.societyId).toBe("22222222-2222-4222-8222-222222222222");
    // "destination" desaparece del contrato: ya no hay nada que fusionar, observations llega tal cual.
    expect(requisition.observations).toBe("Urgente para la fundida del viernes");
    // La evidencia se resuelve y viaja hasta la copia de adjuntos existente (kapso-store.ts).
    expect(hoisted.copyAllCalls).toEqual([{ requisitionId: requisition.id, sources: [{ itemId: requisition.items[0].id, attachmentUrl: FAKE_ATTACHMENT_URL }] }]);
  });

  it("reintento del mismo wamid no duplica la requisición", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const first = await postPayload(fixture);
    expect((await first.json()).status).toBe("created");
    const second = await postPayload(fixture);
    expect((await second.json()).status).toBe("duplicate");
    expect(requisitionMap.size).toBe(1);
  });

  it("franjas 2 y 3 vacías producen una requisición con 1 solo ítem", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    await postPayload(fixture);
    const [requisition] = [...requisitionMap.values()];
    expect(requisition.items).toHaveLength(1);
  });

  it("token con firma inválida: rechazo neutro, sin crear requisición, registrado en whatsapp_eventos", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const tampered = withResponseFields(fixture, { flow_token: `2026-08-24T12:00:00.000Z.${"0".repeat(64)}` });

    const response = await postPayload(tampered);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true, status: "rejected", reason: "invalid_flow_token_signature" });
    expect(requisitionMap.size).toBe(0);
    expect(hoisted.rejections).toHaveLength(1);
    expect(hoisted.rejections[0]).toMatchObject({ wamid: fixture.message.id, phone: "573001234567", reason: "invalid_flow_token_signature" });
  });

  it("token expirado (>24h): rechazo neutro, sin crear requisición", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    vi.setSystemTime(new Date(FIXTURE_TOKEN_ISSUED_AT.getTime() + 25 * 60 * 60 * 1000));

    const response = await postPayload(fixture);
    await expect(response.json()).resolves.toEqual({ received: true, status: "rejected", reason: "flow_token_expired" });
    expect(requisitionMap.size).toBe(0);
  });

  it("cantidad inválida en una franja presente: rechazo neutro de TODO el evento, no requisición a medias", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const invalidQuantity = withResponseFields(fixture, { item_1_cantidad: "-3" });

    const response = await postPayload(invalidQuantity);
    await expect(response.json()).resolves.toEqual({ received: true, status: "rejected", reason: "invalid_item" });
    expect(requisitionMap.size).toBe(0);
    expect(hoisted.copyAllCalls).toHaveLength(0);
  });

  it("un rechazo no invoca nunca la copia de adjuntos", async () => {
    const { dependencies } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const noItems = withResponseFields(fixture, { item_1_catalogo: "", item_1_descripcion: "" });
    await postPayload(noItems);
    expect(hoisted.copyAllCalls).toHaveLength(0);
  });
});
