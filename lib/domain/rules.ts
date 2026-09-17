import type { Actor, CostCenterType, DashboardActivityItem, DashboardAmountByKey, DashboardMetrics, DashboardQueueItem, Expense, ExpenseShare, ItemLine, Money, Order, OrderAdminStatus, OrderPayment, OrderStatus, OrderType, PaymentStatus, Requisition, RequisitionStatus, Role } from "./model";
import { DomainError } from "./model";

export const ALL_ROLES: readonly Role[] = ["solicitante", "revisor", "aprobador", "contabilidad", "admin_mizar", "admin_sixteam"];
/**
 * VALORES POR DEFECTO, no la última palabra (decisión de Ernesto, 2026-09-17: «que los permisos no
 * estén hardcodeados: que se puedan editar»). Un override por rol vive en `configuracion`
 * (`permisos_por_rol_v1`) y lo carga la infraestructura, que le pasa al `Actor` la lista EFECTIVA ya
 * resuelta; este módulo sigue siendo dominio puro, sin base de datos y sin async. Editar esta tabla
 * sigue siendo lo que cambia el default de una instalación nueva.
 */
const permissions: Record<Role, readonly string[]> = {
  solicitante: ["requisition:create", "requisition:read:own", "dashboard:read"],
  // "order:create" (generar órdenes) es del revisor, NO del aprobador: aprobar y designar proveedor/generar
  // órdenes son roles distintos por decisión explícita de la reunión 2026-08-31 — exigirle al aprobador
  // proveedor o generación de órdenes rompería su rol de solo aprobar.
  // "payment:register" (reunión agosto 2026, pagos parciales; acotado por Ernesto el 2026-09-17 a
  // revisor y admin_sixteam): registrar un abono parcial no es "contabilizar" ni "pagar el saldo
  // completo", es un tercer gesto, más frecuente, que ninguno de los dos cubre por sí solo — y el
  // dueño decidió que quien lo hace es Daniel, no contabilidad.
  // RF-1301 (Reportes, reunión 2026-09-11): "report:read" (ver el reporte de requisiciones) y
  // "report:export" (descargar su Excel) se separan porque el revisor ya podía ENTRAR a /reportes sin
  // poder descargar (el botón de XLSX provisional de gastos solo se pinta para Contabilidad/Administrador
  // Mizar/Administrador Sixteam, ver app/api/reports/expenses-report.ts) — separar los dos permisos
  // conserva exactamente esa asimetría con el reporte nuevo en vez de dársela de regalo.
  // "income:register" (cliente, 11-sep-2026, cajas/ingresos/cierres): mismo conjunto de roles que
  // "payment:register" arriba — revisor/contabilidad/admin_sixteam — registrar un ingreso de caja es
  // el mismo tipo de gesto operativo/contable que registrar un pago parcial de orden.
  revisor: ["requisition:create", "requisition:read", "requisition:review", "item:manage", "supplier:manage", "petty_cash:create", "petty_cash:read", "expense:read", "report:read", "order:read", "order:update", "order:create", "order:pay", "payment:register", "income:register", "dashboard:read"],
  // Juliana (aprobadora) pidió poder ver y descargar "todo lo que aprobé este mes" desde Reportes — hasta
  // hoy el rol no tenía ninguno de los dos permisos. Esto no amplía lo que puede VER: el repositorio
  // sigue acotando su lectura a public.es_aprobador_de(r.id, actor.id) (cabecera o ítem propio), la misma
  // visibilidad que ya aplica en /aprobaciones — estos permisos solo abren la puerta del módulo, no el
  // alcance de datos.
  aprobador: ["requisition:read:assigned", "requisition:approve", "requisition:return", "order:read", "report:read", "report:export", "dashboard:read"],
  // "income:register"/"cash:close" (cliente, 11-sep-2026): Daniel (contabilidad) cierra la caja
  // administrativa a inicio de mes e ingresa los gastos para el reporte — es quien más registra
  // ingresos y quien cierra el mes. "cash:close" NO la tiene el revisor (a diferencia de
  // "income:register"): cerrar caja es un gesto contable, no de compras.
  // DECISIÓN DE ERNESTO (2026-09-17): "payment:register" SALE de contabilidad — registrar y anular
  // pagos queda en revisor (Daniel) y admin_sixteam. Contabilidad conserva ver pagos y comprobantes
  // (order:read), contabilizar (order:account) y su cierre de caja; "income:register"/"cash:close" no
  // se tocan (son del módulo de cajas, no del pago de órdenes). Quien quiera devolvérselo ya no
  // necesita tocar este archivo: lo edita en Configuración → Permisos por rol.
  contabilidad: ["requisition:read", "petty_cash:read", "expense:read", "report:read", "report:export", "order:read", "order:account", "income:register", "cash:close", "dashboard:read"],
  // "supplier:manage" (H11, QA pagos y caja): RF-605 dice que Mizar administra proveedores; antes solo
  // lo tenía por la puerta de atrás del feature flag "catalogos_admin_mizar" (autoservicio de catálogos
  // en general, apagado por defecto) — «Proveedores» aparecía en su menú pero GET /api/suppliers
  // siempre respondía 403 en una instalación nueva.
  admin_mizar: ["requisition:create", "catalog:manage", "supplier:manage", "dashboard:read", "expense:read", "report:read", "report:export"],
  admin_sixteam: ["*"],
};
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<Role, readonly string[]>> = permissions;
/** Comodín de `admin_sixteam`: "todos los permisos, también los que se inventen mañana". */
export const WILDCARD_PERMISSION = "*";
/**
 * Catálogo CERRADO de permisos, con el nombre de negocio de cada uno — la pantalla de Configuración
 * pinta estas etiquetas y nunca el slug crudo, y `assertValidPermissionOverrides` rechaza cualquier
 * clave que no esté aquí (un permiso mal escrito en `configuracion` no puede volverse un permiso que
 * nadie tiene y nadie ve). Añadir un permiso nuevo al código obliga a añadirlo también aquí.
 */
