import { DomainError, MIZAR_SELF_SERVICE_MODULE, MIZAR_SELF_SERVICE_PERMISSIONS, SIXTEAM_ROLE, assertPermission, canManageSixteamAccounts, hasGatedPermission, permissionOnlyViaMizarAdmin, type Actor, type Role } from "../domain";
import type { CatalogCashBox, CatalogCostCenter, CatalogCreateRecord, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogRequester, CatalogSociety, CatalogSupplier, CatalogTag, CatalogUser, CatalogWork, ServiceDependencies } from "./contracts";

export type CatalogCreateInput = CatalogCreateRecord;
export type CatalogPatchInput = CatalogPatchRecord;

/**
 * 25-sep-2026 (decisión del cliente: «Daniel puede hacer todo»): la administración de catálogos deja
 * de decidirse por NOMBRE de rol y pasa a PERMISO, uno por pestaña. Quién tiene cada uno lo dicen los
 * defaults de lib/domain/rules.ts (revisor los tiene todos) y, encima, Configuración → Permisos por rol.
 * `catalog:manage` y `requester:manage` siguen además bajo el módulo `catalogos_admin_mizar` cuando
 * llegan solo por el rol admin_mizar (`hasGatedPermission`), igual que antes de este cambio. RF-203
 * sigue en pie: "item:manage" no lo tiene admin_mizar por defecto, ni con el módulo encendido.
 */
export const CATALOG_KIND_PERMISSION: Readonly<Record<CatalogKind, string>> = {
  works: "catalog:manage",
  tags: "catalog:manage",
  costCenters: "catalog:manage",
  cashBoxes: "catalog:manage",
  items: "item:manage",
  suppliers: "supplier:manage",
  societies: "society:manage",
  requesters: "requester:manage",
  users: "user:manage",
};

export function canManageCatalog(actor: Actor, kind: CatalogKind, mizarSelfService: boolean): boolean {
  return hasGatedPermission(actor, CATALOG_KIND_PERMISSION[kind], mizarSelfService);
}

/**
 * Candados de usuarios que ningún permiso abre (coordinador, 25-sep-2026):
 * - Una cuenta de Administrador Sixteam, y el propio rol admin_sixteam, solo los toca otro
 *   Administrador Sixteam: crear, editar, desactivar, asignar o quitar (`canManageSixteamAccounts`).
 * - Nadie se deja a sí mismo sin acceso: ni desactivarse ni quedarse sin ningún rol (sin rol la sesión
 *   ya no resuelve: ROLE_REQUIRED). Quitarse UN rol sí se puede mientras le quede otro.
 */
export function assertUserChangeAllowed(actor: Actor, change: { id?: string; before?: { roles: readonly Role[] } | null; roles?: readonly Role[]; active?: boolean }): void {
  const touchesSixteam = Boolean(change.before?.roles.includes(SIXTEAM_ROLE)) || Boolean(change.roles?.includes(SIXTEAM_ROLE));
  if (touchesSixteam && !canManageSixteamAccounts(actor)) throw new DomainError("FORBIDDEN", "Solo un Administrador Sixteam puede crear, editar o asignar el rol Administrador Sixteam");
  if (change.id && change.id === actor.id) {
    if (change.active === false) throw new DomainError("SELF_LOCKOUT", "No puedes desactivar tu propia cuenta: te quedarías sin acceso. Pídeselo a otro administrador.");
    if (change.roles && change.roles.length === 0) throw new DomainError("SELF_LOCKOUT", "No puedes quitarte todos los roles: te quedarías sin acceso. Pídeselo a otro administrador.");
  }
}

/**
 * Restablecer la contraseña de otra persona (POST /api/usuarios/:id/clave). Antes la ruta lo dejaba a
 * admin_mizar/admin_sixteam por nombre de rol y SIN mirar a quién: un Administrador Mizar podía
 * cambiarle la clave a un Administrador Sixteam y entrar con su cuenta. Ahora: permiso
 * `user:reset_password`, y la cuenta de un Administrador Sixteam solo la restablece otro.
 */
export function assertCanResetPassword(actor: Actor, target: { roles: readonly Role[] } | null): void {
  assertPermission(actor, "user:reset_password");
  if (!target) throw new DomainError("NOT_FOUND", "El usuario indicado no existe.");
  if (target.roles.includes(SIXTEAM_ROLE) && !canManageSixteamAccounts(actor)) throw new DomainError("FORBIDDEN", "Solo un Administrador Sixteam puede restablecer la contraseña de otro Administrador Sixteam");
}

