import postgres, { type Sql } from "postgres";
import { normalizeItemName, type Actor, type AuditEvent, type Expense, type ExpenseShare, type ItemLine, type Order, type PettyCash, type Requisition, type Role } from "../domain";
import type { AuditRepository, CatalogKind, CatalogPatchRecord, CatalogRecord, CatalogRepository, CatalogSociety, CatalogSupplier, CatalogTag, CatalogItem, CatalogUser, ConsecutiveRepository, IdGenerator, PublicAccessVerifier, ServiceDependencies, TagRepository, TransactionManager, TransactionRepositories } from "../services";
import { hmacSha256, safeEqual } from "../security/crypto";
import { publicEnv, runtimeEnv } from "../security/env";
import { asJsonb } from "./jsonb";

let sharedSql: Sql | undefined;
export function sharedPostgres(databaseUrl = runtimeEnv().DATABASE_URL): Sql { sharedSql ??= postgres(databaseUrl, { prepare: true, max: 10 }); return sharedSql; }

type DbRow = Record<string, unknown>;
const asNumber = (value: unknown) => Number(value ?? 0);
/**
 * Una columna `date` de Postgres llega como Date de JavaScript construido a medianoche
 * UTC. `String(fecha)` produce "Tue Aug 25 2026 19:00:00 GMT-0500", que ademas de no ser
 * un formato presentable muestra el DIA ANTERIOR en Colombia (GMT-5). Se toman los
 * componentes UTC para devolver siempre el mismo dia calendario que guarda la BD.
 */
const asIsoDate = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? ""));
const isElevated = (actor: Actor) => actor.roles.some((role) => ["revisor", "contabilidad", "admin_mizar", "admin_sixteam"].includes(role));
function item(row: DbRow): ItemLine { return { id: String(row.id), itemId: row.item_id ? String(row.item_id) : undefined, description: row.descripcion_libre ? String(row.descripcion_libre) : undefined, quantity: asNumber(row.cantidad), unit: String(row.unidad), possibleSupplier: row.posible_proveedor_texto ? String(row.posible_proveedor_texto) : undefined, productLink: row.link_producto ? String(row.link_producto) : undefined, finalSupplierId: row.proveedor_final_id ? String(row.proveedor_final_id) : undefined, unitBase: asNumber(row.valor_base), unitIva: asNumber(row.iva), unitTotal: asNumber(row.valor_base) + asNumber(row.iva) }; }
function requisition(row: DbRow, items: ItemLine[]): Requisition { return { id: String(row.id), consecutive: String(row.consecutivo), type: row.tipo as Requisition["type"], workId: String(row.obra_id), requesterId: row.solicitante_id ? String(row.solicitante_id) : undefined, externalRequester: row.solicitante_nombre_externo ? { name: String(row.solicitante_nombre_externo), phone: String(row.solicitante_telefono_externo ?? "") } : undefined, channel: row.canal as Requisition["channel"], requiredDate: asIsoDate(row.fecha_requerida), destination: row.destino ? String(row.destino) : undefined, observations: row.observaciones ? String(row.observaciones) : undefined, tagId: row.etiqueta_id ? String(row.etiqueta_id) : undefined, approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, status: row.estado as Requisition["status"], declineReason: row.motivo_declinacion ? String(row.motivo_declinacion) : undefined, returnReason: row.motivo_devolucion ? String(row.motivo_devolucion) : undefined, kapsoEventId: row.kapso_event_id ? String(row.kapso_event_id) : undefined, items, updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined }; }
function order(row: DbRow): Order { return { id: String(row.id), consecutive: String(row.consecutivo), type: row.tipo as Order["type"], requisitionId: String(row.requisicion_id), supplierId: row.proveedor_id ? String(row.proveedor_id) : undefined, itemIds: Array.isArray(row.item_ids) ? row.item_ids.map(String) : [], status: row.estado_cumplimiento as Order["status"], updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : undefined }; }
function expense(row: DbRow): Expense { return { id: String(row.id), workId: String(row.obra_id), origin: row.origen as Expense["origin"], referenceId: String(row.referencia_id), tagId: row.etiqueta_id ? String(row.etiqueta_id) : undefined, supplierId: row.proveedor_id ? String(row.proveedor_id) : undefined, date: asIsoDate(row.fecha), base: asNumber(row.valor_base), iva: asNumber(row.iva), total: asNumber(row.valor_total), period: String(row.periodo).slice(0, 7) }; }
function catalogRecord(kind: CatalogKind, row: DbRow): CatalogRecord {
  if (kind === "works") return { id: String(row.id), name: String(row.nombre), societyId: String(row.sociedad_id), active: row.estado === "activa" };
  if (kind === "tags") return { id: String(row.id), name: String(row.nombre), approverId: row.aprobador_id ? String(row.aprobador_id) : undefined, active: row.activa === true };
  if (kind === "items") return { id: String(row.id), name: String(row.nombre), specification: row.especificacion ? String(row.especificacion) : undefined, unit: String(row.unidad_defecto), category: row.categoria ? String(row.categoria) : undefined, active: row.estado === "activo" };
  if (kind === "societies") return { id: String(row.id), name: String(row.nombre), nit: row.nit ? String(row.nit) : undefined, active: row.activa === true };
  // "roles" no es columna de `usuarios`: siempre se adjunta a la fila antes de llamar a este mapeador
  // (agregada por join/select aparte en get/create/update, ver más abajo).
  if (kind === "users") return { id: String(row.id), name: String(row.nombre), email: String(row.email), phone: row.telefono ? String(row.telefono) : undefined, active: row.estado === "activo", roles: Array.isArray(row.roles) ? row.roles.map(String) as Role[] : [] };
  const contact = row.contacto && typeof row.contacto === "object" ? row.contacto as Record<string, unknown> : {};
  return { id: String(row.id), name: String(row.razon_social), nit: row.nit ? String(row.nit) : undefined, phone: typeof contact.phone === "string" ? contact.phone : undefined, email: typeof contact.email === "string" ? contact.email : undefined, address: typeof contact.address === "string" ? contact.address : undefined, active: row.activo === true };
}

