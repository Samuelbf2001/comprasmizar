import { describe, expect, it } from "vitest";
import { supplierCreateSchema } from "../../app/api/suppliers/route";
import { DomainError, type Supplier, type SupplierDocument } from "../../lib/domain";
import { SupplierService, type SupplierDocumentUpload, type SupplierServiceDependencies, type SupplierTransaction } from "../../lib/services";

const reviewer = { id: "reviewer", roles: ["revisor"] as const };
const sixteam = { id: "sixteam", roles: ["admin_sixteam"] as const };
const accounting = { id: "accounting", roles: ["contabilidad"] as const };
const mizarAdmin = { id: "mizar", roles: ["admin_mizar"] as const };
const supplierId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
const validUpload: SupplierDocumentUpload = { type: "rut", name: "RUT Mízar.pdf", mimeType: "application/pdf", sizeBytes: 42 };

function fixture(options: { feature?: boolean; object?: { sizeBytes: number; mimeType: string } | null } = {}) {
  const suppliers = new Map<string, Supplier>([[supplierId, { id: supplierId, name: "Proveedor inicial", nit: "900123", contact: { email: "proveedor@example.test" }, bankDetails: { bankName: "Banco", accountNumber: "123456789" }, active: true }]]);
  const documents = new Map<string, SupplierDocument>(), audits: unknown[] = [], storagePaths: string[] = [];
  const repository = {
    list: async () => [...suppliers.values()].map((value) => structuredClone(value)),
    get: async (id: string) => suppliers.has(id) ? structuredClone(suppliers.get(id)!) : null,
    create: async (value: Omit<Supplier, "id">) => { const normalizedNit = value.nit?.replace(/[^0-9A-Za-z]/g, "").toLowerCase(); if ([...suppliers.values()].some((entry) => entry.name === value.name || (normalizedNit && entry.nit?.replace(/[^0-9A-Za-z]/g, "").toLowerCase() === normalizedNit))) throw Object.assign(new Error("duplicate"), { code: "23505" }); const created = { ...value, id: `supplier-${suppliers.size + 1}` }; suppliers.set(created.id, structuredClone(created)); return created; },
    update: async (id: string, value: Partial<Omit<Supplier, "id">>) => { const before = suppliers.get(id); if (!before) return null; const after = { ...before, ...value }; suppliers.set(id, structuredClone(after)); return after; },
    listOrders: async () => [{ id: "order-1", consecutive: "OC-2026-0001", type: "OC" as const, status: "generada" as const, generatedAt: "2026-08-24T00:00:00.000Z", total: 100 }],
    listDocuments: async (id: string) => [...documents.values()].filter((entry) => entry.supplierId === id).map((value) => structuredClone(value)),
    getDocument: async (id: string, docId: string) => { const found = documents.get(docId); return found?.supplierId === id ? structuredClone(found) : null; },
    insertDocument: async (value: SupplierDocument) => { if (documents.has(value.id)) throw Object.assign(new Error("duplicate"), { code: "23505" }); documents.set(value.id, structuredClone(value)); return value; },
  };
  const deps: SupplierServiceDependencies = {
    transactions: { transaction: async <T>(_supplierId: string | undefined, work: (tx: SupplierTransaction) => Promise<T>): Promise<T> => { const supplierSnapshot = structuredClone([...suppliers.entries()]), documentSnapshot = structuredClone([...documents.entries()]), auditLength = audits.length; try { return await work({ suppliers: repository, features: { isEnabled: async () => options.feature === true }, audit: { append: async (event) => { audits.push(event); } } }); } catch (error) { suppliers.clear(); supplierSnapshot.forEach(([id, value]) => suppliers.set(id, value)); documents.clear(); documentSnapshot.forEach(([id, value]) => documents.set(id, value)); audits.splice(auditLength); throw error; } } },
    storage: { createUploadUrl: async (path) => { storagePaths.push(path); return { url: `https://storage.test/upload/${encodeURIComponent(path)}?token=private` }; }, info: async () => options.object ?? { sizeBytes: 42, mimeType: "application/pdf" }, createDownloadUrl: async (path) => `https://storage.test/download/${encodeURIComponent(path)}?token=private` },
    clock: { now: () => new Date("2026-08-24T00:00:00.000Z") }, ids: { next: () => documentId },
  };
  return { service: new SupplierService(deps), suppliers, documents, audits, storagePaths };
}

