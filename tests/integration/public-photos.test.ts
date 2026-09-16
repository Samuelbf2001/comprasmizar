import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Requisition } from "../../lib/domain";
import type { ServiceDependencies, TransactionRepositories } from "../../lib/services";

// RF portal-fotos-articulo: el portal público (components/screens/public-request.tsx) admite ahora
// UNA foto opcional por artículo, calcada del `PhotoPicker` del Flow de WhatsApp. Este archivo prueba
// el camino REAL de punta a punta — `POST /api/public/requisitions` con `multipart/form-data` ->
// `ProcurementService.create` (con dependencias en memoria, mismo arnés que
// tests/integration/kapso-attachments.test.ts) -> `lib/infrastructure/public-photos.ts` (real, sin
// mockear) -> almacenamiento y SQL de adjuntos FALSOS, para poder afirmar qué se escribió sin tocar
// disco ni Postgres.
//
// El diseño de seguridad que esto verifica: la foto viaja en la MISMA petición que radica (nunca un
// endpoint de subida previa), solo se guarda si la radicación fue válida (contraseña primero), cada
// archivo se valida por separado con la firma binaria real (nunca el Content-Type declarado) y una
// foto inválida se descarta sin romper la creación de la requisición.

function fakeServiceDependencies(): { dependencies: ServiceDependencies; requisitionMap: Map<string, Requisition> } {
  const requisitionMap = new Map<string, Requisition>();
  let sequence = 0;
  const unused = async (): Promise<never> => { throw new Error("not exercised by this test"); };
  const requisitions: ServiceDependencies["requisitions"] = {
    get: async (id) => (requisitionMap.has(id) ? structuredClone(requisitionMap.get(id)!) : null),
    save: async (value) => { requisitionMap.set(value.id, structuredClone(value)); },
    list: async () => [...requisitionMap.values()],
    listVisibleTo: async () => [...requisitionMap.values()],
    listVisibleHeaders: unused, dashboardByStatus: unused,
  };
  const consecutives: ServiceDependencies["consecutives"] = { take: async (prefix, year) => `${prefix}-${year}-${String(++sequence).padStart(4, "0")}` };
  const items: ServiceDependencies["items"] = { propose: async () => ({ id: `catalog-${++sequence}`, created: true }) };
  const audit: ServiceDependencies["audit"] = { append: async () => {}, list: async () => [] };
  const notifications: ServiceDependencies["notifications"] = { enqueue: async () => {} };
  const verifyResult = true;
  const repositories: TransactionRepositories = {
    requisitions,
    orders: { save: unused, list: unused, listVisibleTo: unused, listByRequisition: unused, get: unused, listAttentionCandidates: unused, listRecentlyUpdated: unused, dashboardPendingCount: unused },
    expenses: { get: unused, save: unused, markPaid: unused, deleteByReference: unused, saveShares: unused, list: unused, listVisibleTo: unused, listByReference: unused, dashboardAggregates: unused, listRecentlyUpdated: unused },
    orderPayments: { save: unused, listByOrder: unused, get: unused, annul: unused, listCash: unused },
    pettyCash: { save: unused, list: unused },
    incomes: { save: unused, list: unused },
    cashCloses: { get: unused, listByCashBox: unused, sumMovements: unused, previousClosingBalance: unused, upsert: unused, tagMovements: unused, setStatus: unused, listMovementsByCostCenter: unused },
    audit, consecutives,
    features: { isEnabled: unused },
    items,
    catalogs: { create: unused, get: unused, update: unused, findSupplierDuplicate: unused, findSupplierByIdentification: unused, findRequesterDuplicate: unused, isEligibleApprover: unused, hasRequisitionsForWork: unused },
    notifications,
  };
  const dependencies: ServiceDependencies = {
    ...repositories,
    publicAccess: { verify: async () => verifyResult, verifySociety: async () => verifyResult },
    transactions: { transaction: async <T>(_lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> => work(repositories) },
    clock: { now: () => new Date("2026-09-13T12:00:00.000Z") },
    ids: { next: () => `id-${++sequence}` },
  };
  return { dependencies, requisitionMap };
}

const hoisted = vi.hoisted(() => {
  const uploads: Array<{ path: string; mimeType: string; sizeBytes: number }> = [];
  const inserts: Array<{ sql: string; values: unknown[] }> = [];
  const fakeStorage = {
    createUploadUrl: async () => ({ url: "unused" }),
    info: async () => null,
    createDownloadUrl: async () => "unused",
    upload: async (objectPath: string, bytes: Buffer, mimeType: string) => { uploads.push({ path: objectPath, mimeType, sizeBytes: bytes.byteLength }); },
  };
  function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
    inserts.push({ sql: strings.join("?"), values });
    return Promise.resolve([]);
  }
  fakeSql.json = (value: unknown) => value;
  let currentDependencies: ServiceDependencies | null = null;
  return {
    uploads, inserts, fakeStorage, fakeSql,
    getDependencies: (): ServiceDependencies | null => currentDependencies,
    setDependencies: (value: ServiceDependencies): void => { currentDependencies = value; },
    reset: (): void => { uploads.length = 0; inserts.length = 0; },
  };
});

vi.mock("../../lib/infrastructure/local-storage", () => ({ createLocalBucketStorage: () => hoisted.fakeStorage }));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  createPostgresDependencies: () => hoisted.getDependencies(),
  sharedPostgres: () => hoisted.fakeSql,
}));

