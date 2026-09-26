import { ALL_ROLES, DomainError, PERMISSION_CATALOG, assertPermission, assertValidPermissionOverrides, resolveRolePermissions, type Actor, type Role, type RolePermissionOverrides } from "../domain";
import { AUDIT_ENTITY_OPTIONS, AUDIT_EVENT_OPTIONS, AUDIT_ORIGIN_OPTIONS, AUDIT_PAGE_DEFAULT, AUDIT_PAGE_MAX, type AuditEntityGroup, type AuditEventGroup, type AuditOriginKey } from "./audit-log-options";

/**
 * HISTORIAL DE CAMBIOS (ADM-08 del plan de pruebas, RF-1003 del PRD: «toda transición y edición de
 * catálogo queda en auditoría inmutable»). La tabla `auditoria` ya guardaba todo; faltaba poder
 * LEERLA sin abrir Postgres. Este servicio es de solo lectura y hace tres cosas:
 *
 * 1. Autoriza por el permiso `audit:read` (admin_sixteam por "*", admin_mizar y revisor por defecto).
 * 2. Pide una página al repositorio (cursor por fecha+id, solo eventos de aplicación: las copias fila
 *    a fila de los disparadores genéricos no tienen actor y repiten lo mismo varias veces).
 * 3. Traduce cada evento a lenguaje de negocio: quién (nombre), qué pasó, sobre qué (consecutivo o
 *    nombre) y el antes/después legible.
 *
 * LO QUE NUNCA SALE DE AQUÍ, por construcción y no por disciplina: los detalles se arman con una LISTA
 * BLANCA de campos con nombre de negocio (`FIELD_LABELS` y los casos por evento). Un campo que no esté
 * en la lista no se muestra, así que ni un evento viejo ni uno futuro puede filtrar cédulas/NIT,
 * datos bancarios, correos, teléfonos, contraseñas o hashes aunque alguien los hubiera guardado. Y
 * ningún identificador interno (UUID) se muestra: los ids se resuelven a nombres o consecutivos, y lo
 * que no se resuelve sale como «no disponible».
 */

/** Fila cruda de `auditoria` tal como la entrega el repositorio. `cursorAt` es la fecha con
 *  microsegundos (texto), necesaria para que el cursor no salte ni repita filas. */
export interface AuditLogRow {
  id: string;
  entity: string;
  entityId: string | null;
  event: string;
  origin: string;
  actorId: string | null;
  at: string;
  data: Record<string, unknown>;
}
export interface AuditLogQuery {
  from?: string;
  to?: string;
  actorId?: string;
  entity?: AuditEntityGroup;
  event?: AuditEventGroup;
  origin?: AuditOriginKey;
  limit: number;
  cursor?: { at: string; id: string };
}
/** Ids a traducir a nombre, por tipo. */
export interface AuditNameRefs {
  users: string[]; works: string[]; tags: string[]; items: string[]; suppliers: string[]; societies: string[];
  costCenters: string[]; cashBoxes: string[]; requisitions: string[]; orders: string[]; expenses: string[];
  requisitionItems: string[]; payments: string[]; screens: string[];
}
export type AuditNames = { [K in keyof AuditNameRefs]: ReadonlyMap<string, string> };
export interface AuditLogRepository {
  /** Hasta `query.limit + 1` filas, de la más nueva a la más vieja. */
  listPage(query: AuditLogQuery): Promise<AuditLogRow[]>;
  resolveNames(refs: AuditNameRefs): Promise<AuditNames>;
}

export interface AuditDetail { label: string; before?: string; after?: string; value?: string }
export interface AuditEntryView {
  /** Clave estable para la lista (el id numérico de `auditoria`, no un UUID). */
  key: string;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  entityLabel: string;
  origin: AuditOriginKey;
  originLabel: string;
  details: AuditDetail[];
}
export interface AuditLogPage { rows: AuditEntryView[]; nextCursor: string | null }

// ---------------------------------------------------------------------------------------------
// Cursor: base64url de "<fecha ISO con microsegundos>|<id numérico>". Opaco para el cliente.
// ---------------------------------------------------------------------------------------------
const CURSOR_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export function encodeAuditCursor(at: string, id: string): string { return Buffer.from(`${at}|${id}`, "utf8").toString("base64url"); }
export function decodeAuditCursor(cursor: string): { at: string; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [at, id, ...rest] = raw.split("|");
  if (rest.length || !at || !id || !CURSOR_AT_RE.test(at) || !/^\d{1,18}$/.test(id)) throw new DomainError("INVALID_INPUT", "Cursor inválido");
  return { at, id };
}

