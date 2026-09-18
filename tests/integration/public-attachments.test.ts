import ExcelJS from "exceljs";
import { PDFDocument } from "pdf-lib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Requisition } from "../../lib/domain";
import { MAX_PUBLIC_ATTACHMENT_BYTES } from "../../lib/infrastructure/public-attachments";
import { publicFormRateLimiter, publicWorkAggregateRateLimiter, publicWorkRateLimiter } from "../../lib/security/rate-limit";
import type { ServiceDependencies, TransactionRepositories } from "../../lib/services";

// RF portal-fotos-articulo: el portal público (components/screens/public-request.tsx) admite UN
// soporte opcional por artículo, calcado del `PhotoPicker` del Flow de WhatsApp. Desde el 2026-09-17
// ese soporte ya no es solo una foto (decisión de Ernesto: «muchos tipos de archivos, CSV, Excel,
// etc., PDF, imágenes, lo que sea»). Este archivo prueba el camino REAL de punta a punta —
// `POST /api/public/requisitions` con `multipart/form-data` -> `ProcurementService.create` (con
// dependencias en memoria, mismo arnés que tests/integration/kapso-attachments.test.ts) ->
// `lib/infrastructure/public-attachments.ts` (real, sin mockear) -> almacenamiento y SQL de adjuntos
// FALSOS, para poder afirmar qué se escribió sin tocar disco ni Postgres.
//
// El diseño de seguridad que esto verifica: el archivo viaja en la MISMA petición que radica (nunca un
// endpoint de subida previa), solo se guarda si la radicación fue válida (contraseña primero), cada
// archivo se valida por separado por su CONTENIDO real (nunca el Content-Type declarado) y uno
// inválido se descarta sin romper la creación de la requisición.

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
// Firma PNG real (8 bytes) más un poco de relleno — la firma solo mira la cabecera, así que esto
// basta para pasar por "imagen válida" sin necesitar un PNG bien formado de verdad. Para los formatos
// que SÍ exigen entender la estructura (OOXML, PDF) se generan archivos de verdad más abajo.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NOT_AN_IMAGE = Buffer.from("esto no es una imagen, es texto plano");
const CSV_BYTES = Buffer.from("descripcion,cantidad\nCemento gris,20\n", "utf8");
const EXECUTABLE_BYTES = Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(64), Buffer.from("This program cannot be run in DOS mode")]);
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** Archivos REALES, con las mismas librerías que el repo ya usa para generar sus propios reportes:
 *  una cabecera inventada a mano solo probaría que el test y el validador se copiaron el mismo byte. */
async function realPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage().drawText("Factura de prueba");
  return Buffer.from(await pdf.save());
}
async function realXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Cantidades").addRow(["Descripción", "Cantidad"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
/** Quinto valor interpolado del `insert into adjuntos` (id, entidad_id, bucket, url, TIPO, …). */
const tipoDe = (insert: { values: unknown[] }) => insert.values[4];

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

