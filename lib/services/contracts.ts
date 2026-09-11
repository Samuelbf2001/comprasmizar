import type { Actor, AuditEvent, DashboardAmountByKey, Expense, ExpenseShare, Order, PettyCash, Requisition, RequisitionStatus, Role } from "../domain";
import type { ListQuery, Page } from "./list-query";

/** Persistence ports. Infrastructure adapters (e.g. Supabase) implement these; domain services do not depend on them. */
/**
 * H3 (docs/plan-rendimiento.md, Fase 3): `listVisibleTo` acepta un `ListQuery` opcional. Sin `query`
 * (`undefined`) el comportamiento es EXACTAMENTE el de siempre: `Requisition[]` sin límite, ítems
 * cargados por lote. Con `query` aplica filtros y paginación por cursor en SQL y devuelve
 * `Page<Requisition>` — la unión de retorno es deliberada (en vez de sobrecargas + `.bind()`, que no
 * componen bien con el tipo de `Function.prototype.bind`); el servicio (`ProcurementService`) es quien
 * expone la firma limpia y separada (`listRequisitions` vs `listRequisitionsPage`).
 * `listVisibleHeaders`: variante SIN ítems para el dashboard (RF-1102) — la cola de atención y la
 * actividad reciente no los usan (ver `buildAttentionQueue`/`buildRecentActivity` en `lib/domain/rules.ts`),
 * así que cargarlos ahí sería trabajo desperdiciado. `orderBy` por defecto es `created_at`; `updated_at`
 * es el que usa la actividad reciente.
 * `dashboardByStatus`: conteo por estado con la MISMA visibilidad por actor que `listVisibleTo`, para
 * que `dashboard()` no tenga que cargar la colección completa solo para contar (H3).
 */
export interface RequisitionRepository {
  get(id: string): Promise<Requisition | null>; save(requisition: Requisition): Promise<void>; list(): Promise<Requisition[]>;
  listVisibleTo(actor: Actor, query?: ListQuery): Promise<Requisition[] | Page<Requisition>>;
  listVisibleHeaders(actor: Actor, options?: { status?: RequisitionStatus[]; orderBy?: "created_at" | "updated_at"; limit?: number }): Promise<Requisition[]>;
  dashboardByStatus(actor: Actor): Promise<Record<RequisitionStatus, number>>;
}
/**
 * `listAttentionCandidates`: superconjunto acotado (no la colección completa) de órdenes que
 * `buildAttentionQueue` podría necesitar para CUALQUIER rol — `estado_cumplimiento in ('generada',
 * 'no_cumplida')` o `estado_administrativo = 'pendiente'` (y no `no_necesario`) —, con la visibilidad
 * por actor de `listVisibleOrders`. `listRecentlyUpdated`: las `limit` órdenes más recientes por
 * `updated_at`, para `buildRecentActivity`. `dashboardPendingCount`: cuenta de `pendingOrders`
 * (mismo criterio que `calculateDashboard` en `lib/domain/rules.ts`) resuelta en SQL.
 */
export interface OrderRepository {
  save(order: Order): Promise<void>; list(): Promise<Order[]>;
  listVisibleTo(actor: Actor, query?: ListQuery): Promise<Order[] | Page<Order>>;
  listByRequisition(requisitionId: string): Promise<Order[]>; get(id: string): Promise<Order | null>;
  listAttentionCandidates(actor: Actor): Promise<Order[]>;
  listRecentlyUpdated(actor: Actor, limit: number): Promise<Order[]>;
  dashboardPendingCount(actor: Actor): Promise<number>;
}
/**
 * `save` inserta con `on conflict (origen, referencia_id) do nothing` (ver adaptador Postgres): nunca
 * sirve para actualizar un gasto ya existente. `markPaid` es el método dedicado para fijar la fecha de
 * pago del gasto de una orden (reunión 2026-09: "la fecha del gasto es la del pago") — solo aplica a
 * `origin: "requisicion"`, la caja menor nace pagada y nunca pasa por aquí. Devuelve el número de filas
 * afectadas: GRAVE (QA reasignación) — si una orden `contabilizada` llegó a "pagada" sin gasto propio
 * (estado inconsistente), 0 filas es la única señal de que el UPDATE no tocó nada; el servicio debe
 * fallar con un DomainError en vez de dejarla "pagada" en silencio.
 * `deleteByReference` borra el/los gastos de un origen+referencia y su reparto (`gastos_reparto`, FK
 * `on delete restrict`, por eso el reparto se borra PRIMERO) en la MISMA transacción del llamador — usado
 * cuando una orden `contabilizada` pasa a `no_necesario` y su gasto (aún sin pagar) debe anularse por
 * completo, no solo dejarlo huérfano sin fecha para siempre.
 *
 * H3: `dashboardAggregates` reproduce EXACTAMENTE lo que `calculateDashboard`/`groupExpenseByWork`/
 * `groupExpenseByTag`/`groupExpenseByPeriod` (lib/domain/rules.ts) calculaban sobre la colección
 * completa — `periodExpense`/`inProcessValue` sobre `gastos.fecha` (fecha de PAGO, nullable: NULL =
 * compromiso sin pagar; ver 202609070003_gasto_fecha_pago.sql), `expenseByWork`/`expenseByTag`/
 * `expenseByPeriod` solo gastos PAGADOS (`fecha is not null`), mismo criterio "gasto = pagado" que el
 * dominio — pero agregado en SQL con la visibilidad por actor de `listVisibleExpenses`, sin traer una
 * sola fila de `gastos` a memoria. `listRecentlyUpdated` ordena por `coalesce(fecha, fecha_orden)
 * desc` (mismo fallback que `buildRecentActivity`: un compromiso sin pagar usa su fecha de nacimiento),
 * para las 8 más recientes de la actividad reciente.
 */
