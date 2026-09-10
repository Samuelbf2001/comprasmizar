import { z } from "zod";
import { authenticatedJson, assertSameOrigin, parseJson } from "../../../lib/http/api";
import { hasPermission } from "../../../lib/domain";
import { sharedPostgres } from "../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../lib/security/env";
import { CatalogService } from "../../../lib/services";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { invalidateActorCache } from "../../../lib/infrastructure/actor-cache";

export const runtime = "nodejs";

type NamedRow = { id: string; name: string };
type WorkRow = NamedRow & { societyId: string };
const uuid = z.string().uuid();
const name = z.string().trim().min(2).max(160);
const active = z.boolean().optional();
// Debe coincidir exactamente con el tipo Role de lib/domain (lib/domain/model.ts).
const roleLiteral = z.enum(["solicitante", "revisor", "aprobador", "contabilidad", "admin_mizar", "admin_sixteam"]);
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/);
const nit = z.string().trim().min(3).max(32);
const tagCreateData = z.object({ name, approverId: uuid.optional(), active }).strict().superRefine((value, context) => { if (value.active !== false && !value.approverId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["approverId"], message: "Active tags require an approver" }); });
const createCatalogSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("works"), data: z.object({ name, societyId: uuid, active }).strict() }),
  z.object({ kind: z.literal("tags"), data: tagCreateData }),
  z.object({ kind: z.literal("items"), data: z.object({ name, specification: z.string().trim().min(1).max(1_000).optional(), unit: z.string().trim().min(1).max(40), category: z.string().trim().min(1).max(100).optional(), active }).strict() }),
  z.object({ kind: z.literal("suppliers"), data: z.object({ name, nit: nit.optional(), phone: phone.optional(), email: z.string().trim().email().max(254).optional(), address: z.string().trim().min(1).max(300).optional(), active }).strict() }),
  z.object({ kind: z.literal("societies"), data: z.object({ name, nit: nit.optional(), active }).strict() }),
  // RF-004: `id` es obligatorio y debe ser el id ya existente en Supabase Auth (auth.users) del usuario a
  // vincular; esta plataforma nunca crea la cuenta de Auth. Al menos un rol es obligatorio en el alta.
  z.object({ kind: z.literal("users"), data: z.object({ id: uuid, name, email: z.string().trim().email().max(254), phone: phone.optional(), roles: z.array(roleLiteral).min(1).max(6), active }).strict() }),
  // HUECO 1: lista blanca global de solicitantes autorizados por WhatsApp (RF-902). `phone` es
  // obligatorio (a diferencia de proveedores/usuarios): la columna `telefono` es NOT NULL.
  z.object({ kind: z.literal("requesters"), data: z.object({ name, phone, active }).strict() }),
]);
const patchCatalogSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("works"), id: uuid, data: z.object({ name: name.optional(), societyId: uuid.optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("tags"), id: uuid, data: z.object({ name: name.optional(), approverId: uuid.nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("items"), id: uuid, data: z.object({ name: name.optional(), specification: z.string().trim().min(1).max(1_000).nullable().optional(), unit: z.string().trim().min(1).max(40).optional(), category: z.string().trim().min(1).max(100).nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("suppliers"), id: uuid, data: z.object({ name: name.optional(), nit: nit.nullable().optional(), phone: phone.nullable().optional(), email: z.string().trim().email().max(254).nullable().optional(), address: z.string().trim().min(1).max(300).nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("societies"), id: uuid, data: z.object({ name: name.optional(), nit: nit.nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  // Sin "email": el correo se vincula a la cuenta de Auth y no se edita desde este catálogo.
  // "roles" es el conjunto final deseado (reemplaza, no incrementa) y puede quedar vacío.
  z.object({ kind: z.literal("users"), id: uuid, data: z.object({ name: name.optional(), phone: phone.nullable().optional(), roles: z.array(roleLiteral).max(6).optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  // HUECO 1: `phone` no admite null (nunca opcional-a-vacío) porque la columna es NOT NULL.
  z.object({ kind: z.literal("requesters"), id: uuid, data: z.object({ name: name.optional(), phone: phone.optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
]);

/**
 * Minimal, read-only catalog bootstrap for authenticated operational forms.
 * Sensitive supplier/user details are deliberately excluded.
 */
export function GET() {
  return authenticatedJson(async (actor) => {
    const sql = sharedPostgres(runtimeEnv().DATABASE_URL);
    // "ordenes_multi_proveedor" sale de aquí: la generación de órdenes ya siempre agrupa por proveedor
    // (reunión 2026-08-31), y Fase 1 ya marcó ese módulo como obsoleto sin borrar la fila.
    const modules = await sql<Array<{ name: string; enabled: boolean }>>`select nombre as name, activo as enabled from modulos where nombre in ('catalogos_admin_mizar')`;
    const features = Object.fromEntries(modules.map((module) => [module.name, module.enabled]));
    const canReadSuppliers = hasPermission(actor.roles, "order:read") || hasPermission(actor.roles, "supplier:manage") || actor.roles.includes("admin_sixteam") || (actor.roles.includes("admin_mizar") && features.catalogos_admin_mizar === true);
    // "sociedad_id as societyId" es el bloqueo exacto que hoy impide a la UI filtrar obras por empresa
    // (reunión 2026-08-31: el solicitante elige empresa, la obra la asigna el revisor filtrada por ella).
    // "societies" se añade al bootstrap por la misma razón: sin la lista, no hay qué ofrecer para elegir.
    // HUECO 2 (QA reunión 2026-08-31): un UUID crudo nunca debe llegar a pantalla — el historial de
    // trazabilidad y el solicitante interno de una requisición solo traían el id (ver
    // components/screens/connected.tsx). Se añade esta lista MÍNIMA (id + nombre, sin correo/teléfono/
    // roles) para que la UI resuelva el nombre; no se gatea por rol porque cualquier actor autenticado
    // puede ver una requisición ajena o su historial (aprobador, contabilidad, revisor…) y necesita
    // resolver ambos nombres. Deliberadamente sin `where estado='activo'`: un actor histórico ya
    // desactivado igual debe poder identificarse en una traza pasada.
    // Reunión 2026-09: el aprobador ya no se deriva de la etiqueta, lo elige el revisor en la pantalla —
    // "approverId" viaja en cada etiqueta SOLO como sugerencia por defecto (prerellenar el select de
    // aprobador al elegir etiqueta), y "approvers" es la lista completa de donde elegir. Misma consulta
    // de elegibilidad que ya usa app/api/catalogs/manage/route.ts (no se duplica el SQL, se repite el
    // texto porque manage/route.ts la gatea por permiso de administrar catálogos y esta lista es para
    // cualquier revisor). Nunca expone teléfono ni correo, igual que el resto de este bootstrap mínimo.
    const [works, tags, suppliers, items, societies, users, approvers] = await Promise.all([
      sql<WorkRow[]>`select id, nombre as name, sociedad_id as "societyId" from obras where estado = 'activa' order by nombre`,
      sql<Array<NamedRow & { approverId: string | null }>>`select id, nombre as name, aprobador_id as "approverId" from etiquetas where activa = true order by nombre`,
      canReadSuppliers ? sql<NamedRow[]>`select id, razon_social as name from proveedores where activo = true order by razon_social` : Promise.resolve([]),
      sql<Array<NamedRow & { unit: string; status: string }>>`select id, nombre as name, unidad_defecto as unit, estado as status from items where estado = 'activo' order by nombre`,
      sql<NamedRow[]>`select id, nombre as name from sociedades where activa = true order by nombre`,
      sql<NamedRow[]>`select id, nombre as name from usuarios order by nombre`,
      sql<NamedRow[]>`select distinct u.id, u.nombre as name from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam') order by u.nombre`,
    ]);
    return { works, tags, suppliers, items, societies, users, approvers, features };
  });
}

export function POST(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, createCatalogSchema);
    const data = { ...input.data, active: input.data.active ?? true };
    const created = await new CatalogService(createPostgresDependencies()).create(input.kind, data, actor);
    // H1 (docs/plan-rendimiento.md): el caché de actor.ts tiene 60 s de TTL — sin esto, un usuario
    // recién dado de alta con rol podría seguir viendo ROLE_REQUIRED (o, peor, uno reactivado seguir
    // ACCOUNT_INACTIVE) hasta que expire, en vez de al siguiente request.
    if (input.kind === "users") invalidateActorCache(created.id);
    return created;
  }, 201);
}

export function PATCH(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, patchCatalogSchema);
    const patched = await new CatalogService(createPostgresDependencies()).patch(input.kind, input.id, input.data, actor);
    // H1: desactivar una cuenta o cambiar sus roles debe surtir efecto de inmediato, no esperar el TTL.
    if (input.kind === "users") invalidateActorCache(input.id);
    return patched;
  });
}
