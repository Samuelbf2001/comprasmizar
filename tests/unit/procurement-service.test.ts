import { describe, expect, it } from "vitest";
import { DEFAULT_ROLE_PERMISSIONS, DomainError, calculateDashboard, groupExpenseByCostCenter, groupExpenseByPeriod, groupExpenseByTag, groupExpenseByWork, paymentStatus, resolveActorPermissions, sumApprovedLines, sumLines, sumPaid, type AuditEvent, type Expense, type ExpenseShare, type Order, type OrderPayment, type PettyCash, type Requisition, type RequisitionStatus } from "../../lib/domain";
import { ProcurementService, type CatalogSupplier, type ServiceDependencies } from "../../lib/services";

const ZERO_BY_STATUS: Record<RequisitionStatus, number> = { enviada: 0, en_revision: 0, en_aprobacion: 0, aprobada: 0, devuelta: 0, declinada: 0 };

function fakeDeps(): ServiceDependencies & { req: Map<string, Requisition>; ordersData: Order[]; expensesData: Expense[]; paymentsData: OrderPayment[]; pettyData: PettyCash[]; proposedItems: Map<string, string>; notificationData: Array<{ userId?: string; phone?: string; channel: "whatsapp" | "interno"; template: string; payload: Record<string, unknown> }>; audits: AuditEvent[]; shares: ExpenseShare[]; visibleActors: string[]; transactionCalls: number; inactiveSuppliers: Set<string>; createdSuppliers: Map<string, CatalogSupplier> } {
  const req = new Map<string, Requisition>(), ordersData: Order[] = [], expensesData: Expense[] = [], paymentsData: OrderPayment[] = [], petty: PettyCash[] = [], audits: AuditEvent[] = [], shares: ExpenseShare[] = [], visibleActors: string[] = []; let seq = 0;
  // H3 (docs/plan-rendimiento.md): mismo criterio de visibilidad que listVisibleTo (arriba), reutilizado
  // por los métodos nuevos del dashboard (dashboardByStatus/listVisibleHeaders) — un solo lugar donde
  // ese criterio vive en este arnés, para que ambos no puedan divergir por accidente.
  const visibleRequisitions = (actorId: string) => [...req.values()].filter((r) => actorId === "daniel" || r.approverId === actorId);
  const visibleOrders = (actorId: string) => actorId === "daniel" ? ordersData : ordersData.filter((o) => o.requisitionId.includes(actorId));
  // H3: enriquece la orden con workId/requisitionConsecutive, igual que el join a requisiciones del
  // adaptador Postgres real (ver order(row) en postgres-repositories.ts) — generateOrders() en memoria
  // nunca los puebla, así que sin esto el backfill de ProcurementService.dashboard() (orderWorkById)
  // nunca tendría nada que ejercitar en este arnés.
  const withRequisitionJoin = (o: Order): Order => { const owner = req.get(o.requisitionId); return { ...o, workId: owner?.workId, requisitionConsecutive: owner?.consecutive }; };
  // Reunión agosto 2026: mismo criterio que el `left join lateral` del adaptador Postgres real
  // (orderSelectColumns()/orderFromJoins() en postgres-repositories.ts) — `Order.paidAmount` es
  // sum(valor) de pagos_orden, resuelto aquí para que `orders.get()` (el único método que
  // registerOrderPayment/updateOrderAdminStatus usan para leer y devolver la orden) refleje pagos
  // recién registrados en la MISMA transacción, igual que el SELECT real.
  // Adenda de pagos (N1): solo pagos VIGENTES (sumPaid), más estado derivado (paymentStatus contra el
  // total del gasto), último pago y medios — las mismas tres columnas que el lateral real expone.
  const withPayments = (o: Order): Order => {
    const own = paymentsData.filter((p) => p.orderId === o.id), active = own.filter((p) => !p.annulled), paid = sumPaid(own);
    const expense = expensesData.find((e) => e.origin === "requisicion" && e.referenceId === o.id);
    return { ...o, paidAmount: paid, paymentStatus: expense ? paymentStatus(expense.total, paid) : undefined, lastPaymentAt: active.reduce<string | undefined>((latest, p) => (!latest || p.date > latest ? p.date : latest), undefined), paymentMethods: [...new Set(active.map((p) => p.method))] };
  };
  const requisitions = {
    get: async (id: string) => req.get(id) ? structuredClone(req.get(id)!) : null, save: async (r: Requisition) => void req.set(r.id, structuredClone(r)), list: async () => [...req.values()].map((value) => structuredClone(value)),
    listVisibleTo: async (actor: { id: string }) => { visibleActors.push(`req:${actor.id}`); return visibleRequisitions(actor.id).map((value) => structuredClone(value)); },
    listVisibleHeaders: async (actor: { id: string }, options: { status?: RequisitionStatus[]; orderBy?: "created_at" | "updated_at"; limit?: number } = {}) => {
      visibleActors.push(`req:${actor.id}`);
      let visible = visibleRequisitions(actor.id);
      if (options.status?.length) visible = visible.filter((r) => options.status!.includes(r.status));
      if (options.limit) visible = visible.slice(0, options.limit);
      return visible.map((r) => structuredClone({ ...r, items: [] }));
    },
    dashboardByStatus: async (actor: { id: string }) => { visibleActors.push(`req:${actor.id}`); const byStatus = { ...ZERO_BY_STATUS }; for (const r of visibleRequisitions(actor.id)) byStatus[r.status]++; return byStatus; },
  };
  const orders = {
    save: async (o: Order) => { const i = ordersData.findIndex((x) => x.id === o.id); if (i >= 0) ordersData[i] = o; else ordersData.push(o); }, list: async () => ordersData,
    listVisibleTo: async (actor: { id: string }) => { visibleActors.push(`order:${actor.id}`); return visibleOrders(actor.id); },
    listByRequisition: async (id: string) => ordersData.filter((o) => o.requisitionId === id), get: async (id: string) => { const found = ordersData.find((o) => o.id === id); return found ? withPayments(found) : null; },
    listAttentionCandidates: async (actor: { id: string }) => { visibleActors.push(`order:${actor.id}`); return visibleOrders(actor.id).filter((o) => o.status === "generada" || o.status === "no_cumplida" || (o.adminStatus === "pendiente" && o.status !== "no_necesario")).map(withRequisitionJoin); },
    listRecentlyUpdated: async (actor: { id: string }, limit: number) => { visibleActors.push(`order:${actor.id}`); return visibleOrders(actor.id).slice(0, limit).map(withRequisitionJoin); },
    dashboardPendingCount: async (actor: { id: string }) => { visibleActors.push(`order:${actor.id}`); return visibleOrders(actor.id).filter((o) => o.status === "generada" || o.status === "no_cumplida").length; },
  };
  // markPaid: mismo criterio que el adaptador Postgres real (markExpensePaid) — solo actualiza `date`
  // de un gasto `origen: "requisicion"` ya existente; `saveExpense`/`save` nunca sirve para esto.
  // GRAVE 3 (QA reasignación): devuelve el número de filas afectadas, igual que markExpensePaid real
  // (`returning id`.length) — 0 cuando la orden no tiene gasto propio, la señal que el servicio usa
  // para rechazar "pagada" en vez de dejarla pasar en silencio.
  // GRAVE 2 (QA reasignación): deleteByReference borra el gasto Y su reparto, igual que el adaptador
  // Postgres real (gastos_reparto primero, por la FK on delete restrict).
  const visibleExpenses = (actorId: string) => actorId === "daniel" ? expensesData : [];
  const expenses = {
    get: async (id: string) => expensesData.find((entry) => entry.id === id) ?? null, save: async (e: Expense) => void expensesData.push(e),
    markPaid: async (referenceId: string, date: string | null) => { const entry = expensesData.find((e) => e.origin === "requisicion" && e.referenceId === referenceId); if (!entry) return 0; entry.date = date ?? undefined; entry.period = date?.slice(0, 7); return 1; },
    deleteByReference: async (origin: Expense["origin"], referenceId: string) => { const toDelete = expensesData.filter((e) => e.origin === origin && e.referenceId === referenceId); for (const entry of toDelete) { for (let index = shares.length - 1; index >= 0; index--) if (shares[index].expenseId === entry.id) shares.splice(index, 1); const i = expensesData.indexOf(entry); if (i >= 0) expensesData.splice(i, 1); } },
    saveShares: async (s: ExpenseShare[]) => { const id = s[0]?.expenseId; if (id) for (let index = shares.length - 1; index >= 0; index--) if (shares[index].expenseId === id) shares.splice(index, 1); shares.push(...s); },
    list: async () => expensesData, listVisibleTo: async (actor: { id: string }) => { visibleActors.push(`expense:${actor.id}`); return visibleExpenses(actor.id); },
    listByReference: async (id: string) => expensesData.filter((e) => e.referenceId === id || ordersData.some((o) => o.id === e.referenceId && o.requisitionId === id)),
    // H3: reproduce EXACTAMENTE calculateDashboard (periodExpense/inProcessValue) y groupExpenseByWork/
    // groupExpenseByTag/groupExpenseByPeriod (lib/domain/rules.ts, sin cambiar) sobre el mismo conjunto
    // visible que listVisibleTo — mismas funciones de dominio que antes calculaba dashboard(), ahora
    // sobre el resultado de este método en vez de sobre la colección completa.
    dashboardAggregates: async (actor: { id: string }, period: string) => {
      visibleActors.push(`expense:${actor.id}`);
      const visible = visibleExpenses(actor.id);
      return {
        periodExpense: visible.filter((e) => e.period === period).reduce((sum, e) => sum + e.total, 0),
        inProcessValue: visible.filter((e) => e.date === undefined).reduce((sum, e) => sum + e.total, 0),
        expenseByWork: groupExpenseByWork(visible), expenseByTag: groupExpenseByTag(visible), expenseByPeriod: groupExpenseByPeriod(visible),
        expenseByCostCenter: groupExpenseByCostCenter(visible),
      };
    },
    listRecentlyUpdated: async (actor: { id: string }, limit: number) => { visibleActors.push(`expense:${actor.id}`); return [...visibleExpenses(actor.id)].sort((a, b) => (b.date ?? b.orderDate).localeCompare(a.date ?? a.orderDate)).slice(0, limit); },
  };
  // Reunión agosto 2026: pagos parciales de orden — `save` es INSERT puro (igual que el adaptador
  // Postgres real, ver saveOrderPayment en postgres-repositories.ts), `listByOrder` ordena por fecha
  // (mismo criterio que el índice `pagos_orden_orden_fecha_idx`).
  // Adenda de pagos (N1): `get`/`annul` (el único UPDATE: 0 filas → null si ya estaba anulado) y
  // `listCash` (efectivo vigente en el rango, con la orden resuelta) reproducen el adaptador real.
  const orderPayments = {
    save: async (p: OrderPayment) => void paymentsData.push(p),
    listByOrder: async (orderId: string) => paymentsData.filter((p) => p.orderId === orderId).sort((a, b) => a.date.localeCompare(b.date)).map((p) => structuredClone(p)),
    get: async (orderId: string, paymentId: string) => { const found = paymentsData.find((p) => p.id === paymentId && p.orderId === orderId); return found ? structuredClone(found) : null; },
    annul: async (orderId: string, paymentId: string, annulment: { reason: string; actorId: string; at: string }) => { const found = paymentsData.find((p) => p.id === paymentId && p.orderId === orderId); if (!found || found.annulled) return null; found.annulled = true; found.annulmentReason = annulment.reason; found.annulledBy = annulment.actorId; found.annulledAt = annulment.at; return structuredClone(found); },
    listCash: async (query: { from: string; to: string; costCenterId?: string }) => paymentsData.filter((p) => p.method === "efectivo" && !p.annulled && p.date >= query.from && p.date <= query.to).map((p) => { const o = ordersData.find((x) => x.id === p.orderId)!, owner = req.get(o.requisitionId); return { ...structuredClone(p), orderConsecutive: o.consecutive, orderType: o.type, requisitionId: o.requisitionId, requisitionConsecutive: owner?.consecutive ?? "", workId: owner?.workId, costCenterId: owner?.costCenterId, supplierId: o.supplierId }; }).filter((row) => !query.costCenterId || row.costCenterId === query.costCenterId).sort((a, b) => a.date.localeCompare(b.date)),
  };
  const proposed = new Map<string, string>(), notificationData: Array<{ userId?: string; phone?: string; channel: "whatsapp" | "interno"; template: string; payload: Record<string, unknown> }> = [], audit = { append: async (a: AuditEvent) => void audits.push(a), list: async (entity: string, entityId: string) => audits.filter((entry) => entry.entity === entity && entry.entityId === entityId) }, consecutives = { take: async (p: "REQ" | "OC" | "OP", y: number) => `${p}-${y}-${String(++seq).padStart(4, "0")}` }, features = { isEnabled: async (name: string) => name === "ordenes_multi_proveedor" }, itemCatalog = { propose: async (description: string) => { const key = description.toLocaleLowerCase(); const existing = proposed.get(key); if (existing) return { id: existing, created: false }; const id = `catalog-${++seq}`; proposed.set(key, id); return { id, created: true }; } }, notifications = { enqueue: async (notification: (typeof notificationData)[number]) => { notificationData.push(notification); } };
  // Reunión 2026-09: caja menor nace pagada — orderDate y date coinciden siempre con la fecha del movimiento.
  // Cajas (2026-09-12): reproduce lo que sincronizar_gasto_caja_menor hace de verdad — copia
  // caja_id/medio_pago/iva/centro_costo_id/registrado_por al gasto, en vez de forzar iva=0 (el
  // bloqueante que esa migración corrigió).
  const pettyCash = { save: async (p: PettyCash) => { petty.push(p); const generated: Expense = { id: `expense-${p.id}`, workId: p.workId, origin: "caja_menor", referenceId: p.id, tagId: p.tagId, orderDate: p.date, date: p.date, base: p.amount, iva: p.iva ?? 0, total: p.amount + (p.iva ?? 0), period: p.date.slice(0, 7), cashBoxId: p.cashBoxId, paymentMethod: p.paymentMethod, costCenterId: p.costCenterId, registeredBy: p.registeredBy }; expensesData.push(generated); return generated; }, list: async () => petty };
  // "works"/"work" con sociedad "soc": único caso que review() debe resolver como obra válida y de la
  // misma sociedad que usan los fixtures de este archivo; cualquier otro id (p.ej. una obra de otra
  // empresa) resuelve a null para poder probar el rechazo INVALID_INPUT.
  // "suppliers" p1/p2/p3 activos y "p-inactivo" inactivo: cubren tanto los proveedores ya usados en los
  // fixtures de línea (finalSupplierId: "p1"/"p2") como el caso nuevo de assignSuppliers (p3, y el rechazo
  // por proveedor inactivo).
  // inactiveSuppliers: mutable, para probar el chequeo de generateOrders() (proveedor desactivado
  // DESPUÉS de assignSuppliers()/approve()) sin acoplarse al chequeo estático de "p-inactivo".
  const inactiveSuppliers = new Set<string>();
  // RF-606 (adenda de pagos): proveedores creados "al vuelo" por create() con `beneficiary` — el
  // repositorio real les da id en la base; aquí se guardan para que get()/findSupplierByIdentification
  // los encuentren dentro de la misma transacción. "p1" nace con NIT 900.111.222-3 para poder probar
  // el enlace por identificación contra un proveedor ya existente.
  const createdSuppliers = new Map<string, CatalogSupplier>();
  const normalizeId = (value: string) => value.replace(/[^0-9A-Za-z]/g, "");
  // "no-elegible": único id que review() debe rechazar como aprobador (usuario sin rol
  // aprobador/revisor/admin_sixteam, o dado de baja) — cualquier otro id (incluidos "nelson" y "sonia",
  // los dos actores aprobador de este archivo) es elegible.
  // Centros de costo (2026-09-12): "work" tiene "cc-work" como DEFAULT (sociedad "soc", activo) — así
  // el 99% de los tests existentes, que ya asignan workId "work" en review() sin mencionar centro,
  // siguen heredándolo automáticamente y sendForApproval() no los rompe (ver resolveCostCenter). Los
  // demás ids cubren los casos de rechazo/override que ejercitan las pruebas nuevas de este archivo.
  const catalogs = { create: async (kind: string, value: never) => { if (kind !== "suppliers") return value; const id = `sup-${++seq}`; const created = { ...(value as object), id } as CatalogSupplier; createdSuppliers.set(id, created); return created as never; }, get: async (kind: string, id: string) => (
    kind === "suppliers" && createdSuppliers.has(id) ? createdSuppliers.get(id)!
    : kind === "suppliers" && id === "p1" ? { id: "p1", name: "Proveedor p1", nit: "900.111.222-3", identificationType: "NIT" as const, identification: "900.111.222-3", active: !inactiveSuppliers.has("p1") }
    : kind === "works" && id === "work" ? { id: "work", name: "Obra Test", societyId: "soc", active: true, costCenterId: "cc-work" }
    : kind === "costCenters" && id === "cc-work" ? { id: "cc-work", name: "Centro Test", societyId: "soc", active: true }
    : kind === "costCenters" && id === "cc-alterno" ? { id: "cc-alterno", name: "Centro Alterno", societyId: "soc", active: true }
    : kind === "costCenters" && id === "cc-compartido" ? { id: "cc-compartido", name: "Centro Compartido", societyId: undefined, active: true }
    : kind === "costCenters" && id === "cc-otra-sociedad" ? { id: "cc-otra-sociedad", name: "Centro de otra empresa", societyId: "otra-sociedad", active: true }
    : kind === "costCenters" && id === "cc-inactivo" ? { id: "cc-inactivo", name: "Centro Inactivo", societyId: "soc", active: false }
    // RF-008 (N4): centros que NO son obra liberan la exigencia de obra; "cc-obra-explicita" la conserva.
    : kind === "costCenters" && id === "cc-admin" ? { id: "cc-admin", name: "Administración", societyId: "soc", type: "administrativo" as const, active: true }
    : kind === "costCenters" && id === "cc-admin-proim" ? { id: "cc-admin-proim", name: "Servicios PROIM", societyId: "proim", type: "empresa" as const, active: true }
    : kind === "costCenters" && id === "cc-obra-explicita" ? { id: "cc-obra-explicita", name: "Obra Sur", societyId: "soc", type: "obra" as const, active: true }
    // Obra sin centro configurado: ejercita el caso "no hay de dónde heredar" (a diferencia de "work",
    // que siempre trae "cc-work").
    : kind === "works" && id === "obra-sin-centro" ? { id: "obra-sin-centro", name: "Obra Sin Centro", societyId: "soc", active: true }
    : kind === "suppliers" && ["p1", "p2", "p3"].includes(id) ? { id, name: `Proveedor ${id}`, active: !inactiveSuppliers.has(id) }
    : kind === "suppliers" && id === "p-inactivo" ? { id, name: "Proveedor inactivo", active: false }
    // Cajas (2026-09-12): "caja-menor" es la única caja activa de este arnés — registerPettyCash la
    // valida antes de guardar (ver procurement-service.ts).
    : kind === "cashBoxes" && id === "caja-menor" ? { id: "caja-menor", name: "Caja Menor", type: "caja_menor", active: true }
    : kind === "cashBoxes" && id === "caja-inactiva" ? { id: "caja-inactiva", name: "Caja Inactiva", type: "caja_menor", active: false }
    // Empresa facturada (RF-009): "soc" es la sociedad de los fixtures; "proim" otra sociedad activa (la
    // factura de un gasto de Juliana puede venir a nombre de PROIM); "soc-inactiva" para el rechazo.
    : kind === "societies" && id === "soc" ? { id: "soc", name: "Mizar", active: true }
    : kind === "societies" && id === "proim" ? { id: "proim", name: "Proim", active: true }
    : kind === "societies" && id === "soc-inactiva" ? { id: "soc-inactiva", name: "Cerrada", active: false }
    // Usuarios: los consulta `namedApprovers` para escribir el nombre del aprobador saltado en la
    // auditoría de una aprobación por encima (decisión de Ernesto, 2026-09-17). Un id sin ficha deja
    // solo el uuid, que es el caso "usuario borrado del catálogo".
    : kind === "users" && id === "sonia" ? { id: "sonia", name: "Sonia Aprobadora", email: "sonia@mizar.test", active: true, roles: ["aprobador"] }
    : null
  ), update: async (_kind: string, _id: string, value: never) => value, findSupplierDuplicate: async () => null,
    findSupplierByIdentification: async (type: string, identification: string) => {
      const wanted = normalizeId(identification);
      if (type === "NIT" && wanted === "9001112223") return (await catalogs.get("suppliers", "p1")) as CatalogSupplier;
      return [...createdSuppliers.values()].find((supplier) => (supplier.identificationType ?? "NIT") === type && normalizeId(supplier.identification ?? "") === wanted) ?? null;
    },
    findRequesterDuplicate: async () => null, isEligibleApprover: async (id: string) => id !== "no-elegible", hasRequisitionsForWork: async () => false };
  const transactions = { transaction: async <T>(_id: string | undefined, work: (repositories: Parameters<ServiceDependencies["transactions"]["transaction"]>[1] extends (repositories: infer R) => Promise<unknown> ? R : never) => Promise<T>) => {
    const snapshot = { req: structuredClone([...req.entries()]), orders: structuredClone(ordersData), expenses: structuredClone(expensesData), payments: structuredClone(paymentsData), petty: structuredClone(petty), audits: structuredClone(audits), shares: structuredClone(shares), proposed: structuredClone([...proposed.entries()]), notifications: structuredClone(notificationData) };
    try { return await work({ requisitions, orders, expenses, orderPayments, pettyCash, incomes: {} as never, cashCloses: {} as never, audit, consecutives, features, items: itemCatalog, catalogs, notifications }); }
    catch (error) { req.clear(); for (const [id, value] of snapshot.req) req.set(id, value); ordersData.splice(0, ordersData.length, ...snapshot.orders); expensesData.splice(0, expensesData.length, ...snapshot.expenses); paymentsData.splice(0, paymentsData.length, ...snapshot.payments); petty.splice(0, petty.length, ...snapshot.petty); audits.splice(0, audits.length, ...snapshot.audits); shares.splice(0, shares.length, ...snapshot.shares); proposed.clear(); for (const [key, value] of snapshot.proposed) proposed.set(key, value); notificationData.splice(0, notificationData.length, ...snapshot.notifications); throw error; }
  } };
  return { req, ordersData, expensesData, paymentsData, pettyData: petty, proposedItems: proposed, notificationData, audits, shares, visibleActors, transactionCalls: 0, ids: { next: () => `id-${++seq}` }, clock: { now: () => new Date("2026-08-24T12:00:00.000Z") }, consecutives, publicAccess: { verify: async (workId, token, code) => workId === "work" && token === "link" && code === "1234", verifySociety: async (societyId, token, code) => societyId === "society" && token === null && code === "1234" }, features, items: itemCatalog, catalogs, notifications, transactions, requisitions, orders, expenses, orderPayments, pettyCash, incomes: {} as never, cashCloses: {} as never, audit, inactiveSuppliers, createdSuppliers };
}
const reviewer = { actor: { id: "daniel", roles: ["revisor"] as const } }, approver = { actor: { id: "nelson", roles: ["aprobador"] as const } }, requester = { actor: { id: "sol", roles: ["solicitante"] as const } };
// "sonia": segundo actor aprobador, distinto de "nelson" — usado para probar que el aprobador ELEGIDO
// por el revisor en review() (no uno cualquiera con rol aprobador) es quien puede decidir la requisición.
const otherApprover = { actor: { id: "sonia", roles: ["aprobador"] as const } };
const items = [{ id: "l1", itemId: "catalog-cemento", description: "Cemento", quantity: 2, unit: "und", unitBase: 100, unitIva: 19, unitTotal: 119, finalSupplierId: "p1" }, { id: "l2", itemId: "catalog-arena", description: "Arena", quantity: 1, unit: "und", unitBase: 200, unitIva: 38, unitTotal: 238, finalSupplierId: "p2" }];
async function reviewed(service: ProcurementService) { const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester); await service.startReview(r.id, reviewer); await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer); return service.sendForApproval(r.id, reviewer); }

