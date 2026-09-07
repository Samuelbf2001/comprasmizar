import { DomainError, approvedLines, assertAdminTransition, assertCop, assertHasApprovedLine, assertPermission, assertTransition, buildAttentionQueue, buildRecentActivity, calculateDashboard, calculateTax, calculateLineAmounts, calculateLineTotal, groupExpenseByPeriod, groupExpenseByTag, groupExpenseByWork, groupOrderItems, hasPermission, normalizeItemName, orderTypeFor, sumLines, validateShares, type Actor, type AuditEvent, type Expense, type ExpenseShare, type ItemLine, type ItemStatus, type Order, type OrderAdminStatus, type OrderStatus, type PettyCash, type Requisition, type RequisitionChannel, type RequisitionType } from "../domain";
import type { AuditRepository, CatalogSupplier, CatalogWork, RequestContext, ServiceDependencies, TransactionRepositories } from "./contracts";

/**
 * GRAVE 1 (QA Postgres real): fecha y periodo del gasto en la zona horaria DE LA OPERACIÓN
 * (Colombia, America/Bogotá, UTC-5 fijo, sin horario de verano), no en UTC. `this.now().toISOString()
 * .slice(0,10/7)` (el código anterior) toma componentes UTC: cualquier orden generada después de las
 * 19:00 hora local se contabilizaba al día siguiente, y el último día del mes caía en el `periodo`
 * SIGUIENTE (columna generada en `gastos`, ver migración base) — justo el cierre mensual que motiva
 * este proyecto.
 * Mismo CRITERIO que `localTodayISO()` (components/screens/connected.tsx: componentes del calendario
 * local, nunca `toISOString().slice()`), pero implementado con `Intl.DateTimeFormat` de zona horaria
 * FIJA en vez de los getters locales de `Date`: `localTodayISO()` corre en el navegador del usuario,
 * cuyo reloj local ya se asume en Bogotá; esto corre en el servidor, cuyo TZ de proceso es
 * desconocido (a menudo UTC en producción), así que los getters locales de `Date` no sirven aquí.
 */
const COLOMBIA_TIME_ZONE = "America/Bogota";
function colombiaDateParts(date: Date): { day: string; period: string } {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: COLOMBIA_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return { day, period: day.slice(0, 7) };
}

export interface CreateRequisitionInput { type: RequisitionType; societyId?: string; workId?: string; requiredDate?: string; channel: RequisitionChannel; requesterId?: string; externalRequester?: { name: string; phone?: string }; observations?: string; items: ItemLine[]; publicCode?: string; publicLinkToken?: string; kapsoEventId?: string; }
/** approverId is intentionally absent: the current tag configuration owns routing. workId/paymentTerms: RF reunión 2026-08-31, el revisor asigna la obra y la forma de pago. */
export interface ReviewInput { tagId: string; workId?: string; paymentTerms?: string; items: ItemLine[]; }
export interface PettyCashInput { workId: string; date: string; concept: string; tagId: string; amount: number; attachmentUrl?: string; }
/** Reunión 2026-08-31: decisión por ítem del aprobador. No cambia el estado de la requisición. */
export interface ItemDecision { itemId: string; status: ItemStatus; declineReason?: string; quantity?: number; }
/** Bloqueante de atasco (reunión 2026-08-31): shape deliberadamente acotado a {itemId, supplierId} — nada de cantidad/precio/tasas/estado cabe aquí, así que assignSuppliers no puede tocarlos aunque quisiera. */
export interface SupplierAssignment { itemId: string; supplierId: string; }

