import { DomainError, assertPermission, type Actor } from "../domain";
import type { CatalogCreateRecord, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogSociety, CatalogSupplier, CatalogTag, CatalogUser, ServiceDependencies } from "./contracts";

export type CatalogCreateInput = CatalogCreateRecord;
export type CatalogPatchInput = CatalogPatchRecord;

export function canManageCatalog(actor: Actor, kind: CatalogKind, mizarSelfService: boolean): boolean {
  if (actor.roles.includes("admin_sixteam")) return true;
  // RF-004: la administración de usuarios (alta, roles, estado) es exclusiva de admin_sixteam.
  // admin_mizar solo lee (ver canReadUsers en app/api/catalogs/manage/route.ts).
  if (kind === "users") return false;
  // RF-002: sociedades se comparte entre Sixteam y Mizar de forma incondicional, sin depender
  // del autoservicio de catálogos (a diferencia de obras/etiquetas/ítems/proveedores).
  if (kind === "societies") return actor.roles.includes("admin_mizar");
  if (kind === "items") return actor.roles.includes("revisor");
  if (kind === "suppliers" && actor.roles.includes("revisor")) return true;
  return actor.roles.includes("admin_mizar") && mizarSelfService;
}

function safeSnapshot(value: CatalogRecord): Record<string, unknown> {
  // RF-004 / modelo de datos: la auditoría oculta nombre, correo y teléfono de usuarios (PII);
  // los roles no son datos personales y sí quedan trazados. Este chequeo va primero porque
  // CatalogUser también tiene "email"/"phone", que de otro modo calzarían con proveedores.
  if ("roles" in value) { const user = value as CatalogUser; return { active: user.active, roles: [...user.roles].sort() }; }
  if ("societyId" in value) return { name: value.name, societyId: value.societyId, active: value.active };
  if ("approverId" in value) return { name: value.name, approverAssigned: Boolean(value.approverId), active: value.active };
  if ("unit" in value) return { name: value.name, unit: value.unit, category: value.category, active: value.active };
  if ("phone" in value || "email" in value || "address" in value) { const supplier = value as CatalogSupplier; return { name: supplier.name, nitConfigured: Boolean(supplier.nit), contactConfigured: Boolean(supplier.phone || supplier.email || supplier.address), active: supplier.active }; }
  if ("nit" in value) { const society = value as CatalogSociety; return { name: society.name, nitConfigured: Boolean(society.nit), active: society.active }; }
  return { name: value.name, active: value.active };
}

