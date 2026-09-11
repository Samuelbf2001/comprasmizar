import { hmacSha256, safeEqual } from "./crypto";

/**
 * Firma de los enlaces del portal público. Módulo propio y sin dependencias de base de datos a
 * propósito: lo consumen tanto `lib/infrastructure/public-access.ts` como
 * `lib/infrastructure/postgres-repositories.ts`, y ese segundo par ya tiene un ciclo latente —
 * `public-access.ts` importa `sharedPostgres` de `postgres-repositories.ts` (misma razón por la que
 * `normalizeCoPhone` vive en `phone.ts`).
 *
 * Ámbito del enlace GENERAL: el enlace nació siendo por obra (el fragmento llevaba
 * `obra=<uuid>&token=HMAC(uuid)`) y obligaba a repartir uno distinto por cada obra. El cliente pidió
 * lo contrario — "debe ser un link general para montar las requisiciones" — así que ahora hay UN
 * enlace, firmado sobre este ámbito constante en vez de sobre un id de obra, y la obra se elige
 * dentro del formulario.
 */
/**
 * QUÉ PROTEGE EL PORTAL HOY (decisión de Ernesto, 2026-09-11): **la contraseña y el rate limit**.
 * Literal: «que el enlace no necesite un token, sea ruta pública». `/requisiciones/publica` abre sin
 * fragmento, y el token dejó de ser una barrera de entrada.
 *
 * Lo que el token sigue haciendo, y por lo que no se retira: **acotar a UNA obra**. Un enlace firmado
 * sobre un id de obra solo deja radicar contra esa; sin token, el solicitante elige entre las obras
 * habilitadas. Sirve para dar acceso a un contratista de una obra concreta.
 *
 * Consecuencia que conviene tener presente al tocar esto: sin token, una petición llega hasta la base
 * (no hay HMAC que la filtre gratis), así que los limitadores de `app/api/public/requisitions/route.ts`
 * pasaron de ser una defensa más a ser LA defensa. Viven en la memoria del proceso: se reinician en
 * cada despliegue y no se comparten entre réplicas.
 */
export const GENERAL_LINK_SCOPE = "portal-general";

export function generalLinkToken(pepper: string): string { return hmacSha256(GENERAL_LINK_SCOPE, pepper); }

/**
 * Un token vale si firma ESTA obra o si es el general. Los enlaces por obra siguen sirviendo: quien
 * ya tenga uno repartido no se queda fuera, y siguen siendo útiles para que alguien solo pueda
 * radicar contra una obra concreta.
 *
 * Comparación en tiempo constante y sin tocar la base: es el primer filtro del endpoint público y
 * tiene que salir barato para nosotros y caro de eludir (ver el comentario sobre el orden de las
 * comprobaciones en app/api/public/requisitions/route.ts).
 */
export function verifyPublicLinkToken(workId: string, linkToken: string, pepper: string): boolean {
  return safeEqual(hmacSha256(workId, pepper), linkToken) || safeEqual(generalLinkToken(pepper), linkToken);
}