class PostgresPorts implements AuditRepository, ConsecutiveRepository, TagRepository, CatalogRepository {
  constructor(private readonly sql: Sql) {}
  async getRequisition(id: string): Promise<Requisition | null> { const rows = await this.sql<DbRow[]>`select r.*, e.aprobador_id from requisiciones r left join etiquetas e on e.id = r.etiqueta_id where r.id = ${id}`; if (!rows[0]) return null; const items = await this.sql<DbRow[]>`select * from requisicion_items where requisicion_id = ${id} order by created_at`; return requisition(rows[0], items.map(item)); }
  async saveRequisition(value: Requisition): Promise<void> { await this.sql`insert into requisiciones (id, consecutivo, tipo, obra_id, solicitante_id, solicitante_nombre_externo, solicitante_telefono_externo, canal, fecha_requerida, destino, observaciones, etiqueta_id, estado, motivo_declinacion, motivo_devolucion, kapso_event_id) values (${value.id}, ${value.consecutive}, ${value.type}, ${value.workId}, ${value.requesterId ?? null}, ${value.externalRequester?.name ?? null}, ${value.externalRequester?.phone ?? null}, ${value.channel}, ${value.requiredDate || null}, ${value.destination ?? null}, ${value.observations ?? null}, ${value.tagId ?? null}, ${value.status}, ${value.declineReason ?? null}, ${value.returnReason ?? null}, ${value.kapsoEventId ?? null}) on conflict (id) do update set etiqueta_id = excluded.etiqueta_id, estado = excluded.estado, motivo_declinacion = excluded.motivo_declinacion, motivo_devolucion = excluded.motivo_devolucion, destino = excluded.destino, observaciones = excluded.observaciones, kapso_event_id = coalesce(requisiciones.kapso_event_id, excluded.kapso_event_id), updated_at = now()`; await this.sql`delete from requisicion_items where requisicion_id = ${value.id}`; for (const line of value.items) await this.sql`insert into requisicion_items (id, requisicion_id, item_id, descripcion_libre, cantidad, unidad, posible_proveedor_texto, link_producto, proveedor_final_id, valor_base, iva) values (${line.id}, ${value.id}, ${line.itemId ?? null}, ${line.description ?? null}, ${line.quantity}, ${line.unit}, ${line.possibleSupplier ?? null}, ${line.productLink ?? null}, ${line.finalSupplierId ?? null}, ${line.unitBase ?? 0}, ${line.unitIva ?? 0})`; }
  async listRequisitions(): Promise<Requisition[]> { return this.listVisibleRequisitions({ id: "", roles: ["admin_sixteam"] }); }
  // Los ítems se traen en UNA sola consulta con `any(...)` y se agrupan en memoria.
  // Antes se hacía una consulta por requisición (N+1): con la base en us-east-2 cada
  // viaje cuesta ~100 ms, así que 200 requisiciones eran ~200 viajes. Ahora son 2.
  async listVisibleRequisitions(actor: Actor): Promise<Requisition[]> {
    const rows = isElevated(actor) ? await this.sql<DbRow[]>`select r.*, e.aprobador_id from requisiciones r left join etiquetas e on e.id=r.etiqueta_id order by r.created_at desc` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select r.*, e.aprobador_id from requisiciones r join etiquetas e on e.id=r.etiqueta_id where e.aprobador_id=${actor.id} order by r.created_at desc` : await this.sql<DbRow[]>`select r.*, null::uuid as aprobador_id from requisiciones r where r.solicitante_id=${actor.id} order by r.created_at desc`;
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
  async saveOrder(value: Order): Promise<void> { await this.sql`insert into ordenes (id, consecutivo, tipo, requisicion_id, proveedor_id, estado_cumplimiento) values (${value.id}, ${value.consecutive}, ${value.type}, ${value.requisitionId}, ${value.supplierId ?? null}, ${value.status}) on conflict (id) do update set estado_cumplimiento=excluded.estado_cumplimiento, updated_at=now()`; for (const itemId of value.itemIds) await this.sql`insert into orden_items (orden_id, requisicion_item_id) values (${value.id}, ${itemId}) on conflict do nothing`; }
  async listOrders(): Promise<Order[]> { const rows = await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o left join orden_items oi on oi.orden_id=o.id group by o.id`; return rows.map(order); }
  async listVisibleOrders(actor: Actor): Promise<Order[]> { const rows = isElevated(actor) ? await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o left join orden_items oi on oi.orden_id=o.id group by o.id` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join etiquetas e on e.id=r.etiqueta_id left join orden_items oi on oi.orden_id=o.id where e.aprobador_id=${actor.id} group by o.id` : await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o join requisiciones r on r.id=o.requisicion_id left join orden_items oi on oi.orden_id=o.id where r.solicitante_id=${actor.id} group by o.id`; return rows.map(order); }
  async listByRequisition(requisitionId: string): Promise<Order[]> { const rows = await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o left join orden_items oi on oi.orden_id=o.id where o.requisicion_id=${requisitionId} group by o.id`; return rows.map(order); }
  async getOrder(id: string): Promise<Order | null> { const rows = await this.sql<DbRow[]>`select o.*, array_agg(oi.requisicion_item_id) filter (where oi.requisicion_item_id is not null) item_ids from ordenes o left join orden_items oi on oi.orden_id=o.id where o.id=${id} group by o.id`; return rows[0] ? order(rows[0]) : null; }
  async saveExpense(value: Expense): Promise<void> { await this.sql`insert into gastos (id, obra_id, origen, referencia_id, etiqueta_id, proveedor_id, fecha, valor_base, iva) values (${value.id}, ${value.workId}, ${value.origin}, ${value.referenceId}, ${value.tagId ?? null}, ${value.supplierId ?? null}, ${value.date}, ${value.base}, ${value.iva}) on conflict (origen, referencia_id) do nothing`; }
  async getExpense(id: string): Promise<Expense | null> { const rows = await this.sql<DbRow[]>`select * from gastos where id=${id}`; return rows[0] ? expense(rows[0]) : null; }
  async saveShares(shares: ExpenseShare[]): Promise<void> { if (!shares.length) return; await this.sql`delete from gastos_reparto where gasto_id=${shares[0].expenseId}`; for (const share of shares) await this.sql`insert into gastos_reparto (gasto_id, obra_id, valor) values (${share.expenseId}, ${share.workId}, ${share.amount})`; }
  async listExpenses(): Promise<Expense[]> { return (await this.sql<DbRow[]>`select * from gastos`).map(expense); }
  async listVisibleExpenses(actor: Actor): Promise<Expense[]> { const rows = isElevated(actor) ? await this.sql<DbRow[]>`select * from gastos` : actor.roles.includes("aprobador") ? await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id join etiquetas e on e.id=r.etiqueta_id where e.aprobador_id=${actor.id}` : await this.sql<DbRow[]>`select g.* from gastos g join ordenes o on o.id=g.referencia_id join requisiciones r on r.id=o.requisicion_id where r.solicitante_id=${actor.id}`; return rows.map(expense); }
  async listByReference(referenceId: string): Promise<Expense[]> { return (await this.sql<DbRow[]>`select g.* from gastos g where g.referencia_id=${referenceId} or exists (select 1 from ordenes o where o.id=g.referencia_id and o.requisicion_id=${referenceId})`).map(expense); }
  async savePettyCash(value: PettyCash): Promise<Expense> { const inserted = await this.sql<DbRow[]>`insert into caja_menor (id, obra_id, fecha, concepto, etiqueta_id, valor, registrado_por) values (${value.id}, ${value.workId}, ${value.date}, ${value.concept}, ${value.tagId}, ${value.amount}, ${value.registeredBy}) returning gasto_id`; const expenseRows = await this.sql<DbRow[]>`select * from gastos where id=${String(inserted[0]?.gasto_id ?? "")}`; if (!expenseRows[0]) throw new Error("PETTY_CASH_EXPENSE_MISSING"); return expense(expenseRows[0]); }
  async listPettyCash(): Promise<PettyCash[]> { const rows = await this.sql<DbRow[]>`select * from caja_menor`; return rows.map((row) => ({ id: String(row.id), workId: String(row.obra_id), date: asIsoDate(row.fecha), concept: String(row.concepto), tagId: String(row.etiqueta_id), amount: asNumber(row.valor), registeredBy: String(row.registrado_por) })); }
  async append(event: AuditEvent): Promise<void> { await this.sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values (${event.entity}, ${event.entityId}, ${event.event.toUpperCase().replace(/[^A-Z0-9_]/g, "_")}, ${event.origin ?? "web"}, ${event.actorId ?? null}, ${event.at.toISOString()}, ${asJsonb(this.sql, event.data ?? {})})`; }
  async list(entity: string, entityId: string): Promise<AuditEvent[]> { const rows = await this.sql<DbRow[]>`select entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json from auditoria where entidad=${entity} and entidad_id=${entityId} order by fecha, id`; return rows.map((row) => ({ entity: String(row.entidad), entityId: String(row.entidad_id), event: String(row.evento).toLocaleLowerCase(), actorId: row.usuario_id ? String(row.usuario_id) : undefined, at: new Date(String(row.fecha)), data: row.datos_json && typeof row.datos_json === "object" ? row.datos_json as Record<string, unknown> : {}, origin: row.origen as AuditEvent["origin"] })); }
  async take(prefix: "REQ" | "OC" | "OP", year: number): Promise<string> { const rows = await this.sql<DbRow[]>`insert into consecutivos (tipo_documento, anio, siguiente) values (${prefix}, ${year}, 2) on conflict (tipo_documento, anio) do update set siguiente=consecutivos.siguiente+1 returning siguiente-1 as value`; return `${prefix}-${year}-${String(rows[0].value).padStart(4, "0")}`; }
  async getApproverId(tagId: string): Promise<string | null> { const rows = await this.sql<DbRow[]>`select aprobador_id from etiquetas where id=${tagId} and activa=true`; return rows[0]?.aprobador_id ? String(rows[0].aprobador_id) : null; }
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
      // RF-004: nunca se crea la cuenta de Auth aquí; `id` ya fue validado por
      // CatalogService.validateUserExists contra auth.users antes de llegar a este INSERT.
      const user = value as CatalogUser;
      rows = await this.sql<DbRow[]>`insert into usuarios (id, nombre, email, telefono, estado) values (${user.id}, ${user.name}, ${user.email}, ${user.phone ?? null}, ${user.active ? "activo" : "inactivo"}) returning *`;
      for (const rol of user.roles) await this.sql`insert into usuario_roles (usuario_id, rol) values (${user.id}, ${rol}) on conflict do nothing`;
      return catalogRecord(kind, { ...rows[0], roles: [...user.roles] });
    }
    else { const supplier = value as CatalogSupplier; rows = await this.sql<DbRow[]>`insert into proveedores (razon_social, nit, contacto, activo) values (${supplier.name}, ${supplier.nit ?? null}, ${asJsonb(this.sql, { ...(supplier.phone ? { phone: supplier.phone } : {}), ...(supplier.email ? { email: supplier.email } : {}), ...(supplier.address ? { address: supplier.address } : {}) })}, ${supplier.active}) returning *`; }
    return catalogRecord(kind, rows[0]);
  }
  async get(kind: CatalogKind, id: string): Promise<CatalogRecord | null> {
    if (kind === "users") { const rows = await this.sql<DbRow[]>`select u.*, coalesce(array_agg(ur.rol) filter (where ur.rol is not null), '{}') as roles from usuarios u left join usuario_roles ur on ur.usuario_id = u.id where u.id = ${id} group by u.id`; return rows[0] ? catalogRecord(kind, rows[0]) : null; }
    const table = kind === "works" ? "obras" : kind === "tags" ? "etiquetas" : kind === "items" ? "items" : kind === "societies" ? "sociedades" : "proveedores";
    const rows = await this.sql.unsafe<DbRow[]>(`select * from ${table} where id = $1`, [id]);
    return rows[0] ? catalogRecord(kind, rows[0]) : null;
  }
  async update(kind: CatalogKind, id: string, value: CatalogPatchRecord): Promise<CatalogRecord> {
    let rows: DbRow[];
    if (kind === "works") {
      const work = value as Partial<Extract<CatalogRecord, { societyId: string }>>;
      rows = await this.sql<DbRow[]>`update obras set nombre=coalesce(${work.name ?? null}, nombre), sociedad_id=coalesce(${work.societyId ?? null}, sociedad_id), estado=case when ${work.active ?? null} is null then estado when ${work.active ?? false} then 'activa' else 'cerrada' end where id=${id} returning *`;
    } else if (kind === "tags") {
      const tag = value as Partial<CatalogTag>, hasApprover = Object.hasOwn(tag, "approverId");
      rows = await this.sql<DbRow[]>`update etiquetas set nombre=coalesce(${tag.name ?? null}, nombre), aprobador_id=case when ${hasApprover} then ${tag.approverId ?? null} else aprobador_id end, activa=coalesce(${tag.active ?? null}, activa) where id=${id} returning *`;
    } else if (kind === "items") {
      const itemValue = value as Partial<CatalogItem>, name = itemValue.name ?? null, hasSpecification = Object.hasOwn(itemValue, "specification"), hasCategory = Object.hasOwn(itemValue, "category");
      rows = await this.sql<DbRow[]>`update items set nombre=coalesce(${name}, nombre), nombre_normalizado=case when ${name} is null then nombre_normalizado else ${normalizeItemName(name ?? "")} end, especificacion=case when ${hasSpecification} then ${itemValue.specification ?? null} else especificacion end, unidad_defecto=coalesce(${itemValue.unit ?? null}, unidad_defecto), categoria=case when ${hasCategory} then ${itemValue.category ?? null} else categoria end, estado=case when ${itemValue.active ?? null} is null then estado when ${itemValue.active ?? false} then 'activo' else 'inactivo' end where id=${id} returning *`;
    } else if (kind === "societies") {
      const society = value as Partial<CatalogSociety>, hasNit = Object.hasOwn(society, "nit");
      rows = await this.sql<DbRow[]>`update sociedades set nombre=coalesce(${society.name ?? null}, nombre), nit=case when ${hasNit} then ${society.nit ?? null} else nit end, activa=coalesce(${society.active ?? null}, activa) where id=${id} returning *`;
    } else if (kind === "users") {
      const userPatch = value as Partial<CatalogUser>, hasPhone = Object.hasOwn(userPatch, "phone");
      // El trigger usuarios_baja_etiquetas_activas puede rechazar este UPDATE (errcode 23514) si el
      // usuario sigue siendo aprobador de una etiqueta activa; CatalogService.conflict lo traduce.
      rows = await this.sql<DbRow[]>`update usuarios set nombre=coalesce(${userPatch.name ?? null}, nombre), telefono=case when ${hasPhone} then ${userPatch.phone ?? null} else telefono end, estado=case when ${userPatch.active ?? null} is null then estado when ${userPatch.active ?? false} then 'activo' else 'inactivo' end where id=${id} returning *`;
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
    } else {
      const supplier = value as Partial<CatalogSupplier>, hasNit = Object.hasOwn(supplier, "nit"), contactPatch: Record<string, string | null> = {};
      for (const field of ["phone", "email", "address"] as const) if (Object.hasOwn(supplier, field)) contactPatch[field] = supplier[field] ?? null;
      const contact = JSON.stringify(contactPatch);
      rows = await this.sql<DbRow[]>`update proveedores set razon_social=coalesce(${supplier.name ?? null}, razon_social), nit=case when ${hasNit} then ${supplier.nit ?? null} else nit end, contacto=(contacto - array(select jsonb_object_keys(${contact}::jsonb))) || jsonb_strip_nulls(${contact}::jsonb), activo=coalesce(${supplier.active ?? null}, activo) where id=${id} returning *`;
    }
    if (!rows[0]) throw new Error("CATALOG_NOT_FOUND");
    return catalogRecord(kind, rows[0]);
  }
  async findSupplierDuplicate(value: Pick<CatalogSupplier, "name" | "nit">, exceptId?: string): Promise<string | null> { const rows = await this.sql<{ id: string }[]>`select id from proveedores where (${exceptId ?? null}::uuid is null or id <> ${exceptId ?? null}) and (lower(btrim(razon_social)) = lower(btrim(${value.name})) or (${value.nit ?? null} is not null and nit_normalizado = nullif(regexp_replace(${value.nit ?? null}, '[^0-9A-Za-z]', '', 'g'), ''))) limit 1`; return rows[0]?.id ?? null; }
  async isEligibleApprover(id: string): Promise<boolean> { const rows = await this.sql<{ eligible: boolean }[]>`select exists(select 1 from usuarios u join usuario_roles ur on ur.usuario_id=u.id where u.id=${id} and u.estado='activo' and ur.rol in ('aprobador', 'revisor', 'admin_sixteam')) as eligible`; return rows[0]?.eligible === true; }
  // RF-004: la conexión directa a Postgres (DATABASE_URL) puede leer auth.users; nunca se INSERTA
  // ni modifica esa tabla desde esta plataforma, solo se verifica que el id ya exista en Auth.
  async authUserExists(id: string): Promise<boolean> { const rows = await this.sql<{ existe: boolean }[]>`select exists(select 1 from auth.users where id=${id}) as existe`; return rows[0]?.existe === true; }
}

