import { createHash, randomBytes } from "node:crypto";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { invalidateActorCache } from "./actor-cache";
import { asJsonb } from "./jsonb";

/**
 * Autenticación propia, reemplazo de Supabase Auth (migración a autoalojado, 2026-09-10).
 *
 * Decisión clave: las contraseñas NO se migran ni se resetean. Supabase Auth guarda bcrypt en
 * `auth.users.encrypted_password`, y este repo ya usaba bcrypt vía pgcrypto para la contraseña del
 * portal público (`extensions.crypt` / `gen_salt('bf', 12)`, ver public-access.ts). Al verificar con
 * el mismo `extensions.crypt(intento, hash) = hash`, los hashes existentes siguen siendo válidos tal
 * cual salieron del `pg_dump`: nadie pierde su contraseña el día del corte.
 *
 * La sesión pasa de JWT firmado por Supabase a token opaco guardado en `public.sesiones`. Es una
 * decisión a favor de la revocación: cerrar sesión o dar de baja a alguien surte efecto de inmediato
 * (se borra la fila), mientras que un JWT sigue siendo válido hasta que vence. El costo es una
 * consulta por petición, que es exactamente lo que el caché de perfil de 60 s (actor-cache.ts) ya
 * estaba amortizando para la consulta de roles.
 */
const SESSION_BYTES = 32;
const SLIDING_TTL_MS = 12 * 60 * 60 * 1000; // Jornada larga sin re-login.
const ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Tope duro desde la creación: obliga a reautenticar cada semana.
/** Solo se refresca `expira_at` si pasó esto desde el último uso: evita un UPDATE por cada request. */
const REFRESH_AFTER_MS = 30 * 60 * 1000;

export const SESSION_COOKIE = "mizar_sesion";

/** Atributos de la cookie de sesión. `secure` cede en desarrollo (http://localhost), nunca en el VPS. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: maxAgeSeconds };
}

const hashToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

/**
 * Los eventos de sesión se auditan AQUÍ y no en el server action para que ningún camino de entrada
 * futuro pueda abrir sesión sin dejar rastro. `datos_json` se mantiene sin PII a propósito: el
 * correo intentado no se guarda (la redacción de `auditoria_campo_sensible` protege columnas de
 * tabla, no las claves de un insert manual, así que aquí quedaría en claro). Para forense de
 * fuerza bruta está el log del proxy; esto registra el hecho, no el dato personal.
 */
