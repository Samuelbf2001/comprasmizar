import postgres, { type Sql } from "postgres";
import { DomainError, normalizeItemName, type Actor, type AuditEvent, type DashboardAmountByKey, type Expense, type ExpenseShare, type ItemLine, type Order, type OrderAdminStatus, type PettyCash, type Requisition, type RequisitionStatus, type Role } from "../domain";
import type { AuditRepository, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogRequester, CatalogSociety, CatalogSupplier, CatalogTag, CatalogItem, CatalogUser, CatalogUserCreate, ConsecutiveRepository, IdGenerator, ListQuery, Page, PublicAccessVerifier, ServiceDependencies, TransactionManager, TransactionRepositories } from "../services";
import { decodeCursor, encodeCursor, pageLimit } from "../services/list-query";
import { generalLinkToken, verifyPublicLinkToken } from "../security/public-link";
import { safeEqual } from "../security/crypto";
import { publicEnv, runtimeEnv } from "../security/env";
import { asJsonb } from "./jsonb";
// HUECO 1: mismo criterio de normalización que la columna generada telefono_normalizado (ver
// lib/infrastructure/phone.ts) — se usa en findRequesterDuplicate, más abajo.
import { normalizeCoPhone } from "./phone";

let sharedSql: Sql | undefined;
export function sharedPostgres(databaseUrl = runtimeEnv().DATABASE_URL): Sql { sharedSql ??= postgres(databaseUrl, { prepare: true, max: 10 }); return sharedSql; }

type DbRow = Record<string, unknown>;
const asNumber = (value: unknown) => Number(value ?? 0);
/**
 * Una columna `date` de Postgres llega como Date de JavaScript construido a medianoche
 * UTC. `String(fecha)` produce "Tue Aug 25 2026 19:00:00 GMT-0500", que ademas de no ser
 * un formato presentable muestra el DIA ANTERIOR en Colombia (GMT-5). Se toman los
 * componentes UTC para devolver siempre el mismo dia calendario que guarda la BD.
 * Devuelve `undefined` (no `""`) para NULL: con `requiredDate` ahora opcional, un `""` se colaría en
 * los rangos de filtro (`row.requiredDate >= dateFrom`) y en el PDF como si fuera una fecha real.
 */
const asIsoDate = (value: unknown): string | undefined => (value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? undefined : String(value));
/** H3: instante ISO completo de una columna `timestamptz` (created_at, fecha_generacion, updated_at) para
 *  codificar el cursor de paginación — a diferencia de `asIsoDate`, aquí SÍ es correcto usar `toISOString()`
 *  directo: un `timestamptz` es un instante absoluto, no una fecha de calendario, así que no sufre el
 *  corrimiento de día por zona horaria que `asIsoDate` existe para evitar. */
const toIsoInstant = (value: unknown): string => (value instanceof Date ? value : new Date(String(value))).toISOString();
const isElevated = (actor: Actor) => actor.roles.some((role) => ["revisor", "contabilidad", "admin_mizar", "admin_sixteam"].includes(role));
/** H3 (docs/plan-rendimiento.md): `calculateDashboard` (lib/domain/rules.ts) inicializa estas 6 claves en
 *  0 antes de contar; el agregado SQL de `dashboardByStatus` solo devuelve filas para estados con al
 *  menos una requisición, así que se parte siempre de esta plantilla para no dejar ninguna en `undefined`. */
const ZERO_BY_STATUS: Record<RequisitionStatus, number> = { enviada: 0, en_revision: 0, en_aprobacion: 0, aprobada: 0, devuelta: 0, declinada: 0 };
function item(row: DbRow): ItemLine {
  return {
    id: String(row.id), itemId: row.item_id ? String(row.item_id) : undefined, description: row.descripcion_libre ? String(row.descripcion_libre) : undefined,
    quantity: asNumber(row.cantidad), unit: String(row.unidad), possibleSupplier: row.posible_proveedor_texto ? String(row.posible_proveedor_texto) : undefined,
    productLink: row.link_producto ? String(row.link_producto) : undefined, finalSupplierId: row.proveedor_final_id ? String(row.proveedor_final_id) : undefined,
    unitBase: asNumber(row.valor_base), unitIva: asNumber(row.iva), unitTotal: asNumber(row.valor_base) + asNumber(row.iva),
    status: row.estado as ItemLine["status"], declineReason: row.motivo_declinacion ? String(row.motivo_declinacion) : undefined,
    ivaRate: row.iva_tasa != null ? asNumber(row.iva_tasa) : undefined, discountRate: row.descuento_tasa != null ? asNumber(row.descuento_tasa) : undefined,
  };
}
function requisition(row: DbRow, items: ItemLine[]): Requisition {
  return {
    id: String(row.id), consecutive: String(row.consecutivo), type: row.tipo as Requisition["type"], societyId: String(row.sociedad_id), workId: row.obra_id ? String(row.obra_id) : undefined,
    requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, externalRequester: row.solicitante_nombre_externo ? { name: String(row.solicitante_nombre_externo), phone: String(row.solicitante_telefono_externo ?? "") } : undefined,
    channel: row.canal as Requisition["channel"], requiredDate: asIsoDate(row.fecha_requerida), observations: row.observaciones ? String(row.observaciones) : undefined,
    tagId: row.etiqueta_id ? String(row.etiqueta_id) : undefined, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, status: row.estado as Requisition["status"],
    declineReason: row.motivo_declinacion ? String(row.motivo_declinacion) : undefined, returnReason: row.motivo_devolucion ? String(row.motivo_devolucion) : undefined,
    kapsoEventId: row.kapso_event_id ? String(row.kapso_event_id) : undefined, items, updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
    paymentTerms: row.forma_pago ? String(row.forma_pago) : undefined,
  };
}
// H3 (docs/plan-rendimiento.md): requisicion_consecutivo/requisicion_obra_id son alias deliberados (no
// "consecutivo"/"obra_id" a secas): `ordenes` ya tiene su PROPIA columna `consecutivo` (el consecutivo de
// la orden, p.ej. "OC-2026-0001") — sin el alias, el `select r.consecutivo ...` de la requisición dueña
// pisaría esa columna en la misma fila y `order(row)` leería el consecutivo equivocado en `consecutive`.
// Revisión (corrección tras QA): `requisicion_fecha_requerida` sigue el mismo patrón de alias por la
// misma razón (aunque hoy `ordenes` no tenga una columna `fecha_requerida` propia, es el nombre que ya
// usa `orderSelectColumns()` más abajo, para no tener que recordar dos convenciones distintas). `lines`
// NO necesita alias: es un alias de columna calculado (`json_agg(...) as lines`), no una columna real de
// ninguna de las dos tablas, así que no hay nada que pueda pisar.
function order(row: DbRow): Order {
  return {
    id: String(row.id), consecutive: String(row.consecutivo), type: row.tipo as Order["type"], requisitionId: String(row.requisicion_id), supplierId: row.proveedor_id ? String(row.proveedor_id) : undefined,
    itemIds: Array.isArray(row.item_ids) ? row.item_ids.map(String) : [], status: row.estado_cumplimiento as Order["status"],
    adminStatus: (row.estado_administrativo as OrderAdminStatus | undefined) ?? "pendiente", generatedAt: row.fecha_generacion ? new Date(String(row.fecha_generacion)).toISOString() : undefined,
    accountedAt: row.contabilizada_at ? new Date(String(row.contabilizada_at)).toISOString() : undefined, paidAt: row.pagada_at ? new Date(String(row.pagada_at)).toISOString() : undefined,
    paymentTerms: row.forma_pago ? String(row.forma_pago) : undefined, updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined,
    requisitionConsecutive: row.requisicion_consecutivo != null ? String(row.requisicion_consecutivo) : undefined,
    workId: row.requisicion_obra_id != null ? String(row.requisicion_obra_id) : undefined,
    // Revisión (corrección tras QA): `requiredDate`/`lines` restauran la columna "Valor" y el filtro por
    // fecha requerida de la pantalla de órdenes sin volver a descargar TODAS las requisiciones — ver el
    // comentario largo en `Order` (lib/domain/model.ts). `lines` reutiliza el mismo mapeador `item()` que
    // ya usa `requisicion(row, items)` arriba: cada elemento del `json_agg` trae exactamente las mismas
    // columnas crudas de `requisicion_items` (mismos nombres), así que no hace falta un mapeador aparte.
    // Ausentes (undefined) cuando la consulta no hizo el join (fakes de test, lecturas que no pasan por
    // orderSelectColumns()) — nunca `[]`/"" falsos que insinúen "sin fecha"/"sin ítems" cuando en realidad
    // es "no se preguntó".
    requiredDate: asIsoDate(row.requisicion_fecha_requerida),
    lines: Array.isArray(row.lines) ? (row.lines as DbRow[]).map(item) : undefined,
  };
}
// Reunión 2026-09: `fecha` (fecha de pago) y `periodo` (mes de `fecha`) son NULL en la BD mientras la
// orden que originó el gasto no se ha pagado — `asIsoDate` ya devuelve `undefined` para NULL, así que
// NO se fuerza `as string`: un gasto sin pagar debe poder representarse en memoria sin fecha de pago.
// `fecha_orden` (nace con el registro, NOT NULL en la BD) sí es obligatoria.
function expense(row: DbRow): Expense { return { id: String(row.id), workId: String(row.obra_id), origin: row.origen as Expense["origin"], referenceId: String(row.referencia_id), tagId: row.etiqueta_id ? String(row.etiqueta_id) : undefined, supplierId: row.proveedor_id ? String(row.proveedor_id) : undefined, orderDate: asIsoDate(row.fecha_orden) as string, date: asIsoDate(row.fecha), base: asNumber(row.valor_base), iva: asNumber(row.iva), total: asNumber(row.valor_total), period: asIsoDate(row.periodo)?.slice(0, 7) }; }
// `periodo` es una columna `date` (generada, ver migración core_compras): la librería `postgres` la
// entrega como Date, y `String(fecha)` da "Tue Sep 01 2026 ..." — el `.slice(0, 7)` anterior producía
// "Tue Sep" en vez de "2026-09", con lo que el filtro por periodo de la pantalla de gastos y el
// `periodExpense` del dominio nunca coincidían. `asIsoDate` ya resuelve Date/NULL igual que `fecha`.
function catalogRecord(kind: CatalogKind, row: DbRow): CatalogRecord {
  if (kind === "works") return { id: String(row.id), name: String(row.nombre), societyId: String(row.sociedad_id), active: row.estado === "activa" };
  if (kind === "tags") return { id: String(row.id), name: String(row.nombre), approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, active: row.activa === true };
  if (kind === "items") return { id: String(row.id), name: String(row.nombre), specification: row.especificacion ? String(row.especificacion) : undefined, unit: String(row.unidad_defecto), category: row.categoria ? String(row.categoria) : undefined, active: row.estado === "activo" };
  if (kind === "societies") return { id: String(row.id), name: String(row.nombre), nit: row.nit ? String(row.nit) : undefined, active: row.activa === true };
  // "roles" no es columna de `usuarios`: siempre se adjunta a la fila antes de llamar a este mapeador
  // (agregada por join/select aparte en get/create/update, ver más abajo).
  if (kind === "users") return { id: String(row.id), name: String(row.nombre), email: String(row.email), phone: row.telefono ? String(row.telefono) : undefined, active: row.estado === "activo", roles: Array.isArray(row.roles) ? row.roles.map(String) as Role[] : [] };
  // HUECO 1: solicitantes_autorizados (lista blanca global de WhatsApp, migración 202609010001).
  if (kind === "requesters") return { id: String(row.id), name: String(row.nombre), phone: String(row.telefono), active: row.activo === true };
  const contact = row.contacto && typeof row.contacto === "object" ? row.contacto as Record<string, unknown> : {};
  return { id: String(row.id), name: String(row.razon_social), nit: row.nit ? String(row.nit) : undefined, phone: typeof contact.phone === "string" ? contact.phone : undefined, email: typeof contact.email === "string" ? contact.email : undefined, address: typeof contact.address === "string" ? contact.address : undefined, active: row.activo === true };
}

