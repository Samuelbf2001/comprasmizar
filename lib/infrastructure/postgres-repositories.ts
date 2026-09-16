import postgres, { type Sql } from "postgres";
import { DomainError, normalizeItemName, paymentStatus, type Actor, type AuditEvent, type CashClose, type CashCloseStatus, type CashPayment, type CostCenterMovement, type DashboardAmountByKey, type Expense, type ExpenseShare, type Income, type ItemLine, type Order, type OrderAdminStatus, type OrderPayment, type PaymentMethod, type PettyCash, type Requisition, type RequisitionStatus, type Role } from "../domain";
import type { AuditRepository, CatalogCashBox, CatalogCostCenter, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogRequester, CatalogSociety, CatalogSupplier, CatalogTag, CatalogItem, CatalogUser, CatalogUserCreate, ConsecutiveRepository, IdGenerator, ListQuery, Page, PublicAccessVerifier, ReportCatalogSource, ServiceDependencies, TransactionManager, TransactionRepositories } from "../services";
import { PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";
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
    // NULL se mapea a `undefined`, que en el dominio significa "hereda el de la cabecera" (itemApproverId).
    approverId: row.aprobador_id ? String(row.aprobador_id) : undefined,
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
    // RF-1301: solo presente cuando el SELECT trae `created_at` (todas las lecturas de esta clase la
    // traen con `select r.*`/`select *`, así que en la práctica siempre viaja); undefined en fakes de
    // test que no la incluyan en la fila cruda.
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : undefined,
    // Centros de costo (2026-09-12): valor EFECTIVO de la requisición (ver Requisition.costCenterId).
    costCenterId: row.centro_costo_id ? String(row.centro_costo_id) : undefined,
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
    // Reunión agosto 2026: ausente (no `0`) cuando la consulta no hizo el `left join lateral` de
    // `orderSelectColumns()`/`orderFromJoins()` — mismo criterio que requisitionConsecutive/lines de
    // arriba, ver el comentario de `Order.paidAmount` en lib/domain/model.ts.
    paidAmount: row.pagado_total != null ? asNumber(row.pagado_total) : undefined,
    // Centros de costo (UI, 2026-09-12): mismo criterio de ausencia que requisitionConsecutive/workId
    // de arriba — undefined (no "—") cuando el SELECT no hizo el join, nunca un "sin centro" falso.
    costCenterId: row.requisicion_centro_costo_id != null ? String(row.requisicion_centro_costo_id) : undefined,
    // RF-508 (adenda de pagos): derivado con la MISMA función de dominio que el servicio (paymentStatus,
    // lib/domain/rules.ts) a partir de pagado_total (solo vigentes) y gasto_total (valor_total del gasto
    // de la orden). Sin gasto no hay contra qué medir: queda undefined, no un "pendiente" inventado.
    paymentStatus: row.pagado_total != null && row.gasto_total != null ? paymentStatus(asNumber(row.gasto_total), asNumber(row.pagado_total)) : undefined,
    lastPaymentAt: asIsoDate(row.ultimo_pago),
    paymentMethods: row.pagado_total == null ? undefined : typeof row.medios_pago === "string" && row.medios_pago ? (row.medios_pago.split(",") as PaymentMethod[]) : [],
  };
}
// Reunión 2026-09: `fecha` (fecha de pago) y `periodo` (mes de `fecha`) son NULL en la BD mientras la
// orden que originó el gasto no se ha pagado — `asIsoDate` ya devuelve `undefined` para NULL, así que
// NO se fuerza `as string`: un gasto sin pagar debe poder representarse en memoria sin fecha de pago.
// `fecha_orden` (nace con el registro, NOT NULL en la BD) sí es obligatoria.
// caja_id/concepto/medio_pago/registrado_por/cierre_id (2026-09-12, 202609120003): copiados por
// sincronizar_gasto_caja_menor solo en origen 'caja_menor' — NULL en origen 'requisicion'.
function expense(row: DbRow): Expense { return { id: String(row.id), workId: String(row.obra_id), origin: row.origen as Expense["origin"], referenceId: String(row.referencia_id), tagId: row.etiqueta_id ? String(row.etiqueta_id) : undefined, supplierId: row.proveedor_id ? String(row.proveedor_id) : undefined, orderDate: asIsoDate(row.fecha_orden) as string, date: asIsoDate(row.fecha), base: asNumber(row.valor_base), iva: asNumber(row.iva), total: asNumber(row.valor_total), period: asIsoDate(row.periodo)?.slice(0, 7), costCenterId: row.centro_costo_id ? String(row.centro_costo_id) : undefined, cashBoxId: row.caja_id ? String(row.caja_id) : undefined, concept: row.concepto ? String(row.concepto) : undefined, paymentMethod: row.medio_pago ? (row.medio_pago as Expense["paymentMethod"]) : undefined, registeredBy: row.registrado_por ? String(row.registrado_por) : undefined, closeId: row.cierre_id ? String(row.cierre_id) : undefined }; }
/** Ingresos (2026-09-12, migración 202609120003): tabla APARTE de gastos, nunca negativa. */
function income(row: DbRow): Income {
  return {
    id: String(row.id), cashBoxId: String(row.caja_id), costCenterId: String(row.centro_costo_id),
    workId: row.obra_id ? String(row.obra_id) : undefined, date: asIsoDate(row.fecha) as string,
    concept: String(row.concepto), amount: asNumber(row.valor), paymentMethod: row.medio_pago as Income["paymentMethod"],
    thirdParty: row.tercero ? String(row.tercero) : undefined, registeredBy: String(row.registrado_por),
    closeId: row.cierre_id ? String(row.cierre_id) : undefined, period: asIsoDate(row.periodo)?.slice(0, 7),
  };
}
/** Cierres mensuales de caja (202609120003). `period` viaja como "YYYY-MM" (mismo formato que
 *  `Expense.period`), no como el `date` (día 1 del mes) que guarda la columna `periodo`. */
function cashClose(row: DbRow): CashClose {
  return {
    id: String(row.id), cashBoxId: String(row.caja_id), period: (asIsoDate(row.periodo) as string).slice(0, 7),
    status: row.estado as CashClose["status"], openingBalance: asNumber(row.saldo_inicial), totalIncome: asNumber(row.total_ingresos),
    totalExpense: asNumber(row.total_gastos), closingBalance: asNumber(row.saldo_final),
    closedBy: row.cerrado_por ? String(row.cerrado_por) : undefined, closedAt: row.cerrado_at ? toIsoInstant(row.cerrado_at) : undefined,
  };
}
/** Reunión agosto 2026: un pago parcial de orden. `fecha` es `date` en Postgres (asIsoDate, mismo
 *  criterio que `orderDate`/`date` de Expense arriba); `valor` viaja como string desde `numeric(16,2)`
 *  (el driver `postgres` no lo convierte solo), de ahí `asNumber`. */