export const PERMISSION_CATALOG: readonly { key: string; label: string; group: string }[] = [
  { key: "requisition:create", label: "Crear requisiciones", group: "Requisiciones" },
  { key: "requisition:read", label: "Ver todas las requisiciones", group: "Requisiciones" },
  { key: "requisition:read:own", label: "Ver sus propias requisiciones", group: "Requisiciones" },
  { key: "requisition:read:assigned", label: "Ver las requisiciones que le tocan", group: "Requisiciones" },
  { key: "requisition:review", label: "Revisar y enviar a aprobación", group: "Requisiciones" },
  { key: "requisition:approve", label: "Aprobar requisiciones", group: "Requisiciones" },
  { key: "requisition:return", label: "Devolver para corrección", group: "Requisiciones" },
  { key: "order:read", label: "Ver órdenes", group: "Órdenes y pagos" },
  { key: "order:create", label: "Generar órdenes", group: "Órdenes y pagos" },
  { key: "order:update", label: "Editar órdenes", group: "Órdenes y pagos" },
  { key: "order:pay", label: "Marcar órdenes como pagadas", group: "Órdenes y pagos" },
  { key: "order:account", label: "Contabilizar órdenes", group: "Órdenes y pagos" },
  { key: "payment:register", label: "Registrar y anular pagos", group: "Órdenes y pagos" },
  { key: "expense:read", label: "Ver gastos", group: "Gastos y caja" },
  { key: "petty_cash:read", label: "Ver caja menor", group: "Gastos y caja" },
  { key: "petty_cash:create", label: "Registrar caja menor", group: "Gastos y caja" },
  { key: "income:register", label: "Registrar ingresos de caja", group: "Gastos y caja" },
  { key: "cash:close", label: "Cerrar caja", group: "Gastos y caja" },
  { key: "report:read", label: "Entrar a Reportes", group: "Reportes" },
  { key: "report:export", label: "Descargar reportes", group: "Reportes" },
  { key: "dashboard:read", label: "Ver el tablero", group: "Reportes" },
  { key: "item:manage", label: "Administrar ítems del catálogo", group: "Catálogos y administración" },
  { key: "supplier:manage", label: "Administrar proveedores", group: "Catálogos y administración" },
  { key: "catalog:manage", label: "Administrar catálogos", group: "Catálogos y administración" },
  { key: "config:manage", label: "Configurar la plataforma", group: "Catálogos y administración" },
];
export const ALL_PERMISSIONS: readonly string[] = PERMISSION_CATALOG.map((entry) => entry.key);
/**
 * Permiso que `admin_sixteam` NO puede perder: es el que abre la propia pantalla de permisos. Sin
 * este candado, un override podía dejar la plataforma sin nadie capaz de deshacerlo — y la única
 * salida sería un UPDATE a mano contra Postgres.
 */
export const ADMIN_LOCKED_PERMISSION = "config:manage";
/** Override guardado en `configuracion.permisos_por_rol_v1`: un rol ausente conserva su default. */
export type RolePermissionOverrides = Partial<Record<Role, readonly string[]>>;

/** Lista efectiva de UN rol: el override si lo tiene, y si no el default. Pura, sin base de datos. */
export function resolveRolePermissions(role: Role, overrides?: RolePermissionOverrides): readonly string[] {
  return overrides?.[role] ?? permissions[role] ?? [];
}
/** Lista efectiva de un actor (unión de sus roles). Es lo que la infraestructura le cuelga al `Actor`. */
export function resolveActorPermissions(roles: readonly Role[], overrides?: RolePermissionOverrides): readonly string[] {
  const effective = new Set<string>();
  for (const role of roles) for (const permission of resolveRolePermissions(role, overrides)) effective.add(permission);
  return [...effective];
}
/**
 * Valida un override venido de `configuracion` o de la pantalla ANTES de aplicarlo: solo roles
 * conocidos, solo permisos del catálogo, sin repetidos, y con el candado de `admin_sixteam`. Se
 * ejecuta en los dos sentidos (al guardar y al leer) porque la fila la puede editar cualquiera con
 * acceso a Postgres, y un jsonb corrupto no puede traducirse en permisos silenciosamente perdidos.
 */
export function assertValidPermissionOverrides(value: unknown): RolePermissionOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DomainError("INVALID_INPUT", "Los permisos por rol deben venir como un objeto {rol: [permisos]}");
  const result: Partial<Record<Role, readonly string[]>> = {};
  for (const [role, list] of Object.entries(value as Record<string, unknown>)) {
    if (!ALL_ROLES.includes(role as Role)) throw new DomainError("INVALID_INPUT", `Rol desconocido: ${role}`);
    if (!Array.isArray(list) || list.some((permission) => typeof permission !== "string")) throw new DomainError("INVALID_INPUT", `Los permisos de ${role} deben ser una lista de textos`);
    const unique = [...new Set(list as string[])];
    for (const permission of unique) {
      if (permission === WILDCARD_PERMISSION) continue;
      if (!ALL_PERMISSIONS.includes(permission)) throw new DomainError("INVALID_INPUT", `Permiso desconocido: ${permission}`);
    }
    result[role as Role] = unique;
  }
  const admin = result.admin_sixteam;
  if (admin && !admin.includes(WILDCARD_PERMISSION) && !admin.includes(ADMIN_LOCKED_PERMISSION)) {
    throw new DomainError("FORBIDDEN", "Administrador Sixteam no puede quedarse sin «Configurar la plataforma»: nadie podría volver a editar los permisos");
  }
  return result;
}
// "requisition:review" protege decline/review/startReview/sendForApproval (procurement-service.ts):
// bloquearlo también estructuralmente cierra la denegación permanente (RF-1205), no solo aprobar/devolver.
const mcpForbidden = new Set(["requisition:approve", "requisition:return", "requisition:review"]);