/** Forma que exige la columna `auditoria.entidad_id` (uuid). Deliberadamente laxa con los nibbles
 * de versión y variante: lo que la base rechaza es lo que no tiene forma de uuid, no un v0. */
const AUDIT_ENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresPorts implements AuditRepository, ConsecutiveRepository, CatalogRepository {
  constructor(private readonly sql: Sql) {}
  // aprobador_id ya vive en requisiciones (reunión 2026-09: lo elige el revisor, no lo deriva la
  // etiqueta) — sin left join etiquetas para resolverlo, a diferencia de antes de
  // 202609070001_aprobador_elegido.sql.
  async getRequisition(id: string): Promise<Requisition | null> { const rows = await this.sql<DbRow[]>`select * from requisiciones where id = ${id}`; if (!rows[0]) return null; const items = await this.sql<DbRow[]>`select * from requisicion_items where requisicion_id = ${id} order by created_at`; return requisition(rows[0], items.map(item)); }
  // Upsert por línea + borrado selectivo (en vez de DELETE incondicional + reinserción): orden_items
  // tiene `requisicion_item_id references requisicion_items(id) on delete restrict`, así que borrar
  // TODAS las líneas de una requisición con órdenes ya generadas violaba esa FK y tumbaba cualquier
  // reguardado (incluida la sola edición de cabecera). El DELETE final solo se lleva los ids que ya
  // no están en la lista vigente; si esa FK igual revienta (línea ya facturada en una orden) se
  // traduce a un DomainError legible en vez de un 500.
  async saveRequisition(value: Requisition): Promise<void> {
    // societyId ausente (solo posible en el canal público, anclado a la obra) se traduce a NULL: el
    // trigger `requisiciones_0_derivar_sociedad` la deriva de obra_id ANTES del insert. `destino` ya no se
    // escribe desde el dominio (quedó obsoleto, fusionado en observaciones por la migración de Fase 1).
    // forma_pago y aprobador_id van también en el `on conflict do update`: si no, review() los asigna y
    // nunca se persisten (el mismo bug que ya existía con fecha_requerida y con obra_id antes de
    // arreglarse — ya van tres veces).
    await this.sql`insert into requisiciones (id, consecutivo, tipo, sociedad_id, obra_id, solicitante_id, solicitante_nombre_externo, solicitante_telefono_externo, canal, fecha_requerida, observaciones, etiqueta_id, aprobador_id, estado, motivo_declinacion, motivo_devolucion, forma_pago, kapso_event_id) values (${value.id}, ${value.consecutive}, ${value.type}, ${value.societyId ?? null}, ${value.workId ?? null}, ${value.requesterId ?? null}, ${value.externalRequester?.name ?? null}, ${value.externalRequester?.phone ?? null}, ${value.channel}, ${value.requiredDate || null}, ${value.observations ?? null}, ${value.tagId ?? null}, ${value.approverId ?? null}, ${value.status}, ${value.declineReason ?? null}, ${value.returnReason ?? null}, ${value.paymentTerms ?? null}, ${value.kapsoEventId ?? null}) on conflict (id) do update set obra_id = excluded.obra_id, etiqueta_id = excluded.etiqueta_id, aprobador_id = excluded.aprobador_id, estado = excluded.estado, motivo_declinacion = excluded.motivo_declinacion, motivo_devolucion = excluded.motivo_devolucion, observaciones = excluded.observaciones, fecha_requerida = excluded.fecha_requerida, forma_pago = excluded.forma_pago, kapso_event_id = coalesce(requisiciones.kapso_event_id, excluded.kapso_event_id), updated_at = now()`;
    // iva_tasa: NULL (no 0) cuando la línea no trae ivaRate. B2 (QA Postgres real): con `?? 0` una
    // línea legacy cuya tasa se restauró como `undefined` (defensa IVA legacy en review(), ver
    // procurement-service.ts) se reescribiría como 0 al guardar — el mismo bug que hizo nullable la
    // columna, pero ahora en la escritura en vez de la lectura. `?? null` preserva la distinción:
    // undefined -> NULL ("tasa sin capturar"), 0 explícito -> 0 ("tasa 0% real").
    for (const line of value.items) await this.sql`insert into requisicion_items (id, requisicion_id, item_id, descripcion_libre, cantidad, unidad, posible_proveedor_texto, link_producto, proveedor_final_id, valor_base, iva, iva_tasa, descuento_tasa, estado, motivo_declinacion) values (${line.id}, ${value.id}, ${line.itemId ?? null}, ${line.description ?? null}, ${line.quantity}, ${line.unit}, ${line.possibleSupplier ?? null}, ${line.productLink ?? null}, ${line.finalSupplierId ?? null}, ${line.unitBase ?? 0}, ${line.unitIva ?? 0}, ${line.ivaRate ?? null}, ${line.discountRate ?? 0}, ${line.status ?? "pendiente"}, ${line.declineReason ?? null}) on conflict (id) do update set item_id = excluded.item_id, descripcion_libre = excluded.descripcion_libre, cantidad = excluded.cantidad, unidad = excluded.unidad, posible_proveedor_texto = excluded.posible_proveedor_texto, link_producto = excluded.link_producto, proveedor_final_id = excluded.proveedor_final_id, valor_base = excluded.valor_base, iva = excluded.iva, iva_tasa = excluded.iva_tasa, descuento_tasa = excluded.descuento_tasa, estado = excluded.estado, motivo_declinacion = excluded.motivo_declinacion, updated_at = now()`;
    const ids = value.items.map((line) => line.id);
    try { await this.sql`delete from requisicion_items where requisicion_id = ${value.id} and id <> all(${ids}::uuid[])`; }
    catch (error) {
      // B1 (QA Postgres real, verificado contra embedded-postgres 18.4): orden_items_requisicion_item_id_fkey
      // es ON DELETE RESTRICT (ver 202608240001_core_compras.sql), y RESTRICT emite restrict_violation
      // (23001), NO foreign_key_violation (23503) — el `error.code === "23503"` original nunca se disparaba
      // contra Postgres real, así que un borrado bloqueado caía en el 500 genérico de abajo. NO ACTION (o
      // una FK diferida) sí emitiría 23503, de ahí que se acepten AMBOS códigos: no "simplificar" a uno
      // solo sin volver a romper esto.
      if (typeof error === "object" && error !== null && "code" in error && (error.code === "23001" || error.code === "23503") && "constraint_name" in error && error.constraint_name === "orden_items_requisicion_item_id_fkey") throw new DomainError("ORDER_LINE_LOCKED", "No se puede eliminar un ítem que ya está en una orden generada");
      throw error;
    }
  }
  async listRequisitions(): Promise<Requisition[]> { return this.listVisibleRequisitions({ id: "", roles: ["admin_sixteam"] }) as Promise<Requisition[]>; }
  // Los ítems se traen en UNA sola consulta con `any(...)` y se agrupan en memoria.
  // Antes se hacía una consulta por requisición (N+1): con la base en us-east-2 cada
  // viaje cuesta ~100 ms, así que 200 requisiciones eran ~200 viajes. Ahora son 2.
  // H3 (docs/plan-rendimiento.md, Fase 3): `query` opcional y aditivo. Sin `query`, exactamente el
  // comportamiento de siempre (sin límite). Con `query`, filtros + paginación por cursor en SQL —
  // devuelve `Page<Requisition>` (unión de retorno, ver el porqué en contracts.ts). El cast final en
  // `listRequisitions()` de arriba es seguro: esa llamada NUNCA pasa `query`, así que el resultado real
  // siempre es `Requisition[]`, aunque el tipo estático de este método sea la unión.
  async listVisibleRequisitions(actor: Actor, query?: ListQuery): Promise<Requisition[] | Page<Requisition>> {
    if (!query) {
      // Filtro de visibilidad del rol aprobador por r.aprobador_id directo (reunión 2026-09): ya no hace
      // falta el join con etiquetas para resolver ni para filtrar quién ve qué.
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select r.* from requisiciones r order by r.created_at desc` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select r.* from requisiciones r where r.aprobador_id=${actor.id} order by r.created_at desc` : await this.sql<DbRow[]>`select r.* from requisiciones r where r.solicitante_id=${actor.id} order by r.created_at desc`;
      if (!rows.length) return [];
      const ids = rows.map((row) => String(row.id));
      const itemRows = await this.sql<DbRow[]>`select * from requisicion_items where requisicion_id = any(${ids}::uuid[]) order by created_at`;
      const porRequisicion = new Map<string, ItemLine[]>();
      for (const row of itemRows) {
        const clave = String(row.requisicion_id);
        const lista = porRequisicion.get(clave);
        if (lista) lista.push(item(row));
        else porRequisicion.set(clave, [item(row)]);
      }
      return rows.map((row) => requisition(row, porRequisicion.get(String(row.id)) ?? []));
    }
    const limit = pageLimit(query.limit);
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const statusFilter = query.status?.length ? this.sql`and r.estado::text = any(${query.status})` : this.sql``;
    const workFilter = query.workId ? this.sql`and r.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and r.created_at >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and r.created_at < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (r.created_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select r.* from requisiciones r where true ${visibility} ${statusFilter} ${workFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by r.created_at desc, r.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows;
    const ids = pageRows.map((row) => String(row.id));
    const itemRows = ids.length ? await this.sql<DbRow[]>`select * from requisicion_items where requisicion_id = any(${ids}::uuid[]) order by created_at` : [];
    const porRequisicion = new Map<string, ItemLine[]>();
    for (const row of itemRows) { const clave = String(row.requisicion_id); const lista = porRequisicion.get(clave); if (lista) lista.push(item(row)); else porRequisicion.set(clave, [item(row)]); }
    const last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(toIsoInstant(last.created_at), String(last.id)) : null;
    return { rows: pageRows.map((row) => requisition(row, porRequisicion.get(String(row.id)) ?? [])), nextCursor };
  }
  // H3: cabeceras SIN ítems para el dashboard (RF-1102) — buildAttentionQueue/buildRecentActivity nunca
  // los usan (lib/domain/rules.ts), así que cargarlos aquí sería trabajo desperdiciado. `orderBy` por
  // defecto created_at (cola de atención, sin límite estricto salvo el tope defensivo); "updated_at"
  // es el que usa la actividad reciente, siempre con `limit` explícito.
  async listVisibleHeaders(actor: Actor, options: { status?: RequisitionStatus[]; orderBy?: "created_at" | "updated_at"; limit?: number } = {}): Promise<Requisition[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const statusFilter = options.status?.length ? this.sql`and r.estado::text = any(${options.status})` : this.sql``;
    const orderColumn = options.orderBy === "updated_at" ? this.sql`r.updated_at` : this.sql`r.created_at`;
    const limit = options.limit ?? 500;
    const rows = await this.sql<DbRow[]>`select r.* from requisiciones r where true ${visibility} ${statusFilter} order by ${orderColumn} desc, r.id desc limit ${limit}`;
    return rows.map((row) => requisition(row, []));
  }
  // H3: conteo por estado con la MISMA visibilidad de listVisibleRequisitions, para que dashboard() no
  // tenga que cargar la colección completa solo para contar (mismas 6 claves que calculateDashboard en
  // lib/domain/rules.ts — ZERO_BY_STATUS ya las inicializa en 0, el agregado solo llena las que aplican).
  async dashboardByStatus(actor: Actor): Promise<Record<RequisitionStatus, number>> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<{ estado: RequisitionStatus; total: string }[]>`select r.estado, count(*) as total from requisiciones r where true ${visibility} group by r.estado`;
    const byStatus: Record<RequisitionStatus, number> = { ...ZERO_BY_STATUS };
    for (const row of rows) byStatus[row.estado] = Number(row.total);
    return byStatus;
  }
  // El delete final de orden_items nunca puede violar orden_items_requisicion_item_id_fkey (esa FK
  // vive en esta misma tabla, no en la referenciada), así que no hace falta try/catch aquí: solo
  // limpia huérfanos cuando una orden se regenera con menos líneas.
  // estado_administrativo y forma_pago van en el `on conflict do update`: sin ellos el eje administrativo
  // (contabilizada/pagada) nunca sobreviviría a un reguardado posterior de la orden.
  async saveOrder(value: Order): Promise<void> {
    // fecha_generacion: MENOR (QA Postgres real) — antes esta columna nunca se escribía y quedaba
    // confiada al `default now()` de la BD, ignorando `value.generatedAt` (el reloj inyectado del
    // servicio, ver ProcurementService.generateOrders). `coalesce(..., now())` respeta ese valor
    // cuando viene informado y solo cae al default si alguna vez llega ausente.
    await this.sql`insert into ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento, estado_administrativo, fecha_generacion, contabilizada_at, pagada_at, forma_pago) values (${value.id}, ${value.consecutive}, ${value.type}, ${value.requisitionId}, ${value.supplierId ?? null}, ${value.status}, ${value.adminStatus}, coalesce(${value.generatedAt ?? null}::timestamptz, now()), ${value.accountedAt ?? null}, ${value.paidAt ?? null}, ${value.paymentTerms ?? null}) on conflict (id) do update set proveedor_id=excluded.proveedor_id, estado_cumplimiento=excluded.estado_cumplimiento, estado_administrativo=excluded.estado_administrativo, contabilizada_at=excluded.contabilizada_at, pagada_at=excluded.pagada_at, forma_pago=excluded.forma_pago, updated_at=now()`;
    for (const itemId of value.itemIds) await this.sql`insert into orden_items (orden_id, requisicion_item_id) values (${value.id}, ${itemId}) on conflict do nothing`;
    await this.sql`delete from orden_items where orden_id = ${value.id} and requisicion_item_id <> all(${value.itemIds}::uuid[])`;
  }
  // H3: todas las lecturas de orden hacen ahora `join requisiciones r` (INNER: requisicion_id es NOT
  // NULL) para traer requisicion_consecutivo/requisicion_obra_id en la misma fila (ver `order(row)`) —
  // la pantalla de órdenes dejaba de descargar TODAS las requisiciones solo para resolver esos dos
  // datos. `group by o.id, r.id` basta (sin listar r.consecutivo/r.obra_id): Postgres permite omitir del
  // GROUP BY columnas funcionalmente dependientes de la llave primaria de una tabla ya agrupada por ella.
  // Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): `orderSelectColumns()`/
  // `orderFromJoins()` extraen las columnas y los joins comunes a las 5 lecturas de abajo (antes
  // repetidos literalmente en cada una) para sumar, en el MISMO SELECT, `requisicion_fecha_requerida` y
  // `lines` (json_agg de `requisicion_items`) — ver los comentarios largos junto a `order(row)` y junto a
  // `Order` en lib/domain/model.ts. `listAttentionCandidates`/`listOrdersRecentlyUpdated`, más abajo, NO
  // usan este fragmento: alimentan el dashboard (RF-1102), que no consume ni `requiredDate` ni `lines`,
  // así que agregarles el `json_agg` sería trabajo desperdiciado en cada carga del dashboard.
  private orderSelectColumns() {
    // BLOQUEANTE 1 (QA 2026-08-31): `lines` solo transporta las columnas CRUDAS de `requisicion_items`
    // (los mismos nombres que ya lee `item(row)`, arriba) — ningún total se calcula aquí; sigue viviendo
    // en `calculateLineTotal`/`sumLines` (lib/domain/rules.ts), la única fuente de verdad también usada
    // por el PDF. `filter (where ri.id is not null)` deja `lines: '[]'` en vez de una fila fantasma con
    // todo NULL cuando la orden no tiene (o no debería tener) ítems.
    return this.sql`o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, r.fecha_requerida as requisicion_fecha_requerida, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids, coalesce(json_agg(json_build_object('id', ri.id, 'item_id', ri.item_id, 'descripcion_libre', ri.descripcion_libre, 'cantidad', ri.cantidad, 'unidad', ri.unidad, 'posible_proveedor_texto', ri.posible_proveedor_texto, 'link_producto', ri.link_producto, 'proveedor_final_id', ri.proveedor_final_id, 'valor_base', ri.valor_base, 'iva', ri.iva, 'estado', ri.estado, 'motivo_declinacion', ri.motivo_declinacion, 'iva_tasa', ri.iva_tasa, 'descuento_tasa', ri.descuento_tasa) order by ri.created_at) filter (where ri.id is not null), '[]') as lines`;
  }
  // `ri` cuelga del mismo `left join orden_items oi` que ya resolvía `item_ids`: si algún día ambos joins
  // dejan de compartir la misma fila, `lines` y `item_ids` dejarían de corresponder al mismo conjunto de
  // ítems — no separar esta cadena sin revisar ese acoplamiento.
  private orderFromJoins() {
    return this.sql`from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id left join requisicion_items ri on ri.id=oi.requisicion_item_id`;
  }
  async listOrders(): Promise<Order[]> { const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} group by o.id, r.id`; return rows.map(order); }
  async listVisibleOrders(actor: Actor, query?: ListQuery): Promise<Order[] | Page<Order>> {
    if (!query) {
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} group by o.id, r.id` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where r.aprobador_id=${actor.id} group by o.id, r.id` : await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where r.solicitante_id=${actor.id} group by o.id, r.id`;
      return rows.map(order);
    }
    // H3: fragmentos condicionales anidados (misma técnica documentada en el README de `postgres`, ver
    // "Building queries" — sql`` vacío para el caso "sin filtro"). Orden estable fecha_generacion desc,
    // id desc: mismas columnas que `ordenes_requisicion_idx`/`ordenes_estado_idx` ya usan, más id como
    // desempate para que el cursor sea determinístico con fecha_generacion repetida.
    const limit = pageLimit(query.limit);
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const statusFilter = query.status?.length ? this.sql`and o.estado_cumplimiento::text = any(${query.status})` : this.sql``;
    const workFilter = query.workId ? this.sql`and r.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and o.fecha_generacion >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and o.fecha_generacion < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (o.fecha_generacion, o.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where true ${visibility} ${statusFilter} ${workFilter} ${fromFilter} ${toFilter} ${cursorFilter} group by o.id, r.id order by o.fecha_generacion desc, o.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(toIsoInstant(last.fecha_generacion), String(last.id)) : null;
    return { rows: pageRows.map(order), nextCursor };
  }
  async listByRequisition(requisitionId: string): Promise<Order[]> { const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where o.requisicion_id=${requisitionId} group by o.id, r.id`; return rows.map(order); }
  async getOrder(id: string): Promise<Order | null> { const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where o.id=${id} group by o.id, r.id`; return rows[0] ? order(rows[0]) : null; }
  // H3: candidatos acotados para el dashboard (RF-1102) — superconjunto de lo que buildAttentionQueue
  // podría necesitar para CUALQUIER rol (revisor: estado_cumplimiento generada/no_cumplida; contabilidad:
  // estado_administrativo pendiente, salvo no_necesario — assertAdminTransition ya la excluye de
  // contabilizar/pagar para siempre). Tope de 500 filas: protege el peor caso sin fingir que hace falta
  // paginar una cola de atención, que por diseño es pequeña.
  async listAttentionCandidates(actor: Actor): Promise<Order[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id where (o.estado_cumplimiento in ('generada', 'no_cumplida') or (o.estado_administrativo = 'pendiente' and o.estado_cumplimiento <> 'no_necesario')) ${visibility} group by o.id, r.id order by o.fecha_generacion desc limit 500`;
    return rows.map(order);
  }
  // H3: las `limit` órdenes visibles más recientes por `updated_at`, para buildRecentActivity. Nombrado
  // "listOrdersRecentlyUpdated" (no "listRecentlyUpdated" a secas) para no chocar con el método
  // homónimo de gastos más abajo en esta misma clase — cada uno se expone bajo el mismo nombre
  // `listRecentlyUpdated` pero en su propia interfaz (OrderRepository/ExpenseRepository, ver el
  // `.bind()` en `transactionRepositories`/`createPostgresDependencies`).
  async listOrdersRecentlyUpdated(actor: Actor, limit: number): Promise<Order[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id where true ${visibility} group by o.id, r.id order by o.updated_at desc, o.id desc limit ${limit}`;
    return rows.map(order);
  }
  // H3: mismo criterio que `calculateDashboard` (lib/domain/rules.ts) para pendingOrders — estado_cumplimiento
  // en generada|no_cumplida — resuelto en SQL con la misma visibilidad por actor que listVisibleOrders.
  async dashboardPendingCount(actor: Actor): Promise<number> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<{ total: string }[]>`select count(*) as total from ordenes o join requisiciones r on r.id=o.requisicion_id where o.estado_cumplimiento in ('generada', 'no_cumplida') ${visibility}`;
    return Number(rows[0]?.total ?? 0);
  }
  // `fecha` (fecha de pago) viaja nullable: un gasto recién nacido de una orden generada (aún sin
  // pagar) se guarda con `date` ausente en memoria -> NULL en la BD -> `periodo` NULL (columna
  // generada). `fecha_orden` sí siempre viaja (obligatoria en el dominio).
  async saveExpense(value: Expense): Promise<void> { await this.sql`insert into gastos (id, obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva) values (${value.id}, ${value.workId}, ${value.origin}, ${value.referenceId}, ${value.tagId ?? null}, ${value.supplierId ?? null}, ${value.orderDate}, ${value.date ?? null}, ${value.base}, ${value.iva}) on conflict (origen, referencia_id) do nothing`; }
  // Único método que actualiza `gastos.fecha` de un gasto ya existente: `saveExpense` inserta con `on
  // conflict do nothing` a propósito (no reescribe un gasto ya guardado), así que no sirve para fijar
  // la fecha de pago cuando `updateOrderAdminStatus(..., "pagada")` la conoce. Solo aplica a
  // `origen = 'requisicion'`: la caja menor nace pagada y su `fecha` la gobierna
  // `sincronizar_gasto_caja_menor` (trigger), no este método.
  // GRAVE (QA reasignación): `returning id` + `.length` es la única forma de saber si el UPDATE tocó
  // algo — sin esto, marcar "pagada" una orden sin gasto propio (estado inconsistente que no debería
  // existir, pero contabilizada/pagada son ejes independientes del cumplimiento) quedaba en silencio.
  async markExpensePaid(referenceId: string, date: string): Promise<number> { const rows = await this.sql<{ id: string }[]>`update gastos set fecha = ${date} where origen = 'requisicion' and referencia_id = ${referenceId} returning id`; return rows.length; }
  // GRAVE 2 (QA reasignación): una orden `contabilizada` que pasa a `no_necesario` debe poder anular su
  // gasto (aún sin pagar) por completo, no dejarlo huérfano sin fecha para siempre. El reparto
  // (`gastos_reparto`, FK `on delete restrict` hacia `gastos`) se borra PRIMERO — si no, el DELETE de
  // `gastos` revienta esa FK. Ambos DELETE corren sobre `this.sql`, que ya es la conexión transaccional
  // del llamador (ver PostgresTransactionManager): no hace falta un `.begin()` propio, y el trigger
  // diferido `gastos_reparto_cuadra` solo se evalúa al COMMIT de esa transacción externa.
  async deleteExpenseByReference(origin: Expense["origin"], referenceId: string): Promise<void> {
    await this.sql`delete from gastos_reparto where gasto_id in (select id from gastos where origen=${origin} and referencia_id=${referenceId})`;
    await this.sql`delete from gastos where origen=${origin} and referencia_id=${referenceId}`;
  }
  async getExpense(id: string): Promise<Expense | null> { const rows = await this.sql<DbRow[]>`select * from gastos where id=${id}`; return rows[0] ? expense(rows[0]) : null; }
  async saveShares(shares: ExpenseShare[]): Promise<void> { if (!shares.length) return; await this.sql`delete from gastos_reparto where gasto_id=${shares[0].expenseId}`; for (const share of shares) await this.sql`insert into gastos_reparto (gasto_id, obra_id, valor) values (${share.expenseId}, ${share.workId}, ${share.amount})`; }
  async listExpenses(): Promise<Expense[]> { return (await this.sql<DbRow[]>`select * from gastos`).map(expense); }
  // H3: `query` opcional y aditivo — mismo contrato que listVisibleRequisitions/listVisibleOrders.
  // `status` de ListQuery NO aplica a gastos (no hay columna de estado en `gastos`): se ignora a
  // propósito en vez de fallar, ver el comentario de ListQuery en lib/services/list-query.ts.
  // NOTA para el revisor: la paginación de gastos ordena por `fecha_orden` (nace con el registro, NUNCA
  // nula) en vez de `fecha` (fecha de PAGO, nula mientras la orden no se ha pagado) — un cursor de
  // teclado sobre una columna nullable rompe la comparación de tupla `(a,b) < (cursor)` en SQL (NULL
  // hace que la fila entera compare a UNKNOWN, nunca "menor que"), así que ordenar/paginar por `fecha`
  // dejaría FUERA para siempre cualquier compromiso sin pagar. `from`/`to` sí filtran sobre `fecha`
  // (fecha de pago), tal como se pidió: un rango de fechas sobre "cuándo se pagó" es la pregunta de
  // negocio real, y excluye a los no pagados de forma correcta (no accidental).
  async listVisibleExpenses(actor: Actor, query?: ListQuery): Promise<Expense[] | Page<Expense>> {
    if (!query) {
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select * from gastos` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id where r.aprobador_id=${actor.id}` : await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id where r.solicitante_id=${actor.id}`;
      return rows.map(expense);
    }
    const limit = pageLimit(query.limit);
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const workFilter = query.workId ? this.sql`and g.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and g.fecha >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and g.fecha < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (g.fecha_orden, g.id) < (${cursor.at}::date, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select g.* from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility} ${workFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by g.fecha_orden desc, g.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(asIsoDate(last.fecha_orden) as string, String(last.id)) : null;
    return { rows: pageRows.map(expense), nextCursor };
  }
  async listByReference(referenceId: string): Promise<Expense[]> { return (await this.sql<DbRow[]>`select g.* from gastos g where g.referencia_id=${referenceId} or exists (select 1 from ordenes o where o.id=g.referencia_id and o.requisicion_id=${referenceId})`).map(expense); }
  // H3: agregados en SQL que reproducen exactamente calculateDashboard/groupExpenseByWork/
  // groupExpenseByTag/groupExpenseByPeriod (lib/domain/rules.ts) sobre la MISMA visibilidad por actor
  // que listVisibleExpenses (join a ordenes/requisiciones para aprobador/solicitante; sin filtro para
  // elevados). `g.periodo = (period || '-01')::date` en vez de `to_char(...) = period`: compara
  // directamente contra la columna (permite usar los índices existentes sobre `periodo`); el `to_char`
  // solo se usa para FORMATEAR la clave de salida de expenseByPeriod, nunca en un WHERE.
  async dashboardAggregates(actor: Actor, period: string): Promise<{ periodExpense: number; inProcessValue: number; expenseByWork: DashboardAmountByKey[]; expenseByTag: DashboardAmountByKey[]; expenseByPeriod: DashboardAmountByKey[] }> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const periodStart = `${period}-01`;
    const totalsRows = await this.sql<{ period_expense: string; in_process_value: string }[]>`select coalesce(sum(g.valor_total) filter (where g.periodo = ${periodStart}::date), 0) as period_expense, coalesce(sum(g.valor_total) filter (where g.fecha is null), 0) as in_process_value from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility}`;
    const byWorkRows = await this.sql<{ key: string; total: string }[]>`select g.obra_id as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.fecha is not null ${visibility} group by g.obra_id order by total desc`;
    const byTagRows = await this.sql<{ key: string | null; total: string }[]>`select g.etiqueta_id as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.fecha is not null ${visibility} group by g.etiqueta_id order by total desc`;
    // order by periodo desc limit 6, invertido en JS: mismo resultado final que groupExpenseByPeriod
    // (que ordena cronológico ascendente y se queda con los últimos `monthsBack`).
    const byPeriodRows = await this.sql<{ key: string; total: string }[]>`select to_char(g.periodo, 'YYYY-MM') as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.periodo is not null ${visibility} group by g.periodo order by g.periodo desc limit 6`;
    const totals = totalsRows[0];
    return {
      periodExpense: asNumber(totals?.period_expense), inProcessValue: asNumber(totals?.in_process_value),
      expenseByWork: byWorkRows.map((row) => ({ key: String(row.key), total: asNumber(row.total) })),
      expenseByTag: byTagRows.map((row) => ({ key: row.key ? String(row.key) : "", total: asNumber(row.total) })),
      expenseByPeriod: byPeriodRows.map((row) => ({ key: row.key, total: asNumber(row.total) })).reverse(),
    };
  }
  // H3: los `limit` gastos visibles más recientes, para buildRecentActivity — mismo fallback que la
  // función de dominio (`expense.date ?? expense.orderDate`): coalesce(fecha, fecha_orden) desc.
  // Nombrado "listExpensesRecentlyUpdated" para no chocar con el de órdenes — ver esa nota.
  async listExpensesRecentlyUpdated(actor: Actor, limit: number): Promise<Expense[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and r.aprobador_id = ${actor.id}` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select g.* from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility} order by coalesce(g.fecha, g.fecha_orden) desc, g.id desc limit ${limit}`;
    return rows.map(expense);
  }
  async savePettyCash(value: PettyCash): Promise<Expense> { const inserted = await this.sql<DbRow[]>`insert into caja_menor (id, obra_id, fecha, concepto, etiqueta_id, valor, registrado_por) values (${value.id}, ${value.workId}, ${value.date}, ${value.concept}, ${value.tagId}, ${value.amount}, ${value.registeredBy}) returning gasto_id`; const expenseRows = await this.sql<DbRow[]>`select * from gastos where id=${String(inserted[0]?.gasto_id ?? "")}`; if (!expenseRows[0]) throw new Error("PETTY_CASH_EXPENSE_MISSING"); return expense(expenseRows[0]); }
  // H3: `query` opcional y aditivo, mismo contrato que los demás. Caja menor no tiene visibilidad por
  // actor (ver PettyCashRepository en contracts.ts), así que solo filtra/pagina, sin fragmento de
  // visibilidad. `fecha` es NOT NULL aquí (se paga en el acto, reunión 2026-09): a diferencia de
  // gastos, filtrar/paginar por la misma columna `fecha` no tiene el problema de NULLs del cursor.
  async listPettyCash(query?: ListQuery): Promise<PettyCash[] | Page<PettyCash>> {
    const mapRow = (row: DbRow) => ({ id: String(row.id), workId: String(row.obra_id), date: asIsoDate(row.fecha) as string, concept: String(row.concepto), tagId: String(row.etiqueta_id), amount: asNumber(row.valor), registeredBy: String(row.registrado_por) });
    if (!query) { const rows = await this.sql<DbRow[]>`select * from caja_menor`; return rows.map(mapRow); }
    const limit = pageLimit(query.limit);
    const workFilter = query.workId ? this.sql`and c.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and c.fecha >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and c.fecha < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (c.fecha, c.id) < (${cursor.at}::date, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select c.* from caja_menor c where true ${workFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by c.fecha desc, c.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(asIsoDate(last.fecha) as string, String(last.id)) : null;
    return { rows: pageRows.map(mapRow), nextCursor };
  }
  // `auditoria.entidad_id` es de tipo `uuid` y `AuditEvent.entityId` es `string`: nada impide pasarle
  // una etiqueta. Cuando pasa, Postgres lanza 22P02 — pero lo hace DESPUÉS de que la escritura que se
  // está auditando ya ocurrió, y el error que llega arriba ("invalid input syntax for type uuid") no
  // apunta ni de lejos al sitio donde alguien escribió el literal. Eso costó semanas de 500 en el
  // endpoint de la contraseña del portal.
  //
  // Esta comprobación es la que cubre TODOS los caminos: un literal en el objeto, un argumento
  // posicional, una variable, un valor que llega de fuera. El escáner de
  // tests/unit/auditoria-entity-id.test.ts solo ve los literales, y siempre irá por detrás.
  async append(event: AuditEvent): Promise<void> { if (!AUDIT_ENTITY_ID_RE.test(event.entityId)) throw new Error(`AUDIT_ENTITY_ID_INVALIDO: "${event.entityId}" no es un uuid (entidad "${event.entity}", evento "${event.event}")`); await this.sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values (${event.entity}, ${event.entityId}, ${event.event.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}, ${event.origin ?? "web"}, ${event.actorId ?? null}, ${event.at.toISOString()}, ${asJsonb(this.sql, event.data ?? {})})`; }
  async list(entity: string, entityId: string): Promise<AuditEvent[]> { const rows = await this.sql<DbRow[]>`select entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json from auditoria where entidad=${entity} and entidad_id=${entityId} order by fecha, id`; return rows.map((row) => ({ entity: String(row.entidad), entityId: String(row.entidad_id), event: String(row.evento).toLocaleLowerCase(), actorId: row.usuario_id ? String(row.usuario_id) : undefined, at: new Date(String(row.fecha)), data: row.datos_json && typeof row.datos_json === "object" ? row.datos_json as Record<string, unknown> : {}, origin: row.origen as AuditEvent["origin"] })); }
  async take(prefix: "REQ" | "OC" | "OP", year: number): Promise<string> { const rows = await this.sql<DbRow[]>`insert into consecutivos (tipo_documento, anio, siguiente) values (${prefix}, ${year}, 2) on conflict (tipo_documento, anio) do update set siguiente=consecutivos.siguiente+1 returning siguiente-1 as value`; return `${prefix}-${year}-${String(rows[0].value).padStart(4, "0")}`; }
  async isEnabled(name: string): Promise<boolean> { const rows = await this.sql<{ activo: boolean }[]>`select activo from modulos where nombre=${name}`; return rows[0]?.activo === true; }
  async propose(description: string, unit: string, createdBy?: string): Promise<{ id: string; created: boolean }> { const normalized = normalizeItemName(description); const rows = await this.sql<{ id: string; created: boolean }[]>`with inserted as (insert into items(nombre, nombre_normalizado, unidad_defecto, estado, creado_por) values (${description}, ${normalized}, ${unit}, 'pendiente_normalizacion', ${createdBy ?? null}) on conflict (nombre_normalizado) do nothing returning id) select id, true as created from inserted union all select id, false as created from items where nombre_normalizado=${normalized} and not exists (select 1 from inserted) limit 1`; if (!rows[0]) throw new Error("ITEM_PROPOSAL_FAILED"); return rows[0]; }
  async enqueue(notification: { userId?: string; phone?: string; channel: "whatsapp" | "interno"; template: string; payload: Record<string, unknown> }): Promise<void> { await this.sql`insert into notificaciones (usuario_id, telefono_destino, canal, plantilla, payload) values (${notification.userId ?? null}, ${notification.phone ?? null}, ${notification.channel}, ${notification.template}, ${asJsonb(this.sql, notification.payload)})`; }
  async create(kind: CatalogKind, value: Omit<CatalogRecord, "id">): Promise<CatalogRecord> {
    let rows: DbRow[];
    if (kind === "works") { const work = value as Extract<CatalogRecord, { societyId: string }>; rows = await this.sql<DbRow[]>`insert into obras (nombre, sociedad_id, estado) values (${work.name}, ${work.societyId}, ${work.active ? "activa" : "cerrada"}) returning *`; }
    else if (kind === "tags") { const tag = value as CatalogTag; rows = await this.sql<DbRow[]>`insert into etiquetas (nombre, aprobador_id, activa) values (${tag.name}, ${tag.approverId ?? null}, ${tag.active}) returning *`; }
    else if (kind === "items") { const itemValue = value as Extract<CatalogRecord, { unit: string }>; rows = await this.sql<DbRow[]>`insert into items (nombre, nombre_normalizado, especificacion, unidad_defecto, categoria, estado) values (${itemValue.name}, ${normalizeItemName(itemValue.name)}, ${itemValue.specification ?? null}, ${itemValue.unit}, ${itemValue.category ?? null}, ${itemValue.active ? "activo" : "inactivo"}) returning *`; }
    else if (kind === "societies") { const society = value as CatalogSociety; rows = await this.sql<DbRow[]>`insert into sociedades (nombre, nit, activa) values (${society.name}, ${society.nit ?? null}, ${society.active}) returning *`; }
    else if (kind === "users") {
      // Alta de usuarios (2026-09-11): la plataforma CREA la cuenta de acceso. Antes solo vinculaba
      // un id que ya existiera en `auth.users` porque de crearlo se encargaba el panel de Supabase;
      // al salir de Supabase ese panel desapareció y no quedaba forma de dar de alta a nadie.
      //
      // Las tres escrituras van en la misma transacción (`this.sql` ya lo es cuando el llamador es
      // CatalogService): una cuenta sin fila en `usuarios`, o un usuario sin roles, son estados que
      // nadie puede arreglar desde la interfaz.
      const user = value as CatalogUserCreate;
      // La contraseña se convierte a bcrypt DENTRO de la base (`extensions.crypt`), igual que en el
      // resto del repo: así el texto en claro no pasa por el log de consultas ni vive en memoria del
      // proceso más de lo imprescindible. Coste 12, el mismo que usa el cambio de contraseña.
      const auth = await this.sql<DbRow[]>`
        insert into auth.users (aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data)
        values ('authenticated', 'authenticated', ${user.email}, extensions.crypt(${user.password}, extensions.gen_salt('bf', 12)), now(),
                ${asJsonb(this.sql, { provider: "email", providers: ["email"] })}, ${asJsonb(this.sql, {})})
        returning id`;
      const id = String(auth[0].id);
      rows = await this.sql<DbRow[]>`insert into usuarios (id, nombre, email, telefono, estado) values (${id}, ${user.name}, ${user.email}, ${user.phone ?? null}, ${user.active ? "activo" : "inactivo"}) returning *`;
      for (const rol of user.roles) await this.sql`insert into usuario_roles (usuario_id, rol) values (${id}, ${rol}) on conflict do nothing`;
      return catalogRecord(kind, { ...rows[0], roles: [...user.roles] });
    }
    else if (kind === "requesters") { const requester = value as CatalogRequester; rows = await this.sql<DbRow[]>`insert into solicitantes_autorizados (nombre, telefono, activo) values (${requester.name}, ${requester.phone}, ${requester.active}) returning *`; }
    else { const supplier = value as CatalogSupplier; rows = await this.sql<DbRow[]>`insert into proveedores (razon_social, nit, contacto, activo) values (${supplier.name}, ${supplier.nit ?? null}, ${asJsonb(this.sql, { ...(supplier.phone ? { phone: supplier.phone } : {}), ...(supplier.email ? { email: supplier.email } : {}), ...(supplier.address ? { address: supplier.address } : {}) })}, ${supplier.active}) returning *`; }
    return catalogRecord(kind, rows[0]);
  }
  async get(kind: CatalogKind, id: string): Promise<CatalogRecord | null> {
    if (kind === "users") { const rows = await this.sql<DbRow[]>`select u.*, coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles from usuarios u left join usuario_roles ur on ur.usuario_id = u.id where u.id = ${id} group by u.id`; return rows[0] ? catalogRecord(kind, rows[0]) : null; }
    const table = kind === "works" ? "obras" : kind === "tags" ? "etiquetas" : kind === "items" ? "items" : kind === "societies" ? "sociedades" : kind === "requesters" ? "solicitantes_autorizados" : "proveedores";
    const rows = await this.sql.unsafe<DbRow[]>(`select * from ${table} where id = $1`, [id]);
    return rows[0] ? catalogRecord(kind, rows[0]) : null;
  }
  async update(kind: CatalogKind, id: string, value: CatalogPatchRecord): Promise<CatalogRecord> {
    let rows: DbRow[];
    if (kind === "works") {
      const work = value as Partial<Extract<CatalogRecord, { societyId: string }>>;
      // Los ${x ?? null} dentro de `case when ... is null` van con cast explícito: un NULL sin tipo
      // en esa posición (a diferencia de coalesce, que infiere del otro argumento) dispara
      // 42P18 "could not determine data type of parameter" contra Postgres real.
      rows = await this.sql<DbRow[]>`update obras set nombre=coalesce(${work.name ?? null}, nombre), sociedad_id=coalesce(${work.societyId ?? null}, sociedad_id), estado=case when ${work.active ?? null}::boolean is null then estado when ${work.active ?? false} then 'activa' else 'cerrada' end where id=${id} returning *`;
    } else if (kind === "tags") {
      const tag = value as Partial<CatalogTag>, hasApprover = Object.hasOwn(tag, "approverId");
      rows = await this.sql<DbRow[]>`update etiquetas set nombre=coalesce(${tag.name ?? null}, nombre), aprobador_id=case when ${hasApprover} then ${tag.approverId ?? null} else aprobador_id end, activa=coalesce(${tag.active ?? null}, activa) where id=${id} returning *`;
    } else if (kind === "items") {
      const itemValue = value as Partial<CatalogItem>, name = itemValue.name ?? null, hasSpecification = Object.hasOwn(itemValue, "specification"), hasCategory = Object.hasOwn(itemValue, "category");
      rows = await this.sql<DbRow[]>`update items set nombre=coalesce(${name}, nombre), nombre_normalizado=case when ${name}::text is null then nombre_normalizado else ${normalizeItemName(name ?? "")} end, especificacion=case when ${hasSpecification} then ${itemValue.specification ?? null} else especificacion end, unidad_defecto=coalesce(${itemValue.unit ?? null}, unidad_defecto), categoria=case when ${hasCategory} then ${itemValue.category ?? null} else categoria end, estado=case when ${itemValue.active ?? null}::boolean is null then estado when ${itemValue.active ?? false} then 'activo' else 'inactivo' end where id=${id} returning *`;
    } else if (kind === "societies") {
      const society = value as Partial<CatalogSociety>, hasNit = Object.hasOwn(society, "nit");
      rows = await this.sql<DbRow[]>`update sociedades set nombre=coalesce(${society.name ?? null}, nombre), nit=case when ${hasNit} then ${society.nit ?? null} else nit end, activa=coalesce(${society.active ?? null}, activa) where id=${id} returning *`;
    } else if (kind === "users") {
      const userPatch = value as Partial<CatalogUser>, hasPhone = Object.hasOwn(userPatch, "phone");
      // El trigger usuarios_baja_etiquetas_activas puede rechazar este UPDATE (errcode 23514) si el
      // usuario sigue siendo aprobador de una etiqueta activa; CatalogService.conflict lo traduce.
      rows = await this.sql<DbRow[]>`update usuarios set nombre=coalesce(${userPatch.name ?? null}, nombre), telefono=case when ${hasPhone} then ${userPatch.phone ?? null} else telefono end, estado=case when ${userPatch.active ?? null}::boolean is null then estado when ${userPatch.active ?? false} then 'activo' else 'inactivo' end where id=${id} returning *`;
      if (!rows[0]) throw new Error("CATALOG_NOT_FOUND");
      // Los roles de un patch representan el conjunto final deseado (no un incremento): se
      // calcula el diff contra usuario_roles y cada DELETE dispara validar_retiro_ultimo_rol_aprobador.
      if (Object.hasOwn(userPatch, "roles")) {
        const desired = [...(userPatch.roles ?? [])];
        const current = (await this.sql<{ rol: string }[]>`select rol from usuario_roles where usuario_id=${id}`).map((row) => row.rol);
        for (const rol of desired) if (!current.includes(rol)) await this.sql`insert into usuario_roles (usuario_id, rol) values (${id}, ${rol}) on conflict do nothing`;
        for (const rol of current) if (!desired.includes(rol as Role)) await this.sql`delete from usuario_roles where usuario_id=${id} and rol=${rol}`;
      }
      const finalRoles = (await this.sql<{ rol: string }[]>`select rol from usuario_roles where usuario_id=${id}`).map((row) => row.rol);
      return catalogRecord(kind, { ...rows[0], roles: finalRoles });
    } else if (kind === "requesters") {
      // HUECO 1: a diferencia de proveedores/usuarios, `telefono` es NOT NULL (no tiene sentido un
      // solicitante sin teléfono), así que un `coalesce` simple basta: nunca se envía null aquí porque
      // CatalogPatchRecord no admite `phone: null` para este kind (ver contracts.ts).
      const requester = value as Partial<CatalogRequester>;
      rows = await this.sql<DbRow[]>`update solicitantes_autorizados set nombre=coalesce(${requester.name ?? null}, nombre), telefono=coalesce(${requester.phone ?? null}, telefono), activo=coalesce(${requester.active ?? null}, activo) where id=${id} returning *`;
    } else {
      const supplier = value as Partial<CatalogSupplier>, hasNit = Object.hasOwn(supplier, "nit"), contactPatch: Record<string, string | null> = {};
      for (const field of ["phone", "email", "address"] as const) if (Object.hasOwn(supplier, field)) contactPatch[field] = supplier[field] ?? null;
      const contact = JSON.stringify(contactPatch);
      rows = await this.sql<DbRow[]>`update proveedores set razon_social=coalesce(${supplier.name ?? null}, razon_social), nit=case when ${hasNit} then ${supplier.nit ?? null} else nit end, contacto=(contacto - array(select jsonb_object_keys(${contact}::jsonb))) || jsonb_strip_nulls(${contact}::jsonb), activo=coalesce(${supplier.active ?? null}, activo) where id=${id} returning *`;
    }
    if (!rows[0]) throw new Error("CATALOG_NOT_FOUND");
    return catalogRecord(kind, rows[0]);
  }
  // El cast ::text en `${nit} is not null` no es opcional: un `is null`/`is not null` sobre un
  // parámetro sin otro contexto de tipo no permite a Postgres inferir el tipo EN TIEMPO DE PREPARE
  // (independiente del valor), y dispara 42P18. Esta consulta corre en cada alta/edición de
  // proveedor vía supplierConflict, así que sin el cast ninguna se podía crear contra Postgres real.
  async findSupplierDuplicate(value: Pick<CatalogSupplier, "name" | "nit">, exceptId?: string): Promise<string | null> { const rows = await this.sql<{ id: string }[]>`select id from proveedores where (${exceptId ?? null}::uuid is null or id <> ${exceptId ?? null}) and (lower(btrim(razon_social)) = lower(btrim(${value.name})) or (${value.nit ?? null}::text is not null and nit_normalizado = nullif(regexp_replace(${value.nit ?? null}, '[^0-9A-Za-z]', '', 'g'), ''))) limit 1`; return rows[0]?.id ?? null; }
  // HUECO 1: compara contra telefono_normalizado (columna generada) con el MISMO criterio que
  // normalizeCoPhone (ver lib/infrastructure/phone.ts) — así "3001112233" y "+57 300 111 2233" chocan
  // como el mismo solicitante antes de que el INSERT/UPDATE llegue a depender del unique constraint.
  async findRequesterDuplicate(phone: string, exceptId?: string): Promise<string | null> { const rows = await this.sql<{ id: string }[]>`select id from solicitantes_autorizados where (${exceptId ?? null}::uuid is null or id <> ${exceptId ?? null}) and telefono_normalizado = ${normalizeCoPhone(phone)} limit 1`; return rows[0]?.id ?? null; }
  async isEligibleApprover(id: string): Promise<boolean> { const rows = await this.sql<{ eligible: boolean }[]>`select exists(select 1 from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.id=${id} and u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam')) as eligible`; return rows[0]?.eligible === true; }
  // GRAVE 3 (QA Postgres real): tras `update obras set sociedad_id=...`, cualquier UPDATE posterior de
  // una requisición anclada a esa obra revienta con 23514 ("La obra asignada no pertenece a la
  // sociedad de la requisición") porque saveRequisition siempre reenvía obra_id en su on conflict — la
  // requisición queda inservible para siempre. CatalogService.patch usa este chequeo para impedir el
  // cambio de sociedad en vez de intentar re-sincronizar historial.
  async hasRequisitionsForWork(workId: string): Promise<boolean> { const rows = await this.sql<{ existe: boolean }[]>`select exists(select 1 from requisiciones where obra_id=${workId}) as existe`; return rows[0]?.existe === true; }
  // RF-004: la conexión directa a Postgres (DATABASE_URL) puede leer auth.users; nunca se INSERTA
  // ni modifica esa tabla desde esta plataforma, solo se verifica que el id ya exista en Auth.
}