function safeSnapshot(value: CatalogRecord): Record<string, unknown> {
  // RF-004 / modelo de datos: la auditoría oculta nombre, correo y teléfono de usuarios (PII);
  // los roles no son datos personales y sí quedan trazados. Este chequeo va primero porque
  // CatalogUser también tiene "email"/"phone", que de otro modo calzarían con proveedores.
  if ("roles" in value) { const user = value as CatalogUser; return { active: user.active, roles: [...user.roles].sort() }; }
  // HUECO 1: la migración 202609010001 marca "nombre" Y "telefono_normalizado" como sensibles para
  // `solicitantes_autorizados` (auditoria_campo_sensible) — más estricto que proveedores, donde el
  // nombre comercial sí se audita en claro. Este chequeo va antes que el de proveedores (abajo):
  // CatalogRequester solo tiene "phone" entre las claves que ese chequeo mira, nunca nit/email/address.
  if ("phone" in value && !("nit" in value) && !("email" in value) && !("address" in value)) { const requester = value as CatalogRequester; return { active: requester.active }; }
  // Centros de costo (2026-09-12): comprobado ANTES que el de "work" de abajo — CatalogCostCenter
  // también tiene `societyId`, y sin este orden un centro se auditaría con la forma de una obra
  // (perdiendo `code`, su dato propio). `code` es el discriminador: ninguna otra forma de CatalogRecord
  // lo tiene.
  if ("code" in value) { const costCenter = value as CatalogCostCenter; return { name: costCenter.name, code: costCenter.code ?? null, societyId: costCenter.societyId ?? null, type: costCenter.type ?? "obra", active: costCenter.active }; }
  // Cajas (2026-09-12): comprobado ANTES que el de "work" de abajo por la MISMA razón que costCenters
  // — "type" es el discriminador (ninguna otra forma de CatalogRecord lo tiene).
  if ("type" in value) { const cashBox = value as CatalogCashBox; return { name: cashBox.name, type: cashBox.type, societyId: cashBox.societyId ?? null, costCenterId: cashBox.costCenterId ?? null, active: cashBox.active }; }
  // 25-sep-2026 (historial de cambios): la obra lleva también su centro de costo por defecto y la
  // etiqueta el ID de su aprobador — un id de usuario no es dato personal (el nombre se resuelve al
  // mostrar el historial) y sin él «Cambió el aprobador de Materiales de Nelson a Juliana» no se podía
  // contar. `approverAssigned` se conserva para quien ya leía eventos viejos.
  if ("societyId" in value) return { name: value.name, societyId: value.societyId, costCenterId: (value as CatalogWork).costCenterId ?? null, active: value.active };
  if ("approverId" in value) return { name: value.name, approverId: value.approverId ?? null, approverAssigned: Boolean(value.approverId), active: value.active };
  if ("unit" in value) return { name: value.name, unit: value.unit, category: value.category, active: value.active };
  // RF-601: tipo y "si hay identificación", nunca el número (la cédula de una persona es dato personal).
  if ("phone" in value || "email" in value || "address" in value) { const supplier = value as CatalogSupplier; return { name: supplier.name, nitConfigured: Boolean(supplier.nit), identificationType: supplier.identificationType ?? "NIT", identificationConfigured: Boolean(supplier.identification ?? supplier.nit), pendingNormalization: supplier.pendingNormalization ?? false, contactConfigured: Boolean(supplier.phone || supplier.email || supplier.address), active: supplier.active }; }
  if ("nit" in value) { const society = value as CatalogSociety; return { name: society.name, nitConfigured: Boolean(society.nit), active: society.active }; }
  return { name: value.name, active: value.active };
}