describe("soporte opcional por artículo del portal público — camino real de punta a punta", () => {
  beforeAll(() => { for (const key of Object.keys(ENV)) { savedEnv[key] = process.env[key]; process.env[key] = ENV[key]; } });
  afterAll(() => { for (const key of Object.keys(ENV)) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; } });
  // Los limitadores REALES siguen en el camino (el orden "límite antes que nada" es parte de lo que
  // este archivo cubre), pero se les devuelve el presupuesto entre pruebas: si no, a partir de la
  // décima radicación contra la misma obra el endpoint responde el 202 neutro y las pruebas de
  // adjuntos empezarían a "pasar" sin haber creado nada.
  beforeEach(() => { hoisted.reset(); publicFormRateLimiter.reset(); publicWorkRateLimiter.reset(); publicWorkAggregateRateLimiter.reset(); });
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
    // `entidad='requisicion_item'` y `subido_por=null` viajan como texto literal en el SQL (no
    // interpolados, ver public-attachments.ts); `entidad_id` y, desde la ampliación de formatos,
    // `tipo` sí son valores interpolados — una imagen sigue entrando como 'foto'.
    expect(insertAdjunto!.sql).toContain("'requisicion_item'");
    expect(insertAdjunto!.sql).toMatch(/,\s*null,/);
    expect(insertAdjunto!.values).toContain(requisicion.items[1].id);
    expect(tipoDe(insertAdjunto!)).toBe("foto");
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

  it("el descarte ya no es mudo: queda en auditoría y en el log, con el motivo (aquí, texto con nombre .png) y sin el nombre del archivo", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { dependencies } = fakeServiceDependencies();
      hoisted.setDependencies(dependencies);
      await POST(multipartRequest(basePayload(), { foto_0: { name: "factura-juan-perez.png", type: "image/png", bytes: NOT_AN_IMAGE } }));
      const audit = hoisted.inserts.find((entry) => entry.sql.includes("'ADJUNTO_PORTAL_DESCARTADO'"));
      expect(audit).toBeDefined();
      expect(JSON.stringify(audit!.values)).toContain("extension_no_coincide");
      expect(JSON.stringify(audit!.values)).not.toContain("juan-perez");
      const logged = warn.mock.calls.map((call) => String(call[0])).find((line) => line.includes("adjunto_portal_descartado"));
      expect(logged).toBeDefined();
      expect(logged).toContain("extension_no_coincide");
      expect(logged).not.toContain("juan-perez");
    } finally {
      warn.mockRestore();
    }
  });

  it("una foto que excede el tope de 10 MB se descarta sin romper la radicación", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const tooBig = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_PUBLIC_ATTACHMENT_BYTES)]);
    const response = await POST(multipartRequest(basePayload(), { foto_0: { name: "gigante.png", type: "image/png", bytes: tooBig } }));
    expect(response.status).toBe(202);
    expect(requisitionMap.size).toBe(1);
    expect(hoisted.uploads).toHaveLength(0);
  });

  // Ampliación 2026-09-17: lo que sube quien radica por el portal ya no tiene por qué ser una foto.
  // Lo que decide qué es cada archivo —y por tanto con qué `tipo` se guarda— son SUS BYTES.
  it("un PDF real y un XLSX real se guardan como `soporte`, con el MIME que husmeó el servidor", async () => {
    for (const caso of [
      { name: "factura.pdf", bytes: await realPdf(), mimeType: "application/pdf" },
      { name: "cantidades.xlsx", bytes: await realXlsx(), mimeType: XLSX_MIME },
    ]) {
      hoisted.reset();
      const { dependencies, requisitionMap } = fakeServiceDependencies();
      hoisted.setDependencies(dependencies);
      // Content-Type MENTIROSO a propósito: el navegador dice que es una foto y no se le hace caso.
      const response = await POST(multipartRequest(basePayload(), { foto_0: { name: caso.name, type: "image/png", bytes: caso.bytes } }));
      expect(response.status).toBe(202);

      const [requisicion] = [...requisitionMap.values()];
      expect(hoisted.uploads, caso.name).toHaveLength(1);
      expect(hoisted.uploads[0].mimeType).toBe(caso.mimeType);
      expect(hoisted.uploads[0].path).toContain(`/${requisicion.items[0].id}/`);
      const insertAdjunto = hoisted.inserts.find((entry) => entry.sql.includes("insert into adjuntos"));
      // `tipo` dejó de viajar como literal en el SQL y es ahora un valor interpolado: un documento se
      // guarda como 'soporte', nunca como 'foto' (que en la base debe seguir siendo una imagen).
      expect(tipoDe(insertAdjunto!)).toBe("soporte");
      
      expect(insertAdjunto!.values).toContain(caso.mimeType);
    }
  });

  it("un CSV se acepta como texto y una imagen sigue guardándose como `foto`", async () => {
    const { dependencies } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const response = await POST(multipartRequest(basePayload(), {
      foto_0: { name: "lista.csv", type: "application/vnd.ms-excel", bytes: CSV_BYTES },
      foto_1: { name: "frente.png", type: "image/png", bytes: PNG_BYTES },
    }));
    expect(response.status).toBe(202);
    expect(hoisted.uploads.map((upload) => upload.mimeType)).toEqual(["text/plain", "image/png"]);
    const tipos = hoisted.inserts.filter((entry) => entry.sql.includes("insert into adjuntos")).map(tipoDe);
    expect(tipos).toEqual(["soporte", "foto"]);
  });

  it("un ejecutable disfrazado de PDF y un zip que no es OOXML se descartan, y la requisición se crea igual", async () => {
    const zipNoOoxml = Buffer.from((await realXlsx()).toString("latin1").split("[Content_Types].xml").join("[Content_Typez].xml"), "latin1");
    for (const caso of [
      { name: "factura.pdf", bytes: EXECUTABLE_BYTES },
      { name: "cantidades.xlsx", bytes: zipNoOoxml },
    ]) {
      hoisted.reset();
      const { dependencies, requisitionMap } = fakeServiceDependencies();
      hoisted.setDependencies(dependencies);
      const response = await POST(multipartRequest(basePayload(), { foto_0: { name: caso.name, type: "application/pdf", bytes: caso.bytes } }));
      expect(response.status).toBe(202);
      expect(requisitionMap.size, caso.name).toBe(1);
      expect(hoisted.uploads, caso.name).toHaveLength(0);
      expect(hoisted.inserts.some((entry) => entry.sql.includes("insert into adjuntos"))).toBe(false);
    }
  });

  it("un archivo cuya extensión no corresponde con lo que resultó ser se descarta", async () => {
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    // Un XLSX de verdad, pero nombrado .pdf: se guardaría con `mime_type` de hoja y nombre de PDF, y
    // el CHECK `nombre_mime_adjunto_valido` de la base lo rechazaría. Se corta antes.
    const response = await POST(multipartRequest(basePayload(), { foto_0: { name: "cantidades.pdf", type: "application/pdf", bytes: await realXlsx() } }));
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

  it("un Content-Length declarado por encima del tope multipart (~60 MB) se rechaza sin leer el cuerpo, y se dice (413)", async () => {
    // Adenda de pagos (S3): el 202 neutro se reserva para contraseña/enlace; un cuerpo demasiado
    // grande se rechaza ANTES de cualquier verificación, así que decirlo no filtra nada y el portal
    // puede pedir una foto más liviana en vez de fingir que se radicó.
    const { dependencies, requisitionMap } = fakeServiceDependencies();
    hoisted.setDependencies(dependencies);
    const request = multipartRequest(basePayload(), { foto_0: { name: "foto.png", type: "image/png", bytes: PNG_BYTES } }, { "content-length": String(61 * 1024 * 1024) });
    const response = await POST(request);
    expect(response.status).toBe(413);
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