export class AuditLogService {
  constructor(private readonly deps: { repository: AuditLogRepository }) {}

  async list(actor: Actor, filters: Omit<AuditLogQuery, "limit" | "cursor"> & { limit?: number; cursor?: string }): Promise<AuditLogPage> {
    assertPermission(actor, "audit:read");
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? AUDIT_PAGE_DEFAULT), 1), AUDIT_PAGE_MAX);
    if (filters.from && filters.to && filters.from > filters.to) throw new DomainError("INVALID_INPUT", "La fecha inicial no puede ser posterior a la final");
    const cursor = filters.cursor ? decodeAuditCursor(filters.cursor) : undefined;
    const fetched = await this.deps.repository.listPage({ ...filters, limit, cursor });
    const page = fetched.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = fetched.length > limit && last ? encodeAuditCursor(last.at, last.id) : null;
    const names = await this.deps.repository.resolveNames(collectRefs(page));
    return { rows: page.map((row) => describeAuditRow(row, names)), nextCursor };
  }
}

// ---------------------------------------------------------------------------------------------
// Referencias: qué ids de cada fila hay que traducir a nombre.
// ---------------------------------------------------------------------------------------------
const CATALOG_REF: Record<string, keyof AuditNameRefs> = { works: "works", tags: "tags", items: "items", item: "items", suppliers: "suppliers", proveedor: "suppliers", societies: "societies", costCenters: "costCenters", cashBoxes: "cashBoxes", users: "users", requisicion: "requisitions", orden: "orders", gasto: "expenses", requisicion_item: "requisitionItems", sesion: "users", sesion_pantalla: "screens" };
const DATA_REF: Record<string, keyof AuditNameRefs> = { approverId: "users", previousApproverId: "users", tagId: "tags", workId: "works", costCenterId: "costCenters", billedCompanyId: "societies", societyId: "societies", supplierId: "suppliers", requisitionId: "requisitions", orderId: "orders" };
const PARENT_REF: Record<string, keyof AuditNameRefs> = { requisicion: "requisitions", requisicion_item: "requisitionItems", pago_orden: "payments" };

