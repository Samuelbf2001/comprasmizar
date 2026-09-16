import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Requisition } from "../../lib/domain";
import type { ServiceDependencies, TransactionRepositories } from "../../lib/services";
import type { CatalogSupplier } from "../../lib/services/contracts";

// RF-108 (adenda de pagos, S3): solicitud de pago desde el portal público. Este archivo prueba el
// camino REAL de punta a punta — `POST /api/public/requisitions` con `type: "pago"` ->
// `ProcurementService.create` (con dependencias en memoria, mismo arnés que
// tests/integration/public-photos.test.ts) -> beneficiario enlazado o creado `pendingNormalization`
// (RF-606) en la MISMA transacción -> requisición con UNA línea de concepto cuyo valor es el monto.
//
// Lo que esto fija: que el pago llega a la bandeja (antes el esquema no tenía monto ni beneficiario
// y el 202 neutro lo perdía en silencio), que el proveedor nace pendiente de normalizar solo cuando
// la identificación no existe, que la factura (foto_0) queda ligada a la línea de concepto, y que un
// pago mal formado o una contraseña incorrecta no dejan nada a medias.

type AuditEntry = { entity: string; entityId: string; event: string; data?: Record<string, unknown> };

function fakeServiceDependencies(existingSuppliers: CatalogSupplier[] = []) {
  const requisitionMap = new Map<string, Requisition>();
  const suppliers = new Map<string, CatalogSupplier>(existingSuppliers.map((supplier) => [supplier.id, supplier]));
  const createdSuppliers: CatalogSupplier[] = [];
  const audits: AuditEntry[] = [];
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
      if (kind !== "suppliers") throw new Error(`catalogs.create(${kind}) not exercised by this test`);
      const supplier = { id: `sup-${++sequence}`, ...(value as Omit<CatalogSupplier, "id">) };
      suppliers.set(supplier.id, supplier);
      createdSuppliers.push(supplier);
      return supplier;
    },
    get: async (kind, id) => (kind === "suppliers" ? suppliers.get(id) ?? null : null),
    update: unused, findSupplierDuplicate: unused,
    findSupplierByIdentification: async (type, identification) => [...suppliers.values()].find((supplier) => supplier.identificationType === type && supplier.identification === identification) ?? null,
    findRequesterDuplicate: unused, isEligibleApprover: unused, hasRequisitionsForWork: unused,
  };
  const audit: ServiceDependencies["audit"] = { append: async (entry) => { audits.push(entry); }, list: async () => [] };
  const repositories: TransactionRepositories = {
    requisitions,
    orders: { save: unused, list: unused, listVisibleTo: unused, listByRequisition: unused, get: unused, listAttentionCandidates: unused, listRecentlyUpdated: unused, dashboardPendingCount: unused },
    expenses: { get: unused, save: unused, markPaid: unused, deleteByReference: unused, saveShares: unused, list: unused, listVisibleTo: unused, listByReference: unused, dashboardAggregates: unused, listRecentlyUpdated: unused },
    orderPayments: { save: unused, listByOrder: unused, get: unused, annul: unused, listCash: unused },
    pettyCash: { save: unused, list: unused },
    incomes: { save: unused, list: unused },
    cashCloses: { get: unused, listByCashBox: unused, sumMovements: unused, previousClosingBalance: unused, upsert: unused, tagMovements: unused, setStatus: unused, listMovementsByCostCenter: unused },
    audit,
    consecutives: { take: async (prefix, year) => `${prefix}-${year}-${String(++sequence).padStart(4, "0")}` },
    features: { isEnabled: unused },
    items: { propose: async () => ({ id: `catalog-${++sequence}`, created: true }) },
    catalogs,
    notifications: { enqueue: async () => {} },
  };
  const dependencies: ServiceDependencies = {
    ...repositories,
    publicAccess: { verify: async () => true, verifySociety: async () => true },
    transactions: { transaction: async <T>(_lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> => work(repositories) },
    clock: { now: () => new Date("2026-09-16T12:00:00.000Z") },
    ids: { next: () => `id-${++sequence}` },
  };
  return { dependencies, requisitionMap, createdSuppliers, audits };
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
const societyId = "22222222-2222-4222-8222-222222222222";
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function pagoPayload(overrides: Record<string, unknown> = {}) {
  return {
    workId, code: "1234", type: "pago", phone: "+57 300 123 4567",
    beneficiary: { identificationType: "CC", identification: "1020304050", name: "Ana Topógrafa" },
    amount: 1_250_000, concept: "Levantamiento topográfico lote 3",
    ...overrides,
  };
}
function jsonRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/public/requisitions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
function multipartRequest(payload: Record<string, unknown>, files: Record<string, { name: string; type: string; bytes: Buffer }> = {}): Request {
  const form = new FormData();
  form.set("payload", JSON.stringify(payload));
  for (const [field, file] of Object.entries(files)) form.set(field, new File([new Uint8Array(file.bytes)], file.name, { type: file.type }));
  return new Request("http://localhost/api/public/requisitions", { method: "POST", body: form });
}
const proveedorExistente: CatalogSupplier = { id: "sup-existente", name: "Ana T. Topografía", nit: null, active: true, identificationType: "CC", identification: "1020304050", pendingNormalization: false };

describe("solicitud de pago del portal público — camino real de punta a punta", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  beforeEach(() => { hoisted.reset(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("crea la requisición tipo pago con UNA línea de concepto (valor = monto) y un beneficiario NUEVO pendiente de normalizar", async () => {
    const { dependencies, requisitionMap, createdSuppliers, audits } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await POST(jsonRequest(pagoPayload()));

    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    const [requisicion] = [...requisitionMap.values()];
    expect(requisicion).toMatchObject({ type: "pago", channel: "publico", workId, status: "enviada", externalRequester: { name: "Ana Topógrafa", phone: "+573001234567" } });
    expect(requisicion.items).toHaveLength(1);
    // Misma forma que el formulario interno: cantidad 1, `servicio`, y el valor en la base de la línea.
    expect(requisicion.items[0]).toMatchObject({ description: "Levantamiento topográfico lote 3", quantity: 1, unit: "servicio", unitBase: 1_250_000 });

    // El proveedor nació en la misma transacción, pendiente de que Daniel complete la ficha (RF-606),
    // con la identificación como identidad (nit NULL: es una persona) y el teléfono que dejó.
    expect(createdSuppliers).toHaveLength(1);
    expect(createdSuppliers[0]).toMatchObject({ name: "Ana Topógrafa", identificationType: "CC", identification: "1020304050", pendingNormalization: true, active: true, nit: null, phone: "+573001234567" });
    expect(requisicion.items[0].finalSupplierId).toBe(createdSuppliers[0].id);
    expect(audits.find((entry) => entry.entity === "proveedor" && entry.event === "creado")?.data).toMatchObject({ source: "beneficiario", channel: "publico", pendingNormalization: true });
  });

  it("si la identificación YA existe en el catálogo, enlaza ese proveedor y no crea otro, aunque el nombre venga distinto", async () => {
    const { dependencies, requisitionMap, createdSuppliers } = fakeServiceDependencies([proveedorExistente]);
    hoisted.setDependencies(dependencies);

    const response = await POST(jsonRequest(pagoPayload()));

    expect(response.status).toBe(202);
    const [requisicion] = [...requisitionMap.values()];
    expect(requisicion.items[0].finalSupplierId).toBe("sup-existente");
    expect(createdSuppliers).toHaveLength(0);
  });

  it("la foto de la factura o cuenta de cobro (foto_0) se guarda ligada a la línea de concepto", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await POST(multipartRequest(pagoPayload(), { foto_0: { name: "factura.png", type: "image/png", bytes: PNG_BYTES } }));

    expect(response.status).toBe(202);
    const [requisicion] = [...requisitionMap.values()];
    expect(hoisted.uploads).toHaveLength(1);
    expect(hoisted.uploads[0].path).toContain(`/${requisicion.items[0].id}/`);
    const insertAdjunto = hoisted.inserts.find((entry) => entry.sql.includes("insert into adjuntos"));
    expect(insertAdjunto).toBeDefined();
    expect(insertAdjunto!.sql).toContain("'requisicion_item'");
    expect(insertAdjunto!.values).toContain(requisicion.items[0].id);
  });

  it("un pago SIN monto responde 400 y no deja ni requisición ni proveedor", async () => {
    const { dependencies, requisitionMap, createdSuppliers } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    // `JSON.stringify` omite las claves `undefined`: el cuerpo viaja sin `amount`.
    const response = await POST(jsonRequest(pagoPayload({ amount: undefined })));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_input" });
    expect(requisitionMap.size).toBe(0);
    expect(createdSuppliers).toHaveLength(0);
  });

  it("con la contraseña incorrecta responde el 202 neutro y no crea requisición ni proveedor", async () => {
    const { dependencies, requisitionMap, createdSuppliers } = fakeServiceDependencies();
    dependencies.publicAccess.verify = async () => false;
    hoisted.setDependencies(dependencies);

    const response = await POST(jsonRequest(pagoPayload()));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(requisitionMap.size).toBe(0);
    expect(createdSuppliers).toHaveLength(0);
  });

  it("por EMPRESA (ruta general) el pago se radica igual: el servicio verifica la sociedad, no la obra", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);

    const response = await POST(jsonRequest(pagoPayload({ workId: undefined, societyId })));

    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
  });
});
