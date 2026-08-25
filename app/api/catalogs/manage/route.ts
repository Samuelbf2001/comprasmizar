import { DomainError } from "../../../../lib/domain";
import { authenticatedJson } from "../../../../lib/http/api";
import { sharedPostgres } from "../../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../../lib/security/env";
import { canManageCatalog } from "../../../../lib/services";

export const runtime = "nodejs";

/** Full admin catalogue data, including inactive records; bootstrap GET remains intentionally minimal. */
export function GET() {
  return authenticatedJson(async (actor) => {
    const sql = sharedPostgres(runtimeEnv().DATABASE_URL);
    const featureRows = await sql<Array<{ active: boolean }>>`select activo as active from modulos where nombre='catalogos_admin_mizar'`;
    const feature = featureRows[0]?.active === true;
    // RF-002/RF-004: "societies" y "users" no dependen del autoservicio de catálogos como el resto.
    // "users" solo habilita ESCRITURA aquí (ver canReadUsers para su lectura, exclusiva de admin_mizar/admin_sixteam).
    const access = { works: canManageCatalog(actor, "works", feature), tags: canManageCatalog(actor, "tags", feature), items: canManageCatalog(actor, "items", feature), suppliers: canManageCatalog(actor, "suppliers", feature), societies: canManageCatalog(actor, "societies", feature), users: canManageCatalog(actor, "users", feature) };
    const canReadUsers = access.users || actor.roles.includes("admin_mizar");
    if (!Object.values(access).some(Boolean) && !canReadUsers) throw new DomainError("FORBIDDEN", "No puede administrar catálogos");
    const [works, tags, items, suppliers, societies, approvers, societyRecords, userRecords] = await Promise.all([
      access.works ? sql<Array<{ id: string; name: string; societyId: string; active: boolean }>>`select id, nombre as name, sociedad_id as "societyId", estado='activa' as active from obras order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string; approverId: string | null; active: boolean }>>`select id, nombre as name, aprobador_id as "approverId", activa as active from etiquetas order by nombre` : Promise.resolve([]),
      access.items ? sql<Array<{ id: string; name: string; specification: string | null; unit: string; category: string | null; status: string; active: boolean }>>`select id, nombre as name, especificacion as specification, unidad_defecto as unit, categoria as category, estado as status, estado='activo' as active from items where estado <> 'fusionado' order by nombre` : Promise.resolve([]),
      // Supplier contact data is only selected after supplier:manage/catalog authorization above.
      access.suppliers ? sql<Array<{ id: string; name: string; nit: string | null; phone: string | null; email: string | null; address: string | null; active: boolean }>>`select id, razon_social as name, nit, contacto->>'phone' as phone, contacto->>'email' as email, contacto->>'address' as address, activo as active from proveedores order by razon_social` : Promise.resolve([]),
      // A new work can only be assigned to an active society; the response does not pretend to manage societies here.
      access.works ? sql<Array<{ id: string; name: string }>>`select id, nombre as name from sociedades where activa=true order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string }>>`select distinct u.id, u.nombre as name from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam') order by u.nombre` : Promise.resolve([]),
      // RF-002: listado completo (incluye inactivas) para la administración de sociedades.
      access.societies ? sql<Array<{ id: string; name: string; nit: string | null; active: boolean }>>`select id, nombre as name, nit, activa as active from sociedades order by nombre` : Promise.resolve([]),
      // RF-004: admin_mizar solo lee (nunca ve esto como habilitado para escribir vía `access.users`).
      canReadUsers ? sql<Array<{ id: string; name: string; email: string; phone: string | null; active: boolean; roles: string[] }>>`select u.id, u.nombre as name, u.email, u.telefono as phone, u.estado='activo' as active, coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles from usuarios u left join usuario_roles ur on ur.usuario_id=u.id group by u.id order by u.nombre` : Promise.resolve([]),
    ]);
    return { works, tags, items, suppliers, societies, approvers, societyRecords, userRecords, access, canReadUsers, features: { catalogos_admin_mizar: feature } };
  });
}
