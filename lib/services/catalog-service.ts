import { DomainError, assertPermission, type Actor } from "../domain";
import type { CatalogCreateRecord, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogSupplier, CatalogTag, ServiceDependencies } from "./contracts";

export type CatalogCreateInput = CatalogCreateRecord;
export type CatalogPatchInput = CatalogPatchRecord;

export function canManageCatalog(actor: Actor, kind: CatalogKind, mizarSelfService: boolean): boolean {
  if (actor.roles.includes("admin_sixteam")) return true;
  if (kind === "items") return actor.roles.includes("revisor");
  if (kind === "suppliers" && actor.roles.includes("revisor")) return true;
  return actor.roles.includes("admin_mizar") && mizarSelfService;
}

function safeSnapshot(value: CatalogRecord): Record<string, unknown> {
  if ("societyId" in value) return { name: value.name, societyId: value.societyId, active: value.active };
  if ("nit" in value) { const supplier = value as CatalogSupplier; return { name: supplier.name, nitConfigured: Boolean(supplier.nit), contactConfigured: Boolean(supplier.phone || supplier.email || supplier.address), active: supplier.active }; }
  if ("approverId" in value) return { name: value.name, approverAssigned: Boolean(value.approverId), active: value.active };
  if ("unit" in value) return { name: value.name, unit: value.unit, category: value.category, active: value.active };
  return { name: value.name, active: value.active };
}

export class CatalogService {
  constructor(private readonly deps: ServiceDependencies) {}
  private async authorize(actor: Actor, kind: CatalogKind, features = this.deps.features): Promise<void> {
    const specialized = kind === "items" ? "item:manage" : kind === "suppliers" ? "supplier:manage" : "catalog:manage";
    // RF-203: the item master stays under Daniel/Sixteam even after Mizar catalogue self-service is enabled.
    if (actor.roles.includes("admin_sixteam")) return;
    if (kind === "items") { assertPermission(actor.roles, specialized); return; }
    if (kind === "suppliers" && actor.roles.includes("revisor")) return;
    if (actor.roles.includes("admin_mizar")) {
      if (!(await features.isEnabled("catalogos_admin_mizar"))) throw new DomainError("FEATURE_DISABLED", "El autoservicio de catálogos aún no está habilitado");
      return;
    }
    assertPermission(actor.roles, specialized);
  }
  private conflict(error: unknown, kind: CatalogKind): never { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", kind === "suppliers" ? "Ya existe un proveedor con el mismo nombre o NIT" : "Ya existe un registro equivalente en el catálogo"); throw error; }
  private async audit(action: string, kind: CatalogKind, id: string, actor: Actor, before: CatalogRecord | undefined, after: CatalogRecord, repository: { append(event: Parameters<ServiceDependencies["audit"]["append"]>[0]): Promise<void> }): Promise<void> {
    await repository.append({ entity: kind, entityId: id, event: action, actorId: actor.id, at: this.deps.clock.now(), origin: "web", data: { ...(before ? { before: safeSnapshot(before) } : {}), after: safeSnapshot(after) } });
  }
  private async supplierConflict(repository: CatalogRepository, value: CatalogCreateInput | CatalogPatchInput, exceptId?: string): Promise<void> {
    if (!("name" in value) || typeof value.name !== "string") return;
    const supplier = value as Partial<CatalogSupplier>;
    const duplicate = await repository.findSupplierDuplicate({ name: value.name, nit: supplier.nit }, exceptId);
    if (duplicate) throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o NIT");
  }
  private async validateTag(record: CatalogRecord, repository: CatalogRepository): Promise<void> { const tag = record as CatalogTag; if (tag.active && (!tag.approverId || !(await repository.isEligibleApprover(tag.approverId)))) throw new DomainError("INVALID_INPUT", "Una etiqueta activa requiere un aprobador activo y elegible"); }
  async create(kind: CatalogKind, value: CatalogCreateInput, actor: Actor): Promise<CatalogRecord> {
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.authorize(actor, kind, tx.features); if (kind === "suppliers") await this.supplierConflict(tx.catalogs, value); if (kind === "tags") await this.validateTag(value as CatalogRecord, tx.catalogs); const created = await tx.catalogs.create(kind, value); await this.audit("creada", kind, created.id, actor, undefined, created, tx.audit); return created; }); } catch (error) { this.conflict(error, kind); }
  }
  async patch(kind: CatalogKind, id: string, value: CatalogPatchInput, actor: Actor): Promise<CatalogRecord> {
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.authorize(actor, kind, tx.features); const before = await tx.catalogs.get(kind, id); if (!before) throw new DomainError("NOT_FOUND", "Registro de catálogo no encontrado"); const candidate = { ...before, ...value } as CatalogRecord; if (kind === "suppliers") await this.supplierConflict(tx.catalogs, candidate, id); if (kind === "tags") await this.validateTag(candidate, tx.catalogs); const after = await tx.catalogs.update(kind, id, value); await this.audit("actualizada", kind, id, actor, before, after, tx.audit); return after; }); } catch (error) { this.conflict(error, kind); }
  }
}