/**
 * Un `Actor` trae su lista EFECTIVA ya resuelta (con el override de `configuracion` aplicado por la
 * infraestructura); una lista de roles suelta se resuelve contra los defaults. Pasar el actor es lo
 * correcto en todo el servidor — pasar `actor.roles` ignoraría el override, que es justo el error que
 * este tipo unión hace difícil cometer por accidente.
 */
export type PermissionSubject = readonly Role[] | Actor;
function subjectPermissions(subject: PermissionSubject): readonly string[] {
  if (Array.isArray(subject)) return resolveActorPermissions(subject as readonly Role[]);
  const actor = subject as Actor;
  return actor.permissions ?? resolveActorPermissions(actor.roles);
}
export function hasPermission(subject: PermissionSubject, permission: string, origin: "web" | "mcp" = "web"): boolean {
  if (origin === "mcp" && mcpForbidden.has(permission)) return false;
  const effective = subjectPermissions(subject);
  return effective.includes(WILDCARD_PERMISSION) || effective.includes(permission);
}
export function assertPermission(subject: PermissionSubject, permission: string, origin: "web" | "mcp" = "web"): void {
  if (!hasPermission(subject, permission, origin)) throw new DomainError("FORBIDDEN", `Permiso denegado: ${permission}`);
}

const transitions: Record<RequisitionStatus, readonly RequisitionStatus[]> = {
  // `en_aprobacion -> declinada` es NUEVA (aprobador por ítem, 11-sep-2026): si todos los ítems acaban
  // declinados no queda nada que aprobar, y sin esta transición la requisición se quedaría atascada en
  // aprobación para siempre. Va también en el trigger `validar_transicion_requisicion` de la base
  // (202609110004); tenerla en un solo sitio haría que el dominio y Postgres discrepasen.
  enviada: ["en_revision"], en_revision: ["en_aprobacion", "declinada"], en_aprobacion: ["aprobada", "devuelta", "declinada"],
  devuelta: ["en_revision"], aprobada: [], declinada: [],
};
export function canTransition(from: RequisitionStatus, to: RequisitionStatus): boolean { return transitions[from].includes(to); }
export function assertTransition(from: RequisitionStatus, to: RequisitionStatus, comment?: string): void {
  if (!canTransition(from, to)) throw new DomainError("INVALID_TRANSITION", `No se puede pasar de ${from} a ${to}`);
  if ((to === "devuelta" || to === "declinada") && !comment?.trim()) throw new DomainError("COMMENT_REQUIRED", `Se requiere comentario para ${to}`);
}

export function nextConsecutive(prefix: "REQ" | "OC" | "OP", year: number, currentNext: number): { value: string; next: number } {
  if (!Number.isInteger(currentNext) || currentNext < 1) throw new DomainError("INVALID_CONSECUTIVE", "El consecutivo debe iniciar en 1");
  return { value: `${prefix}-${year}-${String(currentNext).padStart(4, "0")}`, next: currentNext + 1 };
}
export function calculateTax(base: Money, ivaRate: number): { base: Money; iva: Money; total: Money } {
  if (!Number.isInteger(base) || base < 0 || !Number.isFinite(ivaRate) || ivaRate < 0) throw new DomainError("INVALID_MONEY", "Base o IVA inválidos");
  const iva = Math.round(base * ivaRate);
  return { base, iva, total: base + iva };
}
export function assertCop(value: Money, label = "valor"): void {
  if (!Number.isInteger(value) || value < 0) throw new DomainError("INVALID_MONEY", `${label} debe ser un peso COP entero no negativo`);
}
/**
 * QA reasignación (reunión 2026-09): fecha/periodo de la OPERACIÓN en hora de Colombia
 * (America/Bogotá, UTC-5 fijo, sin horario de verano), no en UTC. Vivía duplicada en
 * procurement-service.ts (fecha de orden/pago) y app/api/pantalla/route.ts la recalculaba mal en UTC
 * (`new Date().toISOString().slice(0,7)`: el último día del mes después de las 19:00 hora Colombia
 * mostraba el mes SIGUIENTE en la pantalla de oficina). Única fuente de verdad ahora: se movió al
 * dominio para que ambos consumidores (servicio y ruta HTTP de pantalla) importen la misma función en
 * vez de reimplementarla. Usa `Intl.DateTimeFormat` de zona FIJA (no los getters locales de `Date`,
 * que dependen del TZ del proceso, a menudo UTC en producción) — mismo criterio que `localTodayISO()`
 * en components/screens/connected.tsx, que sí puede fiarse del reloj del navegador del usuario.
 */
