import { describe, expect, it, vi } from "vitest";
import type { Actor, AttachmentEntity, PrivateAttachment, SupplierDocument } from "../../lib/domain";
import type { PrivateAttachmentRepository, PrivateAttachmentServiceDependencies, PrivateAttachmentTransaction } from "../../lib/services/attachment-service";
import type { SupplierRepository, SupplierServiceDependencies, SupplierTransaction } from "../../lib/services/supplier-service";

// H1 (docs/qa/QA-pagos-y-caja.md): `createDownloadUrl` del almacenamiento propio
// (lib/infrastructure/local-storage.ts:147) SIEMPRE devuelve una URL RELATIVA al propio origen — por
// diseño, ver el comentario de `createLocalBucketStorage` ahí mismo. El defecto vivía en el LLAMADOR:
// las dos rutas de descarga hacían `Response.redirect(url, 302)` con esa URL relativa, y el estándar
// exige una absoluta — eso lanza TypeError y `apiError()` lo traduce en 500 para CUALQUIER adjunto y
// CUALQUIER rol (comprobantes de pago, fotos del portal, documentos de proveedor).
//
// El primer arreglo (16-sep) resolvía la URL contra `request.url`, y en producción falló de otra forma:
// detrás de Traefik, `request.url` es la dirección INTERNA del contenedor (https://0.0.0.0:3000/…), así
// que el navegador acababa redirigido a un sitio inalcanzable (verificado el 21-sep-2026). Ahora el 302
// lleva el Location RELATIVO que da el almacenamiento y el navegador lo resuelve contra la URL pública.
// Esta prueba corre el `createLocalBucketStorage` REAL (sin mock) con la request tal como llega en el VPS.
process.env.DATABASE_URL = "postgres://u:p@localhost:5432/db";
process.env.STORAGE_ROOT = "/tmp/mizar-test-storage-h1";
process.env.STORAGE_SIGNING_SECRET = "s".repeat(32);

const actor: Actor = { id: "actor-1", roles: ["contabilidad"] };
vi.mock("../../lib/infrastructure/auth", () => ({ requireServerActor: async (): Promise<Actor> => actor }));

const pagoOrdenId = "11111111-1111-4111-8111-111111111111";
const comprobanteId = "22222222-2222-4222-8222-222222222222";
const supplierId = "33333333-3333-4333-8333-333333333333";
const documentId = "44444444-4444-4444-8444-444444444444";

const comprobante: PrivateAttachment = { id: comprobanteId, entity: "pago_orden", entityId: pagoOrdenId, type: "soporte", name: "comprobante.pdf", mimeType: "application/pdf", sizeBytes: 1000, uploadedAt: "2026-09-16T00:00:00.000Z", storagePath: `pagos-orden/${pagoOrdenId}/${comprobanteId}/comprobante.pdf` };
const rut: SupplierDocument = { id: documentId, supplierId, type: "rut", name: "rut.pdf", mimeType: "application/pdf", sizeBytes: 900, uploadedAt: "2026-09-16T00:00:00.000Z", storagePath: `proveedores/${supplierId}/${documentId}/rut.pdf` };

const unusedAttachments = async (): Promise<never> => { throw new Error("not exercised by this test"); };
const unusedSuppliers = async (): Promise<never> => { throw new Error("not exercised by this test"); };

vi.mock("../../lib/infrastructure/attachment-repositories", async () => {
  const { createLocalBucketStorage } = await import("../../lib/infrastructure/local-storage");
  const { PRIVATE_ATTACHMENT_BUCKET } = await import("../../lib/services/attachment-service");
  const repository: PrivateAttachmentRepository = {
    getParent: async (entity: AttachmentEntity, entityId: string) => ({ entity, id: entityId }),
    get: async () => comprobante,
    list: unusedAttachments, insert: unusedAttachments, listForRequisition: unusedAttachments, listMany: unusedAttachments,
  };
  const dependencies: PrivateAttachmentServiceDependencies = {
    storage: createLocalBucketStorage(PRIVATE_ATTACHMENT_BUCKET),
    clock: { now: () => new Date("2026-09-16T12:00:00.000Z") },
    ids: { next: () => "id-1" },
    transactions: { transaction: async <T>(_entity: AttachmentEntity, _entityId: string, work: (tx: PrivateAttachmentTransaction) => Promise<T>): Promise<T> => work({ attachments: repository, audit: { append: async () => {} } }) },
  };
  return { createPrivateAttachmentServiceDependencies: () => dependencies };
});

vi.mock("../../lib/infrastructure/supplier-repositories", async () => {
  const { createLocalBucketStorage } = await import("../../lib/infrastructure/local-storage");
  const { SUPPLIER_DOCUMENT_BUCKET } = await import("../../lib/services/supplier-service");
  const repository: SupplierRepository = {
    getDocument: async () => rut,
    list: unusedSuppliers, get: unusedSuppliers, create: unusedSuppliers, update: unusedSuppliers, findByIdentification: unusedSuppliers, listOrders: unusedSuppliers, listDocuments: unusedSuppliers, insertDocument: unusedSuppliers,
  };
  const dependencies: SupplierServiceDependencies = {
    storage: createLocalBucketStorage(SUPPLIER_DOCUMENT_BUCKET),
    clock: { now: () => new Date("2026-09-16T12:00:00.000Z") },
    ids: { next: () => "id-2" },
    transactions: { transaction: async <T>(_supplierId: string | undefined, work: (tx: SupplierTransaction) => Promise<T>): Promise<T> => work({ suppliers: repository, features: { isEnabled: async () => false }, audit: { append: async () => {} } }) },
  };
  return { createSupplierServiceDependencies: () => dependencies };
});

const { GET: downloadAttachment } = await import("../../app/api/attachments/[entity]/[entityId]/[attachmentId]/download/route");
const { GET: downloadSupplierDocument } = await import("../../app/api/suppliers/[id]/documents/[documentId]/download/route");

describe("H1: la descarga de adjuntos responde 302 con Location RELATIVO, nunca la dirección interna del contenedor", () => {
  // Así llega la petición al contenedor en el VPS: Next ve su propia dirección de escucha, no el dominio.
  const internal = "https://0.0.0.0:3000";

  it("comprobante de un pago de orden (pago_orden): 302 hacia /api/storage/object", async () => {
    const response = await downloadAttachment(
      new Request(`${internal}/api/attachments/pago_orden/${pagoOrdenId}/${comprobanteId}/download`),
      { params: Promise.resolve({ entity: "pago_orden", entityId: pagoOrdenId, attachmentId: comprobanteId }) },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location?.startsWith("/api/storage/object?token=")).toBe(true);
    expect(location).not.toContain("0.0.0.0");
    // El navegador lo resuelve contra la URL pública que pidió.
    expect(new URL(location as string, "https://comprasmizar.sixteam.pro/x").origin).toBe("https://comprasmizar.sixteam.pro");
  });

  it("documento de un proveedor: 302 hacia /api/storage/object", async () => {
    const response = await downloadSupplierDocument(
      new Request(`${internal}/api/suppliers/${supplierId}/documents/${documentId}/download`),
      { params: Promise.resolve({ id: supplierId, documentId }) },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location?.startsWith("/api/storage/object?token=")).toBe(true);
    expect(location).not.toContain("0.0.0.0");
  });
});
