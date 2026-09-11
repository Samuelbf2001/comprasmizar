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
