import type { Sql } from "postgres";
import type { AuditLogQuery, AuditLogRepository, AuditLogRow, AuditNameRefs, AuditNames } from "../services/audit-log-service";
import type { AuditEntityGroup, AuditEventGroup, AuditOriginKey } from "../services/audit-log-options";
import { AUDIT_EVENT_OPTIONS } from "../services/audit-log-options";

/**
 * Lectura del historial de cambios (GET /api/audit) sobre `auditoria`. Solo lectura: la tabla es
 * inmutable (trigger `auditoria_inmutable`) y aquí no se escribe nada.
 *
 * El `where` base repite AL PIE DE LA LETRA el predicado del índice parcial
 * `auditoria_eventos_app_fecha_idx` (202609250001_historial_de_cambios.sql): así el planificador lo
 * usa para el orden (fecha desc, id desc) y el cursor. Esas constantes van como texto literal, no como
 * parámetros, porque un parámetro impide demostrar que la consulta cae dentro del índice.
 *
 * Los grupos de «sobre qué» y «por dónde» son fragmentos SQL fijos, escritos aquí: ningún texto que
 * llegue por la URL se concatena a la consulta (la ruta además los valida contra la lista cerrada).
 */
const COLOMBIA_OFFSET = "-05:00";
const DAY_MS = 86_400_000;

/** «Ingresos y descargas»: no son cambios. El listado los oculta salvo que se pidan explícitamente. */
function accessPredicate(sql: Sql) {
  return sql`((a.entidad = 'sesion' and a.evento like 'SESION\\_%') or a.entidad in ('reporte', 'mcp') or a.evento like '%\\_DESCARGADO')`;
}
function entityPredicate(sql: Sql, group: AuditEntityGroup) {
  switch (group) {
    case "requisicion": return sql`and a.entidad in ('requisicion', 'requisicion_item')`;
    case "orden": return sql`and a.entidad = 'orden' and a.evento not in ('PAGO_REGISTRADO', 'PAGO_ANULADO')`;
    case "pago": return sql`and a.entidad = 'orden' and a.evento in ('PAGO_REGISTRADO', 'PAGO_ANULADO')`;
    case "gasto": return sql`and a.entidad in ('gasto', 'caja_menor')`;
    case "proveedor": return sql`and a.entidad in ('proveedor', 'suppliers')`;
    case "catalogo": return sql`and a.entidad in ('works', 'tags', 'items', 'item', 'societies', 'costCenters', 'cashBoxes', 'requesters')`;
    case "usuario": return sql`and (a.entidad = 'users' or (a.entidad = 'sesion' and a.evento like 'CLAVE\\_%'))`;
    case "permisos": return sql`and a.entidad = 'configuracion'`;
    case "portal": return sql`and a.entidad = 'acceso_publico'`;
    case "adjunto": return sql`and a.entidad = 'adjunto'`;
    case "pantalla": return sql`and a.entidad = 'sesion_pantalla'`;
    case "accesos": return sql`and ${accessPredicate(sql)}`;
  }
}
function originPredicate(sql: Sql, origin: AuditOriginKey) {
  switch (origin) {
    // Web con usuario = la plataforma; web SIN usuario = el portal público (la excepción, un intento de
    // ingreso con un correo inexistente, es `sesion`, y se cuenta como web: mismo criterio que la pantalla).
    case "web": return sql`and a.origen = 'web' and (a.usuario_id is not null or a.entidad = 'sesion')`;
    case "publico": return sql`and a.origen = 'web' and a.usuario_id is null and a.entidad <> 'sesion'`;
    case "whatsapp": return sql`and a.origen = 'kapso'`;
    case "mcp": return sql`and a.origen = 'mcp'`;
    case "sistema": return sql`and a.origen in ('sistema', 'importacion')`;
  }
}
function eventCodes(group: AuditEventGroup): string[] {
  return [...(AUDIT_EVENT_OPTIONS.find((option) => option.key === group)?.events ?? [])];
}
/** `to` es inclusivo: hasta el final de ese día en hora de Colombia. */
function endOfDay(date: string): string { return new Date(new Date(`${date}T00:00:00${COLOMBIA_OFFSET}`).getTime() + DAY_MS).toISOString(); }

type Row = { id: string; entity: string; entityId: string | null; event: string; origin: string; actorId: string | null; at: string; data: unknown };
type NameRow = { id: string; name: string };

export class PostgresAuditLogRepository implements AuditLogRepository {
  constructor(private readonly sql: Sql) {}

