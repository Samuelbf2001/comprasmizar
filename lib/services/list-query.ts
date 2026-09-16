import { DomainError, type PaymentMethod, type PaymentStatus } from "../domain";

/**
 * H3 (docs/plan-rendimiento.md, Fase 3): filtros y paginación por cursor compartidos por requisiciones,
 * órdenes, gastos y caja menor. Todos los campos son ADITIVOS — un `ListQuery` ausente (`undefined`)
 * en un repositorio preserva EXACTAMENTE el comportamiento actual (sin límite, sin filtros, con la
 * carga de ítems por lote donde ya existía). `status` no aplica a gastos/caja menor (esas tablas no
 * tienen columna de estado): sus adaptadores lo ignoran en vez de fallar, para no acoplar el contrato
 * compartido a lo que cada entidad sí puede filtrar. `from`/`to` son fechas `YYYY-MM-DD` sobre la
 * columna de fecha propia de cada entidad (ver el comentario en cada adaptador de
 * `postgres-repositories.ts`), inclusive en ambos extremos.
 */
export interface ListQuery {
  status?: string[];
  workId?: string;
  /** Centros de costo (2026-09-12): filtro adicional sobre la columna `centro_costo_id` — lo consumen
   *  `listVisibleExpenses` (gastos), `listVisibleRequisitions` (columna propia
   *  `requisiciones.centro_costo_id`, el centro EFECTIVO de la requisición) y, desde la adenda de pagos
   *  (RF-509, 2026-09-15), `listVisibleOrders` (el centro de la requisición dueña, el mismo que
   *  `Order.costCenterId`); caja menor lo ignora, igual que `status` no aplica a gastos/caja menor. */
  costCenterId?: string;
  /**
   * RF-509 (adenda de pagos, 2026-09-15): filtros del panel de órdenes — solo los consume
   * `listVisibleOrders`; el resto de entidades los ignora (mismo patrón aditivo que `approverId`).
   * `paymentMethod`: la orden tiene AL MENOS un pago vigente con ese medio (`efectivo` = caja).
   * `paymentStatus`: estado derivado (`paymentStatus()` en lib/domain/rules.ts, replicado en SQL).
   * `paidFrom`/`paidTo`: la orden tiene al menos un pago vigente con `fecha` en ese rango (inclusive) —
   * distinto de `from`/`to`, que en órdenes siguen filtrando por `fecha_generacion`. Medio = efectivo +
   * rango de fecha de pago es el cierre de caja (PRD §4.3).
   */
  paymentMethod?: PaymentMethod;
  paymentStatus?: PaymentStatus;
  paidFrom?: string;
  paidTo?: string;
  /** RF-509/RF-707 (adenda de pagos, N3): empresa facturada — `requisiciones.empresa_facturada_id` en
   *  requisiciones y órdenes (la de la requisición dueña), `gastos.empresa_facturada_id` (instantánea)
   *  en gastos; caja menor lo ignora. */
  billedCompanyId?: string;
  /** Cajas (2026-09-12): filtro adicional por `caja_id` — aplica a gastos, caja menor e ingresos;
   *  el resto de entidades lo ignora, mismo patrón aditivo que `costCenterId`. */
  cashBoxId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
  /**
   * RF-1301 (Reportes, reunión 2026-09-11): filtro por aprobador — solo lo consume
   * `listVisibleRequisitions` (cabecera O algún ítem, vía `public.es_aprobador_de`, la misma función
   * que ya resuelve la visibilidad por rol). Aditivo como el resto de este contrato: los adaptadores que
   * no lo soportan (órdenes, gastos, caja menor) lo ignoran en vez de fallar.
   */
  approverId?: string;
  /** RF-1301: filtro por etiqueta — hoy solo lo consume `listVisibleRequisitions`; ver nota de `approverId`. */
  tagId?: string;
}
/** Página de resultados de un `ListQuery`. `nextCursor` es `null` en la última página. */
export interface Page<T> { rows: T[]; nextCursor: string | null; }

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 200;
/** `limit` ya viene validado por zod en la ruta HTTP (entero 1-200); esto es una segunda red de
 *  seguridad para cualquier llamador interno (p. ej. el modo "filtrado sin paginar" de las rutas, que
 *  reutiliza el mismo camino paginado con un límite por defecto — ver lib/http/api.ts). */
export function pageLimit(limit?: number): number {
  if (!Number.isInteger(limit) || (limit as number) <= 0) return DEFAULT_PAGE_LIMIT;
  return Math.min(limit as number, MAX_PAGE_LIMIT);
}

const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Cursor opaco = base64url de "<valor ISO de la columna de orden>|<id>". Nunca lo interpretes fuera de
 * estas dos funciones: el cliente debe tratarlo como una cadena opaca, nunca como algo sobre lo que
 * pueda razonar o construir a mano. `at` es el valor ISO de la columna de orden ESTABLE (no nula) de
 * cada entidad — created_at para requisiciones, fecha_generacion para órdenes, fecha_orden para
 * gastos, fecha para caja menor — nunca una columna nullable: así la comparación de tupla
 * `(at, id) < (cursor_at, cursor_id)` es determinística en SQL sin casos NULL que romperían la
 * comparación de fila (ver nota GRAVE en postgres-repositories.ts sobre por qué gastos usa
 * fecha_orden y no la fecha de pago, nullable, para paginar).
 */
export function encodeCursor(at: string, id: string): string { return Buffer.from(`${at}|${id}`, "utf8").toString("base64url"); }
export function decodeCursor(cursor: string): { at: string; id: string } {
  let raw: string;
  try { raw = Buffer.from(cursor, "base64url").toString("utf8"); } catch { throw new DomainError("INVALID_INPUT", "Cursor inválido"); }
  const separatorIndex = raw.lastIndexOf("|");
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) throw new DomainError("INVALID_INPUT", "Cursor inválido");
  const at = raw.slice(0, separatorIndex), id = raw.slice(separatorIndex + 1);
  if (!CURSOR_ID_RE.test(id) || Number.isNaN(Date.parse(at))) throw new DomainError("INVALID_INPUT", "Cursor inválido");
  return { at, id };
}
