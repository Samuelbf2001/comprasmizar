import { Buffer } from "node:buffer";
import { DomainError } from "../../../../../lib/domain";
import { apiError } from "../../../../../lib/http/api";
import { requireServerActor } from "../../../../../lib/infrastructure/auth";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { createPostgresSupplierRepository } from "../../../../../lib/infrastructure/supplier-repositories";
import { buildOrderPdf } from "../../../../../lib/reports";
import type { OrderDocumentItem } from "../../../../../lib/reports/types";
import { ProcurementService } from "../../../../../lib/services";
import type { CatalogRecord, CatalogSociety, CatalogUser, CatalogWork } from "../../../../../lib/services/contracts";
import { calculateLineAmounts } from "../../../../../lib/domain";

export const runtime = "nodejs";

/**
 * Documento real de la orden (Fase 6, reunión 2026-08-31): calcado de la hoja "ORDEN DE ANTICIPO"
 * del Excel del cliente ya podada (docs/reunion-2026-08-31-analisis.md) — reemplaza al stub que
 * imprimía un marcador de borrador en el título, el UUID crudo de la obra y el literal "Proveedor asignado".
 * La fecha impresa es SIEMPRE `ordenes.fecha_generacion` (`order.generatedAt`), nunca la fecha
 * requerida de la requisición (que ahora puede faltar y, además, no es la fecha correcta de una
 * orden). Visibility is checked through the order list first, exactly como antes.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const actor = await requireServerActor(), { id } = await context.params;
    const dependencies = createPostgresDependencies(), service = new ProcurementService(dependencies);
    const order = (await service.listOrders({ actor })).find((candidate) => candidate.id === id);
    if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
    const requisition = await service.getRequisition(order.requisitionId, { actor });
    const lines = requisition.items.filter((line) => order.itemIds.includes(line.id));

    // Resuelve nombres en vez de identificadores: obra, sociedad, proveedor, catálogo de ítems sin
    // descripción propia, y las firmas ELABORADO/APROBADO. Reutiliza los repositorios existentes
    // (catalogs.get, igual que app/api/catalogs/route.ts) en vez de escribir consultas nuevas.
    const [work, society, supplier, approver, itemNames, generatedEvent] = await Promise.all([
      requisition.workId ? (dependencies.catalogs.get("works", requisition.workId) as Promise<CatalogWork | null>) : Promise.resolve(null),
      requisition.societyId ? (dependencies.catalogs.get("societies", requisition.societyId) as Promise<CatalogSociety | null>) : Promise.resolve(null),
      order.supplierId ? createPostgresSupplierRepository().get(order.supplierId) : Promise.resolve(null),
      requisition.approverId ? (dependencies.catalogs.get("users", requisition.approverId) as Promise<CatalogUser | null>) : Promise.resolve(null),
      Promise.all(lines.map((line) => (!line.description && line.itemId ? dependencies.catalogs.get("items", line.itemId) : Promise.resolve(null)))),
      dependencies.audit.list("orden", order.id),
    ]);
    // "ELABORADO": quien detonó "Generar órdenes" (evento "generada" del propio audit trail de la
    // orden — generateOrders() en procurement-service.ts ya lo registra con actorId).
    const elaboratedById = generatedEvent.find((event) => event.event === "generada")?.actorId;
    const elaborator = elaboratedById ? (await dependencies.catalogs.get("users", elaboratedById) as CatalogUser | null) : null;

    const items: OrderDocumentItem[] = lines.map((line, index) => {
      const amounts = calculateLineAmounts(line);
      const description = line.description ?? (itemNames[index] as CatalogRecord | null)?.name ?? "Ítem";
      return { description, unit: line.unit, quantity: line.quantity, unitPrice: line.unitBase ?? 0, discountRate: line.discountRate ?? 0, ivaRate: line.ivaRate ?? 0, base: amounts.base, iva: amounts.iva, total: amounts.total };
    });
    const subtotal = items.reduce((sum, item) => sum + item.base, 0), ivaTotal = items.reduce((sum, item) => sum + item.iva, 0);

    const bytes = await buildOrderPdf({
      consecutive: order.consecutive, type: order.type,
      // fecha_generacion de la ORDEN, nunca requiredDate de la requisición (opcional ahora, y ya
      // era la fecha incorrecta para una orden) — ver comentario del módulo, arriba.
      date: (order.generatedAt ?? "").slice(0, 10),
      company: { name: society?.name ?? "Sociedad no asignada", nit: society?.nit ?? undefined },
      work: work?.name ?? "Sin obra asignada",
      // Datos bancarios (feat/solicitud-de-pago): solo se resuelven para una OP — una orden de
      // compra nunca los necesitó y pdf.ts tampoco los imprime fuera de una OP; no tiene sentido
      // sacarlos de la ficha del proveedor para un documento que no los va a mostrar.
      supplier: supplier ? { name: supplier.name, nit: supplier.nit ?? undefined, identificationType: supplier.identificationType, identification: supplier.identification ?? undefined, contact: supplier.contact.name, address: supplier.contact.address, email: supplier.contact.email, phone: supplier.contact.phone, ...(order.type === "OP" ? { bankDetails: supplier.bankDetails } : {}) } : undefined,
      items, subtotal, ivaTotal, total: subtotal + ivaTotal,
      paymentTerms: order.paymentTerms,
      elaboratedBy: elaborator?.name, approvedBy: approver?.name,
      // Presente pero oculto por acuerdo explícito con el cliente — ver lib/reports/pdf.ts.
      observations: requisition.observations,
    });
    await dependencies.audit.append({ entity: "orden", entityId: order.id, event: "documento_descargado", actorId: actor.id, at: new Date(), origin: "web", data: { format: "pdf" } });
    return new Response(Buffer.from(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename=${order.consecutive}.pdf`, "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