  async listPage(query: AuditLogQuery): Promise<AuditLogRow[]> {
    const sql = this.sql;
    const empty = sql``;
    const rows = await sql<Row[]>`
      select a.id::text as id, a.entidad as entity, a.entidad_id::text as "entityId", a.evento as event, a.origen::text as origin,
             a.usuario_id::text as "actorId", to_char(a.fecha at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at, a.datos_json as data
        from auditoria a
       where a.evento not in ('INSERT', 'UPDATE', 'DELETE', 'STATE_CHANGE') and a.evento not like 'KAPSO\\_PROCESSING\\_%'
         ${query.from ? sql`and a.fecha >= ${`${query.from}T00:00:00${COLOMBIA_OFFSET}`}::timestamptz` : empty}
         ${query.to ? sql`and a.fecha < ${endOfDay(query.to)}::timestamptz` : empty}
         ${query.actorId ? sql`and a.usuario_id = ${query.actorId}::uuid` : empty}
         ${query.entity ? entityPredicate(sql, query.entity) : empty}
         ${query.event ? sql`and a.evento = any(${eventCodes(query.event)}::text[])` : empty}
         ${!query.entity && !query.event ? sql`and not ${accessPredicate(sql)}` : empty}
         ${query.origin ? originPredicate(sql, query.origin) : empty}
         ${query.cursor ? sql`and (a.fecha, a.id) < (${query.cursor.at}::timestamptz, ${query.cursor.id}::bigint)` : empty}
       order by a.fecha desc, a.id desc
       limit ${query.limit + 1}`;
    return rows.map((row) => ({ ...row, data: row.data && typeof row.data === "object" && !Array.isArray(row.data) ? row.data as Record<string, unknown> : {} }));
  }

  async resolveNames(refs: AuditNameRefs): Promise<AuditNames> {
    const sql = this.sql;
    // Solo se consultan los tipos con ids, y los ids que no son uuid se descartan antes (un evento viejo
    // o raro no puede tumbar la página con un 22P02).
    const uuids = (ids: readonly string[]) => ids.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    const run = async (ids: readonly string[], query: (ids: string[]) => Promise<NameRow[]>): Promise<ReadonlyMap<string, string>> => {
      const valid = uuids(ids);
      if (!valid.length) return new Map();
      return new Map((await query(valid)).map((row) => [row.id, row.name]));
    };
    const [users, works, tags, items, suppliers, societies, costCenters, cashBoxes, requisitions, orders, expenses, requisitionItems, payments, screens] = await Promise.all([
      run(refs.users, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from usuarios where id = any(${ids}::uuid[])`),
      run(refs.works, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from obras where id = any(${ids}::uuid[])`),
      run(refs.tags, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from etiquetas where id = any(${ids}::uuid[])`),
      run(refs.items, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from items where id = any(${ids}::uuid[])`),
      run(refs.suppliers, (ids) => sql<NameRow[]>`select id::text as id, razon_social as name from proveedores where id = any(${ids}::uuid[])`),
      run(refs.societies, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from sociedades where id = any(${ids}::uuid[])`),
      run(refs.costCenters, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from centros_costo where id = any(${ids}::uuid[])`),
      run(refs.cashBoxes, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from cajas where id = any(${ids}::uuid[])`),
      run(refs.requisitions, (ids) => sql<NameRow[]>`select id::text as id, consecutivo as name from requisiciones where id = any(${ids}::uuid[]) and consecutivo is not null`),
      run(refs.orders, (ids) => sql<NameRow[]>`select id::text as id, consecutivo as name from ordenes where id = any(${ids}::uuid[]) and consecutivo is not null`),
      run(refs.expenses, (ids) => sql<NameRow[]>`select g.id::text as id, o.consecutivo as name from gastos g join ordenes o on o.id = g.referencia_id where g.id = any(${ids}::uuid[]) and o.consecutivo is not null`),
      run(refs.requisitionItems, (ids) => sql<NameRow[]>`select ri.id::text as id, r.consecutivo as name from requisicion_items ri join requisiciones r on r.id = ri.requisicion_id where ri.id = any(${ids}::uuid[]) and r.consecutivo is not null`),
      run(refs.payments, (ids) => sql<NameRow[]>`select p.id::text as id, o.consecutivo as name from pagos_orden p join ordenes o on o.id = p.orden_id where p.id = any(${ids}::uuid[]) and o.consecutivo is not null`),
      run(refs.screens, (ids) => sql<NameRow[]>`select id::text as id, nombre as name from sesiones_pantalla where id = any(${ids}::uuid[])`),
    ]);
    return { users, works, tags, items, suppliers, societies, costCenters, cashBoxes, requisitions, orders, expenses, requisitionItems, payments, screens };
  }
}
