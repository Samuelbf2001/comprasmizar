import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hmacSha256 } from "../../lib/security/crypto";
import type { Requisition } from "../../lib/domain";
import type { ServiceDependencies, TransactionRepositories } from "../../lib/services";

// Fábrica de dependencias en memoria para ejercitar ProcurementService.create real (sin Postgres),
// siguiendo el mismo patrón de fakes que tests/unit/procurement-service.test.ts.
function fakeServiceDependencies(): { dependencies: ServiceDependencies; requisitionMap: Map<string, Requisition> } {
  const requisitionMap = new Map<string, Requisition>();
  let sequence = 0;
  const unused = async (): Promise<never> => { throw new Error("not exercised by this test"); };
  const requisitions: ServiceDependencies["requisitions"] = {
    get: async (id) => (requisitionMap.has(id) ? structuredClone(requisitionMap.get(id)!) : null),
    save: async (value) => { requisitionMap.set(value.id, structuredClone(value)); },
    list: async () => [...requisitionMap.values()],
    listVisibleTo: async () => [...requisitionMap.values()],
  };
  const consecutives: ServiceDependencies["consecutives"] = { take: async (prefix, year) => `${prefix}-${year}-${String(++sequence).padStart(4, "0")}` };
  const items: ServiceDependencies["items"] = { propose: async () => ({ id: `catalog-${++sequence}`, created: true }) };
  const audit: ServiceDependencies["audit"] = { append: async () => {}, list: async () => [] };
  const notifications: ServiceDependencies["notifications"] = { enqueue: async () => {} };
  const repositories: TransactionRepositories = {
    requisitions,
    orders: { save: unused, list: unused, listVisibleTo: unused, listByRequisition: unused, get: unused },
    expenses: { get: unused, save: unused, saveShares: unused, list: unused, listVisibleTo: unused, listByReference: unused },
    pettyCash: { save: unused, list: unused },
    audit, consecutives,
    tags: { getApproverId: unused },
    features: { isEnabled: unused },
    items,
    catalogs: { create: unused, get: unused, update: unused, findSupplierDuplicate: unused, isEligibleApprover: unused, authUserExists: unused },
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
  let copyAllShouldThrow = false;
  const fakeCopier = {
    copyAll: async (_event: unknown, requisitionId: string, sources: readonly { itemId: string; attachmentUrl: string }[]): Promise<void> => {
      copyAllCalls.push({ requisitionId, sources: [...sources] });
      if (copyAllShouldThrow) throw new Error("copy failed");
    },
  };
  let currentDependencies: ServiceDependencies | null = null;
  return {
    fakeStore, fakeCopier, copyAllCalls,
    getDependencies: (): ServiceDependencies | null => currentDependencies,
    setDependencies: (value: ServiceDependencies): void => { currentDependencies = value; },
    setCopyAllShouldThrow: (value: boolean): void => { copyAllShouldThrow = value; },
    reset: (): void => { storeState = "new"; storedRequisitionId = null; copyAllCalls.length = 0; copyAllShouldThrow = false; },
  };
});

vi.mock("../../lib/infrastructure/kapso-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/infrastructure/kapso-store")>();
  return { ...actual, createPostgresKapsoProcessingStore: () => hoisted.fakeStore, createKapsoAttachmentCopier: () => hoisted.fakeCopier };
});
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({ createPostgresDependencies: () => hoisted.getDependencies() }));

import { sniffAttachmentMime } from "../../lib/infrastructure/kapso-store";
import { POST } from "../../app/api/kapso/route";

const ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key-0123456789",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-0123456789",
  KAPSO_WEBHOOK_SECRET: "test-kapso-webhook-secret-0123456789",
};
const savedEnv: Record<string, string | undefined> = {};

const fixtureRaw = readFileSync(resolve("fixtures/kapso-flow.json"), "utf8");
function sign(raw: string): string { return `sha256=${hmacSha256(raw, ENV.KAPSO_WEBHOOK_SECRET)}`; }
function postRaw(raw: string, headers: Record<string, string> = {}): Promise<Response> {
  return POST(new Request("http://localhost/api/kapso", { method: "POST", body: raw, headers: { "content-type": "application/json", "x-kapso-signature": sign(raw), ...headers } }));
}

describe("sniffAttachmentMime — firma real de bytes, no Content-Type declarado", () => {
  it("reconoce los cuatro tipos permitidos por su firma binaria", () => {
    expect(sniffAttachmentMime(Buffer.from("%PDF-1.4 resto del archivo"))).toMatchObject({ mimeType: "application/pdf", extension: "pdf" });
    expect(sniffAttachmentMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))).toMatchObject({ mimeType: "image/jpeg", extension: "jpg" });
    expect(sniffAttachmentMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]))).toMatchObject({ mimeType: "image/png", extension: "png" });
    const webp = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBP", "latin1")]);
    expect(sniffAttachmentMime(webp)).toMatchObject({ mimeType: "image/webp", extension: "webp" });
  });
  it("rechaza contenido cuyos bytes no calzan con ninguna firma permitida", () => {
    expect(sniffAttachmentMime(Buffer.from("MZ\x90\x00esto es un ejecutable, no una foto"))).toBeNull();
    expect(sniffAttachmentMime(Buffer.alloc(0))).toBeNull();
    expect(sniffAttachmentMime(Buffer.from("texto plano sin firma alguna"))).toBeNull();
  });
});

