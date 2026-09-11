import { type Sql } from "postgres";
import { runtimeEnv } from "../security/env";
import type { PublicAccessAdminRepository, PublicAccessAuditEvent, PublicAccessStatus } from "../services";
import { PostgresPorts, sharedPostgres } from "./postgres-repositories";
// GRAVE 2 (QA Postgres real): normalizeCoPhone vive en su propio módulo (ver phone.ts) para que
// postgres-repositories.ts también la reutilice (alta de solicitantes_autorizados vía catálogo) sin
// crear un ciclo de imports con este archivo, que ya importa sharedPostgres desde ese módulo.
import { normalizeCoPhone } from "./phone";

/**
 * Empresas que puede elegir quien radica por el portal.
 *
 * Reunión 2026-08-31 y recordatorio de Ernesto (11-sep-2026: "en el formulario público aparece
 * seleccionar obra y ya dijimos era empresa"): el solicitante elige EMPRESA, no obra. La obra es el
 * centro de costo y la asigna el revisor, que es quien sabe a qué contrato cargar el gasto. El Flow
 * de WhatsApp ya funcionaba así; el portal se había quedado atrás.
 *
 * Solo sociedades ACTIVAS: lo que se OFRECE tiene que ser exactamente lo que el endpoint de
 * radicación ACEPTA (ver `verifySociety` en postgres-repositories.ts). Una lista más ancha que la
 * aceptada sería una invitación a un 202 neutro que no crea nada.
 */
export async function listPublicCompanies(databaseUrl = runtimeEnv().DATABASE_URL): Promise<Array<{ id: string; name: string }>> {
  const sql = sharedPostgres(databaseUrl);
  // `sociedades` marca la vigencia con `activa boolean`, no con el enum `estado` que usan `obras`.
  const rows = await sql<{ id: string; nombre: string }[]>`
    select id, nombre from sociedades where activa order by nombre`;
  return rows.map((row) => ({ id: String(row.id), name: String(row.nombre) }));
}

/** Applies the optional obra phone allowlist; the code/link verifier remains a separate concern. */
/**
 * ¿Es esta la contraseña del portal? Comparación hecha EN LA BASE con `verificar_codigo_publico`, la
 * misma función que usa el endpoint de radicación: el bcrypt nunca sale de Postgres y no hay dos
 * criterios que puedan divergir.
 *
 * La usa `POST /api/public/access`, que es lo que permite a la compuerta del portal decir
 * «contraseña incorrecta» en la puerta. Antes la compuerta solo miraba en el navegador que la
 * contraseña tuviera cuatro caracteres, así que quien se equivocaba llenaba los dos pasos y recibía
 * el 202 neutro de la radicación: ni requisición ni aviso de que algo había fallado.
 *
 * Cualquier fallo devuelve `false`: ante la duda, no se pasa.
 */
export async function verificarCodigoPublico(code: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<boolean> {
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ valido: boolean }[]>`select public.verificar_codigo_publico(${code}) as valido`;
  return rows[0]?.valido === true;
}