export interface ExpenseRepository {
  get(id: string): Promise<Expense | null>; save(expense: Expense): Promise<void>; markPaid(referenceId: string, date: string): Promise<number>;
  deleteByReference(origin: Expense["origin"], referenceId: string): Promise<void>; saveShares(shares: ExpenseShare[]): Promise<void>; list(): Promise<Expense[]>;
  listVisibleTo(actor: Actor, query?: ListQuery): Promise<Expense[] | Page<Expense>>;
  listByReference(referenceId: string): Promise<Expense[]>;
  dashboardAggregates(actor: Actor, period: string): Promise<{ periodExpense: number; inProcessValue: number; expenseByWork: DashboardAmountByKey[]; expenseByTag: DashboardAmountByKey[]; expenseByPeriod: DashboardAmountByKey[] }>;
  listRecentlyUpdated(actor: Actor, limit: number): Promise<Expense[]>;
}
/**
 * Persistence returns the expense created by the database trigger in the same transaction.
 * H3: `list` acepta un `ListQuery` opcional (mismo contrato que los demás — sin `query`, comportamiento
 * intacto). La caja menor NO tiene visibilidad por actor propia (ver `ProcurementService.listPettyCash`:
 * cualquier actor con permiso `petty_cash:read` ve toda la caja menor), así que a diferencia de los
 * otros tres repositorios este método no recibe `Actor`.
 */
export interface PettyCashRepository { save(entry: PettyCash): Promise<Expense>; list(query?: ListQuery): Promise<PettyCash[] | Page<PettyCash>>; }
export interface AuditRepository { append(event: AuditEvent): Promise<void>; list(entity: string, entityId: string): Promise<AuditEvent[]>; }
export interface ConsecutiveRepository { take(prefix: "REQ" | "OC" | "OP", year: number): Promise<string>; }
/** Verifies a public link and code without exposing storage or clear-text comparison to the service. */
/**
 * `linkToken` es NULO cuando se entra por la ruta pública sin enlace firmado (decisión de Ernesto,
 * 2026-09-11: «que el enlace no necesite un token, sea ruta pública»). En ese caso la única llave es
 * la contraseña del portal; el token, cuando viene, sigue acotando el acceso a una obra concreta.
 */
export interface PublicAccessVerifier {
  verify(workId: string, linkToken: string | null, code: string): Promise<boolean>;
  /**
   * Igual que `verify`, pero para quien elige EMPRESA en vez de obra (portal sin enlace por obra).
   * Un token por obra NO sirve aquí: firma una obra concreta y no puede autorizar una sociedad
   * cualquiera. Solo se acepta el token general, o ninguno — en ambos casos la llave es la contraseña.
   */
  verifySociety(societyId: string, linkToken: string | null, code: string): Promise<boolean>;
}
export interface FeatureRepository { isEnabled(name: string): Promise<boolean>; }
export interface ItemCatalogRepository { propose(description: string, unit: string, createdBy?: string): Promise<{ id: string; created: boolean }>; }
export type CatalogKind = "works" | "tags" | "items" | "suppliers" | "societies" | "users" | "requesters";
export interface CatalogWork { id: string; name: string; societyId: string; active: boolean; }
export interface CatalogTag { id: string; name: string; approverId?: string | null; active: boolean; }
export interface CatalogItem { id: string; name: string; specification?: string | null; unit: string; category?: string | null; active: boolean; }
export interface CatalogSupplier { id: string; name: string; nit?: string | null; phone?: string | null; email?: string | null; address?: string | null; active: boolean; }
/** RF-002: entidad jurídica dueña de las obras. Alta/edición/activación exclusiva de admin_sixteam y admin_mizar. */
export interface CatalogSociety { id: string; name: string; nit?: string | null; active: boolean; }
/**
 * RF-004: usuario de la aplicación. DECISIÓN DE PRODUCTO: dar de alta un usuario aquí NUNCA crea la cuenta
 * en `auth.users` de Supabase — solo VINCULA un usuario de aplicación a un id que ya debe existir en Auth.
 * Por eso, a diferencia de los demás catálogos (cuyo id lo genera la base de datos), `id` es obligatorio y lo
 * aporta quien crea el registro (ver `CatalogCreateRecord`); el repositorio debe rechazar con un error explícito
 * si ese id no existe en Auth. `roles` refleja la tabla `usuario_roles` (relación N:M) y en un `patch` representa
 * el conjunto final deseado de roles, no un incremento.
 */