function orderPayment(row: DbRow): OrderPayment {
  const annulled = row.anulado === true;
  return {
    id: String(row.id), orderId: String(row.orden_id), date: asIsoDate(row.fecha) as string, amount: asNumber(row.valor),
    method: row.medio_pago as OrderPayment["method"], externalReference: row.referencia_externa ? String(row.referencia_externa) : undefined,
    note: row.nota ? String(row.nota) : undefined, registeredBy: row.registrado_por ? String(row.registrado_por) : undefined,
    // RF-510: anulado/motivo/quién/cuándo (202609150001); comprobante = adjunto `pago_orden` más reciente,
    // resuelto por la subconsulta `comprobante_id` de paymentSelectColumns().
    annulled, annulmentReason: annulled && row.motivo_anulacion ? String(row.motivo_anulacion) : undefined,
    annulledBy: annulled && row.anulado_por ? String(row.anulado_por) : undefined, annulledAt: annulled && row.anulado_en ? toIsoInstant(row.anulado_en) : undefined,
    attachmentId: row.comprobante_id ? String(row.comprobante_id) : undefined,
  };
}
/** RF-708: fila del cierre de caja — un pago vigente en efectivo con su orden/requisición resueltas por join. */
function cashPayment(row: DbRow): CashPayment {
  return {
    ...orderPayment(row), orderConsecutive: String(row.orden_consecutivo), orderType: row.orden_tipo as CashPayment["orderType"],
    requisitionId: String(row.requisicion_id), requisitionConsecutive: String(row.requisicion_consecutivo),
    workId: row.requisicion_obra_id ? String(row.requisicion_obra_id) : undefined, costCenterId: row.requisicion_centro_costo_id ? String(row.requisicion_centro_costo_id) : undefined,
    supplierId: row.orden_proveedor_id ? String(row.orden_proveedor_id) : undefined,
  };
}
// `periodo` es una columna `date` (generada, ver migración core_compras): la librería `postgres` la
// entrega como Date, y `String(fecha)` da "Tue Sep 01 2026 ..." — el `.slice(0, 7)` anterior producía
// "Tue Sep" en vez de "2026-09", con lo que el filtro por periodo de la pantalla de gastos y el
// `periodExpense` del dominio nunca coincidían. `asIsoDate` ya resuelve Date/NULL igual que `fecha`.
function catalogRecord(kind: CatalogKind, row: DbRow): CatalogRecord {
  // Centros de costo (2026-09-12): costCenterId viaja en la fila de `obras` (columna centro_costo_id,
  // ver 202609120001) — es el DEFAULT de la obra, no el catálogo de centros en sí (ese es "costCenters").
  if (kind === "works") return { id: String(row.id), name: String(row.nombre), societyId: String(row.sociedad_id), active: row.estado === "activa", costCenterId: row.centro_costo_id ? String(row.centro_costo_id) : undefined };
  if (kind === "costCenters") return { id: String(row.id), name: String(row.nombre), code: row.codigo ? String(row.codigo) : undefined, societyId: row.sociedad_id ? String(row.sociedad_id) : undefined, active: row.activo === true };
  // Cajas (2026-09-12): catálogo de "dónde vive la plata" (migración 202609120003).
  if (kind === "cashBoxes") return { id: String(row.id), name: String(row.nombre), type: row.tipo as CatalogCashBox["type"], societyId: row.sociedad_id ? String(row.sociedad_id) : undefined, costCenterId: row.centro_costo_id ? String(row.centro_costo_id) : undefined, active: row.activo === true };
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
  // VISIBILIDAD DEL APROBADOR: la cabecera suya O algún ítem suyo (aprobador por ítem, 11-sep-2026).
  //
  // UNA SOLA DEFINICIÓN, `public.es_aprobador_de` (migración 202609110004), y no el predicado repetido
  // en cada consulta. El predicado a mano estuvo copiado TRECE veces y se me escaparon dos —órdenes y
  // gastos—, con el resultado de que un aprobador por ítem veía la requisición y luego una lista de
  // órdenes vacía. Escrito trece veces, la pregunta no es si se olvidará una, es cuál.
  //
  // Esa función ya la comprueba el arnés SQL contra Postgres real (cabecera, ítem y ajeno), así que
  // esto hereda esa prueba en vez de necesitar una por consulta.
  //
  // VER no es DECIDIR: esto abre la lectura; quién puede decidir cada ítem lo siguen comprobando
  // decideItems()/approve() línea por línea.
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
    // centro_costo_id va en el `on conflict do update` por la MISMA razón que forma_pago/aprobador_id
    // (comentario de arriba): review() lo asigna (heredado de la obra o elegido por el revisor) y sin
    // reenviarlo aquí el cambio nunca se persistiría.
    await this.sql`insert into requisiciones (id, consecutivo, tipo, sociedad_id, obra_id, solicitante_id, solicitante_nombre_externo, solicitante_telefono_externo, canal, fecha_requerida, observaciones, etiqueta_id, aprobador_id, centro_costo_id, estado, motivo_declinacion, motivo_devolucion, forma_pago, kapso_event_id) values (${value.id}, ${value.consecutive}, ${value.type}, ${value.societyId ?? null}, ${value.workId ?? null}, ${value.requesterId ?? null}, ${value.externalRequester?.name ?? null}, ${value.externalRequester?.phone ?? null}, ${value.channel}, ${value.requiredDate || null}, ${value.observations ?? null}, ${value.tagId ?? null}, ${value.approverId ?? null}, ${value.costCenterId ?? null}, ${value.status}, ${value.declineReason ?? null}, ${value.returnReason ?? null}, ${value.paymentTerms ?? null}, ${value.kapsoEventId ?? null}) on conflict (id) do update set obra_id = excluded.obra_id, etiqueta_id = excluded.etiqueta_id, aprobador_id = excluded.aprobador_id, centro_costo_id = excluded.centro_costo_id, estado = excluded.estado, motivo_declinacion = excluded.motivo_declinacion, motivo_devolucion = excluded.motivo_devolucion, observaciones = excluded.observaciones, fecha_requerida = excluded.fecha_requerida, forma_pago = excluded.forma_pago, kapso_event_id = coalesce(requisiciones.kapso_event_id, excluded.kapso_event_id), updated_at = now()`;
    // iva_tasa: NULL (no 0) cuando la línea no trae ivaRate. B2 (QA Postgres real): con `?? 0` una
    // línea legacy cuya tasa se restauró como `undefined` (defensa IVA legacy en review(), ver
    // procurement-service.ts) se reescribiría como 0 al guardar — el mismo bug que hizo nullable la
    // columna, pero ahora en la escritura en vez de la lectura. `?? null` preserva la distinción:
    // undefined -> NULL ("tasa sin capturar"), 0 explícito -> 0 ("tasa 0% real").
    for (const line of value.items) await this.sql`insert into requisicion_items (id, requisicion_id, item_id, descripcion_libre, cantidad, unidad, posible_proveedor_texto, link_producto, proveedor_final_id, valor_base, iva, iva_tasa, descuento_tasa, estado, motivo_declinacion, aprobador_id) values (${line.id}, ${value.id}, ${line.itemId ?? null}, ${line.description ?? null}, ${line.quantity}, ${line.unit}, ${line.possibleSupplier ?? null}, ${line.productLink ?? null}, ${line.finalSupplierId ?? null}, ${line.unitBase ?? 0}, ${line.unitIva ?? 0}, ${line.ivaRate ?? null}, ${line.discountRate ?? 0}, ${line.status ?? "pendiente"}, ${line.declineReason ?? null}, ${line.approverId ?? null}) on conflict (id) do update set item_id = excluded.item_id, descripcion_libre = excluded.descripcion_libre, cantidad = excluded.cantidad, unidad = excluded.unidad, posible_proveedor_texto = excluded.posible_proveedor_texto, link_producto = excluded.link_producto, proveedor_final_id = excluded.proveedor_final_id, valor_base = excluded.valor_base, iva = excluded.iva, iva_tasa = excluded.iva_tasa, descuento_tasa = excluded.descuento_tasa, estado = excluded.estado, motivo_declinacion = excluded.motivo_declinacion, aprobador_id = excluded.aprobador_id, updated_at = now()`;
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
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select r.* from requisiciones r order by r.created_at desc` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select r.* from requisiciones r where public.es_aprobador_de(r.id, ${actor.id}) order by r.created_at desc` : await this.sql<DbRow[]>`select r.* from requisiciones r where r.solicitante_id=${actor.id} order by r.created_at desc`;
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
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const statusFilter = query.status?.length ? this.sql`and r.estado::text = any(${query.status})` : this.sql``;
    const workFilter = query.workId ? this.sql`and r.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and r.created_at >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and r.created_at < (${query.to}::date + 1)` : this.sql``;
    // RF-1301 (Reportes): "aprobador" filtra por ASIGNACIÓN (cabecera O algún ítem, `es_aprobador_de`),
    // no por si esa persona ya decidió — es la misma función que ya resuelve `visibility` arriba, aquí
    // aplicada al aprobador que el REPORTE pide ver (que puede ser distinto del actor que consulta,
    // p. ej. contabilidad filtrando por "aprobador = Juliana"). "etiqueta" es una columna directa.
    const tagFilter = query.tagId ? this.sql`and r.etiqueta_id = ${query.tagId}` : this.sql``;
    const approverFilter = query.approverId ? this.sql`and public.es_aprobador_de(r.id, ${query.approverId})` : this.sql``;
    // Centros de costo (UI, 2026-09-12): filtro del reporte de requisiciones por el centro de costo
    // EFECTIVO de la requisición (columna propia `requisiciones.centro_costo_id`, no la de la obra) —
    // mismo `ListQuery.costCenterId` que ya usa `listVisibleExpenses`, aditivo igual que `tagFilter`.
    const costCenterFilter = query.costCenterId ? this.sql`and r.centro_costo_id = ${query.costCenterId}` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (r.created_at, r.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select r.* from requisiciones r where true ${visibility} ${statusFilter} ${workFilter} ${tagFilter} ${approverFilter} ${costCenterFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by r.created_at desc, r.id desc limit ${limit + 1}`;
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
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
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
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
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
    // `max(pago.pagado)`: agregado (no columna cruda) porque `pago` es un `left join lateral` sobre
    // `pagos_orden`, no una tabla con llave primaria declarada — Postgres no puede inferir que sea
    // funcionalmente dependiente de `o.id`/`r.id` (a diferencia de `r.consecutivo`/`r.obra_id`, que sí
    // lo son porque `r.id` es su PK y ya está en el GROUP BY). `max` es un passthrough seguro: el
    // LATERAL correlaciona solo por `o.id`, así que vale lo mismo en cada una de las filas que el
    // `left join ... ri` de abajo pueda fanning-out para esa misma orden.
    // `requisicion_centro_costo_id` (UI, 2026-09-12): centro de costo EFECTIVO de la requisición dueña
    // (ver el comentario largo de `Order.costCenterId` en lib/domain/model.ts) — mismo alias por la
    // misma razón que `requisicion_consecutivo`/`requisicion_obra_id` (evitar pisar una columna propia
    // de `ordenes`, aunque hoy no exista una `centro_costo_id` en esa tabla: mantiene la convención).
    // RF-508 (adenda de pagos): `ultimo_pago`/`medios_pago` salen del mismo lateral que `pagado` (solo
    // pagos VIGENTES) y `gasto_total` del gasto de la orden — con los dos, `order(row)` deriva
    // `paymentStatus` con la función de dominio. Todos pasan por `max(...)` por la misma razón que
    // `pagado_total` (laterales sin PK declarada frente al GROUP BY).
    return this.sql`o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, r.fecha_requerida as requisicion_fecha_requerida, r.centro_costo_id as requisicion_centro_costo_id, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids, coalesce(json_agg(json_build_object('id', ri.id, 'item_id', ri.item_id, 'descripcion_libre', ri.descripcion_libre, 'cantidad', ri.cantidad, 'unidad', ri.unidad, 'posible_proveedor_texto', ri.posible_proveedor_texto, 'link_producto', ri.link_producto, 'proveedor_final_id', ri.proveedor_final_id, 'valor_base', ri.valor_base, 'iva', ri.iva, 'estado', ri.estado, 'motivo_declinacion', ri.motivo_declinacion, 'iva_tasa', ri.iva_tasa, 'descuento_tasa', ri.descuento_tasa) order by ri.created_at) filter (where ri.id is not null), '[]') as lines, max(pago.pagado) as pagado_total, max(pago.ultimo_pago) as ultimo_pago, max(pago.medios) as medios_pago, max(gasto.valor_total) as gasto_total`;
  }
  // `ri` cuelga del mismo `left join orden_items oi` que ya resolvía `item_ids`: si algún día ambos joins
  // dejan de compartir la misma fila, `lines` y `item_ids` dejarían de corresponder al mismo conjunto de
  // ítems — no separar esta cadena sin revisar ese acoplamiento.
  // `pago`: reunión agosto 2026, `Order.paidAmount` resuelto en el MISMO select (nunca una consulta
  // por orden) — `coalesce(sum(...), 0)` deja `pagado = 0` (no NULL) para una orden sin ningún pago,
  // y `left join lateral ... on true` (no un `left join` normal) porque la subconsulta no correlaciona
  // con ninguna columna de `pagos_orden` en el ON, solo en el WHERE interno. RF-510: `not po.anulado`
  // — un pago anulado no cuenta (misma regla que sumPaid en el dominio y el trigger en la base).
  // `gasto`: 0..1 filas por `gastos_origen_referencia_unico`; su valor_total es el total contra el que
  // se mide el estado de pago (y el filtro `paymentStatus`).
  private orderFromJoins() {
    return this.sql`from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id left join requisicion_items ri on ri.id=oi.requisicion_item_id left join lateral (select coalesce(sum(po.valor), 0) as pagado, max(po.fecha) as ultimo_pago, string_agg(distinct po.medio_pago::text, ',') as medios from pagos_orden po where po.orden_id = o.id and not po.anulado) pago on true left join lateral (select g.valor_total from gastos g where g.origen = 'requisicion' and g.referencia_id = o.id) gasto on true`;
  }
  async listOrders(): Promise<Order[]> { const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} group by o.id, r.id`; return rows.map(order); }
  async listVisibleOrders(actor: Actor, query?: ListQuery): Promise<Order[] | Page<Order>> {
    if (!query) {
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} group by o.id, r.id` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where public.es_aprobador_de(r.id, ${actor.id}) group by o.id, r.id` : await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where r.solicitante_id=${actor.id} group by o.id, r.id`;
      return rows.map(order);
    }
    // H3: fragmentos condicionales anidados (misma técnica documentada en el README de `postgres`, ver
    // "Building queries" — sql`` vacío para el caso "sin filtro"). Orden estable fecha_generacion desc,
    // id desc: mismas columnas que `ordenes_requisicion_idx`/`ordenes_estado_idx` ya usan, más id como
    // desempate para que el cursor sea determinístico con fecha_generacion repetida.
    const limit = pageLimit(query.limit);
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const statusFilter = query.status?.length ? this.sql`and o.estado_cumplimiento::text = any(${query.status})` : this.sql``;
    const workFilter = query.workId ? this.sql`and r.obra_id = ${query.workId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and o.fecha_generacion >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and o.fecha_generacion < (${query.to}::date + 1)` : this.sql``;
    // RF-509 (adenda de pagos): centro de costo de la requisición dueña (el mismo que Order.costCenterId);
    // medio y rango de fecha de pago miran los pagos VIGENTES de la orden (`exists`, no el lateral, para
    // que un solo pago que cumpla baste); el estado de pago replica en SQL EXACTAMENTE `paymentStatus()`
    // (lib/domain/rules.ts) sobre las mismas dos cifras del lateral — si esa función cambia, cambia esto.
    const costCenterFilter = query.costCenterId ? this.sql`and r.centro_costo_id = ${query.costCenterId}` : this.sql``;
    const paymentMethodFilter = query.paymentMethod ? this.sql`and exists (select 1 from pagos_orden pm where pm.orden_id = o.id and not pm.anulado and pm.medio_pago = ${query.paymentMethod})` : this.sql``;
    const paidFromFilter = query.paidFrom ? this.sql`and pf.fecha >= ${query.paidFrom}::date` : this.sql``;
    const paidToFilter = query.paidTo ? this.sql`and pf.fecha <= ${query.paidTo}::date` : this.sql``;
    const paidRangeFilter = query.paidFrom || query.paidTo ? this.sql`and exists (select 1 from pagos_orden pf where pf.orden_id = o.id and not pf.anulado ${paidFromFilter} ${paidToFilter})` : this.sql``;
    const paymentStatusFilter = query.paymentStatus ? this.sql`and (case when coalesce(pago.pagado, 0) <= 0 then 'pendiente' when pago.pagado < coalesce(gasto.valor_total, 0) then 'parcial' else 'pagada' end) = ${query.paymentStatus}` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (o.fecha_generacion, o.id) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select ${this.orderSelectColumns()} ${this.orderFromJoins()} where true ${visibility} ${statusFilter} ${workFilter} ${costCenterFilter} ${paymentMethodFilter} ${paidRangeFilter} ${paymentStatusFilter} ${fromFilter} ${toFilter} ${cursorFilter} group by o.id, r.id order by o.fecha_generacion desc, o.id desc limit ${limit + 1}`;
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
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id where (o.estado_cumplimiento in ('generada', 'no_cumplida') or (o.estado_administrativo = 'pendiente' and o.estado_cumplimiento <> 'no_necesario')) ${visibility} group by o.id, r.id order by o.fecha_generacion desc limit 500`;
    return rows.map(order);
  }
  // H3: las `limit` órdenes visibles más recientes por `updated_at`, para buildRecentActivity. Nombrado
  // "listOrdersRecentlyUpdated" (no "listRecentlyUpdated" a secas) para no chocar con el método
  // homónimo de gastos más abajo en esta misma clase — cada uno se expone bajo el mismo nombre
  // `listRecentlyUpdated` pero en su propia interfaz (OrderRepository/ExpenseRepository, ver el
  // `.bind()` en `transactionRepositories`/`createPostgresDependencies`).
  async listOrdersRecentlyUpdated(actor: Actor, limit: number): Promise<Order[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select o.*, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id where true ${visibility} group by o.id, r.id order by o.updated_at desc, o.id desc limit ${limit}`;
    return rows.map(order);
  }
  // H3: mismo criterio que `calculateDashboard` (lib/domain/rules.ts) para pendingOrders — estado_cumplimiento
  // en generada|no_cumplida — resuelto en SQL con la misma visibilidad por actor que listVisibleOrders.
  async dashboardPendingCount(actor: Actor): Promise<number> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<{ total: string }[]>`select count(*) as total from ordenes o join requisiciones r on r.id=o.requisicion_id where o.estado_cumplimiento in ('generada', 'no_cumplida') ${visibility}`;
    return Number(rows[0]?.total ?? 0);
  }
  // `fecha` (fecha de pago) viaja nullable: un gasto recién nacido de una orden generada (aún sin
  // pagar) se guarda con `date` ausente en memoria -> NULL en la BD -> `periodo` NULL (columna
  // generada). `fecha_orden` sí siempre viaja (obligatoria en el dominio).
  // centro_costo_id va EN EL INSERT, no en un UPDATE posterior: `on conflict do nothing` significa que
  // esta es la ÚNICA oportunidad de fijarlo — un gasto ya guardado nunca se reescribe por aquí (ver el
  // comentario de la firma en contracts.ts). Es la instantánea de Expense.costCenterId, copiada tal
  // cual (nunca derivada aquí de `obra_id`): quien la resolvió ya fue generateOrders()/ProcurementService.
  async saveExpense(value: Expense): Promise<void> { await this.sql`insert into gastos (id, obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha_orden, fecha, valor_base, iva, centro_costo_id) values (${value.id}, ${value.workId}, ${value.origin}, ${value.referenceId}, ${value.tagId ?? null}, ${value.supplierId ?? null}, ${value.orderDate}, ${value.date ?? null}, ${value.base}, ${value.iva}, ${value.costCenterId ?? null}) on conflict (origen, referencia_id) do nothing`; }
  // Único método que actualiza `gastos.fecha` de un gasto ya existente: `saveExpense` inserta con `on
  // conflict do nothing` a propósito (no reescribe un gasto ya guardado), así que no sirve para fijar
  // la fecha de pago cuando `updateOrderAdminStatus(..., "pagada")` la conoce. Solo aplica a
  // `origen = 'requisicion'`: la caja menor nace pagada y su `fecha` la gobierna
  // `sincronizar_gasto_caja_menor` (trigger), no este método.
  // GRAVE (QA reasignación): `returning id` + `.length` es la única forma de saber si el UPDATE tocó
  // algo — sin esto, marcar "pagada" una orden sin gasto propio (estado inconsistente que no debería
  // existir, pero contabilizada/pagada son ejes independientes del cumplimiento) quedaba en silencio.
  // `date: null` (adenda de pagos, N1) deshace la fecha: anular el pago que cerraba una orden "pagada".
  async markExpensePaid(referenceId: string, date: string | null): Promise<number> { const rows = await this.sql<{ id: string }[]>`update gastos set fecha = ${date}::date where origen = 'requisicion' and referencia_id = ${referenceId} returning id`; return rows.length; }
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
      const rows = isElevated(actor) ? await this.sql<DbRow[]>`select * from gastos` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id where public.es_aprobador_de(r.id, ${actor.id})` : await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id where r.solicitante_id=${actor.id}`;
      return rows.map(expense);
    }
    const limit = pageLimit(query.limit);
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const workFilter = query.workId ? this.sql`and g.obra_id = ${query.workId}` : this.sql``;
    // Centros de costo (2026-09-12): filtro aditivo, mismo patrón que workFilter — `costCenterId`
    // compara contra la INSTANTÁNEA copiada en el gasto (gastos.centro_costo_id), no contra la obra.
    const costCenterFilter = query.costCenterId ? this.sql`and g.centro_costo_id = ${query.costCenterId}` : this.sql``;
    // Cajas (2026-09-12): filtro aditivo, mismo patrón que costCenterFilter — solo tiene valor en
    // gastos de origen 'caja_menor' (gastos.caja_id es NULL en origen 'requisicion').
    const cashBoxFilter = query.cashBoxId ? this.sql`and g.caja_id = ${query.cashBoxId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and g.fecha >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and g.fecha < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (g.fecha_orden, g.id) < (${cursor.at}::date, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select g.* from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility} ${workFilter} ${costCenterFilter} ${cashBoxFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by g.fecha_orden desc, g.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(asIsoDate(last.fecha_orden) as string, String(last.id)) : null;
    return { rows: pageRows.map(expense), nextCursor };
  }
  async listByReference(referenceId: string): Promise<Expense[]> { return (await this.sql<DbRow[]>`select g.* from gastos g where g.referencia_id=${referenceId} or exists (select 1 from ordenes o where o.id=g.referencia_id and o.requisicion_id=${referenceId})`).map(expense); }
  // Reunión agosto 2026: pagos parciales de una orden. `save` es INSERT puro (la tabla no lleva
  // `updated_at`, ver 202609120002_pagos_orden.sql — un pago no se edita); el trigger
  // `validar_pago_no_excede_orden` de esa misma migración es quien de verdad impide sobre-pasar el
  // total, ASÍ QUE `assertPaymentWithinOrder` (lib/domain/rules.ts) en el servicio es la primera
  // línea de defensa (un DomainError legible en vez del 23514 crudo de la base), no la única.
  async saveOrderPayment(value: OrderPayment): Promise<void> { await this.sql`insert into pagos_orden (id, orden_id, fecha, valor, medio_pago, referencia_externa, registrado_por, nota) values (${value.id}, ${value.orderId}, ${value.date}, ${value.amount}, ${value.method}, ${value.externalReference ?? null}, ${value.registeredBy ?? null}, ${value.note ?? null})`; }
  // RF-510/A5: cada pago viaja con su comprobante (el adjunto `pago_orden` más reciente, o ninguno) —
  // una subconsulta correlacionada, no un join, para que un pago sin comprobante siga siendo una fila.
  private paymentSelectColumns() {
    return this.sql`po.*, (select a.id from adjuntos a where a.entidad = 'pago_orden' and a.entidad_id = po.id and a.storage_bucket = ${PRIVATE_ATTACHMENT_BUCKET} order by a.fecha desc limit 1) as comprobante_id`;
  }
  // Orden cronológico (mismo criterio que el índice `pagos_orden_orden_fecha_idx`): es el orden en
  // que la ficha de la pantalla los lista y en el que el servicio calcula la "fecha del último pago".
  // Los anulados VIAJAN (tachados en la ficha, RF-510): quien no los quiera, filtra por `annulled`.
  async listOrderPayments(orderId: string): Promise<OrderPayment[]> { return (await this.sql<DbRow[]>`select ${this.paymentSelectColumns()} from pagos_orden po where po.orden_id=${orderId} order by po.fecha, po.created_at`).map(orderPayment); }
  async getOrderPayment(orderId: string, paymentId: string): Promise<OrderPayment | null> { const rows = await this.sql<DbRow[]>`select ${this.paymentSelectColumns()} from pagos_orden po where po.id=${paymentId} and po.orden_id=${orderId}`; return rows[0] ? orderPayment(rows[0]) : null; }
  // Único UPDATE de la tabla: `and not anulado` hace la anulación idempotente a nivel de fila (0 filas =
  // ya estaba anulado o no es de esa orden → null, el servicio decide el error). El trigger
  // `pagos_orden_no_excede` no interviene (anular nunca excede) y `pagos_orden_auditoria` deja la fila.
  async annulOrderPayment(orderId: string, paymentId: string, annulment: { reason: string; actorId: string; at: string }): Promise<OrderPayment | null> {
    const rows = await this.sql<{ id: string }[]>`update pagos_orden set anulado = true, motivo_anulacion = ${annulment.reason}, anulado_por = ${annulment.actorId}, anulado_en = ${annulment.at}::timestamptz where id = ${paymentId} and orden_id = ${orderId} and not anulado returning id`;
    return rows[0] ? this.getOrderPayment(orderId, paymentId) : null;
  }
  // RF-708: cierre de caja = pagos VIGENTES en efectivo fechados en el rango, con su orden resuelta.
  // `medio_pago = 'efectivo'` fijo a propósito (A1: la caja menor ES ese medio); el índice parcial
  // `pagos_orden_medio_fecha_idx` (202609150001) cubre exactamente este predicado.
  async listCashPayments(query: { from: string; to: string; costCenterId?: string }): Promise<CashPayment[]> {
    const costCenterFilter = query.costCenterId ? this.sql`and r.centro_costo_id = ${query.costCenterId}` : this.sql``;
    const rows = await this.sql<DbRow[]>`select ${this.paymentSelectColumns()}, o.consecutivo as orden_consecutivo, o.tipo as orden_tipo, o.proveedor_id as orden_proveedor_id, r.id as requisicion_id, r.consecutivo as requisicion_consecutivo, r.obra_id as requisicion_obra_id, r.centro_costo_id as requisicion_centro_costo_id from pagos_orden po join ordenes o on o.id = po.orden_id join requisiciones r on r.id = o.requisicion_id where po.medio_pago = 'efectivo' and not po.anulado and po.fecha >= ${query.from}::date and po.fecha <= ${query.to}::date ${costCenterFilter} order by po.fecha, po.created_at`;
    return rows.map(cashPayment);
  }
  // H3: agregados en SQL que reproducen exactamente calculateDashboard/groupExpenseByWork/
  // groupExpenseByTag/groupExpenseByPeriod (lib/domain/rules.ts) sobre la MISMA visibilidad por actor
  // que listVisibleExpenses (join a ordenes/requisiciones para aprobador/solicitante; sin filtro para
  // elevados). `g.periodo = (period || '-01')::date` en vez de `to_char(...) = period`: compara
  // directamente contra la columna (permite usar los índices existentes sobre `periodo`); el `to_char`
  // solo se usa para FORMATEAR la clave de salida de expenseByPeriod, nunca en un WHERE.
  async dashboardAggregates(actor: Actor, period: string): Promise<{ periodExpense: number; inProcessValue: number; expenseByWork: DashboardAmountByKey[]; expenseByTag: DashboardAmountByKey[]; expenseByPeriod: DashboardAmountByKey[]; expenseByCostCenter: DashboardAmountByKey[] }> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const periodStart = `${period}-01`;
    const totalsRows = await this.sql<{ period_expense: string; in_process_value: string }[]>`select coalesce(sum(g.valor_total) filter (where g.periodo = ${periodStart}::date), 0) as period_expense, coalesce(sum(g.valor_total) filter (where g.fecha is null), 0) as in_process_value from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility}`;
    const byWorkRows = await this.sql<{ key: string; total: string }[]>`select g.obra_id as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.fecha is not null ${visibility} group by g.obra_id order by total desc`;
    const byTagRows = await this.sql<{ key: string | null; total: string }[]>`select g.etiqueta_id as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.fecha is not null ${visibility} group by g.etiqueta_id order by total desc`;
    // order by periodo desc limit 6, invertido en JS: mismo resultado final que groupExpenseByPeriod
    // (que ordena cronológico ascendente y se queda con los últimos `monthsBack`).
    const byPeriodRows = await this.sql<{ key: string; total: string }[]>`select to_char(g.periodo, 'YYYY-MM') as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.periodo is not null ${visibility} group by g.periodo order by g.periodo desc limit 6`;
    // Centros de costo (UI, 2026-09-12): mismo criterio que byWorkRows/byTagRows arriba (solo gastos
    // pagados, misma visibilidad por actor) — ver groupExpenseByCostCenter en lib/domain/rules.ts.
    const byCostCenterRows = await this.sql<{ key: string | null; total: string }[]>`select g.centro_costo_id as key, sum(g.valor_total) as total from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where g.fecha is not null ${visibility} group by g.centro_costo_id order by total desc`;
    const totals = totalsRows[0];
    return {
      periodExpense: asNumber(totals?.period_expense), inProcessValue: asNumber(totals?.in_process_value),
      expenseByWork: byWorkRows.map((row) => ({ key: String(row.key), total: asNumber(row.total) })),
      expenseByTag: byTagRows.map((row) => ({ key: row.key ? String(row.key) : "", total: asNumber(row.total) })),
      expenseByPeriod: byPeriodRows.map((row) => ({ key: row.key, total: asNumber(row.total) })).reverse(),
      expenseByCostCenter: byCostCenterRows.map((row) => ({ key: row.key ? String(row.key) : "", total: asNumber(row.total) })),
    };
  }
  // H3: los `limit` gastos visibles más recientes, para buildRecentActivity — mismo fallback que la
  // función de dominio (`expense.date ?? expense.orderDate`): coalesce(fecha, fecha_orden) desc.
  // Nombrado "listExpensesRecentlyUpdated" para no chocar con el de órdenes — ver esa nota.
  async listExpensesRecentlyUpdated(actor: Actor, limit: number): Promise<Expense[]> {
    const visibility = isElevated(actor) ? this.sql`` : actor.roles.includes("aprobador") ? this.sql`and public.es_aprobador_de(r.id, ${actor.id})` : this.sql`and r.solicitante_id = ${actor.id}`;
    const rows = await this.sql<DbRow[]>`select g.* from gastos g left join ordenes o on o.id=g.referencia_id left join requisiciones r on r.id=o.requisicion_id where true ${visibility} order by coalesce(g.fecha, g.fecha_orden) desc, g.id desc limit ${limit}`;
    return rows.map(expense);
  }
  // caja_id/medio_pago/iva (2026-09-12, 202609120003): registerPettyCash es también el camino del
  // "gasto directo" de la pestaña Gastos y caja — ya no está atado a la caja menor clásica de obra.
  async savePettyCash(value: PettyCash): Promise<Expense> { const inserted = await this.sql<DbRow[]>`insert into caja_menor (id, obra_id, fecha, concepto, etiqueta_id, valor, iva, medio_pago, caja_id, centro_costo_id, registrado_por) values (${value.id}, ${value.workId}, ${value.date}, ${value.concept}, ${value.tagId}, ${value.amount}, ${value.iva ?? 0}, ${value.paymentMethod ?? null}, ${value.cashBoxId ?? null}, ${value.costCenterId ?? null}, ${value.registeredBy}) returning gasto_id`; const expenseRows = await this.sql<DbRow[]>`select * from gastos where id=${String(inserted[0]?.gasto_id ?? "")}`; if (!expenseRows[0]) throw new Error("PETTY_CASH_EXPENSE_MISSING"); return expense(expenseRows[0]); }
  // H3: `query` opcional y aditivo, mismo contrato que los demás. Caja menor no tiene visibilidad por
  // actor (ver PettyCashRepository en contracts.ts), así que solo filtra/pagina, sin fragmento de
  // visibilidad. `fecha` es NOT NULL aquí (se paga en el acto, reunión 2026-09): a diferencia de
  // gastos, filtrar/paginar por la misma columna `fecha` no tiene el problema de NULLs del cursor.
  async listPettyCash(query?: ListQuery): Promise<PettyCash[] | Page<PettyCash>> {
    const mapRow = (row: DbRow) => ({ id: String(row.id), workId: String(row.obra_id), date: asIsoDate(row.fecha) as string, concept: String(row.concepto), tagId: String(row.etiqueta_id), amount: asNumber(row.valor), registeredBy: String(row.registrado_por), cashBoxId: row.caja_id ? String(row.caja_id) : undefined, paymentMethod: row.medio_pago ? (row.medio_pago as PettyCash["paymentMethod"]) : undefined, iva: row.iva !== undefined ? asNumber(row.iva) : undefined, closeId: row.cierre_id ? String(row.cierre_id) : undefined, costCenterId: row.centro_costo_id ? String(row.centro_costo_id) : undefined });
    if (!query) { const rows = await this.sql<DbRow[]>`select * from caja_menor`; return rows.map(mapRow); }
    const limit = pageLimit(query.limit);
    const workFilter = query.workId ? this.sql`and c.obra_id = ${query.workId}` : this.sql``;
    const cashBoxFilter = query.cashBoxId ? this.sql`and c.caja_id = ${query.cashBoxId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and c.fecha >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and c.fecha < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (c.fecha, c.id) < (${cursor.at}::date, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select c.* from caja_menor c where true ${workFilter} ${cashBoxFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by c.fecha desc, c.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(asIsoDate(last.fecha) as string, String(last.id)) : null;
    return { rows: pageRows.map(mapRow), nextCursor };
  }
  // ---------------------------------------------------------------------------------------------
  // Ingresos y cierres de caja (2026-09-12, migración 202609120003).
  // ---------------------------------------------------------------------------------------------
  async saveIncome(value: Omit<Income, "id">): Promise<Income> {
    const rows = await this.sql<DbRow[]>`insert into ingresos (caja_id, centro_costo_id, obra_id, fecha, concepto, valor, medio_pago, tercero, registrado_por) values (${value.cashBoxId}, ${value.costCenterId}, ${value.workId ?? null}, ${value.date}, ${value.concept}, ${value.amount}, ${value.paymentMethod}, ${value.thirdParty ?? null}, ${value.registeredBy}) returning *`;
    return income(rows[0]);
  }
  async listIncomes(query?: ListQuery): Promise<Income[] | Page<Income>> {
    if (!query) { const rows = await this.sql<DbRow[]>`select * from ingresos`; return rows.map(income); }
    const limit = pageLimit(query.limit);
    const workFilter = query.workId ? this.sql`and i.obra_id = ${query.workId}` : this.sql``;
    const costCenterFilter = query.costCenterId ? this.sql`and i.centro_costo_id = ${query.costCenterId}` : this.sql``;
    const cashBoxFilter = query.cashBoxId ? this.sql`and i.caja_id = ${query.cashBoxId}` : this.sql``;
    const fromFilter = query.from ? this.sql`and i.fecha >= ${query.from}::date` : this.sql``;
    const toFilter = query.to ? this.sql`and i.fecha < (${query.to}::date + 1)` : this.sql``;
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const cursorFilter = cursor ? this.sql`and (i.fecha, i.id) < (${cursor.at}::date, ${cursor.id}::uuid)` : this.sql``;
    const rows = await this.sql<DbRow[]>`select i.* from ingresos i where true ${workFilter} ${costCenterFilter} ${cashBoxFilter} ${fromFilter} ${toFilter} ${cursorFilter} order by i.fecha desc, i.id desc limit ${limit + 1}`;
    const hasMore = rows.length > limit, pageRows = hasMore ? rows.slice(0, limit) : rows, last = pageRows.at(-1);
    const nextCursor = hasMore && last ? encodeCursor(asIsoDate(last.fecha) as string, String(last.id)) : null;
    return { rows: pageRows.map(income), nextCursor };
  }
  async getCashClose(cashBoxId: string, period: string): Promise<CashClose | null> {
    const rows = await this.sql<DbRow[]>`select * from cierres_caja where caja_id=${cashBoxId} and periodo=${`${period}-01`}::date`;
    return rows[0] ? cashClose(rows[0]) : null;
  }
  async listCashClosesByCashBox(cashBoxId: string): Promise<CashClose[]> {
    return (await this.sql<DbRow[]>`select * from cierres_caja where caja_id=${cashBoxId} order by periodo desc`).map(cashClose);
  }
  // Suma de movimientos de la caja en el mes: caja_menor (gastos) e ingresos por separado — el
  // servicio (CashService.closeCashPeriod) es quien combina esto con el saldo anterior.
  async sumCashMovements(cashBoxId: string, period: string): Promise<{ income: number; expense: number }> {
    const periodDate = `${period}-01`;
    const [incomeRows] = await Promise.all([
      this.sql<{ total: string }[]>`select coalesce(sum(valor), 0) as total from ingresos where caja_id=${cashBoxId} and periodo=${periodDate}::date`,
    ]);
    const expenseRows = await this.sql<{ total: string }[]>`select coalesce(sum(valor + iva), 0) as total from caja_menor where caja_id=${cashBoxId} and date_trunc('month', fecha::timestamp)::date=${periodDate}::date`;
    return { income: asNumber(incomeRows[0]?.total ?? 0), expense: asNumber(expenseRows[0]?.total ?? 0) };
  }
  // Saldo final del cierre INMEDIATO ANTERIOR de esta caja (0 si es el primer mes que se cierra).
  async previousCashCloseBalance(cashBoxId: string, period: string): Promise<number> {
    const rows = await this.sql<{ saldo_final: string }[]>`select saldo_final from cierres_caja where caja_id=${cashBoxId} and periodo < ${`${period}-01`}::date order by periodo desc limit 1`;
    return asNumber(rows[0]?.saldo_final ?? 0);
  }
  async upsertCashClose(close: Omit<CashClose, "id">): Promise<CashClose> {
    const rows = await this.sql<DbRow[]>`
      insert into cierres_caja (caja_id, periodo, estado, saldo_inicial, total_ingresos, total_gastos, saldo_final, cerrado_por, cerrado_at)
      values (${close.cashBoxId}, ${`${close.period}-01`}::date, ${close.status}, ${close.openingBalance}, ${close.totalIncome}, ${close.totalExpense}, ${close.closingBalance}, ${close.closedBy ?? null}, ${close.closedAt ?? null})
      on conflict (caja_id, periodo) do update set
        estado = excluded.estado, saldo_inicial = excluded.saldo_inicial, total_ingresos = excluded.total_ingresos,
        total_gastos = excluded.total_gastos, saldo_final = excluded.saldo_final, cerrado_por = excluded.cerrado_por,
        cerrado_at = excluded.cerrado_at, updated_at = now()
      returning *`;
    return cashClose(rows[0]);
  }
  // Etiqueta con `closeId` los movimientos (caja_menor e ingresos) de esa caja/periodo — se llama
  // MIENTRAS el cierre sigue 'abierto' (ver el comentario grande de cierres_caja en la migración): el
  // trigger validar_periodo_caja_abierto rechazaría esta misma escritura si ya estuviera 'cerrado'.
  async tagCashMovements(cashBoxId: string, period: string, closeId: string): Promise<void> {
    const periodDate = `${period}-01`;
    await this.sql`update caja_menor set cierre_id=${closeId} where caja_id=${cashBoxId} and date_trunc('month', fecha::timestamp)::date=${periodDate}::date`;
    await this.sql`update ingresos set cierre_id=${closeId} where caja_id=${cashBoxId} and periodo=${periodDate}::date`;
  }
  async setCashCloseStatus(id: string, status: CashCloseStatus, actorId?: string): Promise<CashClose> {
    const rows = status === "cerrado"
      ? await this.sql<DbRow[]>`update cierres_caja set estado=${status}, cerrado_por=${actorId ?? null}, cerrado_at=now(), updated_at=now() where id=${id} returning *`
      : await this.sql<DbRow[]>`update cierres_caja set estado=${status}, updated_at=now() where id=${id} returning *`;
    if (!rows[0]) throw new Error("CASH_CLOSE_NOT_FOUND");
    return cashClose(rows[0]);
  }
  // Vista movimientos_centro_costo (migración 202609120003): el cruce ingresos(+)/gastos(-) por
  // centro de costo de un mes — reusa la vista en vez de rearmar el union all aquí.
  async listMovementsByCostCenter(period: string): Promise<CostCenterMovement[]> {
    const rows = await this.sql<DbRow[]>`select centro_costo_id, periodo, origen, valor from public.movimientos_centro_costo where periodo=${`${period}-01`}::date`;
    return rows.map((row) => ({ costCenterId: String(row.centro_costo_id), period: (asIsoDate(row.periodo) as string).slice(0, 7), origin: String(row.origen), amount: asNumber(row.valor) }));
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
    if (kind === "works") { const work = value as Extract<CatalogRecord, { societyId: string }>; rows = await this.sql<DbRow[]>`insert into obras (nombre, sociedad_id, estado, centro_costo_id) values (${work.name}, ${work.societyId}, ${work.active ? "activa" : "cerrada"}, ${work.costCenterId ?? null}) returning *`; }
    else if (kind === "costCenters") { const costCenter = value as CatalogCostCenter; rows = await this.sql<DbRow[]>`insert into centros_costo (nombre, codigo, sociedad_id, activo) values (${costCenter.name}, ${costCenter.code ?? null}, ${costCenter.societyId ?? null}, ${costCenter.active}) returning *`; }
    else if (kind === "cashBoxes") { const cashBox = value as CatalogCashBox; rows = await this.sql<DbRow[]>`insert into cajas (nombre, tipo, sociedad_id, centro_costo_id, activo) values (${cashBox.name}, ${cashBox.type}, ${cashBox.societyId ?? null}, ${cashBox.costCenterId ?? null}, ${cashBox.active}) returning *`; }
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
    const table = kind === "works" ? "obras" : kind === "tags" ? "etiquetas" : kind === "items" ? "items" : kind === "societies" ? "sociedades" : kind === "requesters" ? "solicitantes_autorizados" : kind === "costCenters" ? "centros_costo" : kind === "cashBoxes" ? "cajas" : "proveedores";
    const rows = await this.sql.unsafe<DbRow[]>(`select * from ${table} where id = $1`, [id]);
    return rows[0] ? catalogRecord(kind, rows[0]) : null;
  }
  async update(kind: CatalogKind, id: string, value: CatalogPatchRecord): Promise<CatalogRecord> {
    let rows: DbRow[];
    if (kind === "works") {
      const work = value as Partial<Extract<CatalogRecord, { societyId: string }>>, hasCostCenter = Object.hasOwn(work, "costCenterId");
      // Los ${x ?? null} dentro de `case when ... is null` van con cast explícito: un NULL sin tipo
      // en esa posición (a diferencia de coalesce, que infiere del otro argumento) dispara
      // 42P18 "could not determine data type of parameter" contra Postgres real.
      // centro_costo_id sigue el mismo patrón "hasOwn" que aprobador_id en tags (abajo): así un PATCH
      // puede DESASIGNAR el centro default de la obra (costCenterId: null), no solo asignarlo.
      rows = await this.sql<DbRow[]>`update obras set nombre=coalesce(${work.name ?? null}, nombre), sociedad_id=coalesce(${work.societyId ?? null}, sociedad_id), estado=case when ${work.active ?? null}::boolean is null then estado when ${work.active ?? false} then 'activa' else 'cerrada' end, centro_costo_id=case when ${hasCostCenter} then ${work.costCenterId ?? null} else centro_costo_id end where id=${id} returning *`;
    } else if (kind === "costCenters") {
      const costCenter = value as Partial<CatalogCostCenter>, hasSociety = Object.hasOwn(costCenter, "societyId"), hasCode = Object.hasOwn(costCenter, "code");
      rows = await this.sql<DbRow[]>`update centros_costo set nombre=coalesce(${costCenter.name ?? null}, nombre), codigo=case when ${hasCode} then ${costCenter.code ?? null} else codigo end, sociedad_id=case when ${hasSociety} then ${costCenter.societyId ?? null} else sociedad_id end, activo=coalesce(${costCenter.active ?? null}, activo) where id=${id} returning *`;
    } else if (kind === "cashBoxes") {
      const cashBox = value as Partial<CatalogCashBox>, hasSociety = Object.hasOwn(cashBox, "societyId"), hasCostCenter = Object.hasOwn(cashBox, "costCenterId");
      rows = await this.sql<DbRow[]>`update cajas set nombre=coalesce(${cashBox.name ?? null}, nombre), tipo=coalesce(${cashBox.type ?? null}, tipo), sociedad_id=case when ${hasSociety} then ${cashBox.societyId ?? null} else sociedad_id end, centro_costo_id=case when ${hasCostCenter} then ${cashBox.costCenterId ?? null} else centro_costo_id end, activo=coalesce(${cashBox.active ?? null}, activo) where id=${id} returning *`;
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
    orderPayments: { save: ports.saveOrderPayment.bind(ports), listByOrder: ports.listOrderPayments.bind(ports), get: ports.getOrderPayment.bind(ports), annul: ports.annulOrderPayment.bind(ports), listCash: ports.listCashPayments.bind(ports) },
    pettyCash: { save: ports.savePettyCash.bind(ports), list: ports.listPettyCash.bind(ports) },
    incomes: { save: ports.saveIncome.bind(ports), list: ports.listIncomes.bind(ports) },
    cashCloses: {
      get: ports.getCashClose.bind(ports), listByCashBox: ports.listCashClosesByCashBox.bind(ports),
      sumMovements: ports.sumCashMovements.bind(ports), previousClosingBalance: ports.previousCashCloseBalance.bind(ports),
      upsert: ports.upsertCashClose.bind(ports), tagMovements: ports.tagCashMovements.bind(ports),
      setStatus: ports.setCashCloseStatus.bind(ports), listMovementsByCostCenter: ports.listMovementsByCostCenter.bind(ports),
    },
    audit: ports, consecutives: ports, features: ports, items: ports, catalogs: ports, notifications: ports,
  };
}
/**
 * RF-1301 (Reportes): implementación Postgres de `ReportCatalogSource` (lib/services/report-service.ts)
 * — resuelve obra/etiqueta/empresa/usuario/proveedor a nombre para el Excel del reporte de
 * requisiciones. Cuatro consultas mínimas (id+nombre, sin datos sensibles), calcadas de
 * `GET /api/catalogs` (app/api/catalogs/route.ts) pero SIN el filtro `where estado='activo'`: una
 * requisición de meses atrás puede referenciar una obra ya cerrada o un usuario ya dado de baja, y el
 * reporte debe poder mostrar su nombre igual (el mismo criterio que ya usa esa ruta para `users`,
 * "un actor histórico ya desactivado igual debe poder identificarse").
 */
export function postgresReportCatalogSource(databaseUrl = runtimeEnv().DATABASE_URL): ReportCatalogSource {
  return {
    async load() {
      const sql = sharedPostgres(databaseUrl);
      const toMap = (rows: readonly { id: string; nombre: string }[]) => new Map(rows.map((row) => [String(row.id), String(row.nombre)]));
      const [works, tags, societies, users, suppliers, costCenters] = await Promise.all([
        sql<{ id: string; nombre: string }[]>`select id, nombre from obras`,
        sql<{ id: string; nombre: string }[]>`select id, nombre from etiquetas`,
        sql<{ id: string; nombre: string }[]>`select id, nombre from sociedades`,
        sql<{ id: string; nombre: string }[]>`select id, nombre from usuarios`,
        sql<{ id: string; nombre: string }[]>`select id, razon_social as nombre from proveedores`,
        // Centros de costo (UI, 2026-09-12): mismo criterio que las demás — sin `where activo = true`,
        // una requisición histórica puede referenciar un centro ya desactivado y el reporte debe poder
        // mostrar su nombre igual (ver el comentario largo de esta función más arriba).
        sql<{ id: string; nombre: string }[]>`select id, nombre from centros_costo`,
      ]);
      return { works: toMap(works), tags: toMap(tags), societies: toMap(societies), users: toMap(users), suppliers: toMap(suppliers), costCenters: toMap(costCenters) };
    },
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
