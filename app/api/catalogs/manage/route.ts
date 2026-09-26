import { DomainError, MIZAR_SELF_SERVICE_MODULE, canManageSixteamAccounts, hasPermission } from "../../../../lib/domain";
import { authenticatedJson } from "../../../../lib/http/api";
import { sharedPostgres } from "../../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../../lib/security/env";
import { canManageCatalog } from "../../../../lib/services";

export const runtime = "nodejs";

/** Full admin catalogue data, including inactive records; bootstrap GET remains intentionally minimal. */
export function GET() {
  return authenticatedJson(async (actor) => {
    const sql = sharedPostgres(runtimeEnv().DATABASE_URL);
    const featureRows = await sql<Array<{ active: boolean }>>`select activo as active from modulos where nombre=${MIZAR_SELF_SERVICE_MODULE}`;
    const feature = featureRows[0]?.active === true;
    // 25-sep-2026 («Daniel puede hacer todo»): cada pestaña se abre por su PERMISO
    // (CATALOG_KIND_PERMISSION en lib/services/catalog-service.ts), ya no por nombre de rol. Es la
    // MISMA función que decide la escritura, así que la pantalla nunca ofrece lo que el servicio niega.
    const access = { works: canManageCatalog(actor, "works", feature), tags: canManageCatalog(actor, "tags", feature), items: canManageCatalog(actor, "items", feature), suppliers: canManageCatalog(actor, "suppliers", feature), societies: canManageCatalog(actor, "societies", feature), users: canManageCatalog(actor, "users", feature), requesters: canManageCatalog(actor, "requesters", feature), costCenters: canManageCatalog(actor, "costCenters", feature), cashBoxes: canManageCatalog(actor, "cashBoxes", feature) };
    // Consultar usuarios: "user:read" (admin_mizar lo tenía por nombre de rol, en solo lectura).
    const canReadUsers = access.users || hasPermission(actor, "user:read");
    // HUECO 1: mismo criterio que la policy RLS de lectura de solicitantes_autorizados
    // ("solicitantes_autorizados_lectura_operativa" = can_operate_compras() or can_manage_catalogos()):
    // quien revisa requisiciones puede CONSULTAR quién pide por WhatsApp aunque no administre la lista.
    const canReadRequesters = access.requesters || hasPermission(actor, "requisition:review");
    // Lo que la pantalla necesita saber además de las pestañas, todo decidido aquí por permiso:
    // restablecer contraseñas, la contraseña del portal y si puede tocar cuentas de Administrador Sixteam.
    const canResetPasswords = hasPermission(actor, "user:reset_password");
    const canManagePublicAccess = hasPermission(actor, "public_access:manage");
    const canManageSixteam = canManageSixteamAccounts(actor);
    if (!Object.values(access).some(Boolean) && !canReadUsers && !canReadRequesters && !canResetPasswords && !canManagePublicAccess) throw new DomainError("FORBIDDEN", "No puede administrar catálogos");
    const [works, tags, items, suppliers, societies, approvers, societyRecords, userRecords, requesters, costCenters, costCenterRecords, cashBoxRecords] = await Promise.all([
      access.works ? sql<Array<{ id: string; name: string; societyId: string; costCenterId: string | null; active: boolean }>>`select id, nombre as name, sociedad_id as "societyId", centro_costo_id as "costCenterId", estado='activa' as active from obras order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string; approverId: string | null; active: boolean }>>`select id, nombre as name, aprobador_id as "approverId", activa as active from etiquetas order by nombre` : Promise.resolve([]),
      access.items ? sql<Array<{ id: string; name: string; specification: string | null; unit: string; category: string | null; status: string; active: boolean }>>`select id, nombre as name, especificacion as specification, unidad_defecto as unit, categoria as category, estado as status, estado='activo' as active from items where estado <> 'fusionado' order by nombre` : Promise.resolve([]),
      // Supplier contact data is only selected after supplier:manage/catalog authorization above.
      // RF-601: tipo/identificación/pendiente de normalizar viajan para la pestaña de proveedores (S2).
      access.suppliers ? sql<Array<{ id: string; name: string; nit: string | null; identificationType: string; identification: string | null; pendingNormalization: boolean; phone: string | null; email: string | null; address: string | null; active: boolean }>>`select id, razon_social as name, nit, tipo_identificacion as "identificationType", identificacion as identification, pendiente_normalizacion as "pendingNormalization", contacto->>'phone' as phone, contacto->>'email' as email, contacto->>'address' as address, activo as active from proveedores order by razon_social` : Promise.resolve([]),
      // A new work can only be assigned to an active society; the response does not pretend to manage societies here.
      access.works ? sql<Array<{ id: string; name: string }>>`select id, nombre as name from sociedades where activa=true order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string }>>`select distinct u.id, u.nombre as name from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam') order by u.nombre` : Promise.resolve([]),
      // RF-002: listado completo (incluye inactivas) para la administración de sociedades.
      access.societies ? sql<Array<{ id: string; name: string; nit: string | null; active: boolean }>>`select id, nombre as name, nit, activa as active from sociedades order by nombre` : Promise.resolve([]),
      // RF-004: con "user:read" sin "user:manage" (admin_mizar por defecto) la pestaña es de solo lectura.
      canReadUsers ? sql<Array<{ id: string; name: string; email: string; phone: string | null; active: boolean; roles: string[] }>>`select u.id, u.nombre as name, u.email, u.telefono as phone, u.estado='activo' as active, coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles from usuarios u left join usuario_roles ur on ur.usuario_id=u.id group by u.id order by u.nombre` : Promise.resolve([]),
      // HUECO 1: listado completo (incluye inactivos) para poder reactivar una baja reversible.
      canReadRequesters ? sql<Array<{ id: string; name: string; phone: string; active: boolean }>>`select id, nombre as name, telefono as phone, activo as active from solicitantes_autorizados order by nombre` : Promise.resolve([]),
      // Centros de costo (2026-09-12): "costCenters" es la lista MÍNIMA activa (mismo criterio que
      // "societies" arriba) para el selector del formulario de Obras; "costCenterRecords" es el listado
      // COMPLETO (incluye inactivos) para la pestaña de administración propia — mismo patrón por el que
      // "societies"/"societyRecords" son dos claves distintas (ver CatalogData en catalog-admin.tsx).
      access.works ? sql<Array<{ id: string; name: string }>>`select id, nombre as name from centros_costo where activo=true order by nombre` : Promise.resolve([]),
      access.costCenters ? sql<Array<{ id: string; name: string; code: string | null; societyId: string | null; type: string; active: boolean }>>`select id, nombre as name, codigo as code, sociedad_id as "societyId", tipo as type, activo as active from centros_costo order by nombre` : Promise.resolve([]),
      // Cajas (2026-09-12): listado COMPLETO (incluye inactivas) para la pestaña de administración —
      // mismo patrón que costCenters/costCenterRecords arriba.
      access.cashBoxes ? sql<Array<{ id: string; name: string; type: string; societyId: string | null; costCenterId: string | null; active: boolean }>>`select id, nombre as name, tipo as type, sociedad_id as "societyId", centro_costo_id as "costCenterId", activo as active from cajas order by nombre` : Promise.resolve([]),
    ]);
    // `viewerId`: el propio id de quien mira (no se pinta): la pantalla de usuarios lo usa para no
    // ofrecerle desactivarse a sí mismo. `viewerPermissions`, igual que el bootstrap /api/catalogs.
    return { works, tags, items, suppliers, societies, approvers, societyRecords, userRecords, requesters, costCenters, costCenterRecords, cashBoxRecords, access, canReadUsers, canReadRequesters, canResetPasswords, canManagePublicAccess, canManageSixteam, viewerId: actor.id, viewerPermissions: actor.permissions ?? [], features: { catalogos_admin_mizar: feature } };
  });
}
