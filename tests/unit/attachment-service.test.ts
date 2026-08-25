import { describe, expect, it } from "vitest";
import type { AttachmentEntity, PrivateAttachment } from "../../lib/domain";
import { PrivateAttachmentService, type AttachmentParent, type PrivateAttachmentServiceDependencies, type PrivateAttachmentTransaction } from "../../lib/services";

const requisitionId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const cashId = "33333333-3333-4333-8333-333333333333";
const attachmentId = "44444444-4444-4444-8444-444444444444";
const requester = { id: "requester", roles: ["solicitante"] as const };
const reviewer = { id: "reviewer", roles: ["revisor"] as const };
const accountant = { id: "accountant", roles: ["contabilidad"] as const };
const approver = { id: "approver", roles: ["aprobador"] as const };
const upload = { type: "soporte" as const, name: "Soporte Ágil.pdf", mimeType: "application/pdf", sizeBytes: 128 };

function fixture(options: { info?: { sizeBytes: number; mimeType: string } | null; status?: "enviada" | "en_revision" } = {}) {
  const parents = new Map<string, AttachmentParent>([
    [`requisicion:${requisitionId}`, { entity: "requisicion", id: requisitionId, requesterId: requester.id, requisitionStatus: options.status ?? "enviada", approverId: approver.id }],
    [`requisicion_item:${itemId}`, { entity: "requisicion_item", id: itemId, requesterId: requester.id, requisitionStatus: options.status ?? "enviada", approverId: approver.id }],
    [`caja_menor:${cashId}`, { entity: "caja_menor", id: cashId }],
  ]);
  const attachments = new Map<string, PrivateAttachment>(), audits: unknown[] = [], signedPaths: string[] = [];
  const repository = {
    getParent: async (entity: AttachmentEntity, entityId: string) => parents.get(`${entity}:${entityId}`) ?? null,
    list: async (entity: AttachmentEntity, entityId: string) => [...attachments.values()].filter((entry) => entry.entity === entity && entry.entityId === entityId).map((entry) => structuredClone(entry)),
    get: async (entity: AttachmentEntity, entityId: string, id: string) => { const found = attachments.get(id); return found?.entity === entity && found.entityId === entityId ? structuredClone(found) : null; },
    insert: async (value: PrivateAttachment) => { if (attachments.has(value.id)) throw Object.assign(new Error("duplicate"), { code: "23505" }); attachments.set(value.id, structuredClone(value)); return value; },
  };
  const deps: PrivateAttachmentServiceDependencies = {
    transactions: { transaction: async <T>(_entity: AttachmentEntity, _entityId: string, work: (tx: PrivateAttachmentTransaction) => Promise<T>): Promise<T> => { const snapshot = structuredClone([...attachments.entries()]), auditLength = audits.length; try { return await work({ attachments: repository, audit: { append: async (event) => { audits.push(event); } } }); } catch (error) { attachments.clear(); snapshot.forEach(([id, value]) => attachments.set(id, value)); audits.splice(auditLength); throw error; } } },
    storage: { createUploadUrl: async (path) => { signedPaths.push(path); return { url: `https://storage.test/upload/${encodeURIComponent(path)}?token=private` }; }, info: async () => options.info ?? { sizeBytes: 128, mimeType: "application/pdf" }, createDownloadUrl: async (path, expiry) => { if (expiry !== 60) throw new Error("wrong expiry"); return `https://storage.test/download/${encodeURIComponent(path)}?token=private`; } },
    clock: { now: () => new Date("2026-08-24T00:00:00.000Z") }, ids: { next: () => attachmentId },
  };
  return { service: new PrivateAttachmentService(deps), parents, attachments, audits, signedPaths };
}