describe("ProcurementService", () => {
  it("persists enviada first and enters review through an audited explicit transition", async () => { const deps = fakeDeps(), service = new ProcurementService(deps); const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester); expect(r.status).toBe("enviada"); expect(deps.audits.map((a) => a.event)).toEqual(["creada"]); await service.startReview(r.id, reviewer); expect((await deps.requisitions.get(r.id))?.status).toBe("en_revision"); expect(deps.audits.at(-1)?.data).toMatchObject({ from: "enviada", to: "en_revision" }); });
  // NOTA (feat/solicitud-de-pago): este caso pasó de type:"pago" a type:"compra" — lo que prueba es
  // la materialización de propuestas de CATÁLOGO en general (y el verificador de acceso público),
  // no nada específico de pago. Con la corrección del ítem 1 del encargo, "pago" ya NO materializa
  // catálogo (ver la prueba siguiente); usar aquí "pago" habría probado exactamente el defecto que
  // se corrigió, en vez del camino feliz de una compra.
  it("requisición pública por empresa (sin obra) crea en vez de PUBLIC_ACCESS_DENIED, para compra y para pago", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const porEmpresa = { societyId: "society", channel: "publico" as const, publicCode: "1234", externalRequester: { name: "Maestro" } };
    await expect(service.create({ type: "compra", ...porEmpresa, requiredDate: "2026-08-30", items }, {})).resolves.toMatchObject({ status: "enviada", societyId: "society", workId: undefined });
    await expect(service.create({ type: "pago", ...porEmpresa, beneficiary: { identificationType: "CC", identification: "1.020.304.050", name: "Juan Camilo" }, items: [{ ...items[0], itemId: undefined, description: "Levantamiento", finalSupplierId: undefined }] }, {})).resolves.toMatchObject({ type: "pago", status: "enviada", societyId: "society", workId: undefined });
    // Misma puerta que la ruta: contraseña incorrecta, o un token por obra intentando autorizar una sociedad, se niegan.
    await expect(service.create({ type: "compra", ...porEmpresa, publicCode: "0000", items }, {})).rejects.toMatchObject({ code: "PUBLIC_ACCESS_DENIED" });
    await expect(service.create({ type: "compra", ...porEmpresa, publicLinkToken: "link", items }, {})).rejects.toMatchObject({ code: "PUBLIC_ACCESS_DENIED" });
    await expect(service.create({ type: "compra", channel: "publico", publicCode: "1234", externalRequester: { name: "Maestro" }, items }, {})).rejects.toMatchObject({ code: "PUBLIC_ACCESS_DENIED" });
  });
  it("uses a verifier for public access, materializes proposals and normalizes the external phone", async () => { const deps = fakeDeps(), service = new ProcurementService(deps); const created = await service.create({ type: "compra", workId: "work", requiredDate: "2026-08-30", channel: "publico", publicCode: "1234", publicLinkToken: "link", externalRequester: { name: "Maestro", phone: "+57 300 123 4567" }, items: [{ ...items[0], itemId: undefined, description: "Tubería especial" }] }, {}); expect(created).toMatchObject({ status: "enviada", externalRequester: { phone: "+573001234567" }, items: [{ itemId: expect.stringMatching(/^catalog-/) }] }); expect(deps.audits.map((entry) => entry.event)).toContain("propuesto"); });
  // BLOQUEANTE (feat/solicitud-de-pago, ítem 1 del encargo): antes de este arreglo,
  // materializeProposals() creaba un ítem de CATÁLOGO a partir de cualquier descripción libre sin
  // itemId, sin mirar el tipo de requisición — con type:"pago" eso contaminaría el maestro de ítems
  // con conceptos de una sola vez ("Pago acta 3 contratista X"). Ahora item_id queda NULL (permitido
  // por requisicion_items_item_check, migración 202608240001_core_compras.sql) y no se propone nada.
  it("una solicitud de pago con concepto libre NO materializa un ítem de catálogo (item_id queda NULL)", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const created = await service.create({ type: "pago", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], itemId: undefined, description: "Pago acta 3 - Contratista ABC" }] }, requester);
    expect(created.items).toHaveLength(1);
    expect(created.items[0].itemId).toBeUndefined();
    expect(created.items[0].description).toBe("Pago acta 3 - Contratista ABC");
    expect(deps.audits.map((entry) => entry.event)).not.toContain("propuesto");
    expect(deps.proposedItems.size).toBe(0);
  });

  // EL TELÉFONO DEJÓ DE SER OBLIGATORIO EN EL PORTAL (Ernesto, 11-sep-2026: «el teléfono no lo hagas
  // obligatorio»). Antes esta prueba fijaba lo contrario, y no era un capricho cambiarlo: exigirlo
  // significaba que un maestro que no lo quiere dar no radica.
  //
  // Lo que NO cambia es el precio, y por eso se afirma aquí: sin teléfono no hay a quién avisar, así
  // que no se encola el acuse. Que la requisición entre sin aviso es la decisión; que entrara y el
  // aviso se perdiera en silencio sería un fallo.
  it("el portal público acepta una requisición SIN teléfono, y entonces no encola el acuse", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const created = await service.create({ type: "compra", workId: "work", requiredDate: "2026-08-30", channel: "publico", publicCode: "1234", publicLinkToken: "link", externalRequester: { name: "Maestro" }, items }, {});
    expect(created).toMatchObject({ status: "enviada", externalRequester: { name: "Maestro" } });
    expect(created.externalRequester?.phone).toBeUndefined();
    expect(deps.notificationData).toHaveLength(0);
    // Con teléfono sí lo encola: es el contraste que demuestra que el acuse no se cayó por otra razón.
    const conTelefono = await service.create({ type: "compra", workId: "work", requiredDate: "2026-08-30", channel: "publico", publicCode: "1234", publicLinkToken: "link", externalRequester: { name: "Maestro", phone: "3001234567" }, items }, {});
    expect(deps.notificationData).toEqual([expect.objectContaining({ phone: "3001234567", channel: "whatsapp", template: "requisicion_recibida", payload: expect.objectContaining({ requisitionId: conTelefono.id }) })]);
  });

  it("pero el NOMBRE sigue siendo obligatorio, un teléfono mal escrito se rechaza, y en WhatsApp el teléfono es la identidad", async () => {
    // En WhatsApp el número no es un dato de contacto: es de quién viene el mensaje. Sin él no hay
    // remitente al que atribuir la requisición, así que ahí sí sigue siendo obligatorio.
    const service = new ProcurementService(fakeDeps());
    const publica = { type: "compra" as const, workId: "work", requiredDate: "2026-08-30", channel: "publico" as const, publicCode: "1234", publicLinkToken: "link", items };
    await expect(service.create({ ...publica, externalRequester: { name: "   " } }, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.create({ ...publica, externalRequester: { name: "Maestro", phone: "300" } }, {})).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.create({ type: "compra", societyId: "soc", requiredDate: "2026-08-30", channel: "whatsapp", kapsoEventId: "evt-sin-telefono", externalRequester: { name: "Maestro" }, items }, { origin: "kapso" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  // Decisión del cliente (reunión 2026-09, literal de Daniel): "etiqueto a qué obra va y etiqueto quién
  // me va a aprobar" — el aprobador YA NO se deriva de la etiqueta, lo elige el revisor en review().
  it("review() persiste el aprobador elegido por el revisor (no lo deriva de la etiqueta) y audita transiciones de devolución", async () => { const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester); await service.startReview(r.id, reviewer); const reviewedR = await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer); expect(reviewedR.approverId).toBe("nelson"); await service.sendForApproval(r.id, reviewer); await expect(service.returnForCorrection(r.id, "", approver)).rejects.toBeInstanceOf(DomainError); expect((await service.returnForCorrection(r.id, "falta soporte", approver)).status).toBe("devuelta"); });
  it("review() rechaza un approverId no elegible (usuario sin rol aprobador/revisor/admin_sixteam, o dado de baja)", async () => {
    const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.review(r.id, { tagId: "tag", approverId: "no-elegible", items }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // La validación de approverId corre ANTES de tocar la requisición: un aprobador no elegible no deja
    // nada a medio camino (ni tagId ni approverId quedan escritos).
    const untouched = await service.getRequisition(r.id, reviewer);
    expect(untouched.approverId).toBeUndefined(); expect(untouched.tagId).toBeUndefined(); expect(untouched.status).toBe("en_revision");
  });
  it("review() puede guardarse como borrador sin approverId todavía, pero sendForApproval() lo exige aunque ya haya etiqueta", async () => {
    const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const draft = await service.review(r.id, { tagId: "tag", items }, reviewer); // sin approverId: borrador válido
    expect(draft.tagId).toBe("tag"); expect(draft.approverId).toBeUndefined();
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
  });
  // Punto 4 del rediseño "una acción por estado/rol" (reunión 2026-09): la pantalla ahora autoguarda
  // la revisión cada blur/1.500ms, así que `review()` se llama muchas más veces por sesión de lo que
  // se llamaba con el botón "Guardar revisión" de siempre. Sin esta guarda, cada disparo del
  // autoguardado —incluidos los que no cambiaron nada porque el usuario solo hizo clic en un campo y
  // salió— habría auditado "revisada" y llenado el historial de trazabilidad de entradas vacías.
  it("review() no audita 'revisada' cuando el payload no cambia nada material respecto a lo ya guardado", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const input = { tagId: "tag", approverId: "nelson", workId: "work", items };
    await service.review(r.id, input, reviewer);
    const auditsAfterFirstSave = deps.audits.filter((entry) => entry.event === "revisada").length;
    expect(auditsAfterFirstSave).toBe(1);
    // Mismo payload, otra vez (el autoguardado disparó sin que nada cambiara en pantalla).
    await service.review(r.id, input, reviewer);
    expect(deps.audits.filter((entry) => entry.event === "revisada").length).toBe(auditsAfterFirstSave);
    // Un cambio real (precio distinto) SÍ debe seguir auditándose.
    await service.review(r.id, { ...input, items: [{ ...items[0], unitBase: 150, unitIva: undefined, unitTotal: undefined }, items[1]] }, reviewer);
    expect(deps.audits.filter((entry) => entry.event === "revisada").length).toBe(auditsAfterFirstSave + 1);
  });
  // El aprobador lo elige el revisor, no la etiqueta: dos requisiciones con la MISMA etiqueta pueden
  // terminar con aprobadores distintos, y solo el asignado a cada una puede decidirla.
  it("el aprobador asignado en review() (no cualquier otro con rol aprobador) es quien puede aprobar la requisición", async () => {
    const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const reviewedR = await service.review(r.id, { tagId: "tag", approverId: "sonia", items }, reviewer);
    expect(reviewedR.approverId).toBe("sonia");
    await service.sendForApproval(r.id, reviewer);
    // "nelson" tiene rol aprobador pero NO es el elegido para esta requisición.
    await expect(service.approve(r.id, approver)).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
    await expect(service.approve(r.id, otherApprover)).resolves.toMatchObject({ status: "aprobada" });
  });
  it("returns traceability only after applying requisition visibility", async () => { const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester); await service.startReview(r.id, reviewer); const history = await service.getRequisitionHistory(r.id, reviewer); expect(history.map((entry) => entry.event)).toEqual(["creada", "entrada_revision"]); await expect(service.getRequisitionHistory(r.id, { actor: { id: "stranger", roles: ["solicitante"] } })).rejects.toMatchObject({ code: "NOT_FOUND" }); });
  it("does not let an MCP caller bypass service read permissions", async () => { const service = new ProcurementService(fakeDeps()); await expect(service.listOrders({ ...requester, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(service.listExpenses({ ...requester, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" }); });

  // Cobertura nueva (reunión 2026-08-31), ítem 1: el consecutivo sale del reloj del servidor, nunca de la
  // fecha requerida — sin esta aserción el cambio (year = this.now().getFullYear()) es invisible.
  it("REQ-<año del reloj>, aunque la fecha requerida caiga en otro año", async () => {
    const deps = fakeDeps(); deps.clock.now = () => new Date("2026-12-31T12:00:00.000Z");
    const service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", requiredDate: "2027-03-01", channel: "web", items }, requester);
    expect(r.consecutive).toMatch(/^REQ-2026-\d{4}$/);
  });
  // Ítem 2: crear sin obra y sin fecha requerida funciona; sendForApproval sin obra falla (gastos.obra_id
  // es NOT NULL y sin obra generateOrders reventaría al registrar el gasto).
  it("crea una requisición sin obra y sin fecha requerida; sendForApproval sin obra asignada falla", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", channel: "web", items }, requester);
    expect(r.workId).toBeUndefined(); expect(r.requiredDate).toBeUndefined();
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer); // no asigna obra
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
  });
  it("review() asigna la obra (la elige el revisor) y valida que pertenezca a la sociedad de la requisición", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.review(r.id, { tagId: "tag", workId: "obra-de-otra-empresa", items }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const reviewedR = await service.review(r.id, { tagId: "tag", workId: "work", items }, reviewer);
    expect(reviewedR.workId).toBe("work");
  });
  // Ítem 3: sendForApproval SÍ deja pasar un ítem sin proveedor final — es la decisión central de la
  // reunión (aprobar y designar proveedor son roles distintos; exigirle proveedor al aprobador rompe su rol).
  it("sendForApproval deja pasar un ítem sin proveedor final", async () => {
    const service = new ProcurementService(fakeDeps());
    const req = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], finalSupplierId: undefined }] }, requester);
    await service.startReview(req.id, reviewer);
    await service.review(req.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], finalSupplierId: undefined }] }, reviewer);
    await expect(service.sendForApproval(req.id, reviewer)).resolves.toMatchObject({ status: "en_aprobacion" });
  });
  // Ítem 7: IVA legacy — una línea con iva > 0 y sin ivaRate entrante no se pone en cero al guardar,
  // aunque el payload reenviado sí traiga unitIva en 0 (cliente que ya trata unitIva como derivado).
  // B2 (QA Postgres real): la versión original de esta prueba solo afirmaba sobre `unitIva`, un campo
  // que `calculateLineAmounts` IGNORA cuando `ivaRate` está definido — así que no detectaba el bug
  // real (mapear iva_tasa NOT NULL DEFAULT 0 como `ivaRate: 0`, en vez de `undefined`, fuerza la vía
  // de tasa y evapora el IVA aunque unitIva siga en 190). Ahora se afirma también sobre `ivaRate`
  // (debe quedar `undefined`, nunca coaccionado a 0) y sobre el TOTAL derivado (`service.lineTotal`),
  // que es justo lo que se rompía en producción.
  it("conserva el IVA legacy si la línea entrante no trae ivaRate y la almacenada tenía iva > 0 (sin forzar la vía de tasa con 0)", async () => {
    const service = new ProcurementService(fakeDeps());
    const legacyItem = { id: "legacy-1", itemId: "catalog-legacy", description: "Ítem legacy", quantity: 1, unit: "und", unitBase: 1000, unitIva: 190, unitTotal: 1190, finalSupplierId: "p1" };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [legacyItem] }, requester);
    await service.startReview(r.id, reviewer);
    const reviewedR = await service.review(r.id, { tagId: "tag", items: [{ ...legacyItem, unitIva: 0, unitTotal: undefined }] }, reviewer);
    expect(reviewedR.items[0].ivaRate).toBeUndefined();
    expect(reviewedR.items[0].unitIva).toBe(190);
    expect(service.lineTotal(reviewedR.items[0])).toBe(1190);
  });

  // GRAVE 1 (QA Postgres real): fecha (orderDate) del gasto en zona horaria de Colombia (UTC-5), no en
  // UTC. Reloj congelado en la frontera exacta del bug: 2026-08-31T23:30:00-05:00 (== UTC
  // 2026-09-01T04:30:00Z) debe seguir naciendo en agosto, no en septiembre.
  // Reunión 2026-09: generateOrders ya NO fija fecha/periodo de pago — el gasto nace sin `date`/
  // `period` (compromiso, todavía no un gasto) y solo trae `orderDate`.
  it("generateOrders crea el gasto sin fecha de pago, con orderDate en hora de Colombia (frontera 2026-08-31 23:30 -05:00)", async () => {
    const deps = fakeDeps(); deps.clock.now = () => new Date("2026-09-01T04:30:00.000Z");
    const service = new ProcurementService(deps);
    const r = await reviewed(service);
    await service.approve(r.id, approver);
    await service.generateOrders(r.id, reviewer);
    expect(deps.expensesData).toHaveLength(2);
    for (const expense of deps.expensesData) { expect(expense.orderDate).toBe("2026-08-31"); expect(expense.date).toBeUndefined(); expect(expense.period).toBeUndefined(); }
  });

  // Menor (QA Postgres real): un proveedor puede desactivarse DESPUÉS de aprobar/asignar — generateOrders
  // debe rechazar con un error de dominio legible, todo o nada (ninguna orden/gasto a medias).
  it("generateOrders rechaza con SUPPLIER_INACTIVE si un proveedor asignado se desactivó después de aprobar", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await reviewed(service);
    await service.approve(r.id, approver);
    deps.inactiveSuppliers.add("p1");
    await expect(service.generateOrders(r.id, reviewer)).rejects.toMatchObject({ code: "SUPPLIER_INACTIVE" });
    expect(deps.ordersData).toHaveLength(0); expect(deps.expensesData).toHaveLength(0);
  });

  it("approve() solo transiciona; generateOrders() crea las órdenes transaccionalmente y de forma idempotente, una por proveedor", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service), originalTransaction = deps.transactions.transaction;
    let calls = 0, transactionalReposUsed = false;
    deps.transactions.transaction = async (lockedId, work) => { calls++; expect(lockedId).toBe(`requisition:${r.id}`); return originalTransaction(lockedId, async (repositories) => work({ ...repositories, requisitions: { ...repositories.requisitions, get: async (id) => { transactionalReposUsed = true; return repositories.requisitions.get(id); } } })); };
    const approved = await service.approve(r.id, approver);
    expect(approved.status).toBe("aprobada");
    // Contiene ninguna referencia a Order/Expense/groupOrderItems/features: approve() ya no las toca.
    const first = await service.generateOrders(r.id, reviewer);
    const second = await service.generateOrders(r.id, reviewer);
    expect(calls).toBe(3); // approve() + 2×generateOrders(), todas bajo el mismo lock requisition:<id>
    expect(transactionalReposUsed).toBe(true);
    expect(first).toHaveLength(2); expect(second).toHaveLength(2);
    expect(deps.ordersData).toHaveLength(2); expect(deps.expensesData).toHaveLength(2);
    expect(deps.expensesData.map((e) => e.supplierId).sort()).toEqual(["p1", "p2"]);
    expect(deps.notificationData.filter((entry) => entry.template === "requisicion_aprobada")).toHaveLength(1);
    expect(deps.audits.map((a) => a.entity)).toContain("orden"); expect(deps.audits.map((a) => a.entity)).toContain("gasto");
    await expect(service.approve(r.id, { actor: { id: "other", roles: ["aprobador"] } })).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
  });
  it("generateOrders es todo o nada: si falta proveedor en una línea aprobada, lanza SUPPLIER_REQUIRED y no crea nada", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], finalSupplierId: undefined }] }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], finalSupplierId: undefined }] }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    await expect(service.generateOrders(r.id, reviewer)).rejects.toMatchObject({ code: "SUPPLIER_REQUIRED" });
    expect(deps.ordersData).toHaveLength(0); expect(deps.expensesData).toHaveLength(0);
  });
  // Bloqueante de atasco (reunión 2026-08-31): sin assignSuppliers, la requisición de la prueba anterior
  // quedaría "aprobada" para siempre, sin ninguna forma de generar sus órdenes. Esta prueba cierra el
  // ciclo completo: atascada -> assignSuppliers -> generateOrders funciona.
  it("assignSuppliers asigna proveedor a un ítem aprobado sin proveedor final y desatasca generateOrders", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], finalSupplierId: undefined }] }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], finalSupplierId: undefined }] }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    await expect(service.generateOrders(r.id, reviewer)).rejects.toMatchObject({ code: "SUPPLIER_REQUIRED" }); // atascada
    const assigned = await service.assignSuppliers(r.id, [{ itemId: items[0].id, supplierId: "p3" }], reviewer);
    expect(assigned.items.find((line) => line.id === items[0].id)?.finalSupplierId).toBe("p3");
    const orders = await service.generateOrders(r.id, reviewer); // ya no está atascada
    expect(orders).toHaveLength(1); expect(orders[0].supplierId).toBe("p3");
    expect(deps.audits.map((a) => a.event)).toContain("proveedores_asignados");
  });
  it("assignSuppliers rechaza si la requisición ya tiene órdenes generadas (documento en firme, no se reabre)", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.approve(r.id, approver);
    await service.generateOrders(r.id, reviewer);
    await expect(service.assignSuppliers(r.id, [{ itemId: items[0].id, supplierId: "p3" }], reviewer)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
  it("un aprobador no puede llamar assignSuppliers: es permiso order:create (compras), no requisition:approve", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], finalSupplierId: undefined }] }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], finalSupplierId: undefined }] }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    await expect(service.assignSuppliers(r.id, [{ itemId: items[0].id, supplierId: "p3" }], approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("assignSuppliers solo toca finalSupplierId: cantidad/precio/tasas/estado de la línea no cambian aunque el input traiga esos campos, y rechaza proveedor inexistente/inactivo o un ítem declinado", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.decideItems(r.id, [{ itemId: items[0].id, status: "aprobado" }, { itemId: items[1].id, status: "declinado", declineReason: "no aplica" }], approver);
    await service.approve(r.id, approver);
    await expect(service.assignSuppliers(r.id, [{ itemId: items[0].id, supplierId: "no-existe" }], reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.assignSuppliers(r.id, [{ itemId: items[0].id, supplierId: "p-inactivo" }], reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.assignSuppliers(r.id, [{ itemId: items[1].id, supplierId: "p3" }], reviewer)).rejects.toMatchObject({ code: "ITEM_DECLINED" });
    // El shape de SupplierAssignment ({itemId, supplierId}) no admite otros campos en TypeScript; se
    // fuerza aquí con un cast para probar que, aunque llegaran, assignSuppliers los ignora por completo.
    const tampered = { itemId: items[0].id, supplierId: "p3", quantity: 999, unitBase: 1, status: "declinado" } as unknown as { itemId: string; supplierId: string };
    const assigned = await service.assignSuppliers(r.id, [tampered], reviewer);
    const line = assigned.items.find((entry) => entry.id === items[0].id)!;
    expect(line.finalSupplierId).toBe("p3");
    expect(line.quantity).toBe(items[0].quantity);
    expect(line.unitBase).toBe(items[0].unitBase);
    expect(line.status).toBe("aprobado"); // el decideItems anterior, no el "declinado" colado en el tamper
  });
  // Ítem 4: un ítem declinado se conserva visible (no se borra), se excluye del gasto, y sumApprovedLines
  // difiere de sumLines (que sigue sumando todas las líneas para create()/dashboard.inProcessValue).
  it("un ítem declinado por el aprobador se conserva, se excluye del gasto, y sumApprovedLines ≠ sumLines", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    const decided = await service.decideItems(r.id, [{ itemId: items[0].id, status: "aprobado" }, { itemId: items[1].id, status: "declinado", declineReason: "No corresponde a la obra" }], approver);
    expect(decided.items).toHaveLength(2); // se conserva, no se borra
    expect(decided.items.find((line) => line.id === items[1].id)).toMatchObject({ status: "declinado", declineReason: "No corresponde a la obra" });
    expect(sumApprovedLines(decided.items)).not.toBe(sumLines(decided.items));
    expect(sumApprovedLines(decided.items)).toBe(sumLines([items[0]]));
    // decideItems no cambia el estado de la requisición.
    expect(decided.status).toBe("en_aprobacion");
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect(orders).toHaveLength(1); // la línea declinada (proveedor p2) nunca entra a ninguna orden
    expect(deps.expensesData.reduce((sum, expense) => sum + expense.total, 0)).toBe(sumLines([items[0]]));
  });
  // Ítem 6: los dos ejes no se interfieren, pagada exige contabilizada primero, no_necesario bloquea
  // contabilizar, y un aprobador no puede generar órdenes (permiso order:create solo de revisor/admins).
  it("el eje administrativo es independiente del cumplimiento y respeta los roles (un aprobador no puede generar órdenes)", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await expect(service.generateOrders(r.id, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.approve(r.id, approver);
    const [orderA, orderB] = await service.generateOrders(r.id, reviewer);
    const accounted = await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
    expect(accounted).toMatchObject({ status: "generada", adminStatus: "contabilizada" }); // contabilizar no altera el cumplimiento
    await expect(service.updateOrderAdminStatus(orderB.id, "pagada", reviewer)).rejects.toMatchObject({ code: "INVALID_ADMIN_TRANSITION" }); // pagada exige contabilizada antes
    // Adenda de pagos (A3): "pagada" ya no inventa el pago — exige saldo cero, así que primero se paga el total (238).
    await service.registerOrderPayment(orderA.id, { date: "2026-08-20", amount: 238, method: "transferencia" }, reviewer);
    const paid = await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
    const fulfilled = await service.updateOrderStatus(orderA.id, "cumplida", reviewer);
    expect(fulfilled.adminStatus).toBe("pagada"); // marcar cumplida no altera el eje administrativo
    expect(paid.adminStatus).toBe("pagada");
    await service.updateOrderStatus(orderB.id, "no_necesario", reviewer);
    await expect(service.updateOrderAdminStatus(orderB.id, "contabilizada", { actor: { id: "cont2", roles: ["contabilidad"] } })).rejects.toMatchObject({ code: "ORDER_NOT_NEEDED" });
  });
  // Reunión 2026-09: "la fecha del gasto es la del pago" — marcar una orden "pagada" fija `date`
  // (y por tanto `period`) del gasto que esa orden generó con la fecha del ÚLTIMO pago vigente, no con
  // la del reloj (adenda de pagos, A3: ya no hay pago automático "de hoy"). Reloj congelado en
  // septiembre a propósito: la fecha que manda es la del pago registrado en agosto.
  it("marcar una orden pagada fija la fecha de pago del gasto con la del último pago vigente, no con la del reloj", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    let expense = deps.expensesData.find((e) => e.referenceId === orderA.id)!;
    expect(expense.date).toBeUndefined(); expect(expense.period).toBeUndefined(); // compromiso, aún sin pagar
    await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
    await service.registerOrderPayment(orderA.id, { date: "2026-08-31", amount: 238, method: "efectivo" }, reviewer);
    deps.clock.now = () => new Date("2026-09-01T03:30:00.000Z");
    await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
    expense = deps.expensesData.find((e) => e.referenceId === orderA.id)!;
    expect(expense.date).toBe("2026-08-31");
    expect(expense.period).toBe("2026-08");
  });
  it("rejects incomplete review and blocks approval from MCP", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await expect(service.approve(r.id, { ...approver, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // NOTA (feat/solicitud-de-pago): "compra", no "pago" — este caso prueba REVIEW_INCOMPLETE
    // genérico (ítem vigente en cero al enviar a aprobación), no nada específico de pago. Con la
    // regla nueva (ítem 2 del encargo), un pago en cero se rechaza antes, en create(), así que
    // "pago" aquí habría probado ese rechazo en vez de este.
    const zeroQuote = new ProcurementService(fakeDeps()), zero = await zeroQuote.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], unitBase: 0, unitIva: 0, unitTotal: 0 }] }, requester);
    await zeroQuote.startReview(zero.id, reviewer);
    await zeroQuote.review(zero.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], unitBase: 0, unitIva: 0, unitTotal: 0 }] }, reviewer);
    await expect(zeroQuote.sendForApproval(zero.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
  });
  it("enforces shares, order fulfillment, role-scoped dashboard, typed failures and unit totals", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    const expenses = deps.expensesData;
    expect(expenses.reduce((sum, expense) => sum + expense.total, 0)).toBe(476);
    await expect(service.redistribute("e", 100, [{ expenseId: "wrong", workId: "a", amount: 100 }], reviewer)).rejects.toMatchObject({ code: "INVALID_SHARE" });
    await expect(service.redistribute("missing", 100, [{ expenseId: "missing", workId: "a", amount: 100 }], reviewer)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.redistribute(expenses[0].id, 999, [{ expenseId: expenses[0].id, workId: "a", amount: 999 }], reviewer)).rejects.toMatchObject({ code: "EXPENSE_TOTAL_MISMATCH" });
    await service.redistribute(expenses[0].id, expenses[0].total, [{ expenseId: expenses[0].id, workId: "a", amount: expenses[0].total }], reviewer);
    await expect(service.updateOrderStatus(orders[0].id, "cumplida", reviewer)).resolves.toMatchObject({ status: "cumplida" });
    await expect(service.updateOrderStatus(orders[0].id, "no_cumplida", reviewer)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    const cash = await service.registerPettyCash({ workId: "work", date: "2026-08-03", concept: "Taxi", tagId: "t", amount: 500, cashBoxId: "caja-menor", paymentMethod: "efectivo" }, reviewer);
    expect(cash.expense.origin).toBe("caja_menor");
    // Reunión 2026-09: la caja menor nace pagada — orderDate y date coinciden siempre con la fecha del
    // movimiento, y el periodo queda calculado de inmediato (nunca un compromiso sin pagar).
    expect(cash.expense.orderDate).toBe("2026-08-03");
    expect(cash.expense.date).toBe("2026-08-03");
    expect(cash.expense.period).toBe("2026-08");
    // Reunión 2026-09: periodExpense solo cuenta lo PAGADO — las dos órdenes generadas (476) siguen sin
    // pagar, así que el gasto del periodo es únicamente la caja menor (500, pagada en el acto);
    // inProcessValue es lo comprometido sin pagar (las órdenes: 476).
    await expect(service.dashboard("2026-08", reviewer)).resolves.toMatchObject({ periodExpense: 500, inProcessValue: 476 });
    expect(deps.visibleActors).toEqual(expect.arrayContaining(["req:daniel", "order:daniel", "expense:daniel"]));
    const approverDashboard = await service.dashboard("2026-08", approver);
    expect(approverDashboard.byStatus.aprobada).toBe(1);
    expect(deps.visibleActors).toEqual(expect.arrayContaining(["req:nelson", "order:nelson", "expense:nelson"]));
    const ownDashboard = await service.dashboard("2026-08", requester);
    expect(ownDashboard.byStatus.en_revision).toBe(0);
    expect(deps.visibleActors).toEqual(expect.arrayContaining(["req:sol", "order:sol", "expense:sol"]));
    await expect(service.dashboard("bad", reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.startReview("missing", reviewer)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(service.lineTotal(items[0])).toBe(238);
  });
  // Cajas (2026-09-12): "gasto directo" de la pestaña Gastos y caja — registerPettyCash ya no es
  // exclusivo de la caja menor clásica de obra; el gasto sincronizado debe copiar caja/medio de pago/
  // centro de costo/IVA, y el IVA YA NO se fuerza a 0 (bloqueante corregido por 202609120003).
  it("un gasto directo de caja copia caja_id/medio_pago/centro_costo_id/iva al gasto sincronizado", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const cash = await service.registerPettyCash({ workId: "work", date: "2026-09-05", concept: "Factura de ferretería con IVA", tagId: "t", amount: 100000, cashBoxId: "caja-menor", paymentMethod: "tarjeta", costCenterId: "cc-alterno", iva: 19000 }, reviewer);
    expect(cash.expense).toMatchObject({ cashBoxId: "caja-menor", paymentMethod: "tarjeta", costCenterId: "cc-alterno", iva: 19000, total: 119000, registeredBy: "daniel" });
  });
  it("rechaza una caja inactiva o inexistente antes de guardar nada", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    await expect(service.registerPettyCash({ workId: "work", date: "2026-09-05", concept: "No debería pasar", tagId: "t", amount: 1000, cashBoxId: "caja-inactiva", paymentMethod: "efectivo" }, reviewer)).rejects.toThrow();
    await expect(service.registerPettyCash({ workId: "work", date: "2026-09-05", concept: "No debería pasar", tagId: "t", amount: 1000, cashBoxId: "caja-inexistente", paymentMethod: "efectivo" }, reviewer)).rejects.toThrow();
    expect(deps.pettyData).toHaveLength(0);
  });
  it("declines a requisition with an audited reason, notifies the requester and never generates orders or expenses", async () => {
    // RF-304/PRD §5.2/§3.2: "declinada... nunca genera gasto". decline() no tenía ninguna prueba en ningún nivel.
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.decline(r.id, "", reviewer)).rejects.toMatchObject({ code: "COMMENT_REQUIRED" });
    const declined = await service.decline(r.id, "motivo", reviewer);
    expect(declined.status).toBe("declinada"); expect(declined.declineReason).toBe("motivo");
    expect(deps.audits.map((a) => a.event)).toContain("declinada");
    expect(deps.audits.find((a) => a.event === "declinada")?.data).toMatchObject({ from: "en_revision", to: "declinada", comment: "motivo" });
    expect(deps.notificationData.map((n) => n.template)).toContain("requisicion_declinada");
    expect(deps.ordersData).toHaveLength(0); expect(deps.expensesData).toHaveLength(0);
    // Una vez declinada, es un estado terminal: no admite volver a decline ni ninguna otra transición.
    await expect(service.decline(r.id, "otra vez", reviewer)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
  });
  it("generates a single OP with one expense end-to-end on the payment-order success path", async () => {
    // RF-501/502: groupOrderItems(..., "pago") nunca se ejecutaba por su camino de éxito en toda la suite.
    // Un solo proveedor final evita MULTI_SUPPLIER_PAYMENT y ejercita approve()+generateOrders() completo para type:"pago".
    const deps = fakeDeps(), service = new ProcurementService(deps), paymentItems = [items[0]];
    const r = await service.create({ type: "pago", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: paymentItems }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: paymentItems }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect(orders).toHaveLength(1); expect(orders[0]).toMatchObject({ type: "OP", supplierId: "p1", adminStatus: "pendiente" }); expect(orders[0].consecutive).toMatch(/^OP-2026-\d{4}$/);
    expect(deps.expensesData).toHaveLength(1); expect(deps.expensesData[0].total).toBe(238);
  });
  // Ítem 2 del encargo (feat/solicitud-de-pago): beneficiario y valor > 0 se exigen DESDE la
  // creación, con DomainError legible — a diferencia de una compra, un pago no tiene un paso de
  // revisión previo que los complete.
  describe("solicitud de pago: beneficiario y valor > 0 exigidos desde create() y en review()", () => {
    it("create() rechaza más de una línea, sin beneficiario, o con valor en cero", async () => {
      const service = new ProcurementService(fakeDeps());
      await expect(service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [items[0], items[1]] }, requester)).rejects.toMatchObject({ code: "PAYMENT_SINGLE_LINE" });
      await expect(service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [{ ...items[0], finalSupplierId: undefined }] }, requester)).rejects.toMatchObject({ code: "PAYMENT_BENEFICIARY_REQUIRED" });
      await expect(service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [{ ...items[0], unitBase: 0, unitIva: 0, unitTotal: 0 }] }, requester)).rejects.toMatchObject({ code: "PAYMENT_VALUE_REQUIRED" });
    });
    it("create() rechaza un beneficiario que no exista o esté inactivo en el catálogo", async () => {
      const service = new ProcurementService(fakeDeps());
      await expect(service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [{ ...items[0], finalSupplierId: "p-inactivo" }] }, requester)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [{ ...items[0], finalSupplierId: "no-existe" }] }, requester)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });
    it("una solicitud de pago válida SÍ se crea (camino feliz de la validación)", async () => {
      const service = new ProcurementService(fakeDeps());
      const created = await service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [items[0]] }, requester);
      expect(created.status).toBe("enviada");
      expect(created.items).toHaveLength(1);
    });
    it("review() vuelve a exigir lo mismo si el revisor edita la línea de un pago", async () => {
      const service = new ProcurementService(fakeDeps());
      const r = await service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [items[0]] }, requester);
      await service.startReview(r.id, reviewer);
      await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], finalSupplierId: undefined }] }, reviewer)).rejects.toMatchObject({ code: "PAYMENT_BENEFICIARY_REQUIRED" });
      await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], unitBase: 0, unitIva: 0, unitTotal: 0 }] }, reviewer)).rejects.toMatchObject({ code: "PAYMENT_VALUE_REQUIRED" });
      await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [items[0], items[1]] }, reviewer)).rejects.toMatchObject({ code: "PAYMENT_SINGLE_LINE" });
      // Camino feliz: un review válido sigue aceptándose.
      await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [items[0]] }, reviewer)).resolves.toMatchObject({ status: "en_revision" });
    });
    // RF-606 (adenda de pagos): el portal público y WhatsApp no tienen catálogo delante — mandan
    // identificación + nombre; create() enlaza al proveedor existente o lo crea pendiente de normalizar
    // en la MISMA transacción, y la línea de concepto sale con su finalSupplierId.
    it("create() con `beneficiary` desde el portal: crea el proveedor pendiente_normalizacion y lo enlaza a la línea", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps);
      const created = await service.create({ type: "pago", workId: "work", channel: "publico", publicCode: "1234", publicLinkToken: "link", externalRequester: { name: "Juan Camilo", phone: "+57 300 123 4567" }, beneficiary: { identificationType: "CC", identification: "1.020.304.050", name: "Juan Camilo Topógrafo", phone: "+57 300 123 4567" }, items: [{ ...items[0], itemId: undefined, description: "Levantamiento topográfico", finalSupplierId: undefined }] }, {});
      const supplier = [...deps.createdSuppliers.values()][0];
      expect(supplier).toMatchObject({ name: "Juan Camilo Topógrafo", identificationType: "CC", identification: "1.020.304.050", nit: null, pendingNormalization: true, phone: "+57 300 123 4567", active: true });
      expect(created.items[0].finalSupplierId).toBe(supplier.id);
      expect(deps.audits.some((a) => a.entity === "proveedor" && a.entityId === supplier.id && a.event === "creado" && a.data?.pendingNormalization === true && a.data?.channel === "publico")).toBe(true);
      expect(JSON.stringify(deps.audits)).not.toContain("1.020.304.050");
    });
    it("create() con `beneficiary` reutiliza por identificación (aunque el nombre difiera) y rechaza uno inactivo o sin datos", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps);
      const created = await service.create({ type: "pago", societyId: "soc", channel: "whatsapp", kapsoEventId: "evt-1", externalRequester: { name: "Maestro", phone: "+573001234567" }, beneficiary: { identificationType: "NIT", identification: "900111222-3", name: "Nombre distinto" }, items: [{ ...items[0], itemId: undefined, description: "Corte semanal", finalSupplierId: undefined }] }, { origin: "kapso" });
      expect(created.items[0].finalSupplierId).toBe("p1"); // el p1 del arnés tiene NIT 900.111.222-3
      expect(deps.createdSuppliers.size).toBe(0);
      deps.inactiveSuppliers.add("p1");
      await expect(service.create({ type: "pago", societyId: "soc", channel: "whatsapp", kapsoEventId: "evt-2", externalRequester: { name: "Maestro", phone: "+573001234567" }, beneficiary: { identificationType: "NIT", identification: "900111222-3", name: "x" }, items: [{ ...items[0], itemId: undefined, description: "Corte", finalSupplierId: undefined }] }, { origin: "kapso" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(service.create({ type: "pago", societyId: "soc", channel: "whatsapp", kapsoEventId: "evt-3", externalRequester: { name: "Maestro", phone: "+573001234567" }, beneficiary: { identificationType: "CC", identification: " - ", name: "Sin cédula" }, items: [{ ...items[0], itemId: undefined, description: "Corte", finalSupplierId: undefined }] }, { origin: "kapso" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });
    it("create() con `beneficiary` en la web: solo quien administra proveedores (compras); un solicitante debe elegir del catálogo", async () => {
      const service = new ProcurementService(fakeDeps());
      const input = { type: "pago" as const, societyId: "soc", workId: "work", channel: "web" as const, beneficiary: { identificationType: "CC" as const, identification: "71.555.666", name: "Maestro Pérez" }, items: [{ ...items[0], itemId: undefined, description: "Corte semanal", finalSupplierId: undefined }] };
      await expect(service.create(input, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.create(input, reviewer)).resolves.toMatchObject({ items: [{ finalSupplierId: expect.stringMatching(/^sup-/) }] });
      // Si la línea YA trae finalSupplierId, `beneficiary` se ignora (manda el catálogo).
      await expect(service.create({ ...input, items: [items[0]] }, requester)).resolves.toMatchObject({ items: [{ finalSupplierId: "p1" }] });
    });
  });
  // Hallazgo de revisión (reunión 2026-08-31, atajo #1): paymentTerms ya no se reconstruye leyendo el
  // historial de auditoría (append-only, no es fuente de verdad de negocio); debe sobrevivir en
  // requisition.paymentTerms desde review() hasta generateOrders(). auditListCalls en 0 prueba que
  // generateOrders no consulta la auditoría en absoluto para este dato.
  it("paymentTerms asignado en review() llega a la orden generada por generateOrders() sin pasar por la auditoría", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), originalList = deps.audit.list;
    let auditListCalls = 0; deps.audit.list = async (entity: string, entityId: string) => { auditListCalls++; return originalList(entity, entityId); };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", paymentTerms: "Contado", items }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((order) => order.paymentTerms === "Contado")).toBe(true);
    expect(auditListCalls).toBe(0);
  });
  // Hallazgo de revisión (atajo #2): societyId "" ya no es el sentinel de canales externos; solo el
  // canal público puede omitirla (whatsapp, igual que web, la exige).
  it("crear por el canal web sin empresa falla, y por el canal público sin empresa funciona", async () => {
    const service = new ProcurementService(fakeDeps());
    await expect(service.create({ type: "compra", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.create({ type: "compra", workId: "work", channel: "publico", publicCode: "1234", publicLinkToken: "link", externalRequester: { name: "Maestro", phone: "+57 300 123 4567" }, items }, {})).resolves.toMatchObject({ status: "enviada" });
  });
  // Bloqueante WhatsApp-muerto-en-producción (reunión 2026-08-31): el Flow ya pide EMPRESA, no obra, y ya
  // NO manda workId. Antes create() exigía `input.workId` truthy para el canal whatsapp — cualquier envío
  // real del Flow nuevo (sin workId) moría con FORBIDDEN. Ahora la única exigencia de identidad de nivel
  // superior para whatsapp es societyId, igual que web.
  it("WhatsApp sin workId y con societyId se acepta; sin societyId se rechaza", async () => {
    const service = new ProcurementService(fakeDeps());
    const kapsoItems = [{ ...items[0], finalSupplierId: undefined }];
    const created = await service.create({ type: "compra", societyId: "soc", channel: "whatsapp", kapsoEventId: "evt-flow-nuevo", externalRequester: { name: "Maestro", phone: "+57 300 123 4567" }, items: kapsoItems }, { origin: "kapso" });
    expect(created).toMatchObject({ status: "enviada", societyId: "soc" });
    expect(created.workId).toBeUndefined();
    await expect(service.create({ type: "compra", channel: "whatsapp", kapsoEventId: "evt-sin-empresa", externalRequester: { name: "Maestro", phone: "+57 300 123 4567" }, items: kapsoItems }, { origin: "kapso" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("restricts item proposals by owner, review state and supports reviewer creation on behalf", async () => { const service = new ProcurementService(fakeDeps()), r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester); await expect(service.proposeItem(r.id, "ajeno", { actor: { id: "other", roles: ["solicitante"] } })).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(service.proposeItem(r.id, "propio", requester)).resolves.toMatchObject({ items: expect.any(Array) }); await service.startReview(r.id, reviewer); await expect(service.proposeItem(r.id, "tarde", requester)).rejects.toMatchObject({ code: "INVALID_STATE" }); await expect(service.proposeItem(r.id, "Daniel", reviewer)).resolves.toMatchObject({ items: expect.any(Array) }); await expect(service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", requesterId: "other", items }, requester)).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", requesterId: "sol", externalRequester: { name: "no" }, items }, requester)).rejects.toMatchObject({ code: "INVALID_INPUT" }); await expect(service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", requesterId: "maestro", items }, reviewer)).resolves.toMatchObject({ requesterId: "maestro" }); });
  it("rolls back the complete unit of work when a downstream write fails", async () => {
    const createDeps = fakeDeps(), createService = new ProcurementService(createDeps);
    createDeps.audit.append = async () => { throw new Error("audit unavailable"); };
    await expect(createService.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: [{ ...items[0], itemId: undefined, description: "Propuesta que debe revertirse" }] }, requester)).rejects.toThrow("audit unavailable");
    expect(createDeps.req.size).toBe(0);
    expect(createDeps.proposedItems.size).toBe(0);

    const cashDeps = fakeDeps(), cashService = new ProcurementService(cashDeps);
    cashDeps.pettyCash.save = async (entry) => { cashDeps.pettyData.push(entry); throw new Error("expense unavailable"); };
    await expect(cashService.registerPettyCash({ workId: "work", date: "2026-08-03", concept: "Taxi", tagId: "tag", amount: 500, cashBoxId: "caja-menor", paymentMethod: "efectivo" }, reviewer)).rejects.toThrow("expense unavailable");
    expect(cashDeps.pettyData).toHaveLength(0);
    expect(cashDeps.expensesData).toHaveLength(0);

    const approvalDeps = fakeDeps(), approvalService = new ProcurementService(approvalDeps), r = await reviewed(approvalService);
    approvalDeps.notifications.enqueue = async () => { throw new Error("notification unavailable"); };
    await expect(approvalService.approve(r.id, approver)).rejects.toThrow("notification unavailable");
    expect((await approvalDeps.requisitions.get(r.id))?.status).toBe("en_aprobacion");
    expect(approvalDeps.ordersData).toHaveLength(0);
    expect(approvalDeps.expensesData).toHaveLength(0);
    expect(approvalDeps.notificationData).toHaveLength(1);
    expect(approvalDeps.audits.some((entry) => entry.event === "aprobada")).toBe(false);
  });
  it("blocks returnForCorrection and decline/review at the service level for an MCP-origin actor, not just hasPermission", async () => {
    // Hallazgo de auditoría adversarial (ver AGENTS.md): mcpForbidden en lib/domain/rules.ts ya bloquea
    // "requisition:approve", "requisition:return" y "requisition:review" dentro de hasPermission (ver
    // tests/unit/domain.test.ts), y procurement-service.test.ts ya ejercita approve() de punta a punta con
    // origin "mcp". Pero returnForCorrection y decline/review nunca se habían ejercitado end-to-end contra
    // ProcurementService con un actor origin "mcp": esta prueba cierra ese hueco a nivel de servicio real.
    const returnDeps = fakeDeps(), returnService = new ProcurementService(returnDeps), toReturn = await reviewed(returnService);
    await expect(returnService.returnForCorrection(toReturn.id, "corrige esto", { ...approver, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await returnService.getRequisition(toReturn.id, reviewer)).status).toBe("en_aprobacion"); // sin cambios: nunca llegó a la transacción

    const declineDeps = fakeDeps(), declineService = new ProcurementService(declineDeps);
    const toDecline = await declineService.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await declineService.startReview(toDecline.id, reviewer);
    await expect(declineService.decline(toDecline.id, "motivo", { ...reviewer, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(declineService.review(toDecline.id, { tagId: "tag", items }, { ...reviewer, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await declineService.getRequisition(toDecline.id, reviewer)).status).toBe("en_revision"); // ni declinada ni enrutada
    expect(declineDeps.audits.map((a) => a.event)).not.toContain("declinada");
    expect(declineDeps.audits.map((a) => a.event)).not.toContain("revisada");
  });
  it("RF-1102/RF-706/RF-1103: dashboard() adds an attention queue, recent activity and expense breakdowns scoped to the actor", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const inReview = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(inReview.id, reviewer);
    const forApproval = await reviewed(service);
    await service.approve(forApproval.id, approver);
    const approvedOrders = await service.generateOrders(forApproval.id, reviewer);
    const dashboard = await service.dashboard("2026-08", reviewer);
    // "daniel" (revisor) debe ver la requisición todavía en revisión y las dos órdenes recién generadas
    // esperando confirmación de cumplimiento, pero no la que ya quedó aprobada (no requiere su acción).
    expect(dashboard.attentionQueue).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "requisicion", id: inReview.id, status: "en_revision", action: "Revisar" }),
      expect.objectContaining({ kind: "orden", id: approvedOrders[0].id, status: "generada", action: "Confirmar cumplimiento" }),
      expect.objectContaining({ kind: "orden", id: approvedOrders[1].id, status: "generada", action: "Confirmar cumplimiento" }),
    ]));
    expect(dashboard.attentionQueue?.some((item) => item.id === forApproval.id)).toBe(false);
    // H3: workId de una orden en la cola de atención se resuelve por join a su requisición dueña — esa
    // requisición está SIEMPRE en estado "aprobada" (terminal), fuera de los 4 estados acotados que
    // listVisibleHeaders trae para la cola de atención, así que buildAttentionQueue (sin cambiar) no
    // podría resolverlo por sí sola; el backfill de dashboard() (orderWorkById) lo completa desde la
    // propia fila de la orden. Sin ese backfill, este workId quedaría `undefined` — una regresión real.
    const orderQueueItem = dashboard.attentionQueue?.find((item) => item.id === approvedOrders[0].id);
    expect(orderQueueItem?.workId).toBe("work");
    // El doble de prueba nunca puebla updatedAt (solo lo hace el adaptador Postgres real): la actividad
    // reciente solo puede traer los gastos, que sí llevan fecha en el dominio.
    expect(dashboard.recentActivity).toHaveLength(2);
    expect(dashboard.recentActivity?.every((item) => item.kind === "gasto")).toBe(true);
    // GRAVE 3 (QA reasignación): las dos órdenes recién generadas aún no se han pagado (sin `date`) —
    // "gasto" = pagado (misma decisión que ya gobierna groupExpenseByPeriod), así que expenseByWork y
    // expenseByTag NO cuentan lo comprometido sin pagar: antes de este arreglo mostraban 476 aquí,
    // mezclando comprometido con gasto real.
    expect(dashboard.expenseByWork).toEqual([]);
    expect(dashboard.expenseByTag).toEqual([]);
    expect(dashboard.expenseByCostCenter).toEqual([]);
    // Reunión 2026-09: las dos órdenes recién generadas aún no se han pagado (sin `date`/`period`) —
    // groupExpenseByPeriod las excluye a propósito, no inventa un bucket "sin periodo".
    expect(dashboard.expenseByPeriod).toEqual([]);
    expect(dashboard.inProcessValue).toBe(476);
  });

  // H3 (docs/plan-rendimiento.md, Fase 3): dashboard() ya NO llama a calculateDashboard/groupExpenseBy*
  // (se reemplazaron por agregados SQL, ver dashboardByStatus/dashboardPendingCount/dashboardAggregates
  // en postgres-repositories.ts) — esta prueba es la garantía de que el resultado agregado sigue siendo
  // EXACTAMENTE el mismo que esas funciones de dominio (sin cambiar) producirían sobre el mismo
  // fixture, calculado aquí de forma independiente sobre las mismas colecciones.
  it("H3: dashboard() agregado da el mismo resultado que calculateDashboard/groupExpenseByWork/Tag/Period sobre el mismo fixture", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const baseReq = (id: string, status: Requisition["status"]): Requisition => ({ id, consecutive: `REQ-2026-${id}`, type: "compra", societyId: "soc", workId: "work", channel: "web", status, items: [] });
    deps.req.set("r1", baseReq("r1", "en_revision"));
    deps.req.set("r2", baseReq("r2", "en_aprobacion"));
    deps.req.set("r3", baseReq("r3", "aprobada"));
    const order1: Order = { id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "r3", itemIds: [], status: "generada", adminStatus: "pendiente" };
    deps.ordersData.push(order1);
    // e1: pagada en agosto (cuenta en periodExpense/expenseByWork/expenseByTag/expenseByCostCenter/
    // expenseByPeriod). e2: sin pagar (cuenta solo en inProcessValue — "gasto" = pagado, ver GRAVE 3 en
    // rules.ts).
    const paidExpense: Expense = { id: "e1", workId: "work", origin: "requisicion", referenceId: "o1", tagId: "tag-a", costCenterId: "cc-1", orderDate: "2026-08-01", date: "2026-08-05", base: 1000, iva: 190, total: 1190, period: "2026-08" };
    const unpaidExpense: Expense = { id: "e2", workId: "work", origin: "requisicion", referenceId: "o1", tagId: "tag-b", orderDate: "2026-08-02", base: 500, iva: 95, total: 595 };
    deps.expensesData.push(paidExpense, unpaidExpense);

    const dashboard = await service.dashboard("2026-08", reviewer); // "daniel": visible a todo en este fake

    const fixtureExpenses = [paidExpense, unpaidExpense], fixtureOrders = [order1], fixtureStatuses = [...deps.req.values()].map((r) => r.status);
    const expected = calculateDashboard(fixtureExpenses, fixtureOrders, fixtureStatuses, "2026-08");
    expect(dashboard.byStatus).toEqual(expected.byStatus);
    expect(dashboard.periodExpense).toBe(expected.periodExpense);
    expect(dashboard.inProcessValue).toBe(expected.inProcessValue);
    expect(dashboard.pendingOrders).toBe(expected.pendingOrders);
    expect(dashboard.expenseByWork).toEqual(groupExpenseByWork(fixtureExpenses));
    expect(dashboard.expenseByTag).toEqual(groupExpenseByTag(fixtureExpenses));
    expect(dashboard.expenseByPeriod).toEqual(groupExpenseByPeriod(fixtureExpenses));
    expect(dashboard.expenseByCostCenter).toEqual(groupExpenseByCostCenter(fixtureExpenses));
  });

  it("edita la cabecera de la requisición solo por revisor y solo mientras es editable", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    // un solicitante no puede editar cabecera
    await expect(service.updateRequisitionHeader(r.id, { observations: "Frente 3" }, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // el revisor sí, en estado editable; queda auditado
    const editada = await service.updateRequisitionHeader(r.id, { observations: "urge, Frente 3" }, reviewer);
    expect(editada.observations).toBe("urge, Frente 3");
    const history = await service.getRequisitionHistory(r.id, reviewer);
    expect(history.map((e) => e.event)).toContain("cabecera_editada");
    // tras enviar a aprobación, la cabecera se congela
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await expect(service.updateRequisitionHeader(r.id, { observations: "tarde" }, reviewer)).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  // BLOQUEANTE (QA reasignación, reunión 2026-09): antes de reassignApprover() esta requisición quedaba
  // atascada para siempre en cuanto "nelson" dejaba de poder entrar como el aprobador exacto — decline()
  // desde en_aprobacion es transición inválida, y approve()/otro aprobador no asignado rebota con
  // NOT_ASSIGNED_APPROVER. "falla antes" (ambas vías cerradas) / "pasa después" (reassignApprover abre una
  // tercera vía, y el nuevo aprobador sí puede decidirla).
  it("reassignApprover desatasca una requisición en_aprobacion: decline()/approve() por otro no funcionan, reasignar sí", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service); // approverId: nelson
    await expect(service.decline(r.id, "motivo", reviewer)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    await expect(service.approve(r.id, otherApprover)).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" }); // "sonia" no es la asignada
    const reassigned = await service.reassignApprover(r.id, "sonia", reviewer);
    expect(reassigned.approverId).toBe("sonia");
    expect((await service.getRequisitionHistory(r.id, reviewer)).map((e) => e.event)).toContain("aprobador_reasignado");
    await expect(service.approve(r.id, otherApprover)).resolves.toMatchObject({ status: "aprobada" }); // ya no está atascada
  });
  it("reassignApprover rechaza estados que no lo admiten (aprobada) y exige un aprobador elegible; solo revisor/admin puede llamarlo", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.approve(r.id, approver);
    await expect(service.reassignApprover(r.id, "sonia", reviewer)).rejects.toMatchObject({ code: "INVALID_STATE" });
    const pending = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(pending.id, reviewer);
    await expect(service.reassignApprover(pending.id, "no-elegible", reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.reassignApprover(pending.id, "sonia", approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  // M-6: review() distingue `undefined` (el campo no vino: no tocar) de `""`/`null` (desasignar
  // explícitamente). Antes `if (input.approverId)` trataba `""` igual que `undefined` — un revisor que
  // intentaba limpiar el aprobador lo conservaba en silencio.
  it("review() desasigna el aprobador con approverId \"\" o null; approverId ausente no lo toca", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const withApprover = await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    expect(withApprover.approverId).toBe("nelson");
    const untouched = await service.review(r.id, { tagId: "tag", items }, reviewer); // approverId ausente
    expect(untouched.approverId).toBe("nelson");
    const cleared = await service.review(r.id, { tagId: "tag", approverId: "", items }, reviewer);
    expect(cleared.approverId).toBeUndefined();
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    const clearedNull = await service.review(r.id, { tagId: "tag", approverId: null, items }, reviewer);
    expect(clearedNull.approverId).toBeUndefined();
  });
  // M-5 (decisión, ver el comentario junto a buildAttentionQueue en lib/domain/rules.ts): admin_sixteam
  // puede decidir/aprobar/devolver CUALQUIER requisición en_aprobacion, no solo las que tiene asignadas —
  // de lo contrario esa cola de "Aprobar" que ya le muestra buildAttentionQueue sería un botón muerto.
  it("M-5: admin_sixteam puede decidir ítems y aprobar una requisición en_aprobacion que no tiene asignada", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service); // approverId: nelson, no "root"
    const admin = { actor: { id: "root", roles: ["admin_sixteam"] as const } };
    await expect(service.decideItems(r.id, [{ itemId: items[0].id, status: "aprobado" }], admin)).resolves.toMatchObject({ status: "en_aprobacion" });
    await expect(service.approve(r.id, admin)).resolves.toMatchObject({ status: "aprobada" });
  });
  it("M-5: admin_sixteam puede devolver a revisión una requisición en_aprobacion que no tiene asignada", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    const admin = { actor: { id: "root", roles: ["admin_sixteam"] as const } };
    await expect(service.returnForCorrection(r.id, "falta soporte", admin)).resolves.toMatchObject({ status: "devuelta" });
  });
  // M-7 (QA reasignación): decisión consciente PENDIENTE de confirmar con el cliente — ver el comentario
  // en review() (procurement-service.ts). Se fija aquí como comportamiento ACTUAL para que cambiarlo, si
  // el negocio lo pide, sea deliberado y no un descubrimiento accidental en producción.
  it("M-7: un usuario con roles revisor+aprobador puede asignarse a sí mismo y aprobar su propia revisión (comportamiento actual, no bloqueado)", async () => {
    const service = new ProcurementService(fakeDeps());
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    await service.review(r.id, { tagId: "tag", approverId: "dual-role", items }, dual);
    await service.sendForApproval(r.id, dual);
    await expect(service.approve(r.id, dual)).resolves.toMatchObject({ status: "aprobada" });
  });

  // GRAVE 2 (QA reasignación): generar → contabilizar → no_necesario dejaba el gasto (aún sin pagar)
  // engordando inProcessValue para siempre, sin ninguna forma de anularlo (assertAdminTransition bloquea
  // contabilizar/pagar desde no_necesario). "falla antes" queda documentado en el test de más abajo
  // (ORDER_ALREADY_PAID); este cubre la vía que SÍ debe funcionar.
  it("GRAVE 2: contabilizada -> no_necesario borra el gasto y su reparto, y baja inProcessValue", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    const expense = deps.expensesData.find((e) => e.referenceId === orderA.id)!;
    await service.redistribute(expense.id, expense.total, [{ expenseId: expense.id, workId: "work", amount: expense.total }], reviewer);
    expect(deps.shares.some((s) => s.expenseId === expense.id)).toBe(true);
    await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
    const before = await service.dashboard("2026-08", reviewer);
    const updated = await service.updateOrderStatus(orderA.id, "no_necesario", reviewer);
    expect(updated.status).toBe("no_necesario");
    expect(deps.expensesData.some((e) => e.id === expense.id)).toBe(false); // el gasto desapareció
    expect(deps.shares.some((s) => s.expenseId === expense.id)).toBe(false); // y su reparto con él
    const after = await service.dashboard("2026-08", reviewer);
    expect(after.inProcessValue).toBe(before.inProcessValue - expense.total);
    expect(deps.audits.map((a) => a.event)).toContain("gasto_anulado");
  });
  it("GRAVE 2: una orden ya pagada rechaza no_necesario (ORDER_ALREADY_PAID) — no existe flujo de devolución", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
    await service.registerOrderPayment(orderA.id, { date: "2026-08-20", amount: 238, method: "transferencia" }, reviewer);
    await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
    await expect(service.updateOrderStatus(orderA.id, "no_necesario", reviewer)).rejects.toMatchObject({ code: "ORDER_ALREADY_PAID" });
    expect(deps.expensesData.some((e) => e.referenceId === orderA.id)).toBe(true); // el gasto sigue intacto
  });
  it("no_cumplida no toca el gasto: el material puede llegar después", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    await service.updateOrderStatus(orderA.id, "no_cumplida", reviewer);
    expect(deps.expensesData.some((e) => e.referenceId === orderA.id)).toBe(true);
  });
  // GRAVE 3 (QA reasignación): si `markPaid` no encuentra el gasto de la orden (0 filas — un estado
  // inconsistente que contabilizada/pagada, un eje independiente del cumplimiento, no impide por sí
  // solo), el servicio debe fallar explícito en vez de dejar la orden "pagada" en silencio.
  it("GRAVE 3: marcar pagada una orden sin gasto propio falla con ORDER_EXPENSE_MISSING en vez de pasar en silencio", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    const index = deps.expensesData.findIndex((e) => e.referenceId === orderA.id);
    deps.expensesData.splice(index, 1); // simula el estado inconsistente: el gasto ya no existe
    await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
    await expect(service.updateOrderAdminStatus(orderA.id, "pagada", reviewer)).rejects.toMatchObject({ code: "ORDER_EXPENSE_MISSING" });
  });

  // Reunión agosto 2026: pagos parciales de orden — "saber cuánto se ha pagado de cada orden" sin
  // romper el marcado de "pagada" que ya usan la pantalla de órdenes y el flujo (assertAdminTransition,
  // updateOrderAdminStatus arriba). Cada línea con supplier p1 (items[0]) genera una orden con total
  // 238 (quantity 2 × unitBase 100 = 200 de base, + iva 2×19=38 — ver el comentario de `items` arriba).
  describe("registerOrderPayment / listOrderPayments — pagos parciales de orden", () => {
    it("un pago parcial reduce el saldo, aparece en el historial y NO toca adminStatus", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      const { payment, order } = await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo" }, reviewer);
      expect(payment).toMatchObject({ orderId: orderA.id, date: "2026-08-05", amount: 100, method: "efectivo", registeredBy: "daniel" });
      expect(order.paidAmount).toBe(100);
      expect(order.adminStatus).toBe("pendiente"); // un pago parcial no cierra ningún eje por sí solo
      const history = await service.listOrderPayments(orderA.id, reviewer);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ amount: 100, method: "efectivo" });
      expect(deps.audits.some((a) => a.entity === "orden" && a.entityId === orderA.id && a.event === "pago_registrado" && a.data?.amount === 100)).toBe(true);
    });
    it("dos pagos que suman EXACTO el total se aceptan — el límite es 'excede', no 'alcanza'", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo" }, reviewer);
      const { order } = await service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 138, method: "transferencia" }, reviewer);
      expect(order.paidAmount).toBe(238);
      expect(deps.paymentsData.filter((p) => p.orderId === orderA.id)).toHaveLength(2);
    });
    it("un pago que excede el saldo se rechaza con PAYMENT_EXCEEDS_ORDER, sin dejar rastro en pagos_orden", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 200, method: "efectivo" }, reviewer);
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 39, method: "efectivo" }, reviewer)).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_ORDER" }); // 200+39=239 > 238
      expect(deps.paymentsData.filter((p) => p.orderId === orderA.id)).toHaveLength(1); // el rechazado no quedó grabado
    });
    // DECISIÓN DE ERNESTO (2026-09-17): "payment:register" es de Daniel (revisor) y admin_sixteam.
    // Contabilidad SALE — conserva ver órdenes y contabilizarlas, pero no registra pagos.
    it("exige el permiso payment:register (revisor/admin_sixteam) — aprobador, solicitante y CONTABILIDAD no pueden", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, requester)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, { actor: { id: "cont", roles: ["contabilidad"] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, { actor: { id: "root", roles: ["admin_sixteam"] } })).resolves.toBeTruthy();
    });
    // El override de `configuracion` (permisos_por_rol_v1) le devuelve el permiso a contabilidad sin
    // tocar una línea de código: el actor llega con su lista efectiva ya resuelta (ver
    // lib/infrastructure/role-permissions.ts) y el dominio la usa tal cual.
    it("un override de permisos por rol le devuelve payment:register a contabilidad, y se lo quita al revisor", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      const overrides = { contabilidad: ["order:read", "payment:register"], revisor: DEFAULT_ROLE_PERMISSIONS.revisor.filter((permission) => permission !== "payment:register") };
      const contaConOverride = { actor: { id: "cont", roles: ["contabilidad"] as const, permissions: resolveActorPermissions(["contabilidad"], overrides) } };
      const revisorSinPago = { actor: { id: "daniel", roles: ["revisor"] as const, permissions: resolveActorPermissions(["revisor"], overrides) } };
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, contaConOverride)).resolves.toBeTruthy();
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 10, method: "efectivo" }, revisorSinPago)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
    it("sin gasto asociado falla con ORDER_EXPENSE_MISSING (misma señal que updateOrderAdminStatus)", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      const index = deps.expensesData.findIndex((e) => e.referenceId === orderA.id);
      deps.expensesData.splice(index, 1); // simula el estado inconsistente: el gasto ya no existe
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, reviewer)).rejects.toMatchObject({ code: "ORDER_EXPENSE_MISSING" });
    });
    it("una orden ya pagada no admite más pagos (ORDER_ALREADY_PAID) — la reversa es anular un pago, no registrar otro", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 238, method: "transferencia" }, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 10, method: "efectivo" }, reviewer)).rejects.toMatchObject({ code: "ORDER_ALREADY_PAID" });
    });
    it("acepta una nota libre y la conserva en el historial (RF-507)", async () => {
      const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      const { payment } = await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo", note: "  Anticipo topógrafo  " }, reviewer);
      expect(payment.note).toBe("Anticipo topógrafo");
      expect((await service.listOrderPayments(orderA.id, reviewer))[0]).toMatchObject({ note: "Anticipo topógrafo" });
    });
    it("listOrderPayments respeta la MISMA visibilidad que listOrders: NOT_FOUND si el actor no ve la orden", async () => {
      const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo" }, reviewer);
      await expect(service.listOrderPayments(orderA.id, approver)).rejects.toMatchObject({ code: "NOT_FOUND" }); // fakeDeps: solo "daniel" ve órdenes
      await expect(service.listOrderPayments(orderA.id, reviewer)).resolves.toHaveLength(1);
    });
  });

  // Adenda de pagos (A3, RF-508): updateOrderAdminStatus(...,'pagada') DEJA de inventar un pago `otro`
  // por el saldo — cada peso entra por registerOrderPayment con su medio real (la caja menor es
  // `efectivo`). "pagada" exige saldo cero; con saldo, SALDO_PENDIENTE y la pantalla ofrece "Pagar saldo".
  describe("updateOrderAdminStatus('pagada') — exige saldo cero, nunca inventa un pago", () => {
    it("pagada exige saldo 0: sin pagos previos rechaza con SALDO_PENDIENTE y no registra ningún pago automático", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      await expect(service.updateOrderAdminStatus(orderA.id, "pagada", reviewer)).rejects.toMatchObject({ code: "SALDO_PENDIENTE" });
      expect(deps.paymentsData.filter((p) => p.orderId === orderA.id)).toHaveLength(0);
      expect(deps.audits.some((a) => a.event === "pago_registrado" && a.data?.method === "otro")).toBe(false);
      expect((await deps.orders.get(orderA.id))?.adminStatus).toBe("contabilizada");
    });
    it("con un pago parcial previo también rechaza: el saldo restante se paga desde el diálogo, no aquí", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      await service.registerOrderPayment(orderA.id, { date: "2026-08-10", amount: 100, method: "efectivo" }, reviewer);
      await expect(service.updateOrderAdminStatus(orderA.id, "pagada", reviewer)).rejects.toMatchObject({ code: "SALDO_PENDIENTE" });
      expect(deps.paymentsData.filter((p) => p.orderId === orderA.id)).toHaveLength(1);
    });
    it("con el saldo cubierto por pagos parciales pasa a pagada y fija la fecha del ÚLTIMO pago vigente en el gasto", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      await service.registerOrderPayment(orderA.id, { date: "2026-08-10", amount: 100, method: "efectivo" }, reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-15", amount: 138, method: "transferencia" }, reviewer);
      const paid = await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
      expect(paid.paidAmount).toBe(238);
      expect(paid.adminStatus).toBe("pagada");
      expect(deps.paymentsData.filter((p) => p.orderId === orderA.id)).toHaveLength(2); // ningún pago de saldo $0
      const expense = deps.expensesData.find((e) => e.referenceId === orderA.id)!;
      expect(expense.date).toBe("2026-08-15"); // fecha del ÚLTIMO pago, no la de "hoy" (reloj congelado en 2026-08-24)
    });
    it("un pago anulado no cuenta como saldo cubierto", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      const { payment } = await service.registerOrderPayment(orderA.id, { date: "2026-08-10", amount: 238, method: "transferencia" }, reviewer);
      await service.annulOrderPayment(orderA.id, payment.id, "Transferencia rebotó", reviewer);
      await expect(service.updateOrderAdminStatus(orderA.id, "pagada", reviewer)).rejects.toMatchObject({ code: "SALDO_PENDIENTE" });
    });
  });

  // RF-510 (anular ≠ borrar), RF-508 (estado derivado) y RF-708 (cierre de caja = efectivo en un rango).
  describe("annulOrderPayment / paymentStatus / listCashPayments — adenda de pagos", () => {
    async function paidOrder(deps: ReturnType<typeof fakeDeps>, service: ProcurementService) {
      const r = await reviewed(service);
      await service.approve(r.id, approver);
      const [orderA] = await service.generateOrders(r.id, reviewer);
      return orderA;
    }
    it("anular pago excluye del pagado: el pago sigue en el historial (tachado, con motivo) y libera saldo para el reemplazo", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), orderA = await paidOrder(deps, service);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo" }, reviewer);
      const { payment: second } = await service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 138, method: "transferencia" }, reviewer);
      const { payment: annulled, order } = await service.annulOrderPayment(orderA.id, second.id, "Transferencia rebotó", reviewer);
      expect(annulled).toMatchObject({ id: second.id, annulled: true, annulmentReason: "Transferencia rebotó", annulledBy: "daniel", annulledAt: "2026-08-24T12:00:00.000Z" });
      expect(order.paidAmount).toBe(100);
      const history = await service.listOrderPayments(orderA.id, reviewer);
      expect(history).toHaveLength(2); // nunca se borra
      expect(history.find((p) => p.id === second.id)?.annulled).toBe(true);
      // El saldo liberado admite el reemplazo exacto; un peso más, no.
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-07", amount: 139, method: "transferencia" }, reviewer)).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_ORDER" });
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-07", amount: 138, method: "transferencia" }, reviewer)).resolves.toMatchObject({ order: { paidAmount: 238 } });
      expect(deps.audits.some((a) => a.entity === "orden" && a.entityId === orderA.id && a.event === "pago_anulado" && a.data?.paymentId === second.id && a.data?.reason === "Transferencia rebotó")).toBe(true);
    });
    it("no se puede anular sin motivo, dos veces, un pago de otra orden, ni sin permiso payment:register", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), orderA = await paidOrder(deps, service);
      const { payment } = await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo" }, reviewer);
      await expect(service.annulOrderPayment(orderA.id, payment.id, "   ", reviewer)).rejects.toMatchObject({ code: "ANNULMENT_REASON_REQUIRED" });
      await expect(service.annulOrderPayment(orderA.id, payment.id, "motivo", approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
      // Contabilidad tampoco anula desde el 2026-09-17 (misma decisión que registrar).
      await expect(service.annulOrderPayment(orderA.id, payment.id, "motivo", { actor: { id: "cont", roles: ["contabilidad"] } })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.annulOrderPayment(orderA.id, "no-existe", "motivo", reviewer)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(service.annulOrderPayment("otra-orden", payment.id, "motivo", reviewer)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await service.annulOrderPayment(orderA.id, payment.id, "Duplicado", { actor: { id: "root", roles: ["admin_sixteam"] } });
      await expect(service.annulOrderPayment(orderA.id, payment.id, "otra vez", reviewer)).rejects.toMatchObject({ code: "PAYMENT_ALREADY_ANNULLED" });
      expect(deps.paymentsData.find((p) => p.id === payment.id)).toMatchObject({ annulled: true, annulmentReason: "Duplicado" });
    });
    it("estado_pago pendiente/parcial/pagada se deriva de los pagos vigentes y vuelve a parcial al anular (E2E #6 del PRD)", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), orderA = await paidOrder(deps, service);
      expect((await deps.orders.get(orderA.id))).toMatchObject({ paymentStatus: "pendiente", paidAmount: 0, paymentMethods: [] });
      const { order: partial } = await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 100, method: "efectivo" }, reviewer);
      expect(partial).toMatchObject({ paymentStatus: "parcial", lastPaymentAt: "2026-08-05", paymentMethods: ["efectivo"] });
      const { payment: second, order: full } = await service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 138, method: "transferencia" }, reviewer);
      expect(full).toMatchObject({ paymentStatus: "pagada", lastPaymentAt: "2026-08-06", paymentMethods: ["efectivo", "transferencia"] });
      const { order: reverted } = await service.annulOrderPayment(orderA.id, second.id, "Se pagó de más", reviewer);
      expect(reverted).toMatchObject({ paymentStatus: "parcial", paidAmount: 100, lastPaymentAt: "2026-08-05", paymentMethods: ["efectivo"] });
      expect(reverted.status).toBe("generada"); // el eje de cumplimiento no se toca
    });
    it("anular el pago que cerraba una orden ya 'pagada' la devuelve a contabilizada y quita la fecha de pago del gasto", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), orderA = await paidOrder(deps, service);
      await service.updateOrderAdminStatus(orderA.id, "contabilizada", { actor: { id: "cont", roles: ["contabilidad"] } });
      const { payment } = await service.registerOrderPayment(orderA.id, { date: "2026-08-10", amount: 238, method: "transferencia" }, reviewer);
      await service.updateOrderAdminStatus(orderA.id, "pagada", reviewer);
      expect(deps.expensesData.find((e) => e.referenceId === orderA.id)?.date).toBe("2026-08-10");
      const { order } = await service.annulOrderPayment(orderA.id, payment.id, "Transferencia rebotó", reviewer);
      expect(order).toMatchObject({ adminStatus: "contabilizada", paymentStatus: "pendiente", paidAmount: 0 });
      expect(order.paidAt).toBeUndefined();
      const expense = deps.expensesData.find((e) => e.referenceId === orderA.id)!;
      expect(expense.date).toBeUndefined(); expect(expense.period).toBeUndefined();
      expect(deps.audits.filter((a) => a.entityId === orderA.id && a.event === "estado_administrativo_actualizado").at(-1)?.data).toMatchObject({ status: "contabilizada", reason: "pago_anulado", paymentId: payment.id });
      // Y vuelve a admitir el pago corregido.
      await expect(service.registerOrderPayment(orderA.id, { date: "2026-08-11", amount: 238, method: "efectivo" }, reviewer)).resolves.toMatchObject({ order: { paymentStatus: "pagada" } });
    });
    it("listCashPayments solo devuelve efectivo no anulado en el rango, con su orden resuelta, y exige expense:read", async () => {
      const deps = fakeDeps(), service = new ProcurementService(deps), orderA = await paidOrder(deps, service);
      const { payment: cashInRange } = await service.registerOrderPayment(orderA.id, { date: "2026-08-05", amount: 50, method: "efectivo", note: "Peaje" }, reviewer);
      const { payment: cashAnnulled } = await service.registerOrderPayment(orderA.id, { date: "2026-08-06", amount: 50, method: "efectivo" }, reviewer);
      await service.annulOrderPayment(orderA.id, cashAnnulled.id, "Duplicado", reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-08-07", amount: 50, method: "transferencia" }, reviewer);
      await service.registerOrderPayment(orderA.id, { date: "2026-09-02", amount: 50, method: "efectivo" }, reviewer);
      const rows = await service.listCashPayments({ from: "2026-08-01", to: "2026-08-31" }, reviewer);
      expect(rows.map((row) => row.id)).toEqual([cashInRange.id]);
      expect(rows[0]).toMatchObject({ method: "efectivo", note: "Peaje", orderConsecutive: orderA.consecutive, orderType: "OC", requisitionId: orderA.requisitionId, workId: "work", costCenterId: "cc-work", supplierId: "p1" });
      await expect(service.listCashPayments({ from: "2026-08-01", to: "2026-08-31", costCenterId: "cc-work" }, { actor: { id: "cont", roles: ["contabilidad"] } })).resolves.toHaveLength(1);
      await expect(service.listCashPayments({ from: "2026-08-01", to: "2026-08-31", costCenterId: "cc-alterno" }, reviewer)).resolves.toHaveLength(0);
      await expect(service.listCashPayments({ from: "2026-08-31", to: "2026-08-01" }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(service.listCashPayments({ from: "2026-08-01", to: "2026-08-31" }, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  // H2 (docs/plan-rendimiento.md): getRequisition() ya no carga TODAS las requisiciones visibles para
  // hacer un .find() (O(n) por detalle) — comprueba visibilidad POR FILA (assertVisibleRequisition),
  // replicando exactamente la regla de listVisibleRequisitions en el adaptador Postgres real
  // (isElevated + fallback aprobador/solicitante, ver postgres-repositories.ts).
  it("H2: getRequisition — elevado ve cualquiera, aprobador solo la suya, solicitante solo la suya, sin permiso es FORBIDDEN", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service); // aprobador asignado: "nelson"
    await expect(service.getRequisition(r.id, reviewer)).resolves.toMatchObject({ id: r.id }); // revisor: elevado
    await expect(service.getRequisition(r.id, approver)).resolves.toMatchObject({ id: r.id }); // nelson es el aprobador asignado
    await expect(service.getRequisition(r.id, otherApprover)).rejects.toMatchObject({ code: "NOT_FOUND" }); // sonia no es la asignada — NOT_FOUND, no FORBIDDEN (no revela existencia)
    await expect(service.getRequisition(r.id, requester)).resolves.toMatchObject({ id: r.id }); // sol es quien la creó
    await expect(service.getRequisition(r.id, { actor: { id: "otro-sol", roles: ["solicitante"] } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.getRequisition(r.id, { actor: { id: "mizar", roles: ["admin_mizar"] } })).rejects.toMatchObject({ code: "FORBIDDEN" }); // admin_mizar no tiene ningún requisition:read*
  });

  // H2: endpoint compuesto del detalle — orders/expenses se degradan a [] sin el permiso correspondiente
  // (un solicitante viendo su propia requisición no tumba el detalle completo por no poder leer órdenes),
  // pero la requisición misma sigue exigiendo visibilidad (NOT_FOUND si no aplica).
  it("H2: getRequisitionDetail agrupa requisición + órdenes + gastos + historial, degradando a [] sin permiso en vez de fallar", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    const detail = await service.getRequisitionDetail(r.id, reviewer);
    expect(detail.requisition.id).toBe(r.id);
    expect(detail.orders.map((o) => o.id).sort()).toEqual(orders.map((o) => o.id).sort());
    expect(detail.expenses.length).toBeGreaterThan(0);
    expect(detail.history.map((e) => e.event)).toContain("creada");
    const requesterDetail = await service.getRequisitionDetail(r.id, requester); // sol: sin order:read/expense:read
    expect(requesterDetail).toMatchObject({ orders: [], expenses: [] });
    expect(requesterDetail.requisition.id).toBe(r.id);
    await expect(service.getRequisitionDetail(r.id, otherApprover)).rejects.toMatchObject({ code: "NOT_FOUND" }); // sonia: visible ni siquiera la requisición
  });

  // H2: respaldan `?requisitionId=`/`?referenceId=` en /api/orders y /api/expenses — permiso de
  // lectura del recurso PRIMERO (FORBIDDEN sin gastar una consulta), visibilidad de la requisición
  // dueña después (NOT_FOUND si no aplica, aun con el permiso).
  it("H2: listOrdersByRequisition/listExpensesByReference filtran por requisición respetando permiso + visibilidad", async () => {
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect((await service.listOrdersByRequisition(r.id, reviewer)).map((o) => o.id).sort()).toEqual(orders.map((o) => o.id).sort());
    expect((await service.listExpensesByReference(r.id, reviewer)).length).toBeGreaterThan(0);
    await expect(service.listOrdersByRequisition(r.id, requester)).rejects.toMatchObject({ code: "FORBIDDEN" }); // solicitante: sin order:read
    await expect(service.listExpensesByReference(r.id, requester)).rejects.toMatchObject({ code: "FORBIDDEN" }); // sin expense:read
    await expect(service.listOrdersByRequisition(r.id, otherApprover)).rejects.toMatchObject({ code: "NOT_FOUND" }); // sonia tiene order:read pero no está asignada a esta requisición
  });
});

// APROBADOR POR ÍTEM (Ernesto, 11-sep-2026, corrigiendo la lectura de la reunión: «no es aprobador por
// tiempo, es aprobador por ítem»). Las reglas puras están en tests/unit/aprobador-por-item.test.ts y el
// arnés SQL cubre RLS y triggers; aquí va el control de acceso, que es lo único que la aplicación
// aplica hoy de verdad — se conecta a Postgres con el rol dueño, así que RLS no la frena.
describe("aprobador por ítem", () => {
  const ITEMS_REPARTIDOS = [{ ...items[0], approverId: "sonia" }, { ...items[1] }]; // l1 → sonia, l2 → hereda a nelson
  const adminSixteam = { actor: { id: "root", roles: ["admin_sixteam"] as const } };

  /** Deja la requisición en aprobación con los ítems repartidos entre sonia (l1) y nelson (l2). */
  async function repartida(service: ProcurementService) {
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items: ITEMS_REPARTIDOS }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: ITEMS_REPARTIDOS }, reviewer);
    return service.sendForApproval(r.id, reviewer);
  }

  it("cada aprobador decide lo suyo, y NO lo del otro", async () => {
    // El agujero que esto cierra: bastaba con ser aprobador de UN ítem para decidir todos. Por WhatsApp
    // es peor todavía, porque el token dice quién eres pero el cuerpo del mensaje lo arma el remitente.
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    const tras = await service.decideItems(r.id, [{ itemId: "l1", status: "aprobado" }], otherApprover);
    expect(tras.items.find((l) => l.id === "l1")?.status).toBe("aprobado");
    await expect(service.decideItems(r.id, [{ itemId: "l2", status: "aprobado" }], otherApprover)).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
  });

  it("ni colando el ajeno junto al suyo en la misma llamada, y sin dejar nada a medias", async () => {
    // El caso que se escapa si la comprobación se hace una vez por llamada en vez de por línea.
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    await expect(service.decideItems(r.id, [{ itemId: "l1", status: "aprobado" }, { itemId: "l2", status: "aprobado" }], otherApprover)).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
    const sinTocar = await service.getRequisition(r.id, reviewer);
    expect(sinTocar.items.find((l) => l.id === "l1")?.status ?? "pendiente").toBe("pendiente");
  });

  it("quien no decide nada aquí no entra siquiera; admin_sixteam sí (M-5)", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    await expect(service.decideItems(r.id, [{ itemId: "l1", status: "aprobado" }], { actor: { id: "ajeno", roles: ["aprobador"] } })).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
    const tras = await service.decideItems(r.id, [{ itemId: "l1", status: "aprobado" }, { itemId: "l2", status: "aprobado" }], adminSixteam);
    expect(tras.items.every((l) => l.status === "aprobado")).toBe(true);
  });

  it("cierra el ÚLTIMO: el primero que termina lo suyo no cierra por los demás", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    await service.decideItems(r.id, [{ itemId: "l1", status: "aprobado" }], otherApprover);
    await expect(service.approve(r.id, otherApprover)).rejects.toMatchObject({ code: "APPROVAL_PENDING_OTHERS" });
    expect((await service.getRequisition(r.id, reviewer)).status).toBe("en_aprobacion");

    await service.decideItems(r.id, [{ itemId: "l2", status: "aprobado" }], approver);
    await expect(service.approve(r.id, approver)).resolves.toMatchObject({ status: "aprobada" });
  });

  it("con UN solo aprobador todo sigue exactamente igual que siempre", async () => {
    // La comprobación que impide que este cambio rompa lo que ya funcionaba.
    const service = new ProcurementService(fakeDeps()), r = await reviewed(service);
    await service.decideItems(r.id, items.map((l) => ({ itemId: l.id, status: "aprobado" as const })), approver);
    await expect(service.approve(r.id, approver)).resolves.toMatchObject({ status: "aprobada" });
  });

  it("todos los ítems declinados cierran la requisición como DECLINADA, con los motivos arrastrados", async () => {
    // Antes este camino no existía: assertHasApprovedLine lanzaba NO_APPROVED_ITEMS y la requisición se
    // quedaba en aprobación para siempre. El motivo de cabecera no es adorno — la base lo exige.
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await repartida(service);
    await service.decideItems(r.id, [{ itemId: "l1", status: "declinado", declineReason: "sin presupuesto" }], otherApprover);
    await service.decideItems(r.id, [{ itemId: "l2", status: "declinado", declineReason: "llega tarde" }], approver);
    const cerrada = await service.approve(r.id, approver);
    expect(cerrada.status).toBe("declinada");
    expect(cerrada.declineReason).toBe("Todos los ítems fueron declinados: sin presupuesto; llega tarde");
    expect(deps.notificationData.map((n) => n.template)).toContain("requisicion_declinada");
  });

  it("pero declinar ALGUNOS no declina la requisición", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    await service.decideItems(r.id, [{ itemId: "l1", status: "declinado", declineReason: "sin presupuesto" }], otherApprover);
    await service.decideItems(r.id, [{ itemId: "l2", status: "aprobado" }], approver);
    await expect(service.approve(r.id, approver)).resolves.toMatchObject({ status: "aprobada" });
  });

  it("review() exige que el aprobador de un ítem sea elegible, y lo persiste", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], approverId: "no-elegible" }, items[1]] }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });

    const repartidaR = await repartida(new ProcurementService(fakeDeps()));
    expect(repartidaR.items.find((l) => l.id === "l1")?.approverId).toBe("sonia");
    expect(repartidaR.items.find((l) => l.id === "l2")?.approverId).toBeUndefined();
  });

  it("un revisor NO puede declinar una requisición que ya está en aprobación", async () => {
    // Efecto colateral de abrir `en_aprobacion -> declinada`: sin este límite explícito, el revisor
    // podía matar una requisición que ya está en manos de su aprobador. La salida de una atascada
    // sigue siendo reasignar, no declinarla por la espalda.
    const service = new ProcurementService(fakeDeps());
    const r = await repartida(service);
    await expect(service.decline(r.id, "me lo pensé mejor", reviewer)).rejects.toMatchObject({ code: "INVALID_TRANSITION" });
    expect((await service.getRequisition(r.id, reviewer)).status).toBe("en_aprobacion");
  });
});