const COLOMBIA_TIME_ZONE = "America/Bogota";
export function colombiaDateParts(date: Date): { day: string; period: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: COLOMBIA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return { day, period: day.slice(0, 7) };
}
/**
 * Reunión 2026-08-31: aritmética del formato Excel del cliente, redondeando por LÍNEA (no por unidad):
 * bruto = round(cantidad×precioUnitario) → descuento = round(bruto×descuentoTasa) → base = bruto−descuento
 * → iva = round(base×ivaTasa) (reutiliza calculateTax) → total = base+iva.
 * Compatibilidad hacia atrás: si `ivaRate` está ausente (línea legacy, previa a la tasa por ítem), el IVA se
 * calcula con el mecanismo histórico (cantidad × unitIva, sin descuento) en vez de asumir tasa 0 — de lo
 * contrario el primer cálculo de una requisición vieja pondría su IVA en cero en silencio. `ivaRate: 0`
 * explícito (nuevo estilo, ítem exento) sí usa la vía de tasa y da iva 0 deliberadamente.
 */
export function calculateLineAmounts(line: ItemLine): { base: Money; iva: Money; total: Money } {
  if (!Number.isFinite(line.quantity) || line.quantity <= 0) throw new DomainError("INVALID_QUANTITY", "La cantidad debe ser mayor que cero");
  const unitBase = line.unitBase ?? 0; assertCop(unitBase, "Base unitaria");
  const bruto = Math.round(line.quantity * unitBase); assertCop(bruto, "Bruto de línea");
  const discountRate = line.discountRate ?? 0;
  if (!Number.isFinite(discountRate) || discountRate < 0 || discountRate > 1) throw new DomainError("INVALID_MONEY", "Descuento inválido");
  const descuento = Math.round(bruto * discountRate), base = bruto - descuento; assertCop(base, "Base de línea");
  let iva: number;
  if (line.ivaRate !== undefined) {
    if (!Number.isFinite(line.ivaRate) || line.ivaRate < 0 || line.ivaRate > 1) throw new DomainError("INVALID_MONEY", "IVA inválido");
    iva = calculateTax(base, line.ivaRate).iva;
  } else {
    const unitIva = line.unitIva ?? 0, derivedUnitTotal = unitBase + unitIva; assertCop(unitIva, "IVA unitario");
    if (line.unitTotal !== undefined && line.unitTotal !== derivedUnitTotal) throw new DomainError("INCONSISTENT_TOTAL", "El total unitario no cuadra con base e IVA");
    iva = Math.round(line.quantity * unitIva);
  }
  const total = base + iva; assertCop(iva, "IVA de línea"); assertCop(total, "Total de línea"); return { base, iva, total };
}
export function calculateLineTotal(line: ItemLine): Money { return calculateLineAmounts(line).total; }
export function sumLines(lines: readonly ItemLine[]): Money { return lines.reduce((sum, line) => sum + calculateLineTotal(line), 0); }
/**
 * RF-1301 (Reportes, reunión 2026-09-11): mismo cálculo que `sumLines`, pero conservando base e IVA por
 * separado — el reporte de requisiciones (lib/services/report-service.ts) necesita las tres columnas
 * ("total base", "IVA", "total") y no solo el total. Única fuente de verdad de nuevo: reutiliza
 * `calculateLineAmounts` línea por línea en vez de que el reporte reimplemente la aritmética del
 * descuento/IVA por su cuenta.
 */
export function sumLineAmounts(lines: readonly ItemLine[]): { base: Money; iva: Money; total: Money } {
  return lines.reduce((sum, line) => { const amounts = calculateLineAmounts(line); return { base: sum.base + amounts.base, iva: sum.iva + amounts.iva, total: sum.total + amounts.total }; }, { base: 0, iva: 0, total: 0 });
}
/** Reunión 2026-08-31: "pendiente" cuenta como vigente (aún no decidido); solo "declinado" queda fuera. */
export function approvedLines(lines: readonly ItemLine[]): ItemLine[] { return lines.filter((line) => line.status !== "declinado"); }
/** Alimenta órdenes y gastos. `sumLines` NO cambia de semántica (la usan create() y dashboard.inProcessValue). */
export function sumApprovedLines(lines: readonly ItemLine[]): Money { return sumLines(approvedLines(lines)); }
/**
 * Quién decide este ítem: el suyo si lo tiene, y si no el de la cabecera. Es LA función de la herencia
 * y por eso está aquí y no repetida en el servicio y en el emisor — dos copias de esta regla es como se
 * consigue que WhatsApp le mande a alguien un ítem que la pantalla le niega.
 */
export function itemApproverId(line: ItemLine, headApproverId?: string): string | undefined {
  return line.approverId ?? headApproverId;
}
/**
 * DECISIÓN DEL DUEÑO (Ernesto, 2026-09-12): «obra y centro de costo están correlacionados, pero varias
 * obras pueden ir a un centro de costo; en la requisición debe salir predeterminado el centro asociado
 * a esa obra y poder cambiarse». Es LA función de esa herencia — el de la requisición si lo tiene, y si
 * no el de la obra — y por eso vive aquí y no repetida en el servicio: dos copias de esta regla es como
 * se consigue que un gasto nazca con un centro distinto del que la ficha de revisión mostraba como
 * "heredado". Tipado estructural a propósito (no `CatalogWork` de lib/services/contracts.ts): el
 * dominio no depende de la capa de servicios, igual que `itemApproverId` no depende de nada externo.
 */