export class CatalogService {
  constructor(private readonly deps: ServiceDependencies) {}
  private async authorize(actor: Actor, kind: CatalogKind, features = this.deps.features): Promise<void> {
    // RF-203: the item master stays under Daniel/Sixteam even after Mizar catalogue self-service is enabled.
    if (actor.roles.includes("admin_sixteam")) return;
    // RF-004: alta, edición, estado y roles de usuarios son exclusivos de admin_sixteam. admin_mizar
    // puede LEER (ver ruta de administración) pero jamás escribir aquí — ni siquiera para crear otro
    // admin_sixteam: este bloqueo total es, en sí mismo, la barrera contra escalamiento de privilegios.
    if (kind === "users") throw new DomainError("FORBIDDEN", "Solo un administrador Sixteam puede administrar usuarios");
    // RF-002: sociedades se comparte entre Sixteam y Mizar de forma incondicional (no depende del
    // autoservicio de catálogos, a diferencia del resto de kinds gestionados por esta función).
    if (kind === "societies") { if (actor.roles.includes("admin_mizar")) return; throw new DomainError("FORBIDDEN", "No puede administrar sociedades"); }
    const specialized = kind === "items" ? "item:manage" : kind === "suppliers" ? "supplier:manage" : "catalog:manage";
    if (kind === "items") { assertPermission(actor.roles, specialized); return; }
    if (kind === "suppliers" && actor.roles.includes("revisor")) return;
    if (actor.roles.includes("admin_mizar")) {
      if (!(await features.isEnabled("catalogos_admin_mizar"))) throw new DomainError("FEATURE_DISABLED", "El autoservicio de catálogos aún no está habilitado");
      return;
    }
    assertPermission(actor.roles, specialized);
  }
  private conflict(error: unknown, kind: CatalogKind): never {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") throw new DomainError("CONFLICT", kind === "suppliers" ? "Ya existe un proveedor con el mismo nombre o NIT" : kind === "societies" ? "Ya existe una sociedad con el mismo nombre o NIT" : kind === "users" ? "Ya existe un usuario con ese correo electrónico" : "Ya existe un registro equivalente en el catálogo");
      // Defensa adicional ante una condición de carrera: el chequeo explícito de validateUserExists ya
      // cubre el caso normal, pero si el id dejó de existir entre el chequeo y el INSERT, la FK de
      // `usuarios.id -> auth.users.id` sigue protegiendo la integridad y aquí se traduce el error.
      if (kind === "users" && error.code === "23503") throw new DomainError("AUTH_ACCOUNT_NOT_FOUND", "El id indicado no corresponde a una cuenta existente en Supabase Auth. Cree primero la cuenta en Auth y luego vincúlela aquí.");
      // Los triggers de BD (validar_baja_usuario_con_etiquetas_activas y
      // validar_retiro_ultimo_rol_aprobador) protegen que una etiqueta activa nunca se quede sin
      // aprobador elegible; aquí se traducen a mensajes útiles en vez de dejarlos explotar crudos.
      if (kind === "users" && error.code === "23514") {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("desactivar un aprobador")) throw new DomainError("APPROVER_HAS_ACTIVE_TAGS", "No se puede desactivar este usuario: es aprobador de etiquetas activas. Reasigne o desactive esas etiquetas primero.");
        if (message.includes("retirar el último rol elegible")) throw new DomainError("LAST_APPROVER_ROLE", "No se puede quitar este rol: el usuario quedaría sin ningún rol elegible (aprobador, revisor o admin Sixteam) mientras sigue siendo aprobador de etiquetas activas. Reasigne las etiquetas primero.");
      }
    }
    throw error;
  }
  /** RF-004: nunca se crea la cuenta en `auth.users` desde aquí; solo se vincula un id que ya debe existir en Auth. */
  private async validateUserExists(value: CatalogCreateInput, repository: CatalogRepository): Promise<void> {
    const user = value as CatalogUser;
    if (!(await repository.authUserExists(user.id))) throw new DomainError("AUTH_ACCOUNT_NOT_FOUND", "No existe una cuenta de Supabase Auth con este id. Esta plataforma no crea cuentas nuevas: cree primero el usuario en Supabase Auth y luego vincúlelo aquí con su id.");
  }
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
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.authorize(actor, kind, tx.features); if (kind === "suppliers") await this.supplierConflict(tx.catalogs, value); if (kind === "tags") await this.validateTag(value as CatalogRecord, tx.catalogs); if (kind === "users") await this.validateUserExists(value, tx.catalogs); const created = await tx.catalogs.create(kind, value); await this.audit("creada", kind, created.id, actor, undefined, created, tx.audit); return created; }); } catch (error) { this.conflict(error, kind); }
  }
  async patch(kind: CatalogKind, id: string, value: CatalogPatchInput, actor: Actor): Promise<CatalogRecord> {
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.authorize(actor, kind, tx.features); const before = await tx.catalogs.get(kind, id); if (!before) throw new DomainError("NOT_FOUND", "Registro de catálogo no encontrado"); const candidate = { ...before, ...value } as CatalogRecord; if (kind === "suppliers") await this.supplierConflict(tx.catalogs, candidate, id); if (kind === "tags") await this.validateTag(candidate, tx.catalogs); const after = await tx.catalogs.update(kind, id, value); await this.audit("actualizada", kind, id, actor, before, after, tx.audit); return after; }); } catch (error) { this.conflict(error, kind); }
  }
}
