import { describe, expect, it } from "vitest";
import type { AttachmentEntity, PrivateAttachment } from "../../lib/domain";
import { PrivateAttachmentService, type AttachmentParent, type PrivateAttachmentServiceDependencies, type PrivateAttachmentTransaction } from "../../lib/services";

const requisitionId = "11111111-1111-4111-8111-111111111111";
const itemId = "22222222-2222-4222-8222-222222222222";
const cashId = "33333333-3333-4333-8333-333333333333";
const paymentId = "55555555-5555-4555-8555-555555555555";
const attachmentId = "44444444-4444-4444-8444-444444444444";
const requester = { id: "requester", roles: ["solicitante"] as const };
const reviewer = { id: "reviewer", roles: ["revisor"] as const };
const accountant = { id: "accountant", roles: ["contabilidad"] as const };
const approver = { id: "approver", roles: ["aprobador"] as const };
// Aprobador POR ÍTEM: no es el de cabecera, decide una línea. Debe poder leer los soportes.
const itemApprover = { id: "item-approver", roles: ["aprobador"] as const };
const strangerApprover = { id: "stranger-approver", roles: ["aprobador"] as const };
const upload = { type: "soporte" as const, name: "Soporte Ágil.pdf", mimeType: "application/pdf", sizeBytes: 128 };

