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

/**
 * El destinatario de CUALQUIER mensaje saliente de WhatsApp. Los tres emisores —plantillas de texto
 * (kapso.ts), Flow y plantilla de aprobación (approval-flow-sender.ts) y Flow de captura
 * (flow-sender.ts)— pasan por aquí, para que nadie pueda mandar un `to` crudo.
 *
 * POR QUÉ EXISTE, medido el 11-sep-2026: `usuarios.telefono` guarda el número local tal cual
 * ("3002408743") y los emisores lo mandaban sin tocar. Kapso ACEPTA la llamada y devuelve un
 * `wamid` —así que la cola lo marcaba `enviado`— pero Meta lo descarta después con `failed`, y ese
 * fallo llega por un evento de estado al que el webhook no está suscrito. Resultado: ningún aviso
 * dirigido a un usuario de la plataforma llegaba, y el sistema decía que sí. Cinco envíos de ese día
 * a "3002408743" terminaron en `failed`; los dirigidos a "+573002408743" (portal y router), entregados.
 * Kapso llegó a tener dos conversaciones para la misma persona, "573002408743" y "3002408743".
 *
 * Es `normalizeCoPhone` sin adornos —un alias con nombre propio— porque el criterio tiene que ser
 * EXACTAMENTE el mismo que usa la lista blanca y la columna generada `normalizar_telefono_co`: si el
 * destino y la identidad se normalizaran distinto, un número podría ser válido para recibir y
 * desconocido para responder. Lo que aporta es el nombre: dice para qué sirve y dónde tiene que
 * usarse.
 *
 * Un número que no sea de 10 dígitos se deja como está, sin maquillar. Si está mal, que lo rechace
 * Meta y se vea, en vez de inventarle un indicativo y mandarlo a otra persona.
 */
export function destinatarioWhatsApp(phone: string): string {
  return normalizeCoPhone(phone);
}