class PostgresTransactionManager implements TransactionManager {
  constructor(private readonly sql: Sql) {}
  async transaction<T>(lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T> { return this.sql.begin(async (tx) => { const [kind, id] = lockKey?.includes(":") ? lockKey.split(":", 2) : ["requisition", lockKey]; if (id && kind === "requisition") await tx`select id from requisiciones where id=${id} for update`; else if (id && kind === "order") await tx`select id from ordenes where id=${id} for update`; else if (id && kind === "expense") await tx`select id from gastos where id=${id} for update`; return work(transactionRepositories(new PostgresPorts(tx as unknown as Sql))); }) as Promise<T>; }
}
function transactionRepositories(ports: PostgresPorts): TransactionRepositories { return { requisitions: { get: ports.getRequisition.bind(ports), save: ports.saveRequisition.bind(ports), list: ports.listRequisitions.bind(ports), listVisibleTo: ports.listVisibleRequisitions.bind(ports) }, orders: { save: ports.saveOrder.bind(ports), list: ports.listOrders.bind(ports), listVisibleTo: ports.listVisibleOrders.bind(ports), listByRequisition: ports.listByRequisition.bind(ports), get: ports.getOrder.bind(ports) }, expenses: { get: ports.getExpense.bind(ports), save: ports.saveExpense.bind(ports), saveShares: ports.saveShares.bind(ports), list: ports.listExpenses.bind(ports), listVisibleTo: ports.listVisibleExpenses.bind(ports), listByReference: ports.listByReference.bind(ports) }, pettyCash: { save: ports.savePettyCash.bind(ports), list: ports.listPettyCash.bind(ports) }, audit: ports, consecutives: ports, tags: ports, features: ports, items: ports, catalogs: ports, notifications: ports }; }
export function createPostgresDependencies(databaseUrl = runtimeEnv().DATABASE_URL): ServiceDependencies {
  const sql = sharedPostgres(databaseUrl), ports = new PostgresPorts(sql);
  const publicAccess: PublicAccessVerifier = { verify: async (workId, linkToken, code) => { const env = publicEnv(); if (!safeEqual(hmacSha256(workId, env.PUBLIC_FORM_CODE_PEPPER), linkToken)) return false; const rows = await sql<DbRow[]>`select public_submission_enabled and public_code_hash is not null and public_code_hash = extensions.crypt(${code}, public_code_hash) as valid from obras where id=${workId}`; return rows[0]?.valid === true; } };
  const transactionPorts = transactionRepositories(ports);
  return { ...transactionPorts, pettyCash: { save: ports.savePettyCash.bind(ports), list: ports.listPettyCash.bind(ports) }, publicAccess, tags: ports, features: ports, items: ports, catalogs: ports, notifications: ports, transactions: new PostgresTransactionManager(sql), clock: { now: () => new Date() }, ids: { next: () => crypto.randomUUID() } as IdGenerator };
}