export function resolveCostCenter(requisition: { costCenterId?: string }, work?: { costCenterId?: string } | null): string | undefined {
  return requisition.costCenterId ?? work?.costCenterId ?? undefined;
}
/**
 * RF-008 (adenda de pagos): «un CC de tipo administrativo o personal no requiere obra». Es LA función
 * de esa excepción — sin centro, o con un centro de tipo `obra` (el default, y lo que son todos los
 * nacidos del backfill de 202609120001), la obra sigue siendo obligatoria; solo un centro
 * administrativo/personal/empresa la libera. La misma regla la aplica la base sobre `gastos`
 * (trigger `gastos_obra_segun_centro`, 202609150004). Un centro sin `type` cargado (fakes, filas
 * anteriores a la columna) cuenta como obra: es el lado seguro.
 */
export function costCenterRequiresWork(costCenter?: { type?: CostCenterType } | null): boolean {
  return !costCenter || (costCenter.type ?? "obra") === "obra";
}
/**
 * RF-009 (adenda de pagos, A7): la EMPRESA FACTURADA es la sociedad a cuyo nombre viene el soporte —
 * lo que contabiliza el contador — y no tiene por qué ser la del centro de costo (Claudia) ni la de la
 * requisición: la factura de un gasto de Juliana puede venir a nombre de PROIM. Es LA función del
 * default (la elegida en revisión si la hay; si no la sociedad del centro de costo; si no la de la obra;
 * si no la propia de la requisición) y por eso vive aquí, hermana de `resolveCostCenter`. Un centro
 * COMPARTIDO (sin sociedad) cae a la obra, y un centro sin obra (administrativo/personal) a la sociedad
 * de la requisición. Tipado estructural a propósito, como `resolveCostCenter`.
 */
export function resolveBilledCompany(requisition: { billedCompanyId?: string; societyId?: string }, costCenter?: { societyId?: string | null } | null, work?: { societyId?: string } | null): string | undefined {
  return requisition.billedCompanyId ?? costCenter?.societyId ?? work?.societyId ?? requisition.societyId ?? undefined;
}
/**
 * RF-308 (adenda de pagos, A9): la auto-aprobación en un paso es solo para el usuario MAESTRO — quien
 * reúne revisor Y aprobador (Daniel) — o admin_sixteam (que ya decide cualquier requisición, M-5). Un
 * revisor a secas o un aprobador a secas no la tienen: cada uno hace su mitad del flujo.
 */
export function assertCanSelfApprove(actor: Actor): void {
  if (canOverrideAssignedApprover(actor)) return;
  throw new DomainError("FORBIDDEN", "Aprobar en un solo paso exige los roles de revisor y aprobador");
}
/**
 * DECISIÓN DE ERNESTO (2026-09-17): «Daniel tiene control total para aprobar aunque haya otro
 * aprobador, pero que quede que el que aprobó fue Daniel». Quien reúne revisor Y aprobador (el
 * usuario maestro) y `admin_sixteam` pueden cerrar una aprobación por encima del aprobador asignado;
 * el resto NO — un aprobador a secas sigue sin poder decidir lo ajeno (ver `decideItems`). Es la
 * misma condición que habilita la auto-aprobación en un paso, y por eso vive en una sola función:
 * dos copias de esta regla serían dos criterios distintos de "quién manda".
 */
export function canOverrideAssignedApprover(actor: Actor): boolean {
  return actor.roles.includes("admin_sixteam") || (actor.roles.includes("revisor") && actor.roles.includes("aprobador"));
}
/** Ítems que ESTE actor tiene pendientes de decidir. Vacío no significa "no le toca": puede haberlos ya decidido. */
export function pendingItemsFor(actorId: string, lines: readonly ItemLine[], headApproverId?: string): ItemLine[] {
  return lines.filter((line) => (line.status ?? "pendiente") === "pendiente" && itemApproverId(line, headApproverId) === actorId);
}
/** Aprobadores a los que todavía se les espera algo, sin repetir. Vacío = ya se puede cerrar. */
export function pendingApproverIds(lines: readonly ItemLine[], headApproverId?: string): string[] {
  const ids = new Set<string>();
  for (const line of lines) {
    if ((line.status ?? "pendiente") !== "pendiente") continue;
    const approver = itemApproverId(line, headApproverId);
    if (approver) ids.add(approver);
  }
  return [...ids];
}
/**
 * Motivo de cabecera cuando se declina TODO. No es cosmético: `requisiciones_motivo_declinacion_check`
 * exige motivo al declinar y el trigger de historial lo copia como comentario de la transición, así que
 * sin esto la base rechaza el cierre. Se arrastran los motivos de ítem sin repetirlos: el solicitante
 * tiene que poder leer por qué se cayó su pedido sin abrir ítem por ítem.
 */
export function combinedDeclineReason(lines: readonly ItemLine[]): string {
  const motivos = [...new Set(lines.map((line) => line.declineReason?.trim()).filter((motivo): motivo is string => Boolean(motivo)))];
  return motivos.length ? `Todos los ítems fueron declinados: ${motivos.join("; ")}` : "Todos los ítems fueron declinados.";
}
export function assertHasApprovedLine(lines: readonly ItemLine[]): void { if (approvedLines(lines).length === 0) throw new DomainError("NO_APPROVED_ITEMS", "La requisición no tiene ítems aprobados"); }
/** Guía de UI: el botón "Generar órdenes" solo aplica a una requisición aprobada, sin órdenes previas y con algo que ordenar. */
export function canGenerateOrders(status: RequisitionStatus, existingOrderCount: number, lines: readonly ItemLine[]): boolean { return status === "aprobada" && existingOrderCount === 0 && approvedLines(lines).length > 0; }
const adminTransitions: Record<OrderAdminStatus, readonly OrderAdminStatus[]> = { pendiente: ["contabilizada"], contabilizada: ["pagada"], pagada: [] };
/**
 * Eje administrativo: pendiente → contabilizada → pagada, irreversible, sin saltos. Única interacción
 * deliberada con el eje de cumplimiento: una orden `no_necesario` no se contabiliza ni se paga.
 */