describe("POST /api/kapso", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  beforeEach(() => { hoisted.reset(); hoisted.setDependencies(fakeServiceDependencies().dependencies); });
  afterEach(() => { vi.restoreAllMocks(); });

  describe("endurecimiento: límite de tamaño sin bufferizar todo el body", () => {
    it("corta la lectura de un body en streaming que nunca declara content-length y supera el límite", async () => {
      const chunk = new Uint8Array(50_000).fill(97);
      // La fuente nunca cierra el stream: una implementación vieja que hiciera request.text() primero
      // se quedaría esperando para siempre. Si esto no cuelga y responde 413, el corte temprano funciona.
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); } });
      const init: RequestInit & { duplex?: "half" } = { method: "POST", body: stream, duplex: "half" };
      const response = await POST(new Request("http://localhost/api/kapso", init));
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "invalid_event" });
    }, 2_000);

    it("rechaza también un body finito pero mayor al límite enviado sin content-length", async () => {
      const chunks = [new Uint8Array(60_000).fill(98), new Uint8Array(60_000).fill(98)];
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); } });
      const init: RequestInit & { duplex?: "half" } = { method: "POST", body: stream, duplex: "half" };
      const response = await POST(new Request("http://localhost/api/kapso", init));
      expect(response.status).toBe(413);
    });
  });

  describe("endurecimiento: fixture conectado a una prueba real del endpoint (firma HMAC válida)", () => {
    it("acepta fixtures/kapso-flow.json firmado y crea la requisición", async () => {
      const response = await postRaw(fixtureRaw);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true, status: "created" });
    });

    it("rechaza el mismo fixture si la firma HMAC es inválida", async () => {
      const response = await POST(new Request("http://localhost/api/kapso", { method: "POST", body: fixtureRaw, headers: { "x-kapso-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000" } }));
      expect(response.status).toBe(401);
    });
  });

  describe("adjuntos del Flow de WhatsApp (RF-903)", () => {
    it("ya no falla cerrado con attachment_storage_not_configured", async () => {
      const response = await postRaw(fixtureRaw);
      const body = (await response.json()) as { error?: string };
      expect(body.error).not.toBe("attachment_storage_not_configured");
      expect(response.status).toBe(200);
    });

    it("copia únicamente el ítem que trae attachmentUrl, emparejado por posición con el ítem creado", async () => {
      const { dependencies, requisitionMap } = fakeServiceDependencies();
      hoisted.setDependencies(dependencies);
      await postRaw(fixtureRaw);
      expect(hoisted.copyAllCalls).toHaveLength(1);
      const [call] = hoisted.copyAllCalls;
      const [requisition] = [...requisitionMap.values()];
      expect(requisition.items).toHaveLength(2);
      expect(call.requisitionId).toBe(requisition.id);
      expect(call.sources).toEqual([{ itemId: requisition.items[1].id, attachmentUrl: "https://api.kapso.ai/v1/whatsapp/media/wamid.fixture-attachment-001" }]);
    });

    it("crea la requisición igual aunque falle por completo la copia del adjunto (RF-903: no bloquea la solicitud)", async () => {
      hoisted.setCopyAllShouldThrow(true);
      const { dependencies, requisitionMap } = fakeServiceDependencies();
      hoisted.setDependencies(dependencies);
      const response = await postRaw(fixtureRaw);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ received: true, status: "created" });
      expect(requisitionMap.size).toBe(1);
      expect(hoisted.copyAllCalls).toHaveLength(1);
    });

    it("no invoca la copia de adjuntos cuando ningún ítem trae attachmentUrl", async () => {
      const noAttachmentEvent = { eventId: "evt-sin-adjunto", type: "flow_submission" as const, receivedAt: "2026-08-24T12:00:00.000Z", submission: { eventId: "evt-sin-adjunto", phone: "+573001234567", workId: "11111111-1111-4111-8111-111111111111", requiredDate: "2026-08-30", type: "compra" as const, requesterName: "Maestro sin evidencia", items: [{ quantity: 1, unit: "unidad", proposedDescription: "Ítem sin foto" }] } };
      const raw = JSON.stringify(noAttachmentEvent);
      const response = await postRaw(raw);
      expect(response.status).toBe(200);
      expect(hoisted.copyAllCalls).toHaveLength(0);
    });
  });
});
