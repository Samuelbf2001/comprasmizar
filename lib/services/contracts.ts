import type { Actor, AuditEvent, Expense, ExpenseShare, Order, PettyCash, Requisition } from "../domain";

/** Persistence ports. Infrastructure adapters (e.g. Supabase) implement these; domain services do not depend on them. */
/** `listVisibleTo` is mandatory: adapters must apply the actor's server-side/RLS scope, never a service-role global list. */
export interface RequisitionRepository { get(id: string): Promise<Requisition | null>; save(requisition: Requisition): Promise<void>; list(): Promise<Requisition[]>; listVisibleTo(actor: Actor): Promise<Requisition[]>; }
export interface OrderRepository { save(order: Order): Promise<void>; list(): Promise<Order[]>; listVisibleTo(actor: Actor): Promise<Order[]>; listByRequisition(requisitionId: string): Promise<Order[]>; get(id: string): Promise<Order | null>; }
export interface ExpenseRepository { get(id: string): Promise<Expense | null>; save(expense: Expense): Promise<void>; saveShares(shares: ExpenseShare[]): Promise<void>; list(): Promise<Expense[]>; listVisibleTo(actor: Actor): Promise<Expense[]>; listByReference(referenceId: string): Promise<Expense[]>; }
/** Persistence returns the expense created by the database trigger in the same transaction. */
export interface PettyCashRepository { save(entry: PettyCash): Promise<Expense>; list(): Promise<PettyCash[]>; }
export interface AuditRepository { append(event: AuditEvent): Promise<void>; list(entity: string, entityId: string): Promise<AuditEvent[]>; }
export interface ConsecutiveRepository { take(prefix: "REQ" | "OC" | "OP", year: number): Promise<string>; }
/** Verifies a public link and code without exposing storage or clear-text comparison to the service. */
export interface PublicAccessVerifier { verify(workId: string, linkToken: string, code: string): Promise<boolean>; }
export interface TagRepository { getApproverId(tagId: string): Promise<string | null>; }
export interface FeatureRepository { isEnabled(name: string): Promise<boolean>; }
export interface ItemCatalogRepository { propose(description: string, unit: string, createdBy?: string): Promise<{ id: string; created: boolean }>; }
export type CatalogKind = "works" | "tags" | "items" | "suppliers";
export interface CatalogWork { id: string; name: string; societyId: string; active: boolean; }
export interface CatalogTag { id: string; name: string; approverId?: string | null; active: boolean; }
export interface CatalogItem { id: string; name: string; specification?: string | null; unit: string; category?: string | null; active: boolean; }
export interface CatalogSupplier { id: string; name: string; nit?: string | null; phone?: string | null; email?: string | null; address?: string | null; active: boolean; }
export type CatalogRecord = CatalogWork | CatalogTag | CatalogItem | CatalogSupplier;
export type CatalogCreateRecord = CatalogRecord extends infer T ? T extends CatalogRecord ? Omit<T, "id"> : never : never;
export type CatalogPatchRecord = CatalogRecord extends infer T ? T extends CatalogRecord ? Partial<Omit<T, "id">> : never : never;
/** CRUD-only records; adapters must normalize duplicate comparisons and never delete rows. */
export interface CatalogRepository { create(kind: CatalogKind, value: CatalogCreateRecord): Promise<CatalogRecord>; get(kind: CatalogKind, id: string): Promise<CatalogRecord | null>; update(kind: CatalogKind, id: string, value: CatalogPatchRecord): Promise<CatalogRecord>; findSupplierDuplicate(value: Pick<CatalogSupplier, "name" | "nit">, exceptId?: string): Promise<string | null>; isEligibleApprover(id: string): Promise<boolean>; }
export interface NotificationRepository { enqueue(notification: { userId?: string; phone?: string; channel: "whatsapp" | "interno"; template: string; payload: Record<string, unknown> }): Promise<void>; }
/** Repositories provided to the callback are pinned to the same database transaction/connection. */
export interface TransactionRepositories { requisitions: RequisitionRepository; orders: OrderRepository; expenses: ExpenseRepository; pettyCash: PettyCashRepository; audit: AuditRepository; consecutives: ConsecutiveRepository; tags: TagRepository; features: FeatureRepository; items: ItemCatalogRepository; catalogs: CatalogRepository; notifications: NotificationRepository; }
/**
 * Executes a unit of work on one database transaction. A lock key is `requisition:<id>`
 * or `order:<id>` when a state transition must be serialized; undefined is still atomic.
 */
export interface TransactionManager { transaction<T>(lockKey: string | undefined, work: (repositories: TransactionRepositories) => Promise<T>): Promise<T>; }
export interface Clock { now(): Date; }
export interface IdGenerator { next(): string; }
export interface ServiceDependencies {
  requisitions: RequisitionRepository; orders: OrderRepository; expenses: ExpenseRepository; pettyCash: PettyCashRepository;
  audit: AuditRepository; consecutives: ConsecutiveRepository; publicAccess: PublicAccessVerifier; tags: TagRepository; features: FeatureRepository; items: ItemCatalogRepository; catalogs: CatalogRepository; notifications: NotificationRepository; transactions: TransactionManager; clock: Clock; ids: IdGenerator;
}
export interface RequestContext { actor?: Actor; origin?: "web" | "mcp" | "kapso"; }