export function assertAdminTransition(from: OrderAdminStatus, to: OrderAdminStatus, fulfillment: OrderStatus): void {
  if (!adminTransitions[from].includes(to)) throw new DomainError("INVALID_ADMIN_TRANSITION", `No se puede pasar de ${from} a ${to}`);
  if (fulfillment === "no_necesario") throw new DomainError("ORDER_NOT_NEEDED", "Una orden no necesaria no se contabiliza ni se paga");
}
/**
 * Reunión agosto 2026: un pago parcial nunca puede dejar la orden "sobre-pagada". `total` es
 * `gastos.valor_total` del gasto de la orden (única fuente de verdad, igual que en la base — ver el
 * trigger `validar_pago_no_excede_orden` de 202609120002_pagos_orden.sql, que impone EXACTAMENTE
 * esta misma regla al insertar directamente en la base); `paid` es la suma de los pagos ya
 * registrados (sin contar `next`); `next` es el pago que se intenta registrar ahora. El límite es
 * "excede", no "alcanza": el saldo EXACTO restante sí se acepta (paid + next === total cierra la
 * orden, no la rebasa).
 */
export function assertPaymentWithinOrder(total: Money, paid: Money, next: Money): void {
  assertCop(next, "Valor del pago");
  if (next <= 0) throw new DomainError("INVALID_MONEY", "El pago debe ser mayor a cero");
  if (paid + next > total) throw new DomainError("PAYMENT_EXCEEDS_ORDER", "El pago excede el saldo pendiente de la orden");
}
/**
 * RF-510 (adenda de pagos): lo pagado de una orden es la suma de sus pagos VIGENTES — un pago anulado
 * sigue en el historial pero no cuenta. Única definición de ese "no cuenta" del lado del dominio; la
 * base aplica la misma regla en `validar_pago_no_excede_orden` (202609150001) y el adaptador Postgres
 * en el `left join lateral` de `Order.paidAmount`.
 */
export function sumPaid(payments: readonly OrderPayment[]): Money { return payments.reduce((sum, payment) => sum + (payment.annulled ? 0 : payment.amount), 0); }
/**
 * RF-508: `estado_pago` derivado, nunca guardado. `total` es el valor del gasto de la orden; `paid` la
 * suma de pagos vigentes (`sumPaid`). "pagada" es `paid >= total` (el trigger ya impide pasarse, así que
 * en la práctica es la igualdad); un total en cero sin pagos es "pendiente", no "pagada".
 */
export function paymentStatus(total: Money, paid: Money): PaymentStatus {
  if (paid <= 0) return "pendiente";
  return paid < total ? "parcial" : "pagada";
}
/** RF-510: anular exige motivo y un pago todavía vigente — anular dos veces no es idempotente, es un error. */
export function assertCanAnnulPayment(payment: Pick<OrderPayment, "annulled">, reason: string): void {
  if (!reason?.trim()) throw new DomainError("ANNULMENT_REASON_REQUIRED", "Se requiere motivo para anular un pago");
  if (payment.annulled) throw new DomainError("PAYMENT_ALREADY_ANNULLED", "El pago ya está anulado");
}
export function validateShares(total: Money, shares: readonly ExpenseShare[]): void {
  if (!Number.isInteger(total) || total <= 0 || shares.length === 0 || shares.some((share) => !share.expenseId || !share.workId || !Number.isInteger(share.amount) || share.amount <= 0)) throw new DomainError("INVALID_SHARE", "Reparto inválido");
  if (new Set(shares.map((share) => share.expenseId)).size !== 1 || new Set(shares.map((share) => share.workId)).size !== shares.length) throw new DomainError("INVALID_SHARE", "Cada reparto debe usar un gasto y obras únicas");
  if (shares.reduce((sum, share) => sum + share.amount, 0) !== total) throw new DomainError("UNBALANCED_SHARE", "El reparto debe cuadrar al peso");
}
export function orderTypeFor(requisitionType: "compra" | "pago"): OrderType { return requisitionType === "compra" ? "OC" : "OP"; }
/**
 * Solicitud de pago (encargo feat/solicitud-de-pago): el modelo es una requisición con UNA sola
 * línea de concepto (item_id NULL, descripcion_libre = concepto) que además, a diferencia de una
 * compra, no tiene un paso de revisión previo que complete beneficiario y valor — ambos se exigen
 * desde `create()` y se vuelven a exigir en `review()` (el revisor puede editar la línea). Se
 * exporta como función de dominio en vez de vivir duplicada en ambos métodos del servicio.
 */
export function assertPaymentRequestShape(items: readonly ItemLine[]): void {
  if (items.length !== 1) throw new DomainError("PAYMENT_SINGLE_LINE", "Una solicitud de pago debe tener exactamente un concepto");
  const [line] = items;
  if (!line.finalSupplierId) throw new DomainError("PAYMENT_BENEFICIARY_REQUIRED", "La solicitud de pago requiere un beneficiario");
  if (calculateLineTotal(line) <= 0) throw new DomainError("PAYMENT_VALUE_REQUIRED", "La solicitud de pago requiere un valor mayor a cero");
}
/**
 * La generación de órdenes ya no admite el parámetro `multiSupplier`: siempre agrupa por proveedor final,
 * y lo exige en TODAS las líneas (antes, una orden de pago sin proveedor pasaba silenciosamente con clave
 * `undefined`). El llamador (generateOrders) debe pasar únicamente líneas aprobadas — esta función se
 * mantiene deliberadamente ciega al estado por ítem para que su prueba siga siendo legible.
 */