// CENTROS DE COSTO (Ernesto, 2026-09-12, decisión del dueño): «obra y centro de costo están
// correlacionados, pero varias obras pueden ir a un centro de costo; en la requisición debe salir
// predeterminado el centro asociado a esa obra y poder cambiarse». El arnés SQL
// (supabase/tests/centros_costo_verification.sql) cubre el trigger de coherencia de sociedad/actividad
// contra Postgres real; aquí va la regla de negocio (herencia, override, exigencia en sendForApproval,
// copia congelada en el gasto), que es dominio puro y no debe esperar a un Postgres real para probarse.
// Adenda de pagos, N3: empresa facturada (RF-009), monto auditado (RF-307/RF-1003) y auto-aprobación (RF-308).
describe("empresa facturada, monto auditado y auto-aprobación (adenda de pagos)", () => {
  const paymentLine = { ...items[0], itemId: undefined, description: "Levantamiento topográfico", unitBase: 100, unitIva: 19, unitTotal: 119 };
  it("empresa facturada por defecto = sociedad del CC (vía obra), se guarda en la revisión y en el evento revisada", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const reviewedR = await service.review(r.id, { tagId: "tag", approverId: "nelson", workId: "work", items }, reviewer);
    expect(reviewedR).toMatchObject({ costCenterId: "cc-work", billedCompanyId: "soc" });
    expect(deps.audits.filter((a) => a.event === "revisada").at(-1)?.data).toMatchObject({ billedCompanyId: "soc", costCenterId: "cc-work" });
    // Un centro compartido (sin sociedad) cae a la sociedad de la obra.
    await service.review(r.id, { tagId: "tag", approverId: "nelson", costCenterId: "cc-compartido", billedCompanyId: null, items }, reviewer);
    expect((await deps.requisitions.get(r.id))?.billedCompanyId).toBe("soc");
  });
  it("la empresa facturada elegida en revisión puede ser OTRA sociedad (activa); una inactiva se rechaza; null vuelve al default", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [items[0]] }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "proim", items: [items[0]] }, reviewer)).resolves.toMatchObject({ billedCompanyId: "proim" });
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "soc-inactiva", items: [items[0]] }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "no-existe", items: [items[0]] }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // Ausente = no tocar: sigue en PROIM. Vacío = desasignar y volver a derivar.
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", items: [items[0]] }, reviewer)).resolves.toMatchObject({ billedCompanyId: "proim" });
    await expect(service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "", items: [items[0]] }, reviewer)).resolves.toMatchObject({ billedCompanyId: "soc" });
  });
  it("sendForApproval exige empresa facturada en tipo=pago (no en compra) y generateOrders la copia congelada al gasto", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [items[0]] }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "proim", items: [items[0]] }, reviewer);
    const stored = deps.req.get(r.id)!; stored.billedCompanyId = undefined; deps.req.set(r.id, stored); // simula una revisión previa a la columna
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
    await service.review(r.id, { tagId: "tag", approverId: "nelson", billedCompanyId: "proim", items: [items[0]] }, reviewer);
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    const [orderA] = await service.generateOrders(r.id, reviewer);
    expect(deps.expensesData.find((e) => e.referenceId === orderA.id)).toMatchObject({ billedCompanyId: "proim", costCenterId: "cc-work" });
    // Una compra sin empresa facturada explícita sigue pasando (la deriva review(); aquí se limpia a propósito).
    const c = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(c.id, reviewer); await service.review(c.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    const storedC = deps.req.get(c.id)!; storedC.billedCompanyId = undefined; deps.req.set(c.id, storedC);
    await expect(service.sendForApproval(c.id, reviewer)).resolves.toMatchObject({ status: "en_aprobacion" });
  });
  it("revisada guarda monto antes/después cuando cambia el valor de una solicitud de pago (y no en una compra ni sin cambio)", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "pago", societyId: "soc", workId: "work", channel: "web", items: [paymentLine] }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...paymentLine, unitBase: 300_000, ivaRate: 0 }] }, reviewer);
    expect(deps.audits.filter((a) => a.entityId === r.id && a.event === "revisada").at(-1)?.data).toMatchObject({ montoAntes: 238, montoDespues: 600_000 });
    // Misma revisión otra vez (nada cambia): ni evento nuevo ni montos.
    const eventos = deps.audits.filter((a) => a.event === "revisada").length;
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...paymentLine, unitBase: 300_000, ivaRate: 0 }] }, reviewer);
    expect(deps.audits.filter((a) => a.event === "revisada")).toHaveLength(eventos);
    // Cambia la etiqueta pero no el valor: el evento no lleva montos.
    await service.review(r.id, { tagId: "otra-etiqueta", approverId: "nelson", items: [{ ...paymentLine, unitBase: 300_000, ivaRate: 0 }] }, reviewer);
    expect(deps.audits.filter((a) => a.event === "revisada").at(-1)?.data).not.toHaveProperty("montoAntes");
    // Una compra edita líneas: no lleva montoAntes/montoDespues aunque cambie el total.
    const c = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(c.id, reviewer);
    await service.review(c.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], unitBase: 999, unitTotal: 1018 }, items[1]] }, reviewer);
    expect(deps.audits.filter((a) => a.entityId === c.id && a.event === "revisada").at(-1)?.data).not.toHaveProperty("montoAntes");
  });
  it("send_and_approve deja dos eventos (enviada_aprobacion y aprobada) del mismo actor, sin avisar por WhatsApp al aprobador, y exige roles", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    await service.review(r.id, { tagId: "tag", approverId: "dual-role", items }, dual);
    const approved = await service.sendAndApproveAsMaster(r.id, dual);
    expect(approved.status).toBe("aprobada");
    const eventos = deps.audits.filter((a) => a.entityId === r.id && ["enviada_aprobacion", "aprobada"].includes(a.event));
    expect(eventos.map((a) => a.event)).toEqual(["enviada_aprobacion", "aprobada"]);
    expect(eventos.every((a) => a.actorId === "dual-role")).toBe(true);
    expect(deps.notificationData.some((n) => n.template === "pendiente_aprobador")).toBe(false);
    expect(deps.notificationData.some((n) => n.template === "requisicion_aprobada" && n.userId === "sol")).toBe(true);
  });
  // DECISIÓN DE ERNESTO (2026-09-17): el maestro aprueba aunque la cabecera apunte a otro. Lo que NO
  // cambia es quién es maestro: un revisor a secas o un aprobador a secas siguen sin poder.
  it("send_and_approve: revisor a secas o aprobador a secas no pueden; el maestro aprueba aunque la cabecera sea de otro; admin_sixteam también", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, dual);
    await expect(service.sendAndApproveAsMaster(r.id, reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.sendAndApproveAsMaster(r.id, approver)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.sendAndApproveAsMaster(r.id, dual)).resolves.toMatchObject({ status: "aprobada" });
    // Queda escrito por encima de quién: el aprobador asignado era nelson, no dual-role.
    expect(deps.audits.filter((a) => a.entityId === r.id && a.event === "aprobada").at(-1)).toMatchObject({ actorId: "dual-role", data: { overrideReason: "aprobacion_por_encima", overrodeApprovers: [{ id: "nelson" }] } });
    const otra = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(otra.id, dual);
    await service.review(otra.id, { tagId: "tag", approverId: "nelson", items }, dual);
    await expect(service.sendAndApproveAsMaster(otra.id, { actor: { id: "root", roles: ["admin_sixteam"] as const } })).resolves.toMatchObject({ status: "aprobada" });
    await expect(service.sendAndApproveAsMaster(otra.id, { actor: { id: "root", roles: ["admin_sixteam"] as const }, origin: "mcp" })).rejects.toMatchObject({ code: "FORBIDDEN" }); // nunca por MCP
  });
  // H4 (docs/qa/QA-pagos-y-caja.md) sigue cubierto, pero por la vía correcta: envío y aprobación
  // comparten UNA transacción, así que ya no hay forma de quedarse en `en_aprobacion` sin aviso.
  it("send_and_approve con reparto por ítem: el maestro aprueba por encima del aprobador de ítem y la auditoría lo registra con nombre", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    // l1 → sonia (otro aprobador elegible), l2 sin approverId propio: hereda la cabecera (dual-role).
    await service.review(r.id, { tagId: "tag", approverId: "dual-role", items: [{ ...items[0], approverId: "sonia" }, items[1]] }, dual);
    await expect(service.sendAndApproveAsMaster(r.id, dual)).resolves.toMatchObject({ status: "aprobada" });
    const aprobada = deps.audits.filter((a) => a.entityId === r.id && a.event === "aprobada").at(-1);
    expect(aprobada).toMatchObject({ actorId: "dual-role", data: { overrideReason: "aprobacion_por_encima", overrodeApprovers: [{ id: "sonia", name: "Sonia Aprobadora" }] } });
    expect(deps.notificationData.some((n) => n.template === "pendiente_aprobador")).toBe(false); // a sonia no se le pide decidir algo ya decidido
  });
  // El candado que NO se movió: un aprobador cualquiera sigue sin poder cerrar lo ajeno.
  it("un aprobador a secas no puede aprobar lo que decide otro aprobador", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items: [{ ...items[0], approverId: "sonia" }, items[1]] }, dual);
    await service.sendForApproval(r.id, dual);
    // nelson decide lo suyo (l2, heredado de la cabecera) y no puede cerrar por sonia.
    await expect(service.approve(r.id, approver)).rejects.toMatchObject({ code: "APPROVAL_PENDING_OTHERS" });
    // Y alguien que no aprueba nada de esta requisición ni siquiera llega a esa comprobación.
    await expect(service.approve(r.id, { actor: { id: "ajeno", roles: ["aprobador"] as const } })).rejects.toMatchObject({ code: "NOT_ASSIGNED_APPROVER" });
    expect((await deps.requisitions.get(r.id))?.status).toBe("en_aprobacion");
  });
  it("send_and_approve con reparto por ítem: si cabecera Y todos los ítems son el maestro, aprueba con dos eventos", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const dual = { actor: { id: "dual-role", roles: ["revisor", "aprobador"] as const } };
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", channel: "web", items }, requester);
    await service.startReview(r.id, dual);
    await service.review(r.id, { tagId: "tag", approverId: "dual-role", items: [{ ...items[0], approverId: "dual-role" }, items[1]] }, dual);
    const approved = await service.sendAndApproveAsMaster(r.id, dual);
    expect(approved.status).toBe("aprobada");
    const eventos = deps.audits.filter((a) => a.entityId === r.id && ["enviada_aprobacion", "aprobada"].includes(a.event));
    expect(eventos.map((a) => a.event)).toEqual(["enviada_aprobacion", "aprobada"]);
    expect(eventos.every((a) => a.actorId === "dual-role")).toBe(true);
  });
});
// RF-008 (N4): «un CC de tipo administrativo o personal no requiere obra» — la obra deja de ser
// obligatoria solo bajo un centro que no es de tipo obra; el gasto nace sin obra y su empresa facturada
// sale de la sociedad del centro.
describe("obra opcional cuando el centro de costo no es de tipo obra (RF-008)", () => {
  it("un CC administrativo permite enviar a aprobación sin obra; la orden y el gasto nacen sin obra", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", costCenterId: "cc-admin", items }, reviewer);
    await expect(service.sendForApproval(r.id, reviewer)).resolves.toMatchObject({ status: "en_aprobacion", workId: undefined, costCenterId: "cc-admin" });
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect(orders).toHaveLength(2);
    for (const order of orders) expect(deps.expensesData.find((e) => e.referenceId === order.id)).toMatchObject({ workId: "", costCenterId: "cc-admin", billedCompanyId: "soc" });
  });
  it("un CC de tipo obra sigue exigiendo obra (explícito, o sin tipo cargado), tanto al enviar a aprobación como al generar órdenes", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", costCenterId: "cc-obra-explicita", items }, reviewer);
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
    await service.review(r.id, { tagId: "tag", approverId: "nelson", costCenterId: "cc-work", items }, reviewer); // sin `type`: cuenta como obra
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
    // Con obra, como siempre.
    await service.review(r.id, { tagId: "tag", approverId: "nelson", workId: "work", items }, reviewer);
    await expect(service.sendForApproval(r.id, reviewer)).resolves.toMatchObject({ status: "en_aprobacion" });
    // generateOrders aplica la misma regla (dato legado: aprobada sin obra bajo un centro de tipo obra).
    await service.approve(r.id, approver);
    const stored = deps.req.get(r.id)!; stored.workId = undefined; stored.costCenterId = "cc-obra-explicita"; deps.req.set(r.id, stored);
    await expect(service.generateOrders(r.id, reviewer)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(deps.ordersData).toHaveLength(0);
  });
  it("gasto sin obra hereda la sociedad del CC como empresa facturada", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "pago", societyId: "proim", channel: "web", items: [items[0]] }, requester);
    await service.startReview(r.id, reviewer);
    const reviewedR = await service.review(r.id, { tagId: "tag", approverId: "nelson", costCenterId: "cc-admin-proim", items: [items[0]] }, reviewer);
    expect(reviewedR.billedCompanyId).toBe("proim"); // derivada del centro en la revisión
    await service.sendForApproval(r.id, reviewer);
    await service.approve(r.id, approver);
    // Dato anterior a la columna: sin empresa facturada guardada, generateOrders la resuelve desde el centro.
    const stored = deps.req.get(r.id)!; stored.billedCompanyId = undefined; deps.req.set(r.id, stored);
    const [order] = await service.generateOrders(r.id, reviewer);
    expect(order.workId).toBeUndefined();
    expect(deps.expensesData.find((e) => e.referenceId === order.id)).toMatchObject({ workId: "", costCenterId: "cc-admin-proim", billedCompanyId: "proim" });
  });
});
describe("centros de costo", () => {
  it("review() hereda el centro de la obra cuando no hay uno explícito ni previo, y el revisor puede cambiarlo o limpiarlo", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    // Sin costCenterId en el input: hereda "cc-work" (el default de la obra "work").
    const heredado = await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    expect(heredado.costCenterId).toBe("cc-work");

    // El revisor lo cambia explícitamente a otro centro válido (misma sociedad, activo).
    const cambiado = await service.review(r.id, { tagId: "tag", costCenterId: "cc-alterno", items }, reviewer);
    expect(cambiado.costCenterId).toBe("cc-alterno");

    // Un review() posterior SIN costCenterId no toca el valor ya elegido (no lo vuelve a heredar de la obra).
    const sinTocar = await service.review(r.id, { tagId: "tag", items }, reviewer);
    expect(sinTocar.costCenterId).toBe("cc-alterno");

    // null/"" lo desasigna explícitamente, igual que approverId (M-6).
    const limpiado = await service.review(r.id, { tagId: "tag", costCenterId: null, items }, reviewer);
    expect(limpiado.costCenterId).toBeUndefined();
  });

  it("review() rechaza un centro de otra sociedad o inactivo, pero acepta uno compartido (sociedad NULL)", async () => {
    const service = new ProcurementService(fakeDeps());
    const r = await service.create({ type: "compra", societyId: "soc", workId: "work", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await expect(service.review(r.id, { tagId: "tag", costCenterId: "cc-otra-sociedad", items }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.review(r.id, { tagId: "tag", costCenterId: "cc-inactivo", items }, reviewer)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const compartido = await service.review(r.id, { tagId: "tag", costCenterId: "cc-compartido", items }, reviewer);
    expect(compartido.costCenterId).toBe("cc-compartido");
  });

  it("sendForApproval exige centro de costo (además de obra/etiqueta/aprobador)", async () => {
    const service = new ProcurementService(fakeDeps());
    // "obra-sin-centro" no trae costCenterId: nada de dónde heredar.
    const r = await service.create({ type: "compra", societyId: "soc", workId: "obra-sin-centro", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    const reviewedR = await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    expect(reviewedR.costCenterId).toBeUndefined();
    await expect(service.sendForApproval(r.id, reviewer)).rejects.toMatchObject({ code: "REVIEW_INCOMPLETE" });
    // Con un centro explícito, sendForApproval ya no lo bloquea (compartido: no importa la sociedad).
    await service.review(r.id, { tagId: "tag", costCenterId: "cc-compartido", items }, reviewer);
    await expect(service.sendForApproval(r.id, reviewer)).resolves.toMatchObject({ status: "en_aprobacion" });
  });

  it("generateOrders() copia el centro de costo heredado a cada gasto generado", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await reviewed(service); // workId "work" desde create(): hereda "cc-work" en review().
    expect(r.costCenterId).toBe("cc-work");
    await service.approve(r.id, approver);
    const orders = await service.generateOrders(r.id, reviewer);
    expect(orders.length).toBeGreaterThan(0);
    const expensesGeneradas = deps.expensesData.filter((expense) => orders.some((order) => order.id === expense.referenceId));
    expect(expensesGeneradas.length).toBeGreaterThan(0);
    for (const expense of expensesGeneradas) expect(expense.costCenterId).toBe("cc-work");
  });

  // Esta prueba debe FALLAR si algún día se quita el guardián de generateOrders(): sendForApproval()
  // bloquea el camino normal (probado arriba), pero una requisición "aprobada" ANTES de que existiera
  // esta exigencia (dato legado, o un bypass futuro) no debe poder generar un gasto sin centro en
  // silencio — `saveExpense` inserta con `on conflict do nothing`, así que un gasto que nace sin centro
  // se queda así PARA SIEMPRE.
  it("generateOrders() NUNCA deja nacer un gasto sin centro: si la requisición aprobada no tiene uno (ni su obra), falla en vez de crearlo", async () => {
    const deps = fakeDeps(), service = new ProcurementService(deps);
    const r = await service.create({ type: "compra", societyId: "soc", workId: "obra-sin-centro", requiredDate: "2026-08-30", channel: "web", items }, requester);
    await service.startReview(r.id, reviewer);
    await service.review(r.id, { tagId: "tag", approverId: "nelson", items }, reviewer);
    // Simula el dato legado: se fuerza el estado a "aprobada" sin pasar por sendForApproval() (que sí
    // exige el centro), reproduciendo una requisición que llegó a este estado antes de esta exigencia.
    const stored = deps.req.get(r.id)!;
    stored.status = "aprobada";
    deps.req.set(r.id, stored);
    await expect(service.generateOrders(r.id, reviewer)).rejects.toMatchObject({ code: "COST_CENTER_REQUIRED" });
    expect(deps.expensesData).toHaveLength(0); // ningún gasto llegó a crearse, ni con centro ni sin él.
  });
});