export async function isAuthorizedPublicRequester(workId: string, phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<boolean> { const sql = sharedPostgres(databaseUrl), rows = await sql`select o.require_authorized_requester, exists(select 1 from obra_solicitantes_autorizados s where s.obra_id=o.id and s.activo and s.telefono_normalizado=regexp_replace(${phone}, '[^0-9]', '', 'g')) as phone_allowed from obras o where o.id=${workId}`; return Boolean(rows[0] && (!rows[0].require_authorized_requester || rows[0].phone_allowed)); }

/**
 * Identidad del solicitante del WhatsApp Flow a partir de su número (RF-902), contra la lista
 * blanca GLOBAL `solicitantes_autorizados` (migración 202609010001). El Flow ya no pide nombre ni
 * teléfono: se busca el número en la lista y se devuelve el nombre autorizado. Devuelve `null`
 * cuando el número no está autorizado, para que el adaptador rechace la requisición.
 *
 * Reunión 2026-08-31: antes la lista era por obra (`obra_solicitantes_autorizados`, con su regla de
 * "obra sin exigir autorización" propia de esa tabla) porque el Flow pedía obra. Ahora el
 * solicitante elige empresa, no obra, y ya no hay obra sobre la cual anclar la lista — de ahí la
 * lista GLOBAL, sin la opción de "no exigir autorización" (siempre se exige). La tabla vieja se
 * conserva intacta: la sigue usando el portal público (`isAuthorizedPublicRequester`, arriba), que
 * sigue anclado a la obra.
 */
export async function resolveAuthorizedRequesterName(phone: string, databaseUrl = runtimeEnv().DATABASE_URL): Promise<{ name: string } | null> {
  const sql = sharedPostgres(databaseUrl);
  const rows = await sql<{ nombre: string }[]>`
    select nombre from solicitantes_autorizados where activo and telefono_normalizado = ${normalizeCoPhone(phone)} limit 1`;
  const row = rows[0];
  return row ? { name: String(row.nombre) } : null;
}

/**
 * Reunión: la contraseña del portal público dejó de ser por obra (`obras.public_code_hash`, obsoleta)
 * y pasó a ser GLOBAL, guardada en la tabla singleton `acceso_publico` (migración 202609070002 —
 * GRAVE del QA contra Postgres real: NO se guarda en `configuracion.valor` porque esa columna la
 * comparte cualquier clave de configuración y `auditoria_campo_sensible` redacta por nombre de
 * columna; con `configuracion` el hash habría quedado en texto plano en `auditoria` cada vez que se
 * cambiara, o habría exigido redactar TODO `configuracion.valor` — incluidas claves de negocio sin
 * nada secreto como `impuestos_v1`. La tabla propia con columna `public_code_hash` hereda la
 * redacción por nombre que ya existe desde la migración base, sin ese costo colateral). Este
 * repositorio administra esa fila única: nunca ve el hash en claro fuera de la base (extensions.crypt
 * corre en la base) y nunca lo devuelve al llamador (getStatus solo informa si hay uno configurado y
 * cuándo cambió).
 */
export function createPublicAccessAdminRepository(databaseUrl = runtimeEnv().DATABASE_URL): PublicAccessAdminRepository {
  const sql = sharedPostgres(databaseUrl);
  return {
    async getStatus(): Promise<PublicAccessStatus> {
      const rows = await sql<{ configured: boolean; updated_at: string | null }[]>`
        select public_code_hash is not null as configured, updated_at
        from acceso_publico where id = '00000000-0000-0000-0000-000000000001'`;
      const row = rows[0];
      return { configured: row?.configured === true, updatedAt: row?.updated_at ? new Date(row.updated_at).toISOString() : null };
    },
    // GRAVE (QA Postgres real): antes no se comprobaban las filas afectadas — un PATCH corriendo
    // contra una fila singleton borrada/ausente (no debería pasar nunca en operación normal, pero una
    // base mal migrada sí podría dejarla sin filas) devolvía 200 sin haber cambiado nada.
    // `gen_salt('bf', 12)` fija el costo de bcrypt explícito (sin el argumento, sale en $2a$06$ — 2^6
    // rondas, muy por debajo de lo razonable para una contraseña de portal público).
    // Contraseña y auditoría, en UNA transacción. Antes eran dos escrituras encadenadas desde el
    // servicio, y la segunda falló siempre durante semanas (un `entityId` que no era uuid): el update
    // ya había commiteado, así que el administrador veía un 500 con la contraseña ya cambiada. Ese
    // error concreto está corregido, pero el patrón "escribo, confirmo, y luego audito" quedaba vivo
    // para el siguiente — un corte entre ambas dejaría una contraseña de portal cambiada sin ningún
    // rastro de quién lo hizo.
    //
    // El insert de auditoría NO se reescribe aquí: se reutiliza `PostgresPorts`, que implementa
    // `AuditRepository` sobre cualquier conexión, atado a la transacción. Duplicar ese insert sería
    // la forma segura de que un día diverja del real.
    async setPassword(code: string, actorId: string, audit: PublicAccessAuditEvent): Promise<void> {
      await sql.begin(async (tx) => {
        const result = await tx`
          update acceso_publico
          set public_code_hash = extensions.crypt(${code}, extensions.gen_salt('bf', 12)),
              updated_at = now(), updated_by = ${actorId}
          where id = '00000000-0000-0000-0000-000000000001'`;
        if (result.count === 0) throw new Error("No se pudo actualizar la contraseña del portal: la fila de configuración no existe");
        await new PostgresPorts(tx as unknown as Sql).append(audit);
      });
    },
  };
}