export function groupOrderItems(lines: readonly ItemLine[], type: "compra" | "pago"): Map<string, ItemLine[]> {
  if (lines.some((line) => !line.finalSupplierId)) throw new DomainError("SUPPLIER_REQUIRED", "Cada ítem debe tener proveedor final para generar la orden");
  if (type === "pago") {
    const suppliers = new Set(lines.map((line) => line.finalSupplierId as string));
    if (suppliers.size > 1) throw new DomainError("MULTI_SUPPLIER_PAYMENT", "Una orden de pago solo puede tener un proveedor");
    return new Map(lines.length ? [[lines[0].finalSupplierId as string, [...lines]]] : []);
  }
  const groups = new Map<string, ItemLine[]>();
  for (const line of lines) { const key = line.finalSupplierId as string; groups.set(key, [...(groups.get(key) ?? []), line]); }
  return groups;
}
/**
 * Decisión del cliente (reunión 2026-09): el gasto se fecha con el pago, no con la generación de la
 * orden — `periodExpense` (que filtra por `period`, derivado de `date`) ya deja fuera, correctamente,
 * lo que aún no se ha pagado. `inProcessValue` ANTES quedaba fijo en 0 (dead code, ver historial):
 * ahora suma los gastos SIN `date` — lo comprometido en órdenes ya generadas y todavía sin pagar —
 * para que ese dinero no desaparezca de todas las vistas hasta que se pague.
 */
export function calculateDashboard(expenses: readonly Expense[], orders: readonly Order[], statuses: readonly RequisitionStatus[], period: string): DashboardMetrics {
  const byStatus = { enviada: 0, en_revision: 0, en_aprobacion: 0, aprobada: 0, devuelta: 0, declinada: 0 };
  for (const status of statuses) byStatus[status]++;
  const inProcessValue = expenses.filter((expense) => expense.date === undefined).reduce((sum, expense) => sum + expense.total, 0);
  return { byStatus, inProcessValue, periodExpense: expenses.filter((expense) => expense.period === period).reduce((sum, expense) => sum + expense.total, 0), pendingOrders: orders.filter((order) => order.status === "generada" || order.status === "no_cumplida").length };
}
/**
 * RF-1102: cola de "qué espera algo de mí" en el dashboard conectado. Se calcula en el dominio sobre
 * las mismas colecciones que ya filtró `listVisibleTo(actor)` (procurement-service.dashboard): nunca
 * expone un documento que ese alcance no hubiera autorizado ya. Determinística: ordena por consecutivo
 * descendente (el formato PREFIJO-AÑO-NNNN es monótono) y limita a 20 elementos para el panel.
 */
/**
 * M-5 (QA reasignación, reunión 2026-09): esta cola ya metía en "Aprobar" de admin_sixteam TODA
 * requisición en_aprobacion (línea de abajo), pero antes de esta reunión approve()/returnForCorrection()/
 * decideItems() en procurement-service.ts exigían `approverId === actor.id` sin excepción — admin_sixteam
 * veía el botón y el backend se lo rechazaba con NOT_ASSIGNED_APPROVER. DECISIÓN (no la alternativa de
 * vaciar esta cola para admin_sixteam): admin_sixteam SÍ puede decidir/aprobar/devolver CUALQUIER
 * requisición en aprobación, no solo las que tiene asignadas — coherente con que ya ve y puede accionar
 * todo lo demás en esta cola (revisar, confirmar cumplimiento, contabilizar) sin estar "asignado" a nada,
 * y con isElevated() en postgres-repositories.ts (admin_sixteam ve todas las filas sin scope de rol). Ver
 * el mismo chequeo replicado, a propósito, en approve()/returnForCorrection()/decideItems().
 */
export function buildAttentionQueue(requisitions: readonly Requisition[], orders: readonly Order[], actor: Actor): DashboardQueueItem[] {
  const workByRequisition = new Map(requisitions.map((requisition) => [requisition.id, requisition.workId]));
  const canReview = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam");
  const canApprove = actor.roles.includes("aprobador") || actor.roles.includes("admin_sixteam");
  // Reunión 2026-08-31: contabilidad tiene su propia acción sobre el eje administrativo (order:account),
  // independiente de la confirmación de cumplimiento que ya ve el revisor.
  const canAccount = actor.roles.includes("contabilidad") || actor.roles.includes("admin_sixteam");
  const items: DashboardQueueItem[] = [];
  if (canReview) for (const requisition of requisitions) if (requisition.status === "enviada" || requisition.status === "en_revision") items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Revisar" });
  // APROBADOR POR ÍTEM: también entra en la cola quien tiene ítems suyos, aunque la cabecera sea de
  // otro. Sin esto, a un aprobador secundario le llega el WhatsApp y no le aparece nada en la pantalla.
  if (canApprove) for (const requisition of requisitions) if (requisition.status === "en_aprobacion" && (actor.roles.includes("admin_sixteam") || requisition.approverId === actor.id || requisition.items.some((line) => line.approverId === actor.id))) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Aprobar" });
  for (const requisition of requisitions) if (requisition.status === "devuelta" && requisition.requesterId === actor.id) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, action: "Corregir" });
  if (canReview) for (const order of orders) if (order.status === "generada") items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId), status: order.status, action: "Confirmar cumplimiento" });
  // Una orden `no_necesario` nunca se contabiliza (assertAdminTransition la bloquea): no tiene sentido ponerla en la cola.
  if (canAccount) for (const order of orders) if (order.adminStatus === "pendiente" && order.status !== "no_necesario") items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId), status: order.adminStatus, action: "Contabilizar" });
  return items.sort((a, b) => b.consecutive.localeCompare(a.consecutive)).slice(0, 20);
}
/**
 * RF-1102: actividad reciente combinando requisiciones, órdenes y gastos visibles para el actor.
 * Requisiciones/órdenes ordenan por su `updatedAt` real (poblado solo por el adaptador Postgres); los
 * gastos del dominio solo llevan fecha (sin hora), así que dos eventos del mismo día ordenan por esa
 * fecha. `expense.date` (fecha de pago) puede faltar mientras la orden no se ha pagado: se usa
 * `expense.orderDate` en ese caso, para que un compromiso recién generado siga apareciendo en la
 * actividad reciente en vez de desaparecer hasta que se pague. Es una aproximación explícita, no un
 * registro de auditoría con hora exacta.
 */