async function auditSession(sql: ReturnType<typeof sharedPostgres>, event: string, userId: string | null, data: Record<string, unknown> = {}): Promise<void> {
  await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json)
            values ('sesion', ${userId}, ${event}, 'web', ${userId}, now(), ${asJsonb(sql, data)})`;
}

export type SignInResult = { token: string; maxAgeSeconds: number };
export type SignInFailure = "INVALID_CREDENTIALS" | "ACCOUNT_INACTIVE";

/**
 * Verifica correo + contraseña y abre sesión. Devuelve un código de fallo en vez de lanzar, porque
 * el llamador (server action del login) traduce todo a un mensaje único y genérico.
 *
 * El `crypt` de relleno cuando el correo no existe no es adorno: sin él, una cuenta inexistente
 * responde en microsegundos y una existente tarda lo que tarda bcrypt (~100 ms con coste 12), lo que
 * convierte el formulario en un oráculo de qué correos están dados de alta.
 */
export async function signIn(email: string, password: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<SignInResult | SignInFailure> {
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ id: string; valida: boolean; estado: string | null }[]>`
    select u.id,
           u.encrypted_password is not null and u.encrypted_password = extensions.crypt(${password}, u.encrypted_password) as valida,
           p.estado
    from auth.users u
    left join public.usuarios p on p.id = u.id
    where lower(u.email) = lower(${email})
    limit 1`;
  const row = rows[0];
  if (!row) { await sql`select extensions.crypt(${password}, extensions.gen_salt('bf', 12))`; await auditSession(sql, "SESION_RECHAZADA", null, { motivo: "credenciales" }); return "INVALID_CREDENTIALS"; }
  if (!row.valida) { await auditSession(sql, "SESION_RECHAZADA", row.id, { motivo: "credenciales" }); return "INVALID_CREDENTIALS"; }
  // Una cuenta dada de baja no debe poder abrir sesión siquiera: sin esto entraría y solo chocaría
  // después contra getAuthSnapshot(), que la echaría con un mensaje mucho menos claro.
  if (row.estado !== "activo") { await auditSession(sql, "SESION_RECHAZADA", row.id, { motivo: "inactiva" }); return "ACCOUNT_INACTIVE"; }
  const token = await createSession(row.id, databaseUrl);
  await auditSession(sql, "SESION_INICIADA", row.id);
  return { token, maxAgeSeconds: Math.floor(SLIDING_TTL_MS / 1000) };
}

export async function createSession(userId: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<string> {
  const sql = sharedPostgres(databaseUrl);
  const token = randomBytes(SESSION_BYTES).toString("base64url");
  await sql`
    insert into public.sesiones (usuario_id, token_hash, expira_at)
    values (${userId}, ${hashToken(token)}, now() + (${SLIDING_TTL_MS} * interval '1 millisecond'))`;
  return token;
}

/**
 * Devuelve el `usuario_id` de una sesión viva, o `null`. La búsqueda es POR HASH sobre una columna
 * única: no se compara ningún secreto en JavaScript, así que no hay que preocuparse por comparaciones
 * de tiempo variable aquí.
 *
 * Renueva la ventana deslizante como máximo cada REFRESH_AFTER_MS, con tope absoluto desde
 * `creada_at`: una sesión en uso continuo no molesta al usuario, pero tampoco vive para siempre.
 */
export async function verifySession(token: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<string | null> {
  if (!token) return null;
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ usuario_id: string }[]>`
    update public.sesiones
       set ultimo_uso_at = now(),
           expira_at = case
             when ultimo_uso_at < now() - (${REFRESH_AFTER_MS} * interval '1 millisecond')
               then least(now() + (${SLIDING_TTL_MS} * interval '1 millisecond'),
                          creada_at + (${ABSOLUTE_TTL_MS} * interval '1 millisecond'))
             else expira_at
           end
     where token_hash = ${hashToken(token)}
       and expira_at > now()
       and creada_at > now() - (${ABSOLUTE_TTL_MS} * interval '1 millisecond')
    returning usuario_id`;
  return rows[0]?.usuario_id ?? null;
}

export async function destroySession(token: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<void> {
  if (!token) return;
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ usuario_id: string }[]>`delete from public.sesiones where token_hash = ${hashToken(token)} returning usuario_id`;
  const userId = rows[0]?.usuario_id;
  if (userId) { await auditSession(sql, "SESION_CERRADA", userId); invalidateActorCache(userId); }
}

/**
 * Cambia la contraseña y cierra TODAS las demás sesiones de esa cuenta — comportamiento esperado
 * tras un cambio de clave, y la única forma de que quien creía estar comprometido recupere el
 * control. `keepToken` conserva la sesión desde la que se hizo el cambio para no expulsar a quien
 * acaba de cambiarla.
 */
export async function setPassword(userId: string, password: string, keepToken?: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<void> {
  const sql = sharedPostgres(databaseUrl);
  await sql.begin(async (tx) => {
    await tx`update auth.users set encrypted_password = extensions.crypt(${password}, extensions.gen_salt('bf', 12)), updated_at = now() where id = ${userId}`;
    if (keepToken) await tx`delete from public.sesiones where usuario_id = ${userId} and token_hash <> ${hashToken(keepToken)}`;
    else await tx`delete from public.sesiones where usuario_id = ${userId}`;
    await auditSession(tx as unknown as ReturnType<typeof sharedPostgres>, "CLAVE_CAMBIADA", userId, { otrasSesionesCerradas: true });
  });
  invalidateActorCache(userId);
}

/**
 * Restablecimiento ADMINISTRADO (POST /api/usuarios/:id/clave): lo mismo que `setPassword` sin
 * `keepToken` (cierra todas las sesiones de la cuenta), pero el rastro dice QUIÉN lo hizo. Con
 * `setPassword` el evento quedaba como CLAVE_CAMBIADA a nombre de la propia cuenta intervenida, y el
 * historial de cambios contaba «Juan cambió su contraseña» cuando la había restablecido Daniel.
 * `entidad_id` es la cuenta afectada y `usuario_id` quien la restableció; ni la clave ni su hash viajan.
 */
export async function resetPasswordAsAdmin(userId: string, password: string, adminId: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<void> {
  const sql = sharedPostgres(databaseUrl);
  await sql.begin(async (tx) => {
    await tx`update auth.users set encrypted_password = extensions.crypt(${password}, extensions.gen_salt('bf', 12)), updated_at = now() where id = ${userId}`;
    await tx`delete from public.sesiones where usuario_id = ${userId}`;
    await tx`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json)
             values ('sesion', ${userId}, 'CLAVE_RESTABLECIDA', 'web', ${adminId}, now(), ${asJsonb(tx as unknown as ReturnType<typeof sharedPostgres>, { otrasSesionesCerradas: true })})`;
  });
  invalidateActorCache(userId);
}

/** Purga de sesiones vencidas. La invoca el mismo cron del respaldo diario (ops/backup-daily.sh). */
export async function purgeExpiredSessions(databaseUrl = runtimeEnv().DATABASE_URL): Promise<number> {
  const rows = await sharedPostgres(databaseUrl)<{ id: string }[]>`
    delete from public.sesiones
     where expira_at <= now() or creada_at <= now() - (${ABSOLUTE_TTL_MS} * interval '1 millisecond')
    returning id`;
  return rows.length;
}
