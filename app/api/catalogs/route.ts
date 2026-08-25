import { z } from "zod";
import { authenticatedJson, assertSameOrigin, parseJson } from "../../../lib/http/api";
import { hasPermission } from "../../../lib/domain";
import { sharedPostgres } from "../../../lib/infrastructure/postgres-repositories";
import { runtimeEnv } from "../../../lib/security/env";
import { CatalogService } from "../../../lib/services";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";

export const runtime = "nodejs";

type NamedRow = { id: string; name: string };
const uuid = z.string().uuid();
const name = z.string().trim().min(2).max(160);
const active = z.boolean().optional();
const tagCreateData = z.object({ name, approverId: uuid.optional(), active }).strict().superRefine((value, context) => { if (value.active !== false && !value.approverId) context.addIssue({ code: z.ZodIssueCode.custom, path: ["approverId"], message: "Active tags require an approver" }); });
const createCatalogSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("works"), data: z.object({ name, societyId: uuid, active }).strict() }),
  z.object({ kind: z.literal("tags"), data: tagCreateData }),
  z.object({ kind: z.literal("items"), data: z.object({ name, specification: z.string().trim().min(1).max(1_000).optional(), unit: z.string().trim().min(1).max(40), category: z.string().trim().min(1).max(100).optional(), active }).strict() }),
  z.object({ kind: z.literal("suppliers"), data: z.object({ name, nit: z.string().trim().min(3).max(32).optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).optional(), email: z.string().trim().email().max(254).optional(), address: z.string().trim().min(1).max(300).optional(), active }).strict() }),
]);
const patchCatalogSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("works"), id: uuid, data: z.object({ name: name.optional(), societyId: uuid.optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("tags"), id: uuid, data: z.object({ name: name.optional(), approverId: uuid.nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("items"), id: uuid, data: z.object({ name: name.optional(), specification: z.string().trim().min(1).max(1_000).nullable().optional(), unit: z.string().trim().min(1).max(40).optional(), category: z.string().trim().min(1).max(100).nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
  z.object({ kind: z.literal("suppliers"), id: uuid, data: z.object({ name: name.optional(), nit: z.string().trim().min(3).max(32).nullable().optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/).nullable().optional(), email: z.string().trim().email().max(254).nullable().optional(), address: z.string().trim().min(1).max(300).nullable().optional(), active }).strict().refine((value) => Object.keys(value).length > 0) }),
]);

/**
 * Minimal, read-only catalog bootstrap for authenticated operational forms.
 * Sensitive supplier/user details are deliberately excluded.
 */
export function GET() {
  return authenticatedJson(async (actor) => {
    const sql = sharedPostgres(runtimeEnv().DATABASE_URL);
    const modules = await sql<Array<{ name: string; enabled: boolean }>>`select nombre as name, activo as enabled from modulos where nombre in ('ordenes_multi_proveedor', 'catalogos_admin_mizar')`;
    const features = Object.fromEntries(modules.map((module) => [module.name, module.enabled]));
    const canReadSuppliers = hasPermission(actor.roles, "order:read") || hasPermission(actor.roles, "supplier:manage") || actor.roles.includes("admin_sixteam") || (actor.roles.includes("admin_mizar") && features.catalogos_admin_mizar === true);
    const [works, tags, suppliers, items] = await Promise.all([
      sql<NamedRow[]>`select id, nombre as name from obras where estado = 'activa' order by nombre`,
      sql<NamedRow[]>`select id, nombre as name from etiquetas where activa = true order by nombre`,
      canReadSuppliers ? sql<NamedRow[]>`select id, razon_social as name from proveedores where activo = true order by razon_social` : Promise.resolve([]),
      sql<Array<NamedRow & { unit: string; status: string }>>`select id, nombre as name, unidad_defecto as unit, estado as status from items where estado = 'activo' order by nombre`,
    ]);
    return { works, tags, suppliers, items, features };
  });
}

export function POST(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, createCatalogSchema);
    const data = { ...input.data, active: input.data.active ?? true };
    return new CatalogService(createPostgresDependencies()).create(input.kind, data, actor);
  }, 201);
}

export function PATCH(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, patchCatalogSchema);
    return new CatalogService(createPostgresDependencies()).patch(input.kind, input.id, input.data, actor);
  });
}