export function buildRecentActivity(requisitions: readonly Requisition[], orders: readonly Order[], expenses: readonly Expense[], limit = 8): DashboardActivityItem[] {
  const workByRequisition = new Map(requisitions.map((requisition) => [requisition.id, requisition.workId]));
  const items: DashboardActivityItem[] = [];
  for (const requisition of requisitions) if (requisition.updatedAt) items.push({ kind: "requisicion", id: requisition.id, consecutive: requisition.consecutive, workId: requisition.workId, status: requisition.status, at: requisition.updatedAt });
  for (const order of orders) if (order.updatedAt) items.push({ kind: "orden", id: order.id, consecutive: order.consecutive, workId: workByRequisition.get(order.requisitionId) ?? "", status: order.status, at: order.updatedAt });
  for (const expense of expenses) items.push({ kind: "gasto", id: expense.id, consecutive: expense.id.slice(0, 8), workId: expense.workId, status: expense.origin, at: expense.date ?? expense.orderDate });
  return items.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
function amountByKey(rows: Iterable<readonly [string, Money]>): DashboardAmountByKey[] {
  const totals = new Map<string, number>();
  for (const [key, amount] of rows) totals.set(key, (totals.get(key) ?? 0) + amount);
  return [...totals.entries()].map(([key, total]) => ({ key, total })).sort((a, b) => b.total - a.total);
}
/**
 * GRAVE 3 (QA reasignación, reunión 2026-09): "gasto" = pagado (decisión del cliente, la misma que ya
 * gobierna `date`/`period`, ver Expense en model.ts). Antes de esta reunión sumaban pagado + no pagado,
 * mientras que groupExpenseByPeriod (abajo) ya excluía lo no pagado — tres cifras de "gasto" en la misma
 * pantalla que no cuadraban entre sí. Un gasto sin `date` es un COMPROMISO (orden generada, aún sin
 * pagar): calculateDashboard.inProcessValue ya lo cuenta aparte, con su propio nombre; si el dashboard
 * algún día quiere una serie de "comprometido por obra", debe ser otra función con su propio nombre, no
 * sumada aquí en silencio.
 */
/** RF-706/RF-1103: gasto agrupado por obra, mayor a menor, para el gráfico ejecutivo correspondiente. Solo gastos pagados (con `date`); ver nota GRAVE 3 arriba. */
export function groupExpenseByWork(expenses: readonly Expense[]): DashboardAmountByKey[] { return amountByKey(expenses.filter((expense) => expense.date !== undefined).map((expense) => [expense.workId, expense.total] as const)); }
/** RF-706/RF-1103: gasto agrupado por etiqueta; clave "" representa gastos sin etiqueta asignada. Solo gastos pagados (con `date`); ver nota GRAVE 3 arriba. */
export function groupExpenseByTag(expenses: readonly Expense[]): DashboardAmountByKey[] { return amountByKey(expenses.filter((expense) => expense.date !== undefined).map((expense) => [expense.tagId ?? "", expense.total] as const)); }
/** Centros de costo (UI, reunión 2026-09-12): gasto agrupado por centro de costo, mismo criterio que
 *  `groupExpenseByWork`/`groupExpenseByTag` (solo gastos pagados, con `date`; ver nota GRAVE 3 arriba).
 *  Clave "" representa gastos sin centro de costo asignado. */
export function groupExpenseByCostCenter(expenses: readonly Expense[]): DashboardAmountByKey[] { return amountByKey(expenses.filter((expense) => expense.date !== undefined).map((expense) => [expense.costCenterId ?? "", expense.total] as const)); }
/**
 * RF-706/RF-1103: tendencia de gasto por periodo (YYYY-MM), cronológica, limitada a los últimos
 * `monthsBack`. Excluye los gastos sin `period` (orden generada, aún sin pagar): no inventa un bucket
 * "sin periodo" en una serie que es, por definición, mensual.
 */
export function groupExpenseByPeriod(expenses: readonly Expense[], monthsBack = 6): DashboardAmountByKey[] {
  const withPeriod = expenses.filter((expense): expense is Expense & { period: string } => expense.period !== undefined);
  return amountByKey(withPeriod.map((expense) => [expense.period, expense.total] as const)).sort((a, b) => a.key.localeCompare(b.key)).slice(-monthsBack);
}