export class ProcurementService {
  constructor(private readonly deps: ServiceDependencies) {}
  private now(): Date { return this.deps.clock.now(); }
  private origin(context: RequestContext): "web" | "mcp" | "kapso" { return context.origin ?? "web"; }
  private authOrigin(context: RequestContext): "web" | "mcp" { return this.origin(context) === "mcp" ? "mcp" : "web"; }
  private transaction<T>(lockKey: string | undefined, work: Parameters<ServiceDependencies["transactions"]["transaction"]>[1]): Promise<T> { return this.deps.transactions.transaction(lockKey, work) as Promise<T>; }
  private actor(context: RequestContext): Actor { if (!context.actor) throw new DomainError("UNAUTHENTICATED", "Debe autenticarse"); return context.actor; }
  private async requisition(id: string): Promise<Requisition> { const requisition = await this.deps.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); return requisition; }
  private async audit(entity: string, entityId: string, event: string, actor: Actor, data?: Record<string, unknown>, origin: "web" | "mcp" | "kapso" = "web", repository: AuditRepository = this.deps.audit): Promise<void> { const actorId = actor.id === "kapso" || actor.id === "public" ? undefined : actor.id; await repository.append({ entity, entityId, event, actorId, at: this.now(), data, origin }); }
  private async transition(requisition: Requisition, to: Requisition["status"], actor: Actor, event: string, comment?: string, origin: "web" | "mcp" | "kapso" = "web", auditRepository?: AuditRepository): Promise<void> { const from = requisition.status; assertTransition(from, to, comment); requisition.status = to; await this.audit("requisicion", requisition.id, event, actor, { from, to, ...(comment ? { comment } : {}) }, origin, auditRepository); }
  private async notifyRequester(requisition: Requisition, template: string, tx: TransactionRepositories): Promise<void> { const channel = requisition.channel === "web" ? "interno" : "whatsapp"; if (requisition.requesterId) await tx.notifications.enqueue({ userId: requisition.requesterId, channel, template, payload: { requisitionId: requisition.id, consecutive: requisition.consecutive } }); else if (requisition.externalRequester?.phone) await tx.notifications.enqueue({ phone: requisition.externalRequester.phone, channel: "whatsapp", template, payload: { requisitionId: requisition.id, consecutive: requisition.consecutive } }); }
  private async materializeProposals(lines: readonly ItemLine[], actor: Actor, origin: "web" | "mcp" | "kapso", tx: TransactionRepositories): Promise<ItemLine[]> { const result: ItemLine[] = []; for (const line of lines) { if (!line.itemId && !line.description?.trim()) throw new DomainError("INVALID_INPUT", "Cada línea requiere un ítem o una propuesta"); if (line.itemId) { result.push({ ...line }); continue; } const description = line.description!.trim(); if (!normalizeItemName(description)) throw new DomainError("INVALID_INPUT", "La propuesta debe contener letras o números"); const proposal = await tx.items.propose(description, line.unit, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.id) ? actor.id : undefined); if (proposal.created) await this.audit("item", proposal.id, "propuesto", actor, { source: origin }, origin, tx.audit); result.push({ ...line, itemId: proposal.id, description }); } return result; }

  async create(input: CreateRequisitionInput, context: RequestContext): Promise<Requisition> {
    const origin = this.origin(context);
    const isExternalChannel = input.channel === "publico" || input.channel === "whatsapp";
    if (input.channel === "publico") { if (!input.workId || !input.publicLinkToken || !input.publicCode || !(await this.deps.publicAccess.verify(input.workId, input.publicLinkToken, input.publicCode))) throw new DomainError("PUBLIC_ACCESS_DENIED", "Enlace o código público inválido"); }
    else if (input.channel === "whatsapp") { if (origin !== "kapso" || !input.kapsoEventId?.trim()) throw new DomainError("FORBIDDEN", "WhatsApp solo acepta eventos Kapso verificados"); }
    else assertPermission(this.actor(context).roles, "requisition:create", this.authOrigin(context));
    // Reunión 2026-08-31: el solicitante elige empresa, no obra (la asigna el revisor). El Flow de
    // WhatsApp ya NO pide obra: manda empresa, igual que web. El único canal que puede omitir empresa
    // es el público, anclado a la obra, cuya sociedad deriva el trigger `requisiciones_0_derivar_sociedad`
    // (Fase 1) a partir de obra_id — nunca se le pide al público directamente. Antes este método exigía
    // `input.workId` también para whatsapp (arriba); eso moría en producción en cuanto el Flow dejara de
    // mandarlo — se quitó esa exigencia y se dejó UNA sola fuente de verdad: el chequeo de abajo, común a
    // web y whatsapp.
    if (input.channel !== "publico" && !input.societyId) throw new DomainError("INVALID_INPUT", "Empresa obligatoria");
    if (!input.items.length) throw new DomainError("INVALID_INPUT", "Los ítems son obligatorios"); sumLines(input.items);
    const externalPhone = input.externalRequester?.phone?.replace(/[\s()\-]/g, "");
    if (isExternalChannel && (!input.externalRequester?.name?.trim() || !externalPhone || !/^\+?[1-9]\d{6,14}$/.test(externalPhone))) throw new DomainError("INVALID_INPUT", "Nombre y teléfono externo válidos son obligatorios"); if (!isExternalChannel && input.externalRequester) throw new DomainError("INVALID_INPUT", "Solicitante externo no permitido en canal web");
    const actor = context.actor ?? { id: input.channel === "whatsapp" ? "kapso" : "public", roles: [] }, elevated = actor.roles.includes("revisor") || actor.roles.includes("admin_mizar") || actor.roles.includes("admin_sixteam");
    if (!isExternalChannel && input.requesterId && input.requesterId !== actor.id && !elevated) throw new DomainError("FORBIDDEN", "Un solicitante solo puede crear para sí mismo");
    const requesterId = isExternalChannel ? undefined : input.requesterId ?? actor.id;
    // El año del consecutivo sale SIEMPRE del reloj del servidor, nunca de la fecha requerida (que ahora es
    // opcional y ya era inconsistente con approve()/generateOrders() y con los triggers SQL de consecutivo).
    const year = this.now().getFullYear();
    // societyId ausente (solo posible ahora en el canal público) viaja tal cual, sin coaccionar a "": el
    // adaptador Postgres escribe NULL y el trigger `requisiciones_0_derivar_sociedad` la deriva de obra_id
    // antes del insert. El objeto en memoria devuelto aquí para el canal público queda sin sociedad hasta
    // la próxima lectura real desde Postgres, pero eso ya lo dice el tipo (`societyId?: string`).
    return this.transaction(undefined, async (tx) => { const requisition: Requisition = { id: this.deps.ids.next(), consecutive: await tx.consecutives.take("REQ", year), type: input.type, societyId: input.societyId, workId: input.workId, requesterId, externalRequester: input.externalRequester ? { ...input.externalRequester, phone: externalPhone } : undefined, channel: input.channel, requiredDate: input.requiredDate, observations: input.observations, kapsoEventId: input.channel === "whatsapp" ? input.kapsoEventId : undefined, items: await this.materializeProposals(input.items, actor, origin, tx), status: "enviada" }; await tx.requisitions.save(requisition); await this.audit("requisicion", requisition.id, "creada", actor, { channel: input.channel }, origin, tx.audit); if (isExternalChannel) await this.notifyRequester(requisition, "requisicion_recibida", tx); return requisition; });
  }
  async startReview(id: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); await this.transition(requisition, "en_revision", actor, "entrada_revision", undefined, this.origin(context), tx.audit); await tx.requisitions.save(requisition); return requisition; }); }
  async proposeItem(requisitionId: string, description: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:create", this.authOrigin(context)); if (!description.trim()) throw new DomainError("INVALID_INPUT", "Descripción obligatoria"); return this.transaction(`requisition:${requisitionId}`, async (tx) => { const requisition = await tx.requisitions.get(requisitionId); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); const reviewer = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam"); if (!reviewer && requisition.requesterId !== actor.id) throw new DomainError("FORBIDDEN", "No puede modificar una requisición ajena"); const editable = reviewer ? ["en_revision", "devuelta"] : ["enviada"]; if (!editable.includes(requisition.status)) throw new DomainError("INVALID_STATE", "La requisición no admite nuevos ítems en este estado"); const [line] = await this.materializeProposals([{ id: this.deps.ids.next(), description: description.trim(), quantity: 1, unit: "unidad", unitBase: 0, unitIva: 0 }], actor, this.origin(context), tx); requisition.items.push(line); await tx.requisitions.save(requisition); await this.audit("requisicion", requisition.id, "item_propuesto", actor, { itemId: line.itemId }, this.origin(context), tx.audit); return requisition; }); }
  async review(id: string, input: ReviewInput, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); if (!input.tagId) throw new DomainError("INVALID_INPUT", "Etiqueta obligatoria"); sumLines(input.items);
    return this.transaction(`requisition:${id}`, async (tx) => {
      const approverId = await tx.tags.getApproverId(input.tagId); if (!approverId) throw new DomainError("ROUTING_NOT_FOUND", "La etiqueta no tiene aprobador activo");
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (requisition.status === "devuelta") await this.transition(requisition, "en_revision", actor, "retomada_revision", undefined, this.origin(context), tx.audit);
      if (requisition.status !== "en_revision") throw new DomainError("INVALID_STATE", "La requisición no está en revisión");
      // La obra la asigna el revisor (reunión 2026-08-31) y debe pertenecer a la sociedad de la requisición:
      // sin este chequeo, un revisor podría colgar el gasto de una requisición bajo la obra de otra empresa.
      // requisition.societyId ausente en memoria solo puede pasar para el canal público (el único que la
      // omite en create()); contra Postgres real el trigger `requisiciones_0_derivar_sociedad` ya la habrá
      // poblado al releer la fila, así que aquí NO se inventa una comparación permisiva: sin sociedad
      // conocida no hay forma de validar que la obra le pertenezca, y se exige explícitamente.
      if (input.workId) {
        if (!requisition.societyId) throw new DomainError("INVALID_INPUT", "La requisición no tiene sociedad conocida para validar la obra");
        const work = await tx.catalogs.get("works", input.workId) as CatalogWork | null;
        if (!work || !work.active || work.societyId !== requisition.societyId) throw new DomainError("INVALID_INPUT", "La obra debe existir, estar activa y pertenecer a la sociedad de la requisición");
        requisition.workId = input.workId;
      }
      requisition.tagId = input.tagId; requisition.approverId = approverId;
      if (input.paymentTerms !== undefined) requisition.paymentTerms = input.paymentTerms.trim() || undefined;
      const storedById = new Map(requisition.items.map((line) => [line.id, line]));
      requisition.items = (await this.materializeProposals(input.items, actor, this.origin(context), tx)).map((line) => {
        const stored = storedById.get(line.id);
        // Defensa IVA legacy: si la línea entrante no trae ivaRate y la almacenada sí tenía IVA > 0, se
        // conserva la tasa/monto tal cual (incluida una `stored.ivaRate` que quede en `undefined`) — si
        // no, el primer guardado de una requisición histórica pondría su IVA en cero en silencio, y con
        // él el gasto que de ahí se deriva. B2 (QA Postgres real): esta defensa depende por completo de
        // que el mapeador de Postgres pueda devolver `ivaRate: undefined` para una tasa nunca capturada
        // — con `iva_tasa` NOT NULL DEFAULT 0 (como se declaró originalmente) eso era IMPOSIBLE: el
        // mapeador siempre devolvía `ivaRate: 0` (una tasa definida), este `if` restauraba esa tasa 0
        // "real" y `calculateLineAmounts` tomaba la vía de tasa con ella, evaporando el IVA aunque
        // `unitIva` quedara preservado. Con `iva_tasa` nullable (migración 202609010001) el mapeador
        // ahora sí puede devolver `undefined`, y esta defensa por fin protege lo que dice proteger. NO
        // "simplificar" restaurando `stored.ivaRate ?? 0`: eso reintroduce el bug exacto.
        if (line.ivaRate === undefined && stored && (stored.unitIva ?? 0) > 0) return { ...line, ivaRate: stored.ivaRate, unitIva: stored.unitIva };
        return line;
      });
      await tx.requisitions.save(requisition);
      await this.audit("requisicion", id, "revisada", actor, { tagId: input.tagId, approverId, workId: input.workId, paymentTerms: input.paymentTerms }, this.origin(context), tx.audit);
      return requisition;
    });
  }
  async decline(id: string, reason: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); await this.transition(requisition, "declinada", actor, "declinada", reason.trim(), this.origin(context), tx.audit); requisition.declineReason = reason.trim(); await tx.requisitions.save(requisition); await this.notifyRequester(requisition, "requisicion_declinada", tx); return requisition; }); }
  // "sendForApproval" ya NO exige proveedor final por ítem (decisión de la reunión: aprobar y designar
  // proveedor son roles distintos). Sí exige obra: gastos.obra_id es NOT NULL y sin obra generateOrders
  // reventaría al registrar el gasto. Las líneas declinadas no cuentan como "vigentes" (approvedLines).
  async sendForApproval(id: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); const vigentes = approvedLines(requisition.items), incompleteLines = vigentes.some((line) => calculateLineTotal(line) <= 0); if (!requisition.workId || !requisition.tagId || !requisition.approverId || !vigentes.length || incompleteLines) throw new DomainError("REVIEW_INCOMPLETE", "Obra, etiqueta y valor cotizado mayor a cero son obligatorios en cada ítem vigente"); await this.transition(requisition, "en_aprobacion", actor, "enviada_aprobacion", undefined, this.origin(context), tx.audit); await tx.requisitions.save(requisition); await tx.notifications.enqueue({ userId: requisition.approverId, channel: "whatsapp", template: "pendiente_aprobador", payload: { requisitionId: requisition.id, consecutive: requisition.consecutive } }); return requisition; }); }
  /** Reunión 2026-08-31: decisión por ítem del aprobador (aprobar/declinar/ajustar cantidad). No cambia el estado de la requisición: eso lo sigue haciendo approve(). */
  async decideItems(id: string, decisions: readonly ItemDecision[], context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:approve", this.authOrigin(context));
    return this.transaction(`requisition:${id}`, async (tx) => {
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (requisition.approverId !== actor.id) throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado");
      if (requisition.status !== "en_aprobacion") throw new DomainError("INVALID_STATE", "La requisición no está en aprobación");
      const byId = new Map(requisition.items.map((line) => [line.id, line]));
      for (const decision of decisions) {
        const line = byId.get(decision.itemId); if (!line) throw new DomainError("NOT_FOUND", "Ítem no encontrado");
        if (decision.status === "declinado" && !decision.declineReason?.trim()) throw new DomainError("COMMENT_REQUIRED", "Se requiere motivo para declinar un ítem");
        line.status = decision.status; line.declineReason = decision.status === "declinado" ? decision.declineReason!.trim() : undefined;
        if (decision.quantity !== undefined) { if (!Number.isFinite(decision.quantity) || decision.quantity <= 0) throw new DomainError("INVALID_QUANTITY", "La cantidad debe ser mayor que cero"); line.quantity = decision.quantity; }
      }
      await tx.requisitions.save(requisition);
      await this.audit("requisicion", id, "items_decididos", actor, { decisions: decisions.map((d) => ({ itemId: d.itemId, status: d.status })) }, this.origin(context), tx.audit);
      return requisition;
    });
  }
  // approve() se adelgaza a la transición de estado: verificar aprobador asignado → exigir al menos un
  // ítem vigente → transicionar a aprobada → guardar → notificar. Sin órdenes, sin gastos, sin
  // groupOrderItems ni features: ese trabajo se movió a generateOrders(), un paso explícito que el
  // comprador detona con un botón (decisión de la reunión 2026-08-31).
  async approve(id: string, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:approve", this.authOrigin(context));
    return this.transaction(`requisition:${id}`, async (tx) => {
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (requisition.approverId !== actor.id) throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado");
      if (requisition.status === "aprobada") return requisition;
      assertHasApprovedLine(requisition.items);
      await this.transition(requisition, "aprobada", actor, "aprobada", undefined, this.origin(context), tx.audit);
      await tx.requisitions.save(requisition);
      await this.notifyRequester(requisition, "requisicion_aprobada", tx);
      return requisition;
    });
  }
  /**
   * Bloqueante de atasco (reunión 2026-08-31): aprobar y designar proveedor son roles distintos, así que
   * un ítem puede quedar `aprobada` sin `finalSupplierId` — legítimo, no un error. Pero review() (donde
   * antes se asignaba proveedor) ya solo opera en en_revision/devuelta, y generateOrders() es todo o
   * nada (SUPPLIER_REQUIRED si falta alguno): sin este método esa requisición queda `aprobada` para
   * siempre, sin ninguna forma de generar sus órdenes. Permiso order:create (compras), NO
   * requisition:approve: es trabajo del comprador, no del aprobador, que ni siquiera lo tiene en su
   * lista de permisos (lib/domain/rules.ts). Solo válido en `aprobada` y SIN órdenes ya generadas —
   * una vez generadas son el documento en firme y no se reabren. Solo toca `finalSupplierId` de líneas
   * NO declinadas: el shape del input (`SupplierAssignment` = {itemId, supplierId}) ya impide, por
   * construcción, alterar cantidad/precio/tasas/estado de lo que ya aprobó otra persona.
   */
  async assignSuppliers(id: string, assignments: readonly SupplierAssignment[], context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "order:create", this.authOrigin(context));
    if (!assignments.length) throw new DomainError("INVALID_INPUT", "Debe asignar al menos un proveedor");
    return this.transaction(`requisition:${id}`, async (tx) => {
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (requisition.status !== "aprobada") throw new DomainError("INVALID_STATE", "La requisición debe estar aprobada para asignar proveedor");
      if ((await tx.orders.listByRequisition(id)).length > 0) throw new DomainError("INVALID_STATE", "La requisición ya tiene órdenes generadas");
      const byId = new Map(requisition.items.map((line) => [line.id, line]));
      for (const { itemId, supplierId } of assignments) {
        const line = byId.get(itemId); if (!line) throw new DomainError("NOT_FOUND", "Ítem no encontrado");
        if (line.status === "declinado") throw new DomainError("ITEM_DECLINED", "No se puede asignar proveedor a un ítem declinado");
        const supplier = await tx.catalogs.get("suppliers", supplierId) as CatalogSupplier | null;
        if (!supplier || !supplier.active) throw new DomainError("INVALID_INPUT", "El proveedor debe existir y estar activo");
        line.finalSupplierId = supplierId;
      }
      await tx.requisitions.save(requisition);
      await this.audit("requisicion", id, "proveedores_asignados", actor, { assignments }, this.origin(context), tx.audit);
      return requisition;
    });
  }
  /**
   * Reunión 2026-08-31: paso explícito ("Generar órdenes") que el comprador detona con un botón, ya no un
   * efecto secundario de approve(). Bajo el lock `requisition:<id>` (TransactionManager hace `select ...
   * for update` con esa clave): idempotente — si ya hay órdenes para la requisición, las devuelve tal cual.
   * Todo o nada: si alguna línea aprobada no tiene proveedor final, groupOrderItems lanza SUPPLIER_REQUIRED
   * ANTES de guardar nada, así que una generación parcial nunca deja huérfanos.
   */
  async generateOrders(id: string, context: RequestContext): Promise<Order[]> {
    const actor = this.actor(context); assertPermission(actor.roles, "order:create", this.authOrigin(context));
    return this.deps.transactions.transaction(`requisition:${id}`, async (transactional) => {
      const requisition = await transactional.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (requisition.status !== "aprobada") throw new DomainError("INVALID_STATE", "La requisición debe estar aprobada para generar órdenes");
      const existing = await transactional.orders.listByRequisition(id); if (existing.length > 0) return existing;
      if (!requisition.workId) throw new DomainError("INVALID_STATE", "La requisición no tiene obra asignada");
      const lines = approvedLines(requisition.items); assertHasApprovedLine(lines);
      const groups = groupOrderItems(lines, requisition.type), orderType = orderTypeFor(requisition.type), year = this.now().getFullYear(), orders: Order[] = [];
      const paymentTerms = requisition.paymentTerms;
      const generatedAt = this.now().toISOString();
      const { day: expenseDate, period: expensePeriod } = colombiaDateParts(this.now());
      // MENOR (QA Postgres real): un proveedor puede desactivarse DESPUÉS de que assignSuppliers() lo
      // validó activo (no hay ninguna restricción de fila que lo impida) — sin este chequeo,
      // generateOrders reventaba con un 500 crudo en vez de un error de dominio legible. Validación
      // todo-o-nada, igual que SUPPLIER_REQUIRED en groupOrderItems: antes de crear ninguna orden, no
      // a mitad de la generación.
      for (const supplierId of groups.keys()) {
        const supplier = await transactional.catalogs.get("suppliers", supplierId) as CatalogSupplier | null;
        if (!supplier || !supplier.active) throw new DomainError("SUPPLIER_INACTIVE", "El proveedor asignado a uno o más ítems ya no está activo; reasigne un proveedor activo antes de generar órdenes");
      }
      for (const [supplierId, groupLines] of groups) {
        const order: Order = { id: this.deps.ids.next(), consecutive: await transactional.consecutives.take(orderType, year), type: orderType, requisitionId: id, supplierId, itemIds: groupLines.map((line) => line.id), status: "generada", adminStatus: "pendiente", generatedAt, paymentTerms };
        await transactional.orders.save(order); orders.push(order);
        await this.audit("orden", order.id, "generada", actor, { requisitionId: id, supplierId }, this.origin(context), transactional.audit);
        const base = groupLines.reduce((sum, line) => sum + calculateLineAmounts(line).base, 0), iva = groupLines.reduce((sum, line) => sum + calculateLineAmounts(line).iva, 0);
        const expense: Expense = { id: this.deps.ids.next(), workId: requisition.workId, origin: "requisicion", referenceId: order.id, tagId: requisition.tagId, supplierId, date: expenseDate, base, iva, total: sumLines(groupLines), period: expensePeriod };
        await transactional.expenses.save(expense);
        await this.audit("gasto", expense.id, "registrado", actor, { orderId: order.id, supplierId }, this.origin(context), transactional.audit);
      }
      return orders;
    });
  }
  async returnForCorrection(id: string, comment: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:return", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); if (requisition.approverId !== actor.id) throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado"); await this.transition(requisition, "devuelta", actor, "devuelta", comment.trim(), this.origin(context), tx.audit); requisition.returnReason = comment.trim(); await tx.requisitions.save(requisition); await this.notifyRequester(requisition, "requisicion_devuelta", tx); return requisition; }); }
  async updateOrderStatus(orderId: string, status: OrderStatus, context: RequestContext): Promise<Order> { const actor = this.actor(context); assertPermission(actor.roles, "order:update", this.authOrigin(context)); return this.transaction(`order:${orderId}`, async (tx) => { const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada"); if (order.status !== "generada" || !["cumplida", "no_cumplida", "no_necesario"].includes(status)) throw new DomainError("INVALID_TRANSITION", "Estado de orden inválido"); order.status = status; await tx.orders.save(order); await this.audit("orden", order.id, "estado_cumplimiento_actualizado", actor, { status }, this.origin(context), tx.audit); return order; }); }
  /** Reunión 2026-08-31: eje administrativo/contable, independiente de updateOrderStatus (cumplimiento). "contabilizada" exige order:account (contabilidad); "pagada" exige order:pay (revisor/admins). */
  async updateOrderAdminStatus(orderId: string, status: OrderAdminStatus, context: RequestContext): Promise<Order> {
    const actor = this.actor(context); assertPermission(actor.roles, status === "contabilizada" ? "order:account" : "order:pay", this.authOrigin(context));
    return this.transaction(`order:${orderId}`, async (tx) => {
      const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
      assertAdminTransition(order.adminStatus, status, order.status);
      order.adminStatus = status;
      if (status === "contabilizada") order.accountedAt = this.now().toISOString(); else order.paidAt = this.now().toISOString();
      await tx.orders.save(order);
      await this.audit("orden", order.id, "estado_administrativo_actualizado", actor, { status }, this.origin(context), tx.audit);
      return order;
    });
  }
  async redistribute(expenseId: string, total: number, shares: ExpenseShare[], context: RequestContext): Promise<void> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); if (shares.some((share) => share.expenseId !== expenseId)) throw new DomainError("INVALID_SHARE", "Todas las líneas deben pertenecer al gasto"); await this.transaction(`expense:${expenseId}`, async (tx) => { const expense = await tx.expenses.get(expenseId); if (!expense) throw new DomainError("NOT_FOUND", "Gasto no encontrado"); if (expense.total !== total) throw new DomainError("EXPENSE_TOTAL_MISMATCH", "El total del reparto no coincide con el gasto"); validateShares(expense.total, shares); await tx.expenses.saveShares(shares); await this.audit("gasto", expenseId, "repartido", actor, { total: expense.total }, this.origin(context), tx.audit); }); }
  async registerPettyCash(input: PettyCashInput, context: RequestContext): Promise<{ entry: PettyCash; expense: Expense }> { const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:create", this.authOrigin(context)); if (!input.workId || !input.concept.trim() || !input.tagId) throw new DomainError("INVALID_INPUT", "Campos de caja menor obligatorios"); assertCop(input.amount, "Valor"); if (input.amount === 0) throw new DomainError("INVALID_MONEY", "El valor debe ser mayor a cero"); const entry: PettyCash = { id: this.deps.ids.next(), ...input, registeredBy: actor.id }; return this.transaction(undefined, async (tx) => { const expense = await tx.pettyCash.save(entry); await this.audit("caja_menor", entry.id, "registrada", actor, { expenseId: expense.id }, this.origin(context), tx.audit); await this.audit("gasto", expense.id, "registrado", actor, { origin: "caja_menor" }, this.origin(context), tx.audit); return { entry, expense }; }); }
  async listRequisitions(context: RequestContext): Promise<Requisition[]> { const actor = this.actor(context); if (!["requisition:read", "requisition:read:own", "requisition:read:assigned"].some((permission) => hasPermission(actor.roles, permission, this.authOrigin(context)))) throw new DomainError("FORBIDDEN", "No puede consultar requisiciones"); return this.deps.requisitions.listVisibleTo(actor); }
  async getRequisition(id: string, context: RequestContext): Promise<Requisition> { const visible = await this.listRequisitions(context), requisition = visible.find((entry) => entry.id === id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); return requisition; }
  async getRequisitionHistory(id: string, context: RequestContext): Promise<AuditEvent[]> { await this.getRequisition(id, context); return this.deps.audit.list("requisicion", id); }
  /**
   * Edita la cabecera de una requisición (ficha editable): fecha requerida y observaciones (`destination`
   * queda fuera: el campo se fusionó en observaciones y ya no se lee ni se escribe desde el dominio).
   * Solo el revisor/admin (requisition:review) y solo mientras la requisición aún es editable
   * (enviada, en_revision o devuelta): una vez en aprobación, aprobada o declinada, la cabecera se
   * congela. NO toca ítems, obra ni tipo — eso alteraría la identidad o el gasto y va por el flujo
   * de revisión. Registra en auditoría qué cambió.
   */
  async updateRequisitionHeader(id: string, patch: { requiredDate?: string; observations?: string | null }, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context));
    return this.transaction(`requisition:${id}`, async (tx) => {
      const requisition = await tx.requisitions.get(id);
      if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (!["enviada", "en_revision", "devuelta"].includes(requisition.status)) throw new DomainError("INVALID_STATE", "La requisición ya no admite cambios de cabecera en este estado");
      const changed: Record<string, unknown> = {};
      if (patch.requiredDate !== undefined && patch.requiredDate !== requisition.requiredDate) { requisition.requiredDate = patch.requiredDate; changed.requiredDate = patch.requiredDate; }
      if (patch.observations !== undefined) { const value = patch.observations?.trim() || undefined; if (value !== requisition.observations) { requisition.observations = value; changed.observations = value ?? null; } }
      if (Object.keys(changed).length === 0) return requisition;
      await tx.requisitions.save(requisition);
      await this.audit("requisicion", requisition.id, "cabecera_editada", actor, changed, this.origin(context), tx.audit);
      return requisition;
    });
  }
  async listOrders(context: RequestContext): Promise<Order[]> { const actor = this.actor(context); assertPermission(actor.roles, "order:read", this.authOrigin(context)); return this.deps.orders.listVisibleTo(actor); }
  async listExpenses(context: RequestContext): Promise<Expense[]> { const actor = this.actor(context); assertPermission(actor.roles, "expense:read", this.authOrigin(context)); return this.deps.expenses.listVisibleTo(actor); }
  async listPettyCash(context: RequestContext): Promise<PettyCash[]> { const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context)); return this.deps.pettyCash.list(); }
  async dashboard(period: string, context: RequestContext) {
    const actor = this.actor(context); assertPermission(actor.roles, "dashboard:read", this.authOrigin(context)); if (!/^\d{4}-\d{2}$/.test(period)) throw new DomainError("INVALID_INPUT", "Periodo inválido");
    const [requisitions, expenses, orders] = await Promise.all([this.deps.requisitions.listVisibleTo(actor), this.deps.expenses.listVisibleTo(actor), this.deps.orders.listVisibleTo(actor)]);
    const metrics = calculateDashboard(expenses, orders, requisitions.map((r) => r.status), period);
    metrics.inProcessValue = requisitions.filter((r) => r.status === "en_revision" || r.status === "en_aprobacion").reduce((sum, r) => sum + sumLines(r.items), 0);
    // RF-1102/RF-706/RF-1103: agregados adicionales sobre las mismas colecciones ya autorizadas por listVisibleTo,
    // igual que inProcessValue arriba; calculateDashboard no los produce para no romper su firma existente.
    metrics.attentionQueue = buildAttentionQueue(requisitions, orders, actor);
    metrics.recentActivity = buildRecentActivity(requisitions, orders, expenses);
    metrics.expenseByWork = groupExpenseByWork(expenses);
    metrics.expenseByTag = groupExpenseByTag(expenses);
    metrics.expenseByPeriod = groupExpenseByPeriod(expenses);
    return metrics;
  }
  calculateQuotedValue(base: number, ivaRate: number) { return calculateTax(base, ivaRate); }
  lineTotal(line: ItemLine) { return calculateLineTotal(line); }
}