class PostgresTransactionManager implements TransactionManager {
  constructor(private readonly sql: Sql) {}
  async transaction<T>(lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> { return this.sql.begin(async (tx) => { const [kind, id] = lockKey?.includes(":") ? lockKey.split(":", 2) : ["requisition", lockKey]; if (id && kind === "requisition") await tx`select id from requisiciones where id=${id} for update`; else if (id && kind === "order") await tx`select id from ordenes where id=${id} for update`; else if (id && kind === "expense") await tx`select id from gastos where id=${id} for update`; return work(transactionRepositories(new PostgresPorts(tx as unknown as Sql))); }) as Promise<T>; }
}
// H3: los métodos nuevos (listVisibleHeaders/dashboardByStatus/listAttentionCandidates/
// listRecentlyUpdated/dashboardPendingCount/dashboardAggregates) son de SOLO LECTURA — se exponen aquí
// igual que los demás para que el shape de TransactionRepositories/ServiceDependencies sea uno solo,
// pero en la práctica el dashboard y las listas paginadas siempre usan `createPostgresDependencies()`
// directamente (fuera de una transacción explícita), nunca `deps.transactions.transaction(...)`.
function transactionRepositories(ports: PostgresPorts): TransactionRepositories {
  return {
    requisitions: { get: ports.getRequisition.bind(ports), save: ports.saveRequisition.bind(ports), list: ports.listRequisitions.bind(ports), listVisibleTo: ports.listVisibleRequisitions.bind(ports), listVisibleHeaders: ports.listVisibleHeaders.bind(ports), dashboardByStatus: ports.dashboardByStatus.bind(ports) },
    orders: { save: ports.saveOrder.bind(ports), list: ports.listOrders.bind(ports), listVisibleTo: ports.listVisibleOrders.bind(ports), listByRequisition: ports.listByRequisition.bind(ports), get: ports.getOrder.bind(ports), listAttentionCandidates: ports.listAttentionCandidates.bind(ports), listRecentlyUpdated: ports.listOrdersRecentlyUpdated.bind(ports), dashboardPendingCount: ports.dashboardPendingCount.bind(ports) },
    expenses: { get: ports.getExpense.bind(ports), save: ports.saveExpense.bind(ports), markPaid: ports.markExpensePaid.bind(ports), deleteByReference: ports.deleteExpenseByReference.bind(ports), saveShares: ports.saveShares.bind(ports), list: ports.listExpenses.bind(ports), listVisibleTo: ports.listVisibleExpenses.bind(ports), listByReference: ports.listByReference.bind(ports), dashboardAggregates: ports.dashboardAggregates.bind(ports), listRecentlyUpdated: ports.listExpensesRecentlyUpdated.bind(ports) },
    pettyCash: { save: ports.savePettyCash.bind(ports), list: ports.listPettyCash.bind(ports) },
    audit: ports, consecutives: ports, features: ports, items: ports, catalogs: ports, notifications: ports,
  };
}
export function createPostgresDependencies(databaseUrl = runtimeEnv().DATABASE_URL): ServiceDependencies {
  const sql = sharedPostgres(databaseUrl), ports = new PostgresPorts(sql);
  // Sin `linkToken` (ruta pública, decisión de Ernesto del 2026-09-11) no hay HMAC que comprobar y la
  // autorización es solo la contraseña + obra habilitada y activa. Eso significa que una petición sin
  // token SÍ llega a la base, al contrario que antes: por eso importa que los tres limitadores de
  // `app/api/public/requisitions/route.ts` se apliquen ANTES de llamar aquí, que es lo que queda como
  // única defensa contra probar contraseñas a lo bruto.
  const publicAccess: PublicAccessVerifier = { verify: async (workId, linkToken, code) => { const env = publicEnv(); if (linkToken !== null && !verifyPublicLinkToken(workId, linkToken, env.PUBLIC_FORM_CODE_PEPPER)) return false; // `estado = 'activa'` desde que el enlace es general: con un enlace por obra el destino venía
    // firmado, pero el general vale para cualquier obra, así que la única defensa contra radicar
    // sobre una obra cerrada es esta. Además deja el endpoint alineado con /api/public/works, que
    // solo ofrece obras activas: lo que se ofrece es exactamente lo que se acepta.
    const rows = await sql<DbRow[]>`select o.public_submission_enabled and o.estado = 'activa' and public.verificar_codigo_publico(${code}) as valid from obras o where o.id=${workId}`; return rows[0]?.valid === true; },
    /**
     * Contraparte de `verify` para el portal que elige EMPRESA (Ernesto, 11-sep-2026: "ya dijimos era
     * empresa"). Sin obra no hay nada que firmar por obra, así que un token POR OBRA se rechaza
     * explícitamente: firma una obra concreta y aceptarlo aquí lo convertiría en llave para radicar
     * contra cualquier sociedad. Solo vale el token general, o ninguno.
     *
     * `activa` y no `estado`: sociedades marca su vigencia con un booleano. Y se comprueba por la
     * misma razón que en `verify` — lo que ofrece /api/public/companies es exactamente lo que esto
     * acepta.
     */
    verifySociety: async (societyId, linkToken, code) => {
      const env = publicEnv();
      if (linkToken !== null && !safeEqual(generalLinkToken(env.PUBLIC_FORM_CODE_PEPPER), linkToken)) return false;
      const rows = await sql<DbRow[]>`select s.activa and public.verificar_codigo_publico(${code}) as valid from sociedades s where s.id=${societyId}`;
      return rows[0]?.valid === true;
    },
  };
  const transactionPorts = transactionRepositories(ports);
  return { ...transactionPorts, pettyCash: { save: ports.savePettyCash.bind(ports), list: ports.listPettyCash.bind(ports) }, publicAccess, features: ports, items: ports, catalogs: ports, notifications: ports, transactions: new PostgresTransactionManager(sql), clock: { now: () => new Date() }, ids: { next: () => crypto.randomUUID() } as IdGenerator };
}