import { POST } from "../../app/api/public/requisitions/route";

const ENV: Record<string, string> = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/db",
  STORAGE_ROOT: "/tmp/mizar-test-storage",
  STORAGE_SIGNING_SECRET: "test-storage-signing-secret-0123456789",
  PUBLIC_FORM_CODE_PEPPER: "test-public-form-code-pepper-0123456789",
};
const savedEnv: Record<string, string | undefined> = {};

const workId = "11111111-1111-4111-8111-111111111111";
// Firma PNG real (8 bytes) más un poco de relleno — sniffAttachmentMime solo mira la cabecera, así
// que esto basta para pasar por "imagen válida" sin necesitar un PNG bien formado de verdad.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOT_AN_IMAGE = Buffer.from("esto no es una imagen, es texto plano");

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    workId, code: "1234", type: "compra", name: "Maestro de obra",
    items: [{ description: "Cemento", quantity: 1, unit: "und" }, { description: "Arena", quantity: 2, unit: "m3" }],
    ...overrides,
  };
}
function multipartRequest(payload: Record<string, unknown>, files: Record<string, { name: string; type: string; bytes: Buffer }> = {}, headers: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const [field, file] of Object.entries(files)) form.set(field, new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request("http://localhost/api/public/requisitions", { method: "POST", headers, body: form });
}

describe("foto opcional por artículo del portal público — camino real de punta a punta", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  beforeEach(() => { hoisted.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("el camino JSON puro sigue exactamente igual: no toca almacenamiento ni adjuntos", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const response = await POST(new Request("http://localhost/api/public/requisitions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(basePayload()),
    }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    expect(hoisted.uploads).toHaveLength(0);
    expect(hoisted.inserts.some((entry) => entry.sql.includes("insert into adjuntos"))).toBe(false);
  });

  it("una foto válida en multipart se guarda ligada al ÍTEM CREADO correspondiente, por índice", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    // foto_1: le corresponde al SEGUNDO artículo (Arena), no al primero.
    const response = await POST(multipartRequest(basePayload(), { foto_1: { name: "frente-obra.png", type: "image/png", bytes: PNG_BYTES } }));
    expect(response.status).toBe(202);

    const [requisicion] = [...requisitionMap.values()];
    expect(requisicion.items).toHaveLength(2);
    expect(hoisted.uploads).toHaveLength(1);
    expect(hoisted.uploads[0].path).toContain(`/${requisicion.items[1].id}/`);
    expect(hoisted.uploads[0].mimeType).toBe("image/png");

    const insertAdjunto = hoisted.inserts.find((entry) => entry.sql.includes("insert into adjuntos"));
    expect(insertAdjunto).toBeDefined();
    // `entidad='requisicion_item'`, `tipo='foto'` y `subido_por=null` viajan como texto literal en el
    // SQL (no interpolados, ver public-photos.ts); `entidad_id` sí es un valor interpolado, con el id
    // del ítem correcto.
    expect(insertAdjunto!.sql).toContain("'requisicion_item'");
    expect(insertAdjunto!.sql).toContain("'foto'");
    expect(insertAdjunto!.sql).toMatch(/,\s*null,/);
    expect(insertAdjunto!.values).toContain(requisicion.items[1].id);
  });

  it("una foto INVÁLIDA (bytes que no calzan ninguna firma) se descarta, y la requisición se crea igual", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const response = await POST(multipartRequest(basePayload(), { foto_0: { name: "no-es-foto.png", type: "image/png", bytes: NOT_AN_IMAGE } }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    expect(hoisted.uploads).toHaveLength(0);
    expect(hoisted.inserts.some((entry) => entry.sql.includes("insert into adjuntos"))).toBe(false);
  });

  it("una foto que excede el tope de 5 MB se descarta sin romper la radicación", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    const response = await POST(multipartRequest(basePayload(), { foto_0: { name: "gigante.png", type: "image/png", bytes: tooBig } }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    expect(hoisted.uploads).toHaveLength(0);
  });

  it("con contraseña incorrecta no se guarda NADA, ni siquiera en disco: la validación va antes que la foto", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    dependencies.publicAccess.verify = async () => false;
    hoisted.setDependencies(dependencies);
    const response = await POST(multipartRequest(basePayload(), { foto_0: { name: "foto.png", type: "image/png", bytes: PNG_BYTES } }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(0);
    expect(hoisted.uploads).toHaveLength(0);
    expect(hoisted.inserts).toHaveLength(0);
  });

  it("un Content-Length declarado por encima del tope multipart (~60 MB) se rechaza sin leer el cuerpo", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const request = multipartRequest(basePayload(), { foto_0: { name: "foto.png", type: "image/png", bytes: PNG_BYTES } }, { "content-length": String(61 * 1024 * 1024) });
    const response = await POST(request);
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(0);
    expect(hoisted.uploads).toHaveLength(0);
  });

  it("una foto de más (índice sin ítem correspondiente) se ignora en vez de reventar", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    // Solo hay 2 ítems (índices 0 y 1): foto_5 no corresponde a ninguno.
    const response = await POST(multipartRequest(basePayload(), { foto_5: { name: "foto.png", type: "image/png", bytes: PNG_BYTES } }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    expect(hoisted.uploads).toHaveLength(0);
  });
});
