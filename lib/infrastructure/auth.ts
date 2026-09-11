import { cache } from "react";
import { cookies } from "next/headers";
import { ALL_ROLES, type Actor, type Role } from "../domain";
import { SESSION_COOKIE, verifySession } from "./local-auth";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { getCachedProfile, setCachedProfile, type ActorProfile } from "./actor-cache";

export type ResolvedActor = { id: string; roles: Role[]; displayName: string; email?: string };

/**
 * H1 (docs/plan-rendimiento.md): una sola consulta SQL (join + array_agg) reemplaza las dos consultas
 * PostgREST secuenciales que hacía requireServerActor() antes de esta fase. Los códigos de error se
 * conservan tal cual los consumía apiError() (lib/http/api.ts): AUTHZ_LOOKUP_FAILED si la consulta
 * misma falla, ACCOUNT_INACTIVE si el usuario no existe o no está activo (antes de mirar roles).
 * ROLE_REQUIRED se decide en el llamador, después de filtrar roles válidos contra ALL_ROLES.
 */
async function loadProfileFromDb(userId: string): Promise<ActorProfile> {
  const sql = sharedPostgres();
  let rows: Array<{ estado: string; nombre: string; email: string; roles: string[] | null }>;
  try {
    rows = await sql<Array<{ estado: string; nombre: string; email: string; roles: string[] | null }>>`
      select u.estado, u.nombre, u.email,
        coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles
      from public.usuarios u
      left join public.usuario_roles ur on ur.usuario_id = u.id
      where u.id = ${userId}
      group by u.id
    `;
  } catch { throw new Error("AUTHZ_LOOKUP_FAILED"); }
  const row = rows[0];
  if (!row || row.estado !== "activo") throw new Error("ACCOUNT_INACTIVE");
  return { estado: row.estado, nombre: row.nombre, email: row.email, roles: row.roles ?? [] };
}

/**
 * Núcleo sin caché de `react`, expuesto para requireServerActor() (Route Handlers).
 *
 * Autoalojado (2026-09-10): antes esto verificaba un JWT de Supabase con `client.auth.getClaims()`.
 * Ahora resuelve la sesión propia — cookie opaca -> `public.sesiones` (lib/infrastructure/local-auth.ts).
 * La forma del caché no cambia: la validez de la sesión se comprueba SIEMPRE, en cada petición (es lo
 * que permite que un cierre de sesión o una baja surtan efecto de inmediato); solo el perfil de
 * negocio (estado, nombre, roles) se reutiliza 60 s.
 *
 * `displayName`/`email` ya no tienen fuente alterna: salen de `public.usuarios`, no de los metadatos
 * del JWT. Es una simplificación real — antes había tres orígenes posibles para el mismo dato.
 */
async function resolveServerActorUncached(): Promise<ResolvedActor> {
  // La configuración se valida ANTES de mirar la cookie, y el orden importa: si falta el entorno, el
  // ZodError que lanza runtimeEnv() se traduce a 503 "service_unavailable" (ver apiError en
  // lib/http/api.ts), que es lo que un servidor sin configurar debe responder. Al revés, la primera
  // que fallaría sería `cookies()` con un error genérico y toda la API contestaría 500 —
  // indistinguible de un bug. Con Supabase esto salía gratis porque createSupabaseUserClient() ya
  // leía el entorno de primero; ahora hay que pedirlo explícitamente.
  runtimeEnv();
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) throw new Error("UNAUTHENTICATED");
  let userId: string | null;
  // Una falla de la consulta de sesión es un problema del servidor, no una credencial inválida: se
  // distingue para que el guard muestre "config" y no "tu sesión expiró".
  try { userId = await verifySession(token); } catch { throw new Error("AUTHZ_LOOKUP_FAILED"); }
  if (!userId) throw new Error("UNAUTHENTICATED");

  let profile = getCachedProfile(userId);
  if (!profile) { profile = await loadProfileFromDb(userId); setCachedProfile(userId, profile); }

  const assigned = profile.roles.filter((role): role is Role => ALL_ROLES.includes(role as Role));
  if (!assigned.length) throw new Error("ROLE_REQUIRED");

  return { id: userId, roles: assigned, displayName: profile.nombre || "Usuario", email: profile.email };
}

/**
 * Decisión (H1): `cache()` de `react` deduplica llamadas dentro de un mismo render de Server
 * Components (ver "Deduplicating requests" en node_modules/next/dist/docs/01-app/02-guides/
 * caching-without-cache-components.md) — útil para el guard de página (getAuthSnapshot), que puede
 * invocarse desde más de un componente en el mismo árbol de un request. NO se usa dentro de
 * requireServerActor(): un Route Handler es una única función async por petición, sin árbol de
 * render que recorrer, así que memoizar ahí no ahorra ninguna llamada — solo añade una capa cuya
 * garantía de reset "por render" está documentada para Server Components, no para Route Handlers.
 * requireServerActor() llama directo al núcleo sin caché para no depender de esa semántica.
 */
export const resolveServerActor = cache(resolveServerActorUncached);

export async function requireServerActor(): Promise<Actor> {
  const actor = await resolveServerActorUncached();
  return { id: actor.id, roles: actor.roles };
}
