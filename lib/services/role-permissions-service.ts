import { ADMIN_LOCKED_PERMISSION, ALL_ROLES, DEFAULT_ROLE_PERMISSIONS, PERMISSION_CATALOG, assertPermission, assertValidPermissionOverrides, resolveRolePermissions, type Actor, type AuditEvent, type Role, type RolePermissionOverrides } from "../domain";

/**
 * Lee y escribe el override de `configuracion.permisos_por_rol_v1`. `save` se compromete a escribir
 * override Y evento de auditoría de forma atómica: son los permisos de toda la plataforma, y un corte
 * entre ambos dejaría un cambio de permisos sin rastro de quién lo hizo.
 */
export interface RolePermissionsRepository {
  get(): Promise<RolePermissionOverrides>;
  save(overrides: RolePermissionOverrides, actorId: string, audit: AuditEvent): Promise<void>;
}

/** Lo que la pantalla necesita para pintar la matriz sin conocer ninguna regla del dominio. */
export interface RolePermissionsSettings {
  roles: readonly { key: Role; label: string }[];
  permissions: readonly { key: string; label: string; group: string }[];
  /** Valores de `lib/domain/rules.ts`: lo que "Restaurar valores por defecto" devuelve. */
  defaults: Record<Role, readonly string[]>;
  /** Lo que rige hoy (override si lo hay, default si no) — lo que la matriz marca. */
  effective: Record<Role, readonly string[]>;
  /** Roles con override guardado: los que la pantalla señala como "distinto del valor por defecto". */
  overridden: readonly Role[];
  lockedPermission: string;
}

/** Los mismos nombres que la plataforma ya muestra en todas partes (ver app/auth-guard.ts). */
const ROLE_LABELS: Record<Role, string> = {
  solicitante: "Solicitante",
  revisor: "Revisor",
  aprobador: "Aprobador",
  contabilidad: "Contabilidad",
  admin_mizar: "Administrador Mizar",
  admin_sixteam: "Administrador Sixteam",
};

/**
 * `auditoria.entidad_id` es de tipo uuid (202608240001_core_compras.sql), así que la clave de
 * configuración no puede viajar como entidad: necesita un uuid fijo propio, igual que la fila
 * singleton de `acceso_publico`. Escribir aquí "permisos_por_rol_v1" costaría un 22P02 y un 500 con
 * el cambio ya guardado — exactamente el fallo que vivió el endpoint de acceso público.
 */
const ROLE_PERMISSIONS_AUDIT_ID = "00000000-0000-0000-0000-000000000002";

export class RolePermissionsService {
  constructor(private readonly deps: { repository: RolePermissionsRepository; clock: { now(): Date } }) {}

  async getSettings(actor: Actor): Promise<RolePermissionsSettings> {
    assertPermission(actor, "config:manage");
    const overrides = await this.deps.repository.get();
    const byRole = <T>(map: (role: Role) => T) => Object.fromEntries(ALL_ROLES.map((role) => [role, map(role)])) as Record<Role, T>;
    return {
      roles: ALL_ROLES.map((role) => ({ key: role, label: ROLE_LABELS[role] })),
      permissions: PERMISSION_CATALOG,
      defaults: byRole((role) => DEFAULT_ROLE_PERMISSIONS[role]),
      effective: byRole((role) => resolveRolePermissions(role, overrides)),
      overridden: ALL_ROLES.filter((role) => overrides[role] !== undefined),
      lockedPermission: ADMIN_LOCKED_PERMISSION,
    };
  }

  /**
   * Guarda el override COMPLETO (la pantalla manda la matriz entera). Un rol ausente del objeto vuelve
   * a su valor por defecto — así es como funciona «Restaurar valores por defecto»: quitar su clave, no
   * escribir una copia del default, que quedaría congelada si mañana el default cambia.
   */
  async save(actor: Actor, value: unknown): Promise<RolePermissionsSettings> {
    assertPermission(actor, "config:manage");
    const before = await this.deps.repository.get();
    const overrides = assertValidPermissionOverrides(value);
    await this.deps.repository.save(overrides, actor.id, {
      entity: "configuracion",
      entityId: ROLE_PERMISSIONS_AUDIT_ID,
      event: "permisos_por_rol_actualizados",
      actorId: actor.id,
      at: this.deps.clock.now(),
      origin: "web",
      data: { roles: actor.roles, antes: before, despues: overrides },
    });
    return this.getSettings(actor);
  }
}
