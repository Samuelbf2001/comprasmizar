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
    const access = { works: canManageCatalog(actor, "works", feature), tags: canManageCatalog(actor, "tags", feature), items: canManageCatalog(actor, "items", feature), suppliers: canManageCatalog(actor, "suppliers", feature) };
    if (!Object.values(access).some(Boolean)) throw new DomainError("FORBIDDEN", "No puede administrar catálogos");
    const [works, tags, items, suppliers, societies, approvers] = await Promise.all([
      access.works ? sql<Array<{ id: string; name: string; societyId: string; active: boolean }>>`select id, nombre as name, sociedad_id as "societyId", estado='activa' as active from obras order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string; approverId: string | null; active: boolean }>>`select id, nombre as name, aprobador_id as "approverId", activa as active from etiquetas order by nombre` : Promise.resolve([]),
      access.items ? sql<Array<{ id: string; name: string; specification: string | null; unit: string; category: string | null; status: string; active: boolean }>>`select id, nombre as name, especificacion as specification, unidad_defecto as unit, categoria as category, estado as status, estado='activo' as active from items where estado <> 'fusionado' order by nombre` : Promise.resolve([]),
      // Supplier contact data is only selected after supplier:manage/catalog authorization above.
      access.suppliers ? sql<Array<{ id: string; name: string; nit: string | null; phone: string | null; email: string | null; address: string | null; active: boolean }>>`select id, razon_social as name, nit, contacto->>'phone' as phone, contacto->>'email' as email, contacto->>'address' as address, activo as active from proveedores order by razon_social` : Promise.resolve([]),
      // A new work can only be assigned to an active society; the response does not pretend to manage societies here.
      access.works ? sql<Array<{ id: string; name: string }>>`select id, nombre as name from sociedades where activa=true order by nombre` : Promise.resolve([]),
      access.tags ? sql<Array<{ id: string; name: string }>>`select distinct u.id, u.nombre as name from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam') order by u.nombre` : Promise.resolve([]),
    ]);
    return { works, tags, items, suppliers, societies, approvers, access, features: { catalogos_admin_mizar: feature } };
  });
}
