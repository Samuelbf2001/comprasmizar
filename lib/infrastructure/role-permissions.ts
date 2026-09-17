import { type Sql } from "postgres";
import { assertValidPermissionOverrides, resolveActorPermissions, type Actor, type RolePermissionOverrides } from "../domain";
import type { RolePermissionsRepository } from "../services";
import { runtimeEnv } from "../security/env";
import { PostgresPorts, sharedPostgres } from "./postgres-repositories";
import { asJsonb } from "./jsonb";

/**
 * DECISIÓN DE ERNESTO (2026-09-17): los permisos por rol dejan de estar solo hardcodeados. El default
 * sigue siendo `lib/domain/rules.ts` (dominio puro, sin base de datos); el override vive en la tabla
 * `configuracion` que ya existía, bajo esta clave, como jsonb `{rol: [permisos]}`. Un rol ausente del
 * override conserva su default, así que `{}` (o la fila inexistente) es exactamente la plataforma de
 * siempre.
 *
 * No hace falta migración: `configuracion` es clave/valor y la fila se crea sola en el primer guardado
 * (`insert ... on conflict (clave) do update`). El trigger genérico `escribir_auditoria` de esa tabla
 * ya registra el antes/después de la fila; el servicio añade además su propio evento de aplicación
 * con el actor y sus roles, que es lo que el trigger no puede saber.
 */
export const ROLE_PERMISSIONS_KEY = "permisos_por_rol_v1";

/**
 * Caché en proceso, mismo criterio (y mismo TTL) que el perfil de usuario de `actor-cache.ts`: sin
 * esto habría una consulta a `configuracion` por cada petición autenticada, y los permisos se
 * comprueban muchas veces dentro de una misma. Se invalida en cuanto alguien guarda desde la pantalla
 * de Configuración, así que el TTL solo cubre el caso de otra instancia del contenedor.
 */
const TTL_MS = 60_000;
let cached: { overrides: RolePermissionOverrides; expiresAt: number } | undefined;

export function invalidateRolePermissionsCache(): void { cached = undefined; }

async function readOverrides(sql: Sql): Promise<RolePermissionOverrides> {
  const rows = await sql<{ valor: unknown }[]>`select valor from configuracion where clave = ${ROLE_PERMISSIONS_KEY}`;
  const value = rows[0]?.valor;
  if (value === undefined || value === null) return {};
  // Una fila corrupta (editada a mano contra Postgres, o escrita por una versión futura con permisos
  // que aquí no existen) NO puede dejar a media plataforma sin permisos en silencio: se descarta el
  // override entero y se sigue con los defaults, que es el lado seguro y reversible.
  try { return assertValidPermissionOverrides(value); } catch { return {}; }
}

export async function loadRolePermissionOverrides(databaseUrl = runtimeEnv().DATABASE_URL, now = Date.now()): Promise<RolePermissionOverrides> {
  if (cached && cached.expiresAt > now) return cached.overrides;
  const overrides = await readOverrides(sharedPostgres(databaseUrl));
  cached = { overrides, expiresAt: now + TTL_MS };
  return overrides;
}

/**
 * Le cuelga al actor su lista EFECTIVA de permisos. Es el único punto donde infraestructura y dominio
 * se encuentran para esto: a partir de aquí `hasPermission(actor, …)` no vuelve a tocar la base.
 *
 * Si la consulta falla, se sigue con los defaults en vez de tumbar la autenticación entera: un
 * problema leyendo `configuracion` no puede dejar a todo el mundo fuera de la plataforma.
 */
export async function withEffectivePermissions<T extends Actor>(actor: T, databaseUrl?: string): Promise<T> {
  let overrides: RolePermissionOverrides = {};
  try { overrides = await loadRolePermissionOverrides(databaseUrl); } catch { overrides = {}; }
  return { ...actor, permissions: resolveActorPermissions(actor.roles, overrides) };
}

export function createRolePermissionsRepository(databaseUrl = runtimeEnv().DATABASE_URL): RolePermissionsRepository {
  const sql = sharedPostgres(databaseUrl);
  return {
    get: () => readOverrides(sql),
    // Override y evento de auditoría en UNA transacción, por el mismo motivo que la contraseña del
    // portal público (ver setPassword en public-access.ts): "escribo, confirmo, y luego audito" deja
    // permisos cambiados sin rastro de quién en cuanto la segunda escritura falla.
    async save(overrides, actorId, audit) {
      await sql.begin(async (tx) => {
        await tx`
          insert into configuracion (clave, valor, updated_at, updated_by)
          values (${ROLE_PERMISSIONS_KEY}, ${asJsonb(tx, overrides)}, now(), ${actorId})
          on conflict (clave) do update set valor = excluded.valor, updated_at = now(), updated_by = excluded.updated_by`;
        await new PostgresPorts(tx as unknown as Sql).append(audit);
      });
      invalidateRolePermissionsCache();
    },
  };
}
