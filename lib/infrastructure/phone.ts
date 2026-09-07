/**
 * Normalización E.164-colombiana compartida por el canal WhatsApp (`public-access.ts`, RF-902) y el
 * CRUD de solicitantes autorizados (`postgres-repositories.ts`, vía `CatalogService`): ambos deben
 * comparar contra `solicitantes_autorizados.telefono_normalizado` con el MISMO criterio, o un maestro
 * de obra dado de alta desde el catálogo (formato "3001112233") queda fuera del canal en silencio
 * cuando WhatsApp entrega su número en E.164 ("573001112233"). Vive en su propio módulo (no dentro de
 * `public-access.ts`) para que `postgres-repositories.ts` pueda importarla sin crear un ciclo — `public-access.ts`
 * ya importa `sharedPostgres` desde `postgres-repositories.ts`.
 * DEBE coincidir exactamente con `public.normalizar_telefono_co` (columna generada, migración
 * 202609010001): un número local de 10 dígitos (móvil colombiano) se homologa anteponiendo "57";
 * cualquier otro largo se deja tal cual, solo sin los no-dígitos.
 */
export function normalizeCoPhone(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return digits.length === 10 ? `57${digits}` : digits;
}