function fixture(options: { info?: { sizeBytes: number; mimeType: string } | null; status?: "enviada" | "en_revision" } = {}) {
  const parents = new Map<string, AttachmentParent>([
    [`requisicion:${requisitionId}`, { entity: "requisicion", id: requisitionId, requesterId: requester.id, requisitionStatus: options.status ?? "enviada", approverId: approver.id, itemApproverIds: [itemApprover.id] }],
    [`requisicion_item:${itemId}`, { entity: "requisicion_item", id: itemId, requesterId: requester.id, requisitionStatus: options.status ?? "enviada", approverId: approver.id, itemApproverIds: [itemApprover.id] }],
    [`caja_menor:${cashId}`, { entity: "caja_menor", id: cashId }],
    [`pago_orden:${paymentId}`, { entity: "pago_orden", id: paymentId }],
  ]);
  const attachments = new Map<string, PrivateAttachment>(), audits: unknown[] = [], signedPaths: string[] = [];
  const repository = {
    getParent: async (entity: AttachmentEntity, entityId: string) => parents.get(`${entity}:${entityId}`) ?? null,
    list: async (entity: AttachmentEntity, entityId: string) => [...attachments.values()].filter((entry) => entry.entity === entity && entry.entityId === entityId).map((entry) => structuredClone(entry)),
    get: async (entity: AttachmentEntity, entityId: string, id: string) => { const found = attachments.get(id); return found?.entity === entity && found.entityId === entityId ? structuredClone(found) : null; },
    insert: async (value: PrivateAttachment) => { if (attachments.has(value.id)) throw Object.assign(new Error("duplicate"), { code: "23505" }); attachments.set(value.id, structuredClone(value)); return value; },
    // Fixture de un solo requisitionId (constante del archivo): "itemId" es siempre su único ítem, así
    // que filtrar por ambas entidades basta para emular el `or` de la consulta real (ver
    // PostgresAttachmentRepository.listForRequisition).
    listForRequisition: async (id: string) => [...attachments.values()].filter((entry) => (entry.entity === "requisicion" && entry.entityId === id) || (entry.entity === "requisicion_item" && entry.entityId === itemId && id === requisitionId)).map((entry) => structuredClone(entry)),
    listMany: async (entity: AttachmentEntity, entityIds: string[]) => [...attachments.values()].filter((entry) => entry.entity === entity && entityIds.includes(entry.entityId)).map((entry) => structuredClone(entry)),
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

  // Aprobador POR ÍTEM (11-sep-2026): decide una línea sin ser el de cabecera. Sin esto, abría el
  // enlace del Flow, la pantalla pedía `/detail` y recibía 403 en los soportes — la requisición se le
  // mostraba en la lista pero no podía abrirla. Un aprobador ajeno, ni ítem ni cabecera, sigue fuera.
  it("permits a per-item approver to read supports (list and listForRequisition) and keeps a stranger out", async () => {
    const state = fixture();
    await state.service.complete("requisicion", requisitionId, attachmentId, upload, reviewer);
    await expect(state.service.list("requisicion", requisitionId, itemApprover)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.listForRequisition(requisitionId, itemApprover)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.prepare("requisicion", requisitionId, upload, itemApprover)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.list("requisicion", requisitionId, strangerApprover)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.listForRequisition(requisitionId, strangerApprover)).rejects.toMatchObject({ code: "FORBIDDEN" });
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

  // H2 (docs/plan-rendimiento.md): listForRequisition reemplaza pedir /api/attachments/requisicion/:id
  // más una llamada por ítem (N+1) — mismo `assertRead` que list("requisicion", ...), ahora cubriendo
  // también los adjuntos de los ítems en la misma respuesta.
  it("listForRequisition combina adjuntos de la requisición y de sus ítems bajo el mismo assertRead del padre", async () => {
    const state = fixture();
    await state.service.complete("requisicion", requisitionId, attachmentId, upload, requester);
    await expect(state.service.listForRequisition(requisitionId, requester)).resolves.toMatchObject({ attachments: [{ id: attachmentId, entity: "requisicion", entityId: requisitionId }] });
    await expect(state.service.listForRequisition(requisitionId, approver)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.listForRequisition(requisitionId, { id: "stranger", roles: ["solicitante"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  // H2: listMany respalda /api/attachments/:entity?ids= para caja menor (el caso real de la pantalla de
  // gastos); requisicion/requisicion_item quedan fuera a propósito (ver comentario en el servicio).
  // Adenda de pagos (A5): el comprobante de un pago es un adjunto `pago_orden` — solo tipo soporte, ruta
  // pagos-orden/<pago>/…, lo suben revisor/admin Y contabilidad (quien registra el pago), lo leen los
  // mismos tres roles; un solicitante o un aprobador no lo ven ni lo suben.
  it("pago_orden: comprobante de pago solo como soporte, lo sube quien registra pagos (incluida contabilidad) y lo lee compras/contabilidad", async () => {
    const state = fixture();
    await expect(state.service.prepare("pago_orden", paymentId, { ...upload, type: "foto", name: "recibo.png", mimeType: "image/png" }, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("pago_orden", paymentId, upload, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.prepare("pago_orden", paymentId, upload, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.prepare("pago_orden", paymentId, { ...upload, name: "Recibo caja.pdf" }, accountant)).resolves.toMatchObject({ attachment: { type: "soporte", name: "recibo-caja.pdf" } });
    expect(state.signedPaths).toEqual([`pagos-orden/${paymentId}/${attachmentId}/recibo-caja.pdf`]);
    await state.service.complete("pago_orden", paymentId, attachmentId, { ...upload, name: "Recibo caja.pdf" }, accountant);
    await expect(state.service.list("pago_orden", paymentId, reviewer)).resolves.toMatchObject({ attachments: [{ id: attachmentId }] });
    await expect(state.service.download("pago_orden", paymentId, attachmentId, accountant)).resolves.toContain("token=private");
    await expect(state.service.list("pago_orden", paymentId, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.listMany("pago_orden", [paymentId], reviewer)).resolves.toMatchObject({ attachments: [{ id: attachmentId, entity: "pago_orden", entityId: paymentId }] });
    await expect(state.service.listMany("pago_orden", [paymentId], requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("listMany limita a caja_menor y pago_orden, exige 1-100 ids y aplica el mismo chequeo de rol que list()", async () => {
    const state = fixture();
    await state.service.complete("caja_menor", cashId, attachmentId, upload, reviewer);
    await expect(state.service.listMany("caja_menor", [cashId], accountant)).resolves.toMatchObject({ attachments: [{ id: attachmentId, entity: "caja_menor", entityId: cashId }] });
    await expect(state.service.listMany("caja_menor", [cashId], requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.listMany("requisicion", [requisitionId], reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(state.service.listMany("caja_menor", [], reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(state.service.listMany("caja_menor", Array.from({ length: 101 }, () => cashId), reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unsafe paths/types and audits only safe metadata", async () => {
    const state = fixture();
    await expect(state.service.prepare("requisicion", requisitionId, { ...upload, name: "../../secreto.pdf" }, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    // 2026-09-17: un ítem admite `soporte` además de `foto` (por el portal llega la factura del
    // artículo), pero nunca `cotizacion` — esa es del comprador y vive en la cabecera. Y lo que se
    // llame `foto` tiene que SER una imagen: un PDF con `type: "foto"` se sigue rechazando.
    await expect(state.service.prepare("requisicion_item", itemId, { ...upload, type: "cotizacion" }, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("requisicion_item", itemId, { ...upload, type: "foto" }, requester)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await expect(state.service.prepare("caja_menor", cashId, { ...upload, type: "cotizacion" }, reviewer)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
    await state.service.complete("requisicion", requisitionId, attachmentId, upload, requester);
    expect(JSON.stringify(state.audits)).not.toContain("soporte-agil.pdf");
    expect(JSON.stringify(state.audits)).not.toContain("application/pdf");
    expect(JSON.stringify(state.audits)).not.toContain("requisiciones/");
  });
});