describe("SupplierService", () => {
  it("creates the RF-603 minimum only for review/Sixteam and returns a safe selectable supplier", async () => {
    const state = fixture();
    const created = await state.service.create({ name: "Arenera Chicamocha" }, reviewer);
    expect(created).toMatchObject({ id: "supplier-2", name: "Arenera Chicamocha", nit: null, contact: {}, active: true });
    expect(created).not.toHaveProperty("bankDetails");
    await expect(fixture().service.create({ name: "Agregados" }, sixteam)).resolves.toMatchObject({ name: "Agregados", nit: null });
    await expect(fixture().service.create({ name: "Bloqueado" }, { id: "requester", roles: ["solicitante"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fixture().service.create({ name: "Bloqueado" }, mizarAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fixture({ feature: true }).service.create({ name: "Autoservicio" }, mizarAdmin)).resolves.toMatchObject({ name: "Autoservicio", nit: null });
    const audit = JSON.stringify(state.audits);
    expect(audit).not.toContain("Arenera Chicamocha");
    expect(audit).not.toContain("bankDetails");
  });

  it("requires the RF-603 minimum at the HTTP boundary", () => {
    expect(supplierCreateSchema.safeParse({ name: "Arenera Chicamocha", nit: "901234567" }).success).toBe(true);
    const withoutNit = supplierCreateSchema.safeParse({ name: "Arenera Chicamocha" }), blankNit = supplierCreateSchema.safeParse({ name: "Arenera Chicamocha", nit: "  " });
    expect(withoutNit).toMatchObject({ success: true });
    expect(blankNit).toMatchObject({ success: true, data: { nit: null } });
  });

  it("exposes bank data only to roles explicitly allowed to create the Helisa third party", async () => {
    const service = fixture().service;
    const list = await service.list(accounting);
    expect(list.suppliers[0]).not.toHaveProperty("bankDetails");
    expect(list.access).toEqual({ canManage: false, canReadBank: true });
    const accountingView = await service.get(supplierId, accounting);
    expect(accountingView).toMatchObject({ supplier: { bankDetails: { accountNumber: "123456789" } }, access: { canManage: false, canReadBank: true } });
    await expect(service.get(supplierId, reviewer)).resolves.toMatchObject({ supplier: { bankDetails: { accountNumber: "123456789" } } });
    await expect(service.get(supplierId, { id: "requester", roles: ["solicitante"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fails closed for non-operators and rechecks the Mizar catalogue feature inside every transaction", async () => {
    const disabled = fixture();
    await expect(disabled.service.create({ name: "Bloqueado", nit: "900111222" }, accounting)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disabled.service.update(supplierId, { bankDetails: { accountNumber: "1111" } }, accounting)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disabled.service.update(supplierId, { active: false }, mizarAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(fixture({ feature: true }).service.update(supplierId, { active: false }, mizarAdmin)).resolves.toMatchObject({ active: false });
  });

  it("redacts bank values in creation/update audit snapshots and maps duplicate suppliers to a conflict", async () => {
    const state = fixture();
    await state.service.create({ name: "Nuevo", nit: "900111222", bankDetails: { accountNumber: "99887766", bankName: "Banco privado" } }, reviewer);
    await state.service.update(supplierId, { bankDetails: { accountNumber: "55554444" } }, reviewer);
    expect(JSON.stringify(state.audits)).not.toContain("99887766");
    expect(JSON.stringify(state.audits)).not.toContain("55554444");
    await expect(state.service.create({ name: "Otro proveedor", nit: "900-123" }, reviewer)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(state.service.create({ name: "Proveedor sin NIT uno" }, reviewer)).resolves.toMatchObject({ nit: null });
    await expect(state.service.create({ name: "Proveedor sin NIT dos", nit: "   " }, reviewer)).resolves.toMatchObject({ nit: null });
  });

  it("supports clearing an erroneous NIT and replaces contact/bank objects without retaining stale fields", async () => {
    const state = fixture();
    await state.service.update(supplierId, { nit: null, contact: {}, bankDetails: {} }, reviewer);
    const detail = await state.service.get(supplierId, reviewer);
    expect(detail.supplier).toMatchObject({ nit: null, contact: {}, bankDetails: {} });
    expect(detail.supplier.contact).not.toHaveProperty("email");
    expect(detail.supplier.bankDetails).not.toHaveProperty("accountNumber");
  });

  it("uses a canonical private path, rejects hostile metadata, verifies Storage before metadata insert, and finalizes idempotently", async () => {
    const state = fixture({ object: { sizeBytes: 42, mimeType: "application/pdf" } });
    const prepared = await state.service.prepareDocument(supplierId, validUpload, reviewer);
    expect(prepared).toMatchObject({ document: { id: documentId, name: "rut-mizar.pdf" }, upload: { method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } });
    expect(JSON.stringify(prepared)).not.toContain("storagePath");
    expect(state.storagePaths).toEqual([`proveedores/${supplierId}/${documentId}/rut-mizar.pdf`]);
    await expect(state.service.completeDocument(supplierId, documentId, validUpload, reviewer)).resolves.toMatchObject({ document: { id: documentId, type: "rut" } });
    expect(state.documents.size).toBe(1);
    const audit = JSON.stringify(state.audits);
    expect(audit).toContain('"type":"rut"');
    expect(audit).not.toContain("application/pdf");
    expect(audit).not.toContain("rut-mizar.pdf");
    expect(audit).not.toContain(`proveedores/${supplierId}`);
    expect(audit).not.toContain("123456789");
    expect(audit).not.toContain("checksum");
    await expect(state.service.completeDocument(supplierId, documentId, validUpload, reviewer)).resolves.toMatchObject({ document: { id: documentId } });
    await expect(state.service.completeDocument(supplierId, documentId, { ...validUpload, sizeBytes: 43 }, reviewer)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(state.service.prepareDocument(supplierId, { ...validUpload, name: "../../secret.pdf" }, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepareDocument(supplierId, { ...validUpload, name: "rut.png" }, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("does not insert metadata when Storage HEAD does not exactly match the requested MIME or size", async () => {
    const state = fixture({ object: { sizeBytes: 42, mimeType: "image/png" } });
    await expect(state.service.completeDocument(supplierId, documentId, validUpload, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(state.documents.size).toBe(0);
  });

  it("keeps document storage paths private while allowing accounting to obtain a short signed download", async () => {
    const state = fixture();
    await state.service.completeDocument(supplierId, documentId, validUpload, reviewer);
    await expect(state.service.downloadDocument(supplierId, documentId, accounting)).resolves.toContain("token=private");
    await expect(state.service.downloadDocument(supplierId, documentId, { id: "requester", roles: ["solicitante"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("supplier request error shape", () => {
  it("uses DomainError codes for expected user input failures", () => { expect(new DomainError("INVALID_INPUT", "x").code).toBe("INVALID_INPUT"); });
});