describe("PrivateAttachmentService", () => {
  it("returns the explicit signed multipart PUT contract with canonical paths and no raw key field", async () => {
    const state = fixture();
    const prepared = await state.service.prepare("requisicion", requisitionId, { ...upload, type: "foto", name: "Frente 1.png", mimeType: "image/png", sizeBytes: 128 }, requester);
    expect(prepared).toMatchObject({ attachment: { id: attachmentId, name: "frente-1.png" }, upload: { method: "PUT", multipart: { cacheControl: "3600", fileField: "" } } });
    expect(JSON.stringify(prepared)).not.toContain("storagePath");
    expect(state.signedPaths).toEqual([`requisiciones/${requisitionId}/${attachmentId}/frente-1.png`]);
  });

  it("allows a requester only on their own sent requisition/item, while reviewers can operate later", async () => {
    await expect(fixture().service.prepare("requisicion_item", itemId, { ...upload, type: "foto", name: "item.jpg", mimeType: "image/jpeg" }, requester)).resolves.toMatchObject({ attachment: { type: "foto" } });
    const reviewing = fixture({ status: "en_revision" });
    await expect(reviewing.service.prepare("requisicion", requisitionId, upload, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(reviewing.service.prepare("requisicion", requisitionId, upload, reviewer)).resolves.toMatchObject({ attachment: { type: "soporte" } });
    const stateChanged = fixture();
    await stateChanged.service.prepare("requisicion", requisitionId, upload, requester);
    stateChanged.parents.set(`requisicion:${requisitionId}`, { entity: "requisicion", id: requisitionId, requesterId: requester.id, requisitionStatus: "en_revision", approverId: approver.id });
    await expect(stateChanged.service.complete("requisicion", requisitionId, attachmentId, upload, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps caja menor limited to operators and makes accounting read/download-only", async () => {
    const state = fixture();
    await expect(state.service.prepare("caja_menor", cashId, upload, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await state.service.complete("caja_menor", cashId, attachmentId, upload, reviewer);
    await expect(state.service.list("caja_menor", cashId, accountant)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.download("caja_menor", cashId, attachmentId, accountant)).resolves.toContain("token=private");
    await expect(state.service.prepare("caja_menor", cashId, upload, accountant)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.prepare("caja_menor", cashId, upload, { id: "mizar", roles: ["admin_mizar"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.list("caja_menor", cashId, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("permits an assigned approver to read supports but never upload them", async () => {
    const state = fixture();
    await state.service.complete("requisicion", requisitionId, attachmentId, upload, reviewer);
    await expect(state.service.list("requisicion", requisitionId, approver)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.prepare("requisicion", requisitionId, upload, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("HEAD-verifies MIME/size before metadata creation and finalizes safely under retries", async () => {
    const mismatch = fixture({ info: { sizeBytes: 128, mimeType: "image/png" } });
    await expect(mismatch.service.complete("requisicion", requisitionId, attachmentId, upload, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    expect(mismatch.attachments.size).toBe(0);
    const state = fixture();
    await expect(state.service.complete("requisicion", requisitionId, attachmentId, upload, requester)).resolves.toMatchObject({ attachment: { id: attachmentId } });
    await expect(state.service.complete("requisicion", requisitionId, attachmentId, upload, requester)).resolves.toMatchObject({ attachment: { id: attachmentId } });
    await expect(state.service.complete("requisicion", requisitionId, attachmentId, { ...upload, sizeBytes: 129 }, requester)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects unsafe paths/types and audits only safe metadata", async () => {
    const state = fixture();
    await expect(state.service.prepare("requisicion", requisitionId, { ...upload, name: "../../secreto.pdf" }, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("requisicion_item", itemId, upload, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("requisicion_item", itemId, { ...upload, type: "foto" }, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("caja_menor", cashId, { ...upload, type: "cotizacion" }, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await state.service.complete("requisicion", requisitionId, attachmentId, upload, requester);
    expect(JSON.stringify(state.audits)).not.toContain("soporte-agil.pdf");
    expect(JSON.stringify(state.audits)).not.toContain("application/pdf");
    expect(JSON.stringify(state.audits)).not.toContain("requisiciones/");
  });
});