function str(value: unknown): string | undefined { return typeof value === "string" && value ? value : undefined; }
function obj(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

export function collectRefs(rows: readonly AuditLogRow[]): AuditNameRefs {
  const sets = Object.fromEntries((["users", "works", "tags", "items", "suppliers", "societies", "costCenters", "cashBoxes", "requisitions", "orders", "expenses", "requisitionItems", "payments", "screens"] as const).map((key) => [key, new Set<string>()])) as Record<keyof AuditNameRefs, Set<string>>;
  const addFields = (record: Record<string, unknown> | undefined) => { if (!record) return; for (const [field, kind] of Object.entries(DATA_REF)) { const value = str(record[field]); if (value) sets[kind].add(value); } };
  for (const row of rows) {
    if (row.actorId) sets.users.add(row.actorId);
    const kind = CATALOG_REF[row.entity];
    if (kind && row.entityId) sets[kind].add(row.entityId);
    addFields(row.data); addFields(obj(row.data.before)); addFields(obj(row.data.after));
    const parent = PARENT_REF[str(row.data.parentEntity) ?? ""], parentId = str(row.data.parentId);
    if (parent && parentId) sets[parent].add(parentId);
    for (const skipped of Array.isArray(row.data.overrodeApprovers) ? row.data.overrodeApprovers : []) { const id = str(obj(skipped)?.id); if (id) sets.users.add(id); }
  }
  return Object.fromEntries(Object.entries(sets).map(([key, set]) => [key, [...set]])) as unknown as AuditNameRefs;
}

// ---------------------------------------------------------------------------------------------
// Presentación: lenguaje de negocio, lista blanca de campos, nunca un UUID.
// ---------------------------------------------------------------------------------------------
const NOT_AVAILABLE = "no disponible";
const money = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const ROLE_LABELS: Record<string, string> = { solicitante: "Solicitante", revisor: "Revisor", aprobador: "Aprobador", contabilidad: "Contabilidad", admin_mizar: "Administrador Mizar", admin_sixteam: "Administrador Sixteam" };
const REQUISITION_STATUS_LABELS: Record<string, string> = { enviada: "Enviada", en_revision: "En revisión", en_aprobacion: "En aprobación", aprobada: "Aprobada", devuelta: "Devuelta", declinada: "Declinada" };
const ORDER_STATUS_LABELS: Record<string, string> = { generada: "Generada", cumplida: "Cumplida", no_cumplida: "No cumplida", no_necesario: "No necesaria", pendiente: "Pendiente de contabilizar", contabilizada: "Contabilizada", pagada: "Pagada" };
const PAYMENT_METHOD_LABELS: Record<string, string> = { efectivo: "Efectivo (caja)", transferencia: "Transferencia", cheque: "Cheque", tarjeta: "Tarjeta", otro: "Otro" };
const COST_CENTER_TYPE_LABELS: Record<string, string> = { obra: "Obra", administrativo: "Administrativo", personal: "Personal", empresa: "Empresa" };
const CASH_BOX_TYPE_LABELS: Record<string, string> = { caja_menor: "Caja menor", administrativa: "Administrativa", banco: "Banco", personal: "Personal" };
const IDENTIFICATION_TYPE_LABELS: Record<string, string> = { NIT: "NIT", CC: "Cédula de ciudadanía", CE: "Cédula de extranjería", PAS: "Pasaporte", PPT: "Permiso de protección temporal" };
const ENTITY_LABELS: Record<string, string> = {
  requisicion: "Requisición", requisicion_item: "Requisición", orden: "Orden", gasto: "Gasto", caja_menor: "Caja menor",
  proveedor: "Proveedor", suppliers: "Proveedor", works: "Obra", tags: "Etiqueta", items: "Ítem", item: "Ítem", societies: "Empresa",
  costCenters: "Centro de costo", cashBoxes: "Caja", requesters: "Solicitante de WhatsApp", users: "Usuario",
  configuracion: "Permisos por rol", acceso_publico: "Portal público", adjunto: "Soporte", reporte: "Reporte", sesion: "Cuenta",
  sesion_pantalla: "Pantalla de oficina", mcp: "Asistente (MCP)",
};
/** Cómo se nombra cada catálogo dentro de una frase («Creó la obra», «Desactivó al usuario»). */
const CATALOG_NOUN: Record<string, string> = { works: "la obra", tags: "la etiqueta", items: "el ítem", suppliers: "el proveedor", societies: "la empresa", costCenters: "el centro de costo", cashBoxes: "la caja", users: "al usuario", requesters: "a un solicitante de WhatsApp" };

function yesNo(value: unknown): string { return value === true ? "Sí" : "No"; }
function nameOf(names: AuditNames, kind: keyof AuditNames, id: unknown, empty = NOT_AVAILABLE): string {
  const key = str(id);
  if (!key) return empty;
  return names[kind].get(key) ?? NOT_AVAILABLE;
}
function moneyOf(value: unknown): string | undefined { return typeof value === "number" && Number.isFinite(value) ? money.format(value) : undefined; }
function dateOf(value: unknown): string | undefined {
  const text = str(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return undefined;
  const [year, month, day] = text.split("-");
  return `${day}/${month}/${year}`;
}
function humanize(code: string): string { const text = code.toLowerCase().replace(/_/g, " "); return text.charAt(0).toUpperCase() + text.slice(1); }

/** LISTA BLANCA de campos de un antes/después de catálogo o proveedor. Lo que no esté aquí no se pinta. */
type Formatter = (value: unknown, names: AuditNames, entity: string) => string;
const FIELD_LABELS: Record<string, { label: string; format: Formatter }> = {
  name: { label: "Nombre", format: (value) => str(value) ?? "—" },
  active: { label: "Estado", format: (value) => (value === false ? "Inactivo" : "Activo") },
  roles: { label: "Roles", format: (value) => (Array.isArray(value) && value.length ? value.map((role) => ROLE_LABELS[String(role)] ?? humanize(String(role))).join(", ") : "Sin roles") },
  approverId: { label: "Aprobador", format: (value, names) => nameOf(names, "users", value, "Sin aprobador") },
  societyId: { label: "Empresa", format: (value, names, entity) => nameOf(names, "societies", value, entity === "works" ? "Sin empresa" : "Compartida") },
  costCenterId: { label: "Centro de costo", format: (value, names) => nameOf(names, "costCenters", value, "Sin centro") },
  unit: { label: "Unidad", format: (value) => str(value) ?? "—" },
  category: { label: "Categoría", format: (value) => str(value) ?? "—" },
  code: { label: "Código", format: (value) => str(value) ?? "—" },
  type: { label: "Tipo", format: (value, _names, entity) => (entity === "cashBoxes" ? CASH_BOX_TYPE_LABELS : COST_CENTER_TYPE_LABELS)[String(value)] ?? "—" },
  nitConfigured: { label: "NIT registrado", format: yesNo },
  identificationType: { label: "Tipo de identificación", format: (value) => IDENTIFICATION_TYPE_LABELS[String(value)] ?? "—" },
  identificationConfigured: { label: "Identificación registrada", format: yesNo },
  pendingNormalization: { label: "Pendiente de completar", format: yesNo },
  contactConfigured: { label: "Datos de contacto registrados", format: yesNo },
};
/** `approverAssigned` (Sí/No) solo cuenta en eventos viejos, anteriores a guardar el id del aprobador. */
const LEGACY_FIELDS: Record<string, { label: string; format: Formatter }> = { approverAssigned: { label: "Aprobador asignado", format: yesNo } };

/** Campos de la lista blanca que en ciertos registros SÍ son datos personales: el nombre de un usuario
 *  o de quien pide por WhatsApp (la base los redacta igual, `auditoria_campo_sensible`). */
const HIDDEN_BY_ENTITY: Record<string, readonly string[]> = { users: ["name"], requesters: ["name"] };
function snapshotFields(entity: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const hasApproverId = keys.has("approverId");
  const hidden = HIDDEN_BY_ENTITY[entity] ?? [];
  return [...keys].filter((key) => !hidden.includes(key) && (key in FIELD_LABELS || (!hasApproverId && key in LEGACY_FIELDS)));
}
function snapshotDetails(entity: string, before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, names: AuditNames): AuditDetail[] {
  const details: AuditDetail[] = [];
  for (const key of snapshotFields(entity, before, after)) {
    const spec = FIELD_LABELS[key] ?? LEGACY_FIELDS[key];
    const format = (value: unknown) => spec.format(value, names, entity);
    if (before && after) {
      if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
      details.push({ label: spec.label, before: key in before ? format(before[key]) : "—", after: key in after ? format(after[key]) : "—" });
    } else {
      const source = after ?? before;
      if (source && key in source) details.push({ label: spec.label, value: format(source[key]) });
    }
  }
  return details;
}
function changed(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined, key: string): boolean {
  return Boolean(before && after && key in before && key in after && JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function originOf(row: AuditLogRow): AuditOriginKey {
  if (row.origin === "mcp") return "mcp";
  if (row.origin === "kapso") return "whatsapp";
  if (row.origin === "sistema" || row.origin === "importacion") return "sistema";
  // Un evento web sin usuario es el portal público (radicación, beneficiario, adjuntos del portal); la
  // excepción es un intento de ingreso con un correo que no existe, que sí es la web.
  if (!row.actorId && row.entity !== "sesion") return "publico";
  return "web";
}
function actorOf(row: AuditLogRow, names: AuditNames, origin: AuditOriginKey): string {
  if (row.actorId) return names.users.get(row.actorId) ?? "Usuario no disponible";
  if (row.entity === "sesion") return "Persona sin identificar";
  if (origin === "publico") return "Portal público";
  if (origin === "whatsapp") return "WhatsApp";
  return "Sistema";
}
function subjectOf(row: AuditLogRow, names: AuditNames): string | null {
  const id = row.entityId;
  switch (row.entity) {
    case "requisicion": return nameOf(names, "requisitions", id);
    case "requisicion_item": return nameOf(names, "requisitionItems", id);
    case "orden": return nameOf(names, "orders", id);
    case "gasto": { const order = str(id) && names.expenses.get(id as string); return order ? `Gasto de ${order}` : "Gasto"; }
    case "caja_menor": return "Caja menor";
    case "proveedor": case "suppliers": return nameOf(names, "suppliers", id);
    case "works": case "tags": case "items": case "item": case "societies": case "costCenters": case "cashBoxes": case "users": case "sesion":
      return nameOf(names, CATALOG_REF[row.entity], id);
    // Nombre y teléfono de quien pide por WhatsApp son sensibles también en la auditoría de la base
    // (auditoria_campo_sensible, 202609010001): aquí tampoco se muestran.
    case "requesters": return null;
    case "configuracion": return "Permisos por rol";
    case "acceso_publico": return "Portal público";
    case "sesion_pantalla": return names.screens.get(id ?? "") ?? str(row.data.name) ?? NOT_AVAILABLE;
    case "adjunto": {
      const parentEntity = str(row.data.parentEntity), parentId = row.data.parentId;
      if (parentEntity === "caja_menor") return "Caja menor";
      const kind = PARENT_REF[parentEntity ?? ""];
      return kind ? nameOf(names, kind, parentId) : NOT_AVAILABLE;
    }
    case "reporte": return row.event === "CIERRE_CAJA_DESCARGADO" ? "Cierre de caja" : row.event === "REPORTE_REQUISICIONES_DESCARGADO" ? "Reporte de requisiciones" : "Reporte de gastos";
    case "mcp": return str(row.data.tool) ? humanize(String(row.data.tool)) : "Asistente";
    default: return null;
  }
}

function transitionDetails(row: AuditLogRow, names: AuditNames): AuditDetail[] {
  const details: AuditDetail[] = [];
  const from = str(row.data.from), to = str(row.data.to);
  if (from || to) details.push({ label: "Estado", before: REQUISITION_STATUS_LABELS[from ?? ""] ?? "—", after: REQUISITION_STATUS_LABELS[to ?? ""] ?? "—" });
  const comment = str(row.data.comment);
  if (comment) details.push({ label: row.event === "DEVUELTA" ? "Motivo de la devolución" : "Motivo", value: comment });
  const skipped = Array.isArray(row.data.overrodeApprovers) ? row.data.overrodeApprovers.map((entry) => nameOf(names, "users", obj(entry)?.id)) : [];
  if (skipped.length) details.push({ label: "Aprobó por encima de", value: skipped.join(", ") });
  return details;
}
function permissionDiff(beforeValue: unknown, afterValue: unknown): AuditDetail[] {
  const parse = (value: unknown): RolePermissionOverrides => { try { return assertValidPermissionOverrides(value ?? {}); } catch { return {}; } };
  const before = parse(beforeValue), after = parse(afterValue);
  const label = (key: string) => (key === "*" ? "Todos los permisos" : PERMISSION_CATALOG.find((entry) => entry.key === key)?.label ?? humanize(key));
  const details: AuditDetail[] = [];
  for (const role of ALL_ROLES as readonly Role[]) {
    const was = resolveRolePermissions(role, before), now = resolveRolePermissions(role, after);
    const added = now.filter((key) => !was.includes(key)), removed = was.filter((key) => !now.includes(key));
    if (!added.length && !removed.length) continue;
    const parts = [added.length ? `Le dio: ${added.map(label).join(", ")}` : "", removed.length ? `Le quitó: ${removed.map(label).join(", ")}` : ""].filter(Boolean);
    details.push({ label: ROLE_LABELS[role], value: parts.join(" · ") });
  }
  return details;
}

function describeCatalog(row: AuditLogRow, names: AuditNames): { action: string; details: AuditDetail[] } {
  const noun = CATALOG_NOUN[row.entity] ?? "el registro";
  const before = obj(row.data.before), after = obj(row.data.after);
  const details = snapshotDetails(row.entity, before, after, names);
  if (row.event === "CREADA") {
    if (row.entity === "users") return { action: "Dio de alta al usuario", details };
    if (row.entity === "requesters") return { action: "Autorizó a un nuevo solicitante de WhatsApp", details };
    return { action: `Creó ${noun}`, details };
  }
  if (row.event === "ACTUALIZADA") {
    const onlyState = details.length === 1 && changed(before, after, "active");
    if (onlyState) {
      const activated = after?.active !== false;
      if (row.entity === "requesters") return { action: activated ? "Volvió a autorizar a un solicitante de WhatsApp" : "Quitó la autorización a un solicitante de WhatsApp", details };
      return { action: `${activated ? "Reactivó" : "Desactivó"} ${noun}`, details };
    }
    if (row.entity === "tags" && changed(before, after, "approverId")) {
      return { action: `Cambió el aprobador de ${nameOf(names, "users", before?.approverId, "sin aprobador")} a ${nameOf(names, "users", after?.approverId, "sin aprobador")}`, details };
    }
    if (row.entity === "users" && changed(before, after, "roles")) return { action: "Cambió los roles del usuario", details };
    return { action: `Editó ${noun}`, details };
  }
  return { action: humanize(row.event), details };
}

function describeRequisition(row: AuditLogRow, names: AuditNames): { action: string; details: AuditDetail[] } {
  const data = row.data;
  switch (row.event) {
    case "CREADA": {
      const channel = str(data.channel);
      return { action: channel === "publico" ? "Radicó una requisición por el portal público" : channel === "whatsapp" ? "Radicó una requisición por WhatsApp" : "Creó una requisición", details: [] };
    }
    case "ENTRADA_REVISION": return { action: "Empezó a revisar la requisición", details: transitionDetails(row, names) };
    case "RETOMADA_REVISION": return { action: "Retomó la revisión de la requisición", details: transitionDetails(row, names) };
    case "ENVIADA_APROBACION": return { action: "Envió a aprobación la requisición", details: transitionDetails(row, names) };
    case "APROBADA": {
      const skipped = Array.isArray(data.overrodeApprovers) && data.overrodeApprovers.length > 0;
      return { action: skipped ? "Aprobó la requisición por encima del aprobador asignado" : "Aprobó la requisición", details: transitionDetails(row, names) };
    }
    case "DEVUELTA": return { action: "Devolvió para corrección la requisición", details: transitionDetails(row, names) };
    case "DECLINADA": return { action: "Declinó la requisición", details: transitionDetails(row, names) };
    case "REVISADA": {
      const details: AuditDetail[] = [];
      if (str(data.workId)) details.push({ label: "Obra", value: nameOf(names, "works", data.workId) });
      if (str(data.tagId)) details.push({ label: "Etiqueta", value: nameOf(names, "tags", data.tagId) });
      if (str(data.approverId)) details.push({ label: "Aprobador", value: nameOf(names, "users", data.approverId) });
      if (str(data.costCenterId)) details.push({ label: "Centro de costo", value: nameOf(names, "costCenters", data.costCenterId) });
      if (str(data.billedCompanyId)) details.push({ label: "Empresa facturada", value: nameOf(names, "societies", data.billedCompanyId) });
      if (str(data.paymentTerms)) details.push({ label: "Condiciones de pago", value: String(data.paymentTerms) });
      const antes = moneyOf(data.montoAntes), despues = moneyOf(data.montoDespues);
      if (antes && despues) details.push({ label: "Valor", before: antes, after: despues });
      return { action: "Guardó la revisión de la requisición", details };
    }
    case "APROBADOR_REASIGNADO": {
      const previous = str(data.previousApproverId), next = nameOf(names, "users", data.approverId, "sin aprobador");
      return { action: previous ? `Cambió el aprobador de ${nameOf(names, "users", previous)} a ${next}` : `Asignó como aprobador a ${next}`, details: [{ label: "Aprobador", before: previous ? nameOf(names, "users", previous) : "Sin aprobador", after: next }] };
    }
    case "ITEMS_DECIDIDOS": {
      const decisions = Array.isArray(data.decisions) ? data.decisions.map((entry) => str(obj(entry)?.status)) : [];
      const approved = decisions.filter((status) => status === "aprobado").length, declined = decisions.filter((status) => status === "declinado").length;
      return { action: `Decidió ${decisions.length === 1 ? "un ítem" : `${decisions.length} ítems`} de la requisición`, details: [{ label: "Ítems aprobados", value: String(approved) }, { label: "Ítems declinados", value: String(declined) }] };
    }
    case "PROVEEDORES_ASIGNADOS": {
      const count = Array.isArray(data.assignments) ? data.assignments.length : 0;
      return { action: "Asignó proveedores a los ítems de la requisición", details: count ? [{ label: "Ítems con proveedor", value: String(count) }] : [] };
    }
    case "CABECERA_EDITADA": {
      const details: AuditDetail[] = [];
      const required = dateOf(data.requiredDate);
      if (required) details.push({ label: "Fecha requerida", value: required });
      // Las observaciones son texto libre y la base las trata como sensibles: se dice que cambiaron, no qué dicen.
      if ("observations" in data) details.push({ label: "Observaciones", value: "Modificadas" });
      return { action: "Editó los datos generales de la requisición", details };
    }
    case "ITEM_PROPUESTO": return { action: "Propuso un ítem nuevo en la requisición", details: [] };
    default: return { action: humanize(row.event), details: [] };
  }
}

function describeOrder(row: AuditLogRow, names: AuditNames): { action: string; details: AuditDetail[]; entityLabel?: string } {
  const data = row.data;
  switch (row.event) {
    case "GENERADA": return { action: "Generó la orden", details: [{ label: "Requisición", value: nameOf(names, "requisitions", data.requisitionId) }, { label: "Proveedor", value: nameOf(names, "suppliers", data.supplierId) }] };
    case "ESTADO_CUMPLIMIENTO_ACTUALIZADO": {
      const status = str(data.status) ?? "";
      const verb = status === "cumplida" ? "Marcó como cumplida la orden" : status === "no_cumplida" ? "Marcó como no cumplida la orden" : status === "no_necesario" ? "Marcó como no necesaria la orden" : "Actualizó la entrega de la orden";
      return { action: verb, details: [{ label: "Entrega", value: ORDER_STATUS_LABELS[status] ?? "—" }] };
    }
    case "ESTADO_ADMINISTRATIVO_ACTUALIZADO": {
      const status = str(data.status) ?? "";
      const verb = status === "contabilizada" ? (data.reason === "pago_anulado" ? "La orden volvió a contabilizada al anular un pago" : "Contabilizó la orden") : status === "pagada" ? "Marcó como pagada la orden" : "Actualizó la contabilidad de la orden";
      return { action: verb, details: [{ label: "Contabilidad", value: ORDER_STATUS_LABELS[status] ?? "—" }] };
    }
    case "PAGO_REGISTRADO": case "PAGO_ANULADO": {
      const amount = moneyOf(data.amount) ?? "—";
      const details: AuditDetail[] = [{ label: "Valor", value: amount }, { label: "Medio", value: PAYMENT_METHOD_LABELS[str(data.method) ?? ""] ?? "—" }];
      const date = dateOf(data.date);
      if (date) details.push({ label: "Fecha del pago", value: date });
      if (row.event === "PAGO_ANULADO" && str(data.reason)) details.push({ label: "Motivo de la anulación", value: String(data.reason) });
      return { action: row.event === "PAGO_REGISTRADO" ? `Registró un pago de ${amount}` : `Anuló un pago de ${amount}`, details, entityLabel: "Pago" };
    }
    default: return { action: humanize(row.event), details: [] };
  }
}

function describe(row: AuditLogRow, names: AuditNames): { action: string; details: AuditDetail[]; entityLabel?: string } {
  const data = row.data;
  if (row.entity in CATALOG_NOUN) return describeCatalog(row, names);
  switch (row.entity) {
    case "requisicion": return describeRequisition(row, names);
    case "orden": return describeOrder(row, names);
    case "gasto":
      if (row.event === "REGISTRADO") return { action: "Registró el gasto de una orden", details: str(data.orderId) ? [{ label: "Orden", value: nameOf(names, "orders", data.orderId) }, { label: "Proveedor", value: nameOf(names, "suppliers", data.supplierId) }] : [] };
      if (row.event === "GASTO_ANULADO") return { action: "Anuló el gasto porque la orden no era necesaria", details: str(data.orderId) ? [{ label: "Orden", value: nameOf(names, "orders", data.orderId) }] : [] };
      if (row.event === "REPARTIDO") return { action: "Repartió el gasto entre obras", details: moneyOf(data.total) ? [{ label: "Valor repartido", value: moneyOf(data.total) as string }] : [] };
      return { action: humanize(row.event), details: [] };
    case "caja_menor": return { action: "Registró un gasto de caja menor", details: [] };
    case "proveedor": {
      if (row.event === "CREADO") return { action: data.source === "beneficiario" ? "Creó el beneficiario" : "Creó el proveedor", details: snapshotDetails("suppliers", undefined, data, names) };
      if (row.event === "ACTUALIZADO") { const details = snapshotDetails("suppliers", obj(data.before), obj(data.after), names); return { action: details.length === 1 && changed(obj(data.before), obj(data.after), "active") ? (obj(data.after)?.active === false ? "Desactivó el proveedor" : "Reactivó el proveedor") : "Editó el proveedor", details }; }
      if (row.event === "DOCUMENTO_DISPONIBLE") return { action: "Subió un documento al expediente del proveedor", details: [] };
      if (row.event === "DOCUMENTO_DESCARGADO") return { action: "Descargó un documento del expediente del proveedor", details: [] };
      return { action: humanize(row.event), details: [] };
    }
    case "item": return { action: row.event === "PROPUESTO" ? "Propuso un ítem nuevo al catálogo" : humanize(row.event), details: [] };
    case "requisicion_item":
      if (row.event === "ADJUNTO_PORTAL_DESCARTADO") return { action: "Se descartó un adjunto enviado por el portal", details: [] };
      if (row.event === "ADJUNTO_PORTAL_DISPONIBLE") return { action: "Llegó un adjunto enviado por el portal", details: [] };
      return { action: humanize(row.event), details: [] };
    case "adjunto": return { action: row.event === "SOPORTE_DISPONIBLE" ? "Subió un soporte" : row.event === "SOPORTE_DESCARGADO" ? "Descargó un soporte" : humanize(row.event), details: [] };
    case "configuracion": return { action: "Cambió los permisos por rol", details: permissionDiff(data.antes, data.despues) };
    case "acceso_publico": return { action: "Cambió la contraseña del portal público", details: [] };
    case "sesion":
      if (row.event === "SESION_INICIADA") return { action: "Inició sesión", details: [] };
      if (row.event === "SESION_CERRADA") return { action: "Cerró sesión", details: [] };
      if (row.event === "SESION_RECHAZADA") return { action: data.motivo === "inactiva" ? "Intentó entrar con una cuenta desactivada" : "Intentó entrar con datos incorrectos", details: [] };
      if (row.event === "CLAVE_CAMBIADA") return { action: "Cambió su contraseña", details: [] };
      if (row.event === "CLAVE_RESTABLECIDA") return { action: "Restableció la contraseña del usuario", details: [{ label: "Sesiones abiertas", value: "Cerradas" }] };
      return { action: humanize(row.event), details: [] };
    case "reporte": return { action: "Descargó un reporte", details: typeof data.rows === "number" ? [{ label: "Filas", value: String(data.rows) }] : [] };
    case "sesion_pantalla": return { action: row.event === "SESION_PANTALLA_CREADA" ? "Creó una pantalla de oficina" : row.event === "SESION_PANTALLA_REVOCADA" ? "Revocó una pantalla de oficina" : humanize(row.event), details: [] };
    case "mcp": return { action: "Usó el asistente (MCP)", details: [] };
    default: return { action: humanize(row.event), details: [] };
  }
}

export function describeAuditRow(row: AuditLogRow, names: AuditNames): AuditEntryView {
  const origin = originOf(row);
  const described = describe(row, names);
  return {
    key: row.id,
    at: row.at,
    actor: actorOf(row, names, origin),
    action: described.action,
    subject: subjectOf(row, names),
    entityLabel: described.entityLabel ?? ENTITY_LABELS[row.entity] ?? "Registro",
    origin,
    originLabel: AUDIT_ORIGIN_OPTIONS.find((option) => option.key === origin)?.label ?? "Sistema",
    details: described.details,
  };
}

/** Validación de filtros que llegan por la URL (la ruta ya los pasó por zod; esto es la segunda red). */
export const AUDIT_ENTITY_KEYS = AUDIT_ENTITY_OPTIONS.map((option) => option.key) as readonly AuditEntityGroup[];
export const AUDIT_EVENT_KEYS = AUDIT_EVENT_OPTIONS.map((option) => option.key) as readonly AuditEventGroup[];
export const AUDIT_ORIGIN_KEYS = AUDIT_ORIGIN_OPTIONS.map((option) => option.key) as readonly AuditOriginKey[];