export class CatalogService {
  constructor(private readonly deps: ServiceDependencies) {}
  private async authorize(actor: Actor, kind: CatalogKind, features = this.deps.features): Promise<void> {
    const permission = CATALOG_KIND_PERMISSION[kind];
    assertPermission(actor, permission);
    // El módulo se relee DENTRO de la transacción de escritura (`tx.features`), y solo cuando decide
    // algo: un permiso sujeto al módulo que el actor tiene únicamente por el rol admin_mizar.
    if (MIZAR_SELF_SERVICE_PERMISSIONS.includes(permission) && permissionOnlyViaMizarAdmin(actor, permission) && !(await features.isEnabled(MIZAR_SELF_SERVICE_MODULE))) {
      throw new DomainError("FEATURE_DISABLED", "El autoservicio de catálogos aún no está habilitado");
    }
  }
  private conflict(error: unknown, kind: CatalogKind): never {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "23505") throw new DomainError("CONFLICT", kind === "suppliers" ? "Ya existe un proveedor con el mismo nombre o identificación" : kind === "societies" ? "Ya existe una sociedad con el mismo nombre o NIT" : kind === "users" ? "Ya existe un usuario con ese correo electrónico" : kind === "requesters" ? "Ya existe un solicitante autorizado con ese número de teléfono" : kind === "costCenters" ? "Ya existe un centro de costo con el mismo nombre o código" : kind === "cashBoxes" ? "Ya existe una caja con ese nombre" : "Ya existe un registro equivalente en el catálogo");
      // La FK `usuarios.id -> auth.users.id` ya no puede violarse en el alta (ambas filas se crean en la
      // misma transacción, ver postgres-repositories.ts), pero sí en una edición contra un id inventado.
      if (kind === "users" && error.code === "23503") throw new DomainError("NOT_FOUND", "El usuario indicado no existe.");
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
  private async audit(action: string, kind: CatalogKind, id: string, actor: Actor, before: CatalogRecord | undefined, after: CatalogRecord, repository: { append(event: Parameters<ServiceDependencies["audit"]["append"]>[0]): Promise<void> }): Promise<void> {
    await repository.append({ entity: kind, entityId: id, event: action, actorId: actor.id, at: this.deps.clock.now(), origin: "web", data: { ...(before ? { before: safeSnapshot(before) } : {}), after: safeSnapshot(after) } });
  }
  private async supplierConflict(repository: CatalogRepository, value: CatalogCreateInput | CatalogPatchInput, exceptId?: string): Promise<void> {
    if (!("name" in value) || typeof value.name !== "string") return;
    const supplier = value as Partial<CatalogSupplier>;
    const duplicate = await repository.findSupplierDuplicate({ name: value.name, nit: supplier.nit, identificationType: supplier.identificationType, identification: supplier.identification }, exceptId);
    if (duplicate) throw new DomainError("CONFLICT", "Ya existe un proveedor con el mismo nombre o identificación");
  }
  private async validateTag(record: CatalogRecord, repository: CatalogRepository): Promise<void> { const tag = record as CatalogTag; if (tag.active && (!tag.approverId || !(await repository.isEligibleApprover(tag.approverId)))) throw new DomainError("INVALID_INPUT", "Una etiqueta activa requiere un aprobador activo y elegible"); }
  // HUECO 1: chequeo previo (además del 23505 genérico de arriba) para dar un mensaje claro ANTES de
  // tocar la BD; el repositorio normaliza con el mismo criterio que la columna generada
  // telefono_normalizado (ver lib/infrastructure/phone.ts), así que "3001112233" y "+57 300 111 2233"
  // chocan como el mismo solicitante aunque su texto crudo difiera.
  private async requesterConflict(repository: CatalogRepository, value: CatalogCreateInput | CatalogPatchInput, exceptId?: string): Promise<void> {
    if (!("phone" in value) || typeof value.phone !== "string" || !value.phone) return;
    if (await repository.findRequesterDuplicate(value.phone, exceptId)) throw new DomainError("CONFLICT", "Ya existe un solicitante autorizado con ese número de teléfono");
  }
  async create(kind: CatalogKind, value: CatalogCreateInput, actor: Actor): Promise<CatalogRecord> {
    try { return await this.deps.transactions.transaction(undefined, async (tx) => { await this.authorize(actor, kind, tx.features); if (kind === "users") assertUserChangeAllowed(actor, { roles: (value as { roles?: readonly Role[] }).roles }); if (kind === "suppliers") await this.supplierConflict(tx.catalogs, value); if (kind === "requesters") await this.requesterConflict(tx.catalogs, value); if (kind === "tags") await this.validateTag(value as CatalogRecord, tx.catalogs); const created = await tx.catalogs.create(kind, value); await this.audit("creada", kind, created.id, actor, undefined, created, tx.audit); return created; }); } catch (error) { this.conflict(error, kind); }
  }
  async patch(kind: CatalogKind, id: string, value: CatalogPatchInput, actor: Actor): Promise<CatalogRecord> {
    try {
      return await this.deps.transactions.transaction(undefined, async (tx) => {
        await this.authorize(actor, kind, tx.features);
        const before = await tx.catalogs.get(kind, id);
        if (!before) throw new DomainError("NOT_FOUND", "Registro de catálogo no encontrado");
        if (kind === "users") { const change = value as { roles?: readonly Role[]; active?: boolean }; assertUserChangeAllowed(actor, { id, before: before as CatalogUser, roles: change.roles, active: change.active }); }
        const candidate = { ...before, ...value } as CatalogRecord;
        if (kind === "suppliers") await this.supplierConflict(tx.catalogs, candidate, id);
        if (kind === "requesters") await this.requesterConflict(tx.catalogs, candidate, id);
        if (kind === "tags") await this.validateTag(candidate, tx.catalogs);
        // GRAVE 3 (QA Postgres real): mover una obra de sociedad deja inservibles sus requisiciones
        // existentes — saveRequisition siempre reenvía obra_id en su on conflict, así que cualquier
        // UPDATE posterior de una de esas requisiciones revienta contra el trigger
        // validar_catalogos_activos_requisicion (23514, "La obra asignada no pertenece a la sociedad
        // de la requisición"). Más simple y honesto impedir el cambio aquí que intentar
        // re-sincronizar requisiciones históricas con la obra que cambió de dueño.
        if (kind === "works" && "societyId" in value) {
          const work = before as CatalogWork, nextSocietyId = (candidate as CatalogWork).societyId;
          if (nextSocietyId !== work.societyId && (await tx.catalogs.hasRequisitionsForWork(id))) throw new DomainError("WORK_HAS_REQUISITIONS", "No se puede cambiar la sociedad de una obra que ya tiene requisiciones asociadas");
        }
        const after = await tx.catalogs.update(kind, id, value);
        await this.audit("actualizada", kind, id, actor, before, after, tx.audit);
        return after;
      });
    } catch (error) { this.conflict(error, kind); }
  }
}