export interface CatalogUser { id: string; name: string; email: string; phone?: string | null; active: boolean; roles: readonly Role[]; }
/**
 * Alta de un usuario (2026-09-11). Trae `password` y NO trae `id`: desde que la plataforma dejó de
 * apoyarse en Supabase Auth, es ella quien crea la cuenta de acceso, y el id lo genera la base.
 *
 * La contraseña solo existe en este objeto de entrada — nunca se devuelve, nunca se guarda en claro
 * y nunca aparece en `CatalogUser`. El repositorio la convierte a bcrypt dentro de la misma
 * transacción que crea la fila (ver postgres-repositories.ts).
 */
export type CatalogUserCreate = Omit<CatalogUser, "id"> & { password: string };
/**
 * HUECO 1 (reunión 2026-08-31): lista blanca GLOBAL de quién puede radicar una requisición por
 * WhatsApp (RF-902, tabla `solicitantes_autorizados`, migración 202609010001). A diferencia de
 * proveedores/usuarios, `phone` es OBLIGATORIO (la columna `telefono` es NOT NULL): sin teléfono la
 * fila no tiene ninguna función — es lo único contra lo que se compara el remitente entrante.
 */
export interface CatalogRequester { id: string; name: string; phone: string; active: boolean; }
export type CatalogRecord = CatalogWork | CatalogTag | CatalogItem | CatalogSupplier | CatalogSociety | CatalogUser | CatalogRequester;
/** Todos los catálogos generan su id en la base de datos. "users" además recibe la contraseña inicial. */
export type CatalogCreateRecord = CatalogRecord extends infer T ? T extends CatalogUser ? CatalogUserCreate : T extends CatalogRecord ? Omit<T, "id"> : never : never;
export type CatalogPatchRecord = CatalogRecord extends infer T ? T extends CatalogRecord ? Partial<Omit<T, "id">> : never : never;
/** CRUD-only records; adapters must normalize duplicate comparisons and never delete rows. */
export interface CatalogRepository { create(kind: CatalogKind, value: CatalogCreateRecord): Promise<CatalogRecord>; get(kind: CatalogKind, id: string): Promise<CatalogRecord | null>; update(kind: CatalogKind, id: string, value: CatalogPatchRecord): Promise<CatalogRecord>; findSupplierDuplicate(value: Pick<CatalogSupplier, "name" | "nit">, exceptId?: string): Promise<string | null>; /** HUECO 1: compara con el MISMO criterio que `public.normalizar_telefono_co` (ver lib/infrastructure/phone.ts), para que "3001112233" y "+57 300 111 2233" choquen como el mismo solicitante antes de tocar la BD. */ findRequesterDuplicate(phone: string, exceptId?: string): Promise<string | null>; isEligibleApprover(id: string): Promise<boolean>;  /** GRAVE 3 (QA Postgres real): existe al menos una requisición (de cualquier estado) anclada a esta obra — usado para bloquear un cambio de sociedad que las dejaría inservibles. */ hasRequisitionsForWork(workId: string): Promise<boolean>; }
export interface NotificationRepository { enqueue(notification: { userId?: string; phone?: string; channel: "whatsapp" | "interno"; template: string; payload: Record<string, unknown> }): Promise<void>; }
/** Repositories provided to the callback are pinned to the same database transaction/connection. */
export interface TransactionRepositories { requisitions: RequisitionRepository; orders: OrderRepository; expenses: ExpenseRepository; pettyCash: PettyCashRepository; audit: AuditRepository; consecutives: ConsecutiveRepository; features: FeatureRepository; items: ItemCatalogRepository; catalogs: CatalogRepository; notifications: NotificationRepository; }
/**
 * Executes a unit of work on one database transaction. A lock key is `requisition:<id>`
 * or `order:<id>` when a state transition must be serialized; undefined is still atomic.
 */
export interface TransactionManager { transaction<T>(lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T>; }
export interface Clock { now(): Date; }
export interface IdGenerator { next(): string; }
export interface ServiceDependencies {
  requisitions: RequisitionRepository; orders: OrderRepository; expenses: ExpenseRepository; pettyCash: PettyCashRepository;
  audit: AuditRepository; consecutives: ConsecutiveRepository; publicAccess: PublicAccessVerifier; features: FeatureRepository; items: ItemCatalogRepository; catalogs: CatalogRepository; notifications: NotificationRepository; transactions: TransactionManager; clock: Clock; ids: IdGenerator;
}
export interface RequestContext { actor?: Actor; origin?: "web" | "mcp" | "kapso"; }
