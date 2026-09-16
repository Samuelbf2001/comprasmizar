import { DomainError, approvedLines, assertAdminTransition, assertCanAnnulPayment, assertCop, assertHasApprovedLine, assertPaymentRequestShape, assertPaymentWithinOrder, assertPermission, assertTransition, buildAttentionQueue, combinedDeclineReason, itemApproverId, pendingApproverIds, buildRecentActivity, calculateTax, calculateLineAmounts, calculateLineTotal, colombiaDateParts, groupOrderItems, hasPermission, normalizeIdentification, normalizeItemName, orderTypeFor, resolveCostCenter, sumLines, sumPaid, validateShares, type Actor, type AuditEvent, type BeneficiaryInput, type CashPayment, type DashboardMetrics, type Expense, type ExpenseShare, type ItemLine, type ItemStatus, type Order, type OrderAdminStatus, type OrderPayment, type OrderStatus, type PaymentMethod, type PettyCash, type Requisition, type RequisitionChannel, type RequisitionType } from "../domain";
import type { AuditRepository, CatalogCostCenter, CatalogSupplier, CatalogWork, RequestContext, ServiceDependencies, TransactionRepositories } from "./contracts";
import type { ListQuery, Page } from "./list-query";

// H3 (docs/plan-rendimiento.md, Fase 3): los repositorios de listas devuelven `T[]` sin `query` o
// `Page<T>` con `query` (unión de retorno, ver contracts.ts). `isPage` estrecha ese tipo en tiempo de
// ejecución para los métodos `*Page` de abajo, que SIEMPRE pasan `query` y por lo tanto SIEMPRE reciben
// una `Page<T>` — pero el tipo estático del repositorio no lo sabe a partir de la sola presencia del
// argumento, así que se estrecha explícitamente en vez de forzarlo con un cast.
function isPage<T>(value: T[] | Page<T>): value is Page<T> { return !Array.isArray(value); }

// GRAVE 1/QA reasignación: `colombiaDateParts` (fecha/periodo en hora de Colombia, no UTC) se movió a
// lib/domain/rules.ts — vivía duplicada aquí y en app/api/pantalla/route.ts (que además la tenía MAL,
// en UTC crudo). Ver el comentario completo junto a su definición en el dominio; no la reimplementes.

/**
 * `beneficiary` (RF-606, adenda de pagos): alternativa a `items[0].finalSupplierId` en `type: "pago"` para
 * los canales que no tienen catálogo delante (portal público, WhatsApp): identificación + nombre. Se
 * enlaza al proveedor existente por (tipo, identificación) o se crea `pendingNormalization` dentro de la
 * MISMA transacción de la requisición. En el canal web solo lo puede usar quien administra proveedores.
 */
export interface CreateRequisitionInput { type: RequisitionType; societyId?: string; workId?: string; requiredDate?: string; channel: RequisitionChannel; requesterId?: string; externalRequester?: { name: string; phone?: string }; observations?: string; items: ItemLine[]; beneficiary?: BeneficiaryInput; publicCode?: string; publicLinkToken?: string; kapsoEventId?: string; }
/**
 * Decisión del cliente (reunión 2026-09, literal de Daniel): "etiqueto a qué obra va y etiqueto quién me
 * va a aprobar" — approverId lo elige el revisor, ya NO se deriva de tagId. Opcional aquí: review()
 * puede guardarse como borrador sin aprobador todavía; sendForApproval() sí lo exige (ya lo hacía por
 * `!requisition.approverId`). workId/paymentTerms: RF reunión 2026-08-31, el revisor asigna la obra y la
 * forma de pago.
 * M-6 (QA reasignación): `approverId` distingue tres casos, no dos. `undefined` = el campo no vino en el
 * payload, no tocar el aprobador ya asignado (compatibilidad con el borrador parcial de siempre). `null`
 * o `""` = el revisor lo está DESASIGNANDO explícitamente (p.ej. para reelegir uno nuevo desde cero). Un
 * string no vacío = asignar ese aprobador (validado con isEligibleApprover, como siempre). Antes
 * `if (input.approverId)` trataba `""` igual que `undefined` (conservaba el anterior en silencio) y
 * sendForApproval() seguía notificando al aprobador viejo aunque el revisor hubiera intentado limpiarlo.
 */
/**
 * `costCenterId` sigue la MISMA semántica de tres estados que `approverId` (ver el comentario de arriba):
 * `undefined` = no tocar (y, si además llega `workId` nuevo sin centro previo, se HEREDA el de la obra —
 * ver `resolveCostCenter` en lib/domain/rules.ts); `null`/`""` = desasignar explícitamente; un string no
 * vacío = asignar ese centro (validado en `review()` contra el mismo catálogo que `isEligibleApprover`).
 */
export interface ReviewInput { tagId: string; approverId?: string | null; workId?: string; costCenterId?: string | null; paymentTerms?: string; items: ItemLine[]; }
/**
 * `cashBoxId`/`paymentMethod` obligatorios (2026-09-12): TODO movimiento de caja vive bajo una caja
 * del catálogo `cajas` con un medio de pago — ya no es exclusivo de la caja menor clásica de obra (ver
 * migración 202609120003). `costCenterId` es el mismo patrón "hereda-o-elige" que
 * `ReviewInput.costCenterId`: ausente = hereda el de la obra (`resolveCostCenter`); informado, gana
 * sobre el de la obra. `iva`: ausente = 0 (compatibilidad con lo que ya se llamaba caja menor, que
 * nunca llevaba IVA); informado, es el "gasto directo" de la pestaña Gastos y caja.
 */
export interface PettyCashInput { workId: string; date: string; concept: string; tagId: string; amount: number; attachmentUrl?: string; cashBoxId: string; paymentMethod: PaymentMethod; costCenterId?: string; iva?: number; }
/** Reunión agosto 2026: entrada de `registerOrderPayment` — `date`/`amount`/`method` obligatorios, igual que `OrderPayment` en lib/domain/model.ts.
 *  `note` (RF-507, adenda de pagos): nota libre del pago. El comprobante NO viaja aquí: se sube después
 *  contra el id del pago recién creado (adjunto con entidad `pago_orden`), ver OrderPayment.attachmentId. */
export interface OrderPaymentInput { date: string; amount: number; method: PaymentMethod; externalReference?: string; note?: string; }
/** RF-708: rango del cierre de caja (`listCashPayments`), fechas `YYYY-MM-DD` inclusive; `costCenterId` acota al centro de la requisición dueña. */
export interface CashPaymentsQuery { from: string; to: string; costCenterId?: string; }
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
  /**
   * BLOQUEANTE (feat/solicitud-de-pago): antes materializaba un ítem de CATÁLOGO a partir de
   * cualquier descripción libre sin itemId, sin importar el tipo de requisición — con `type:
   * "pago"` eso contaminaría el maestro de ítems con conceptos de una sola vez ("Pago acta 3
   * contratista X"). Para `type === "pago"` la propuesta se SALTA: item_id queda NULL (permitido
   * por `requisicion_items_item_check`, migración 202608240001_core_compras.sql) y
   * descripcion_libre lleva el concepto tal cual. Una línea que YA trae itemId (cualquier tipo)
   * sigue sin tocar tx.items.propose — nunca lo necesitó.
   */
  private async materializeProposals(lines: readonly ItemLine[], actor: Actor, origin: "web" | "mcp" | "kapso", tx: TransactionRepositories, type: RequisitionType = "compra"): Promise<ItemLine[]> { const result: ItemLine[] = []; for (const line of lines) { if (!line.itemId && !line.description?.trim()) throw new DomainError("INVALID_INPUT", "Cada línea requiere un ítem o una propuesta"); if (line.itemId) { result.push({ ...line }); continue; } const description = line.description!.trim(); if (!normalizeItemName(description)) throw new DomainError("INVALID_INPUT", "La propuesta debe contener letras o números"); if (type === "pago") { result.push({ ...line, description }); continue; } const proposal = await tx.items.propose(description, line.unit, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.id) ? actor.id : undefined); if (proposal.created) await this.audit("item", proposal.id, "propuesto", actor, { source: origin }, origin, tx.audit); result.push({ ...line, itemId: proposal.id, description }); } return result; }

  async create(input: CreateRequisitionInput, context: RequestContext): Promise<Requisition> {
    const origin = this.origin(context);
    const isExternalChannel = input.channel === "publico" || input.channel === "whatsapp";
    // `publicLinkToken` dejó de ser obligatorio (2026-09-11): la ruta del portal es pública y la
    // contraseña es la llave. `publicCode` sí sigue siéndolo — sin él no hay nada que verificar.
    if (input.channel === "publico") { if (!input.workId || !input.publicCode || !(await this.deps.publicAccess.verify(input.workId, input.publicLinkToken ?? null, input.publicCode))) throw new DomainError("PUBLIC_ACCESS_DENIED", "Enlace o código público inválido"); }
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
    // Solicitud de pago (feat/solicitud-de-pago): beneficiario y valor > 0 se exigen DESDE la
    // creación — a diferencia de una compra, un pago no tiene un paso de revisión previo que los
    // complete (review() vuelve a exigir esto mismo, ver más abajo). RF-606: si el beneficiario viene
    // por identificación (sin `finalSupplierId`), la forma se comprueba dentro de la transacción, una
    // vez resuelto el proveedor.
    const beneficiary = input.type === "pago" && input.beneficiary && !input.items[0]?.finalSupplierId ? input.beneficiary : undefined;
    if (input.type === "pago" && !beneficiary) assertPaymentRequestShape(input.items);
    const externalPhone = input.externalRequester?.phone?.replace(/[\s()\-]/g, "");
    // El NOMBRE es obligatorio en los dos canales externos: sin él la requisición no tiene autor.
    //
    // El TELÉFONO ya no lo es en el portal público (decisión de Ernesto, 11-sep-2026: "el teléfono no
    // lo hagas obligatorio"). Sigue siéndolo en WhatsApp, donde no es un dato de contacto sino la
    // IDENTIDAD del remitente: sin él no hay de quién venga el mensaje.
    //
    // Cuando viene, se valida igual que antes. Lo que se acepta ahora es que NO venga — y la
    // consecuencia está asumida: sin teléfono no hay acuse por WhatsApp (`notifyRequester` no encola
    // nada, ver arriba), así que quien radique sin dejarlo no recibirá aviso de avance. El precio de
    // exigirlo era peor: un maestro que no lo quiere dar no radica.
    if (isExternalChannel && !input.externalRequester?.name?.trim()) throw new DomainError("INVALID_INPUT", "El nombre del solicitante es obligatorio");
    if (input.channel === "whatsapp" && !externalPhone) throw new DomainError("INVALID_INPUT", "El teléfono del solicitante es obligatorio en WhatsApp");
    if (externalPhone && !/^\+?[1-9]\d{6,14}$/.test(externalPhone)) throw new DomainError("INVALID_INPUT", "El teléfono del solicitante no es válido");if (!isExternalChannel && input.externalRequester) throw new DomainError("INVALID_INPUT", "Solicitante externo no permitido en canal web");
    const actor = context.actor ?? { id: input.channel === "whatsapp" ? "kapso" : "public", roles: [] }, elevated = actor.roles.includes("revisor") || actor.roles.includes("admin_mizar") || actor.roles.includes("admin_sixteam");
    if (!isExternalChannel && input.requesterId && input.requesterId !== actor.id && !elevated) throw new DomainError("FORBIDDEN", "Un solicitante solo puede crear para sí mismo");
    // Crear un proveedor "al vuelo" desde la web es alta de catálogo: solo quien ya puede administrarlos.
    if (beneficiary && !isExternalChannel && !hasPermission(actor.roles, "supplier:manage", this.authOrigin(context))) throw new DomainError("FORBIDDEN", "Solo compras puede crear un beneficiario por identificación; elija uno del catálogo");
    const requesterId = isExternalChannel ? undefined : input.requesterId ?? actor.id;
    // El año del consecutivo sale SIEMPRE del reloj del servidor, nunca de la fecha requerida (que ahora es
    // opcional y ya era inconsistente con approve()/generateOrders() y con los triggers SQL de consecutivo).
    const year = this.now().getFullYear();
    // societyId ausente (solo posible ahora en el canal público) viaja tal cual, sin coaccionar a "": el
    // adaptador Postgres escribe NULL y el trigger `requisiciones_0_derivar_sociedad` la deriva de obra_id
    // antes del insert. El objeto en memoria devuelto aquí para el canal público queda sin sociedad hasta
    // la próxima lectura real desde Postgres, pero eso ya lo dice el tipo (`societyId?: string`).
    return this.transaction(undefined, async (tx) => {
      let items = input.items;
      // RF-606: beneficiario por identificación — se enlaza o se crea pendiente, y la línea de concepto
      // recibe su id antes de la misma comprobación de forma que hace el camino con `finalSupplierId`.
      if (beneficiary) {
        const supplier = await this.resolveBeneficiary(beneficiary, input.channel, actor, origin, tx);
        items = [{ ...input.items[0], finalSupplierId: supplier.id }, ...input.items.slice(1)];
        assertPaymentRequestShape(items);
      }
      // El beneficiario debe existir y estar activo en el catálogo — mismo criterio que
      // assignSuppliers()/generateOrders() para el proveedor final de una compra. Sin este chequeo,
      // un finalSupplierId inválido moría en el insert con la FK cruda (proveedor_final_id
      // references proveedores) en vez de un error de dominio legible.
      if (input.type === "pago") {
        const supplier = await tx.catalogs.get("suppliers", items[0].finalSupplierId as string) as CatalogSupplier | null;
        if (!supplier || !supplier.active) throw new DomainError("INVALID_INPUT", "El beneficiario debe ser un proveedor activo del catálogo");
      }
      const requisition: Requisition = { id: this.deps.ids.next(), consecutive: await tx.consecutives.take("REQ", year), type: input.type, societyId: input.societyId, workId: input.workId, requesterId, externalRequester: input.externalRequester ? { ...input.externalRequester, phone: externalPhone } : undefined, channel: input.channel, requiredDate: input.requiredDate, observations: input.observations, kapsoEventId: input.channel === "whatsapp" ? input.kapsoEventId : undefined, items: await this.materializeProposals(items, actor, origin, tx, input.type), status: "enviada" };
      await tx.requisitions.save(requisition); await this.audit("requisicion", requisition.id, "creada", actor, { channel: input.channel }, origin, tx.audit); if (isExternalChannel) await this.notifyRequester(requisition, "requisicion_recibida", tx); return requisition;
    });
  }
  /**
   * RF-606: la identidad del beneficiario es su identificación, no su nombre — si existe se enlaza aunque
   * el nombre venga distinto (Daniel normaliza después); si está inactivo se rechaza (mismo criterio que
   * un `finalSupplierId` inactivo); si no existe nace `pendingNormalization` con el teléfono que dejó el
   * solicitante como único contacto. `razon_social` es única en la base: un homónimo con OTRA
   * identificación se traduce a CONFLICT en vez de un 500 crudo.
   */
  private async resolveBeneficiary(input: BeneficiaryInput, channel: RequisitionChannel, actor: Actor, origin: "web" | "mcp" | "kapso", tx: TransactionRepositories): Promise<CatalogSupplier> {
    const identification = input.identification.trim(), name = input.name.trim();
    if (!normalizeIdentification(identification)) throw new DomainError("INVALID_INPUT", "La identificación del beneficiario es obligatoria");
    if (!name) throw new DomainError("INVALID_INPUT", "El nombre del beneficiario es obligatorio");
    const existing = await tx.catalogs.findSupplierByIdentification(input.identificationType, identification);
    if (existing) { if (!existing.active) throw new DomainError("INVALID_INPUT", "El beneficiario existe en el catálogo pero está inactivo"); return existing; }
    let created: CatalogSupplier;
    try { created = await tx.catalogs.create("suppliers", { name, nit: input.identificationType === "NIT" ? identification : null, identificationType: input.identificationType, identification, pendingNormalization: true, phone: input.phone?.trim() || undefined, active: true }) as CatalogSupplier; }
    catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") throw new DomainError("CONFLICT", "Ya existe un proveedor con ese nombre y otra identificación"); throw error; }
    await this.audit("proveedor", created.id, "creado", actor, { identificationType: input.identificationType, identificationConfigured: true, pendingNormalization: true, source: "beneficiario", channel }, origin, tx.audit);
    return created;
  }
  async startReview(id: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); await this.transition(requisition, "en_revision", actor, "entrada_revision", undefined, this.origin(context), tx.audit); await tx.requisitions.save(requisition); return requisition; }); }
  async proposeItem(requisitionId: string, description: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:create", this.authOrigin(context)); if (!description.trim()) throw new DomainError("INVALID_INPUT", "Descripción obligatoria"); return this.transaction(`requisition:${requisitionId}`, async (tx) => { const requisition = await tx.requisitions.get(requisitionId); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); const reviewer = actor.roles.includes("revisor") || actor.roles.includes("admin_sixteam"); if (!reviewer && requisition.requesterId !== actor.id) throw new DomainError("FORBIDDEN", "No puede modificar una requisición ajena"); const editable = reviewer ? ["en_revision", "devuelta"] : ["enviada"]; if (!editable.includes(requisition.status)) throw new DomainError("INVALID_STATE", "La requisición no admite nuevos ítems en este estado"); const [line] = await this.materializeProposals([{ id: this.deps.ids.next(), description: description.trim(), quantity: 1, unit: "unidad", unitBase: 0, unitIva: 0 }], actor, this.origin(context), tx); requisition.items.push(line); await tx.requisitions.save(requisition); await this.audit("requisicion", requisition.id, "item_propuesto", actor, { itemId: line.itemId }, this.origin(context), tx.audit); return requisition; }); }
  async review(id: string, input: ReviewInput, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); if (!input.tagId) throw new DomainError("INVALID_INPUT", "Etiqueta obligatoria"); sumLines(input.items);
    return this.transaction(`requisition:${id}`, async (tx) => {
      // Decisión del cliente (reunión 2026-09): el aprobador ya NO se deriva de la etiqueta — lo elige el
      // revisor aquí. Se valida contra el mismo puerto que ya usa CatalogService.validateTag para exigir
      // un aprobador elegible en una etiqueta activa (isEligibleApprover), sin duplicar ese SQL en el
      // servicio. approverId es opcional (un borrador de revisión puede guardarse sin aprobador todavía);
      // sendForApproval() es quien lo exige antes de avanzar el estado.
      // M-6: solo se valida cuando el revisor manda un aprobador de verdad (string no vacío) — `null`/`""`
      // es una desasignación explícita, no un valor a validar contra el catálogo.
      if (input.approverId && !(await tx.catalogs.isEligibleApprover(input.approverId))) throw new DomainError("INVALID_INPUT", "El aprobador debe ser un usuario activo y elegible");
      // MISMO LISTÓN PARA EL APROBADOR POR ÍTEM. La base también lo exige (trigger
      // `requisicion_items_aprobador_elegible`, migración 202609110004), pero un fallo de constraint
      // sube como error de infraestructura: el revisor vería "algo falló" en vez de "ese aprobador no
      // sirve". Comprobarlo aquí es lo que convierte el segundo cinturón en un mensaje entendible.
      for (const aprobadorDeItem of new Set(input.items.map((line) => line.approverId).filter((id): id is string => Boolean(id)))) {
        if (!(await tx.catalogs.isEligibleApprover(aprobadorDeItem))) throw new DomainError("INVALID_INPUT", "El aprobador de un ítem debe ser un usuario activo y elegible");
      }
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      // Autoguardado (reunión 2026-09, rediseño "una acción por estado/rol"): con el disparo cada
      // blur/1.500ms desde la pantalla, `review()` se llama muchas más veces por sesión que antes
      // — y cada llamada auditaba "revisada" aunque el payload fuera IDÉNTICO al ya guardado (el
      // usuario tecleó y borró, o el debounce disparó dos veces seguidas). El historial de
      // trazabilidad (sección "Historial" del detalle) se llenaría de entradas sin ningún cambio
      // real que contar. Se compara contra lo YA guardado (antes de tocar nada) y solo se audita
      // si algo material (etiqueta/aprobador/obra/forma de pago/ítems) de verdad cambió.
      const beforeReview = JSON.stringify({
        tagId: requisition.tagId,
        approverId: requisition.approverId,
        workId: requisition.workId,
        costCenterId: requisition.costCenterId,
        paymentTerms: requisition.paymentTerms,
        items: requisition.items,
      });
      if (requisition.status === "devuelta") await this.transition(requisition, "en_revision", actor, "retomada_revision", undefined, this.origin(context), tx.audit);
      if (requisition.status !== "en_revision") throw new DomainError("INVALID_STATE", "La requisición no está en revisión");
      // Solicitud de pago (feat/solicitud-de-pago): mismo listón que create() — beneficiario y
      // valor > 0 siguen siendo obligatorios si el revisor edita la línea aquí. El tipo es
      // inmutable desde la creación, así que se valida contra `requisition.type`, no `input`.
      if (requisition.type === "pago") {
        assertPaymentRequestShape(input.items);
        const supplier = await tx.catalogs.get("suppliers", input.items[0].finalSupplierId as string) as CatalogSupplier | null;
        if (!supplier || !supplier.active) throw new DomainError("INVALID_INPUT", "El beneficiario debe ser un proveedor activo del catálogo");
      }
      // La obra la asigna el revisor (reunión 2026-08-31) y debe pertenecer a la sociedad de la requisición:
      // sin este chequeo, un revisor podría colgar el gasto de una requisición bajo la obra de otra empresa.
      // requisition.societyId ausente en memoria solo puede pasar para el canal público (el único que la
      // omite en create()); contra Postgres real el trigger `requisiciones_0_derivar_sociedad` ya la habrá
      // poblado al releer la fila, así que aquí NO se inventa una comparación permisiva: sin sociedad
      // conocida no hay forma de validar que la obra le pertenezca, y se exige explícitamente.
      let assignedWork: CatalogWork | null = null;
      if (input.workId) {
        if (!requisition.societyId) throw new DomainError("INVALID_INPUT", "La requisición no tiene sociedad conocida para validar la obra");
        const work = await tx.catalogs.get("works", input.workId) as CatalogWork | null;
        if (!work || !work.active || work.societyId !== requisition.societyId) throw new DomainError("INVALID_INPUT", "La obra debe existir, estar activa y pertenecer a la sociedad de la requisición");
        requisition.workId = input.workId;
        assignedWork = work;
      }
      // DECISIÓN DEL DUEÑO (Ernesto, 2026-09-12): si el revisor NO manda un centro explícito en ESTA
      // llamada (input.costCenterId === undefined) Y la requisición todavía no tiene uno propio, se
      // hereda el default de la obra EFECTIVA — la recién asignada arriba, o la que ya traía la
      // requisición desde create() — UNA SOLA definición (resolveCostCenter, lib/domain/rules.ts), no
      // repetida a mano aquí. Reutiliza `assignedWork` si esta misma llamada ya la trajo (sin una
      // segunda consulta); si la obra viene de antes, se busca aquí. Si la requisición YA tenía un
      // centro (elegido en una revisión anterior), esto no se lo pisa en silencio: seguir cambiando
      // obra no debe deshacer una elección explícita del revisor.
      if (input.costCenterId === undefined && !requisition.costCenterId && requisition.workId) {
        const work = assignedWork ?? (await tx.catalogs.get("works", requisition.workId) as CatalogWork | null);
        requisition.costCenterId = resolveCostCenter(requisition, work);
      }
      // M-6: mismo criterio de tres estados que approverId — `undefined` no toca; `null`/`""` desasigna;
      // un string no vacío se valida (existe, activo, y su sociedad —si tiene una fija— coincide con la
      // de la requisición o el centro es compartido) contra el mismo puerto que isEligibleApprover.
      if (input.costCenterId !== undefined) {
        const costCenterId = input.costCenterId || undefined;
        if (costCenterId) {
          if (!requisition.societyId) throw new DomainError("INVALID_INPUT", "La requisición no tiene sociedad conocida para validar el centro de costo");
          const costCenter = await tx.catalogs.get("costCenters", costCenterId) as CatalogCostCenter | null;
          if (!costCenter || !costCenter.active || (costCenter.societyId && costCenter.societyId !== requisition.societyId)) throw new DomainError("INVALID_INPUT", "El centro de costo debe existir, estar activo y ser compartido o de la sociedad de la requisición");
        }
        requisition.costCenterId = costCenterId;
      }
      // M-7 (QA reasignación, decisión consciente PENDIENTE de confirmar con el cliente): nada aquí
      // impide que un usuario con roles revisor+aprobador a la vez se asigne a sí mismo como approverId
      // y luego apruebe su propia revisión (approve() solo exige `approverId === actor.id`, sin excluir
      // al propio revisor). No se bloquea porque el negocio no ha dicho si eso debe prohibirse — se deja
      // fijado como comportamiento ACTUAL por un test explícito (ver procurement-service.test.ts) para
      // que cualquier cambio futuro sea deliberado, no un descubrimiento accidental en producción.
      requisition.tagId = input.tagId;
      // M-6: `undefined` = no tocar (compatibilidad con guardados parciales); `null`/`""` = desasignar
      // explícitamente; string no vacío = asignar. `input.approverId || undefined` colapsa `null`/`""` a
      // `undefined` (el sentinel de "sin aprobador" que ya usa el resto del dominio).
      if (input.approverId !== undefined) requisition.approverId = input.approverId || undefined;
      if (input.paymentTerms !== undefined) requisition.paymentTerms = input.paymentTerms.trim() || undefined;
      const storedById = new Map(requisition.items.map((line) => [line.id, line]));
      requisition.items = (await this.materializeProposals(input.items, actor, this.origin(context), tx, requisition.type)).map((line) => {
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
      const afterReview = JSON.stringify({
        tagId: requisition.tagId,
        approverId: requisition.approverId,
        workId: requisition.workId,
        costCenterId: requisition.costCenterId,
        paymentTerms: requisition.paymentTerms,
        items: requisition.items,
      });
      if (afterReview !== beforeReview) {
        await this.audit("requisicion", id, "revisada", actor, { tagId: input.tagId, approverId: requisition.approverId, workId: input.workId, costCenterId: requisition.costCenterId, paymentTerms: input.paymentTerms }, this.origin(context), tx.audit);
      }
      return requisition;
    });
  }
  /**
   * BLOQUEANTE (QA reasignación, reunión 2026-09): si el aprobador asignado deja de ser elegible (baja,
   * cambio de rol) mientras la requisición está `en_aprobacion`, antes de este método no había salida por
   * la aplicación — approve()/returnForCorrection() exigen `approverId === actor.id` y ese usuario ya no
   * puede entrar; review() (el único lugar que asignaba aprobador) solo opera en `en_revision`; decline()
   * desde `en_aprobacion` es transición inválida. Solo un DBA podía desatascarla. Mismo permiso y misma
   * validación de elegibilidad que review() (isEligibleApprover); válido en `en_revision`/`devuelta`
   * (mismos estados que review()) y, sobre todo, en `en_aprobacion` — el caso que de verdad bloqueaba. Si
   * la requisición ya está en_aprobacion se notifica al aprobador NUEVO (el viejo, si sigue sin poder
   * entrar, no gana nada con la notificación).
   */
  async reassignApprover(id: string, approverId: string, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context));
    if (!approverId) throw new DomainError("INVALID_INPUT", "Debe indicar el nuevo aprobador");
    return this.transaction(`requisition:${id}`, async (tx) => {
      if (!(await tx.catalogs.isEligibleApprover(approverId))) throw new DomainError("INVALID_INPUT", "El aprobador debe ser un usuario activo y elegible");
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      if (!["en_revision", "devuelta", "en_aprobacion"].includes(requisition.status)) throw new DomainError("INVALID_STATE", "La requisición no admite reasignar aprobador en este estado");
      const previousApproverId = requisition.approverId;
      requisition.approverId = approverId;
      await tx.requisitions.save(requisition);
      await this.audit("requisicion", id, "aprobador_reasignado", actor, { previousApproverId: previousApproverId ?? null, approverId }, this.origin(context), tx.audit);
      if (requisition.status === "en_aprobacion") await tx.notifications.enqueue({ userId: approverId, channel: "whatsapp", template: "pendiente_aprobador", payload: { requisitionId: requisition.id, consecutive: requisition.consecutive } });
      return requisition;
    });
  }
  /**
   * Declinar de REVISOR, que no es lo mismo que declinar todos los ítems.
   *
   * La precondición de estado es EXPLÍCITA desde el aprobador por ítem (11-sep-2026) y ya no se apoya
   * en la tabla de transiciones. Al abrir `en_aprobacion -> declinada` —que hace falta para cerrar una
   * requisición cuyos ítems se declinaron todos— este método se quedó, sin querer, pudiendo matar una
   * requisición que ya está en manos de su aprobador. Eso es quitarle la decisión a quien le toca, y la
   * salida para una requisición atascada sigue siendo `reassignApprover`, no declinarla por la espalda.
   *
   * O sea: la transición es legal para el APROBADOR; la acción del revisor conserva su propio límite.
   */
  async decline(id: string, reason: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); if (requisition.status === "en_aprobacion") throw new DomainError("INVALID_TRANSITION", "La requisición ya está en aprobación: la decide su aprobador o se reasigna"); await this.transition(requisition, "declinada", actor, "declinada", reason.trim(), this.origin(context), tx.audit); requisition.declineReason = reason.trim(); await tx.requisitions.save(requisition); await this.notifyRequester(requisition, "requisicion_declinada", tx); return requisition; }); }
  // "sendForApproval" ya NO exige proveedor final por ítem (decisión de la reunión: aprobar y designar
  // proveedor son roles distintos). Sí exige obra: gastos.obra_id es NOT NULL y sin obra generateOrders
  // reventaría al registrar el gasto. Las líneas declinadas no cuentan como "vigentes" (approvedLines).
  async sendForApproval(id: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); const vigentes = approvedLines(requisition.items), incompleteLines = vigentes.some((line) => calculateLineTotal(line) <= 0);
    // Centros de costo (2026-09-12, decisión del dueño): exigido junto a obra/etiqueta/aprobador — sin
    // él, generateOrders() no tendría de dónde copiar el centro del gasto (ver la nota "ojo" en su
    // propio cuerpo, más abajo). El caso común nunca lo dispara: review() ya lo hereda de la obra en
    // cuanto se asigna una; solo falta aquí si el revisor lo desasignó explícitamente sin volver a elegir uno.
    if (!requisition.workId || !requisition.tagId || !requisition.approverId || !requisition.costCenterId || !vigentes.length || incompleteLines) throw new DomainError("REVIEW_INCOMPLETE", "Obra, etiqueta, centro de costo, aprobador y valor cotizado mayor a cero son obligatorios en cada ítem vigente"); await this.transition(requisition, "en_aprobacion", actor, "enviada_aprobacion", undefined, this.origin(context), tx.audit); await tx.requisitions.save(requisition);
    // UN AVISO POR APROBADOR, no uno por requisición. Con aprobadores por ítem hay varias personas a
    // las que les toca algo, y cada una tiene que recibir SU mensaje con SUS ítems. El `approverId`
    // viaja en el payload porque es lo que luego deja al emisor elegir el contexto correcto: el
    // teléfono lo sigue sacando de `usuarios`, nunca del cuerpo de una petición.
    //
    // Con un solo aprobador esto encola exactamente una notificación, igual que siempre.
    for (const aprobador of pendingApproverIds(requisition.items, requisition.approverId)) {
      await tx.notifications.enqueue({ userId: aprobador, channel: "whatsapp", template: "pendiente_aprobador", payload: { requisitionId: requisition.id, consecutive: requisition.consecutive, approverId: aprobador } });
    }
    return requisition; }); }
  /** Reunión 2026-08-31: decisión por ítem del aprobador (aprobar/declinar/ajustar cantidad). No cambia el estado de la requisición: eso lo sigue haciendo approve(). */
  async decideItems(id: string, decisions: readonly ItemDecision[], context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context); assertPermission(actor.roles, "requisition:approve", this.authOrigin(context));
    return this.transaction(`requisition:${id}`, async (tx) => {
      const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada");
      // M-5: admin_sixteam puede decidir CUALQUIER requisición en aprobación, no solo las asignadas —
      // ver la justificación completa junto a buildAttentionQueue en lib/domain/rules.ts.
      //
      // APROBADOR POR ÍTEM (11-sep-2026): «es el aprobador asignado» dejó de ser una pregunta sobre la
      // requisición y pasó a serlo sobre CADA ÍTEM. Aquí solo se comprueba que al actor le toque algo;
      // qué ítems concretos puede tocar se comprueba línea por línea más abajo, que es donde importa.
      const omnipotente = actor.roles.includes("admin_sixteam");
      if (!omnipotente && requisition.approverId !== actor.id && !requisition.items.some((line) => line.approverId === actor.id)) {
        throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado");
      }
      if (requisition.status !== "en_aprobacion") throw new DomainError("INVALID_STATE", "La requisición no está en aprobación");
      const byId = new Map(requisition.items.map((line) => [line.id, line]));
      for (const decision of decisions) {
        const line = byId.get(decision.itemId); if (!line) throw new DomainError("NOT_FOUND", "Ítem no encontrado");
        // EL CONTROL QUE DE VERDAD IMPORTA: nadie decide un ítem que no es suyo. Sin esto, bastaba con
        // ser aprobador de UN ítem para decidir los de los demás — y por WhatsApp, donde el token dice
        // quién eres pero el cuerpo lo arma el remitente, eso es una puerta abierta.
        if (!omnipotente && itemApproverId(line, requisition.approverId) !== actor.id) {
          throw new DomainError("NOT_ASSIGNED_APPROVER", "Ese ítem lo decide otro aprobador");
        }
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
      // M-5: mismo bypass de decideItems() — ver justificación junto a buildAttentionQueue en lib/domain/rules.ts.
      const omnipotente = actor.roles.includes("admin_sixteam");
      if (!omnipotente && requisition.approverId !== actor.id && !requisition.items.some((line) => line.approverId === actor.id)) {
        throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado");
      }
      if (requisition.status === "aprobada" || requisition.status === "declinada") return requisition;
      // CIERRA EL ÚLTIMO, no el primero. Con aprobadores por ítem, quien termina lo suyo pulsa
      // "Completar aprobación" y no puede cerrar por los demás: la requisición sigue `en_aprobacion`
      // mientras quede un ítem sin decidir. Con un solo aprobador —el caso de siempre— no cambia nada,
      // porque la pantalla manda todas las decisiones juntas y no queda ninguno pendiente.
      const pendientes = pendingApproverIds(requisition.items, requisition.approverId).filter((aprobador) => aprobador !== actor.id);
      if (pendientes.length && !omnipotente) throw new DomainError("APPROVAL_PENDING_OTHERS", `Faltan ${pendientes.length} aprobador(es) por decidir sus ítems`);
      // TODOS DECLINADOS = requisición declinada, no aprobada sin nada dentro. Antes este camino ni
      // existía (`assertHasApprovedLine` reventaba con NO_APPROVED_ITEMS y la requisición se quedaba
      // en aprobación para siempre); ahora se cierra diciendo la verdad, con los motivos de los ítems
      // arrastrados a la cabecera porque la base los exige y el solicitante los necesita.
      if (approvedLines(requisition.items).length === 0) {
        const motivo = combinedDeclineReason(requisition.items);
        requisition.declineReason = motivo;
        await this.transition(requisition, "declinada", actor, "declinada", motivo, this.origin(context), tx.audit);
        await tx.requisitions.save(requisition);
        await this.notifyRequester(requisition, "requisicion_declinada", tx);
        return requisition;
      }
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
      // Centros de costo (2026-09-12, decisión del dueño): sendForApproval() ya lo exige, así que en el
      // camino normal requisition.costCenterId siempre está poblado aquí — este fallback (la obra) y el
      // guardián de abajo son defensa en profundidad para una requisición que llegó a "aprobada" ANTES
      // de que existiera esta exigencia (dato legado), no una vía alterna para saltársela.
      const work = requisition.costCenterId ? null : (await transactional.catalogs.get("works", requisition.workId) as CatalogWork | null);
      const costCenterId = resolveCostCenter(requisition, work);
      // ojo: `saveExpense` hace `on conflict do nothing` — esta es la ÚNICA oportunidad de fijar
      // centro_costo_id en el gasto; si aquí falta, ningún UPDATE posterior lo va a arreglar. Por eso se
      // falla ALTO Y CLARO en vez de dejar nacer un gasto sin centro en silencio.
      if (!costCenterId) throw new DomainError("COST_CENTER_REQUIRED", "No fue posible determinar el centro de costo del gasto: la requisición y su obra no tienen uno asignado");
      const lines = approvedLines(requisition.items); assertHasApprovedLine(lines);
      const groups = groupOrderItems(lines, requisition.type), orderType = orderTypeFor(requisition.type), year = this.now().getFullYear(), orders: Order[] = [];
      const paymentTerms = requisition.paymentTerms;
      const generatedAt = this.now().toISOString();
      // Reunión 2026-09: el gasto nace SIN fecha de pago (`date`/`period` ausentes) — es un compromiso,
      // todavía no un gasto. `orderDate` es la fecha en que nace el registro (hoy, hora Colombia).
      const { day: orderDate } = colombiaDateParts(this.now());
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
        const expense: Expense = { id: this.deps.ids.next(), workId: requisition.workId, origin: "requisicion", referenceId: order.id, tagId: requisition.tagId, supplierId, orderDate, base, iva, total: sumLines(groupLines), costCenterId };
        await transactional.expenses.save(expense);
        await this.audit("gasto", expense.id, "registrado", actor, { orderId: order.id, supplierId }, this.origin(context), transactional.audit);
      }
      return orders;
    });
  }
  // M-5: mismo bypass de admin_sixteam que approve()/decideItems() — ver justificación junto a buildAttentionQueue en lib/domain/rules.ts.
  /**
   * DEVOLVER ES DE LA CABECERA, y es un límite pensado, no un olvido del aprobador por ítem.
   *
   * Devolver manda la requisición ENTERA de vuelta a revisión. Si pudiera hacerlo quien decide un ítem
   * de cinco, tumbaría de paso las decisiones de los otros cuatro aprobadores sin que se enteraran.
   * Quien decide solo unos ítems y ve algo mal tiene su salida: declinarlos con motivo.
   *
   * La devolución POR ÍTEM quedó fuera de v1 a propósito (reunión 11-sep-2026). Si algún día entra,
   * este es el sitio, y entonces sí habrá que decidir qué pasa con lo ya decidido por los demás.
   */
  async returnForCorrection(id: string, comment: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:return", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); if (requisition.approverId !== actor.id && !actor.roles.includes("admin_sixteam")) throw new DomainError("NOT_ASSIGNED_APPROVER", "No es el aprobador asignado"); await this.transition(requisition, "devuelta", actor, "devuelta", comment.trim(), this.origin(context), tx.audit); requisition.returnReason = comment.trim(); await tx.requisitions.save(requisition); await this.notifyRequester(requisition, "requisicion_devuelta", tx); return requisition; }); }
  /**
   * GRAVE 2 (QA reasignación, reunión 2026-09): el eje administrativo (adminStatus) y el de cumplimiento
   * (status, aquí) son independientes — una orden puede llegar a `no_necesario` ya `contabilizada` (el
   * chequeo de arriba solo exige `status === "generada"`, nunca miró adminStatus). Secuencia legal
   * generar → contabilizar → no_necesario: desde ahí assertAdminTransition bloquea contabilizar/pagar
   * para siempre (ORDER_NOT_NEEDED), así que su gasto (nacido sin `date`, un compromiso) quedaba
   * engordando inProcessValue sin fecha y sin forma de anularlo. Se anula aquí, en la MISMA transacción
   * que el cambio de estado: si NO está pagada (pendiente o contabilizada), se borra el gasto y su
   * reparto — todavía no se le pagó a nadie, no hay nada que devolver. Si YA está pagada, se rechaza:
   * anular un pago ya hecho exige un flujo de devolución que no existe todavía. `no_cumplida` no entra
   * en este `if`: el material puede llegar después, el compromiso sigue en pie.
   */
  async updateOrderStatus(orderId: string, status: OrderStatus, context: RequestContext): Promise<Order> {
    const actor = this.actor(context); assertPermission(actor.roles, "order:update", this.authOrigin(context));
    return this.transaction(`order:${orderId}`, async (tx) => {
      const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
      if (order.status !== "generada" || !["cumplida", "no_cumplida", "no_necesario"].includes(status)) throw new DomainError("INVALID_TRANSITION", "Estado de orden inválido");
      if (status === "no_necesario") {
        if (order.adminStatus === "pagada") throw new DomainError("ORDER_ALREADY_PAID", "Una orden ya pagada no puede declararse innecesaria: no existe un flujo de devolución");
        const linkedExpenses = await tx.expenses.listByReference(order.id);
        await tx.expenses.deleteByReference("requisicion", order.id);
        for (const expense of linkedExpenses) await this.audit("gasto", expense.id, "gasto_anulado", actor, { orderId: order.id, reason: "orden_no_necesaria" }, this.origin(context), tx.audit);
      }
      order.status = status; await tx.orders.save(order);
      await this.audit("orden", order.id, "estado_cumplimiento_actualizado", actor, { status }, this.origin(context), tx.audit);
      return order;
    });
  }
  /** Reunión 2026-08-31: eje administrativo/contable, independiente de updateOrderStatus (cumplimiento). "contabilizada" exige order:account (contabilidad); "pagada" exige order:pay (revisor/admins). */
  async updateOrderAdminStatus(orderId: string, status: OrderAdminStatus, context: RequestContext): Promise<Order> {
    const actor = this.actor(context); assertPermission(actor.roles, status === "contabilizada" ? "order:account" : "order:pay", this.authOrigin(context));
    return this.transaction(`order:${orderId}`, async (tx) => {
      const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
      assertAdminTransition(order.adminStatus, status, order.status);
      order.adminStatus = status;
      if (status === "contabilizada") { order.accountedAt = this.now().toISOString(); }
      else {
        /**
         * Adenda de pagos (A3, RF-508): "pagada" ya NO inventa un pago interno con medio `otro` por el
         * saldo — cada peso pagado tiene que entrar por `registerOrderPayment` con su medio real (la
         * caja menor ES el medio `efectivo`; un pago "otro" automático la volvía invisible en el cierre
         * de caja). Cerrar el eje administrativo exige saldo cero: si queda saldo se rechaza con
         * SALDO_PENDIENTE y la pantalla ofrece "Pagar saldo" (el diálogo de pago prellenado). La fecha
         * de pago del gasto es la del ÚLTIMO pago vigente ("la fecha del gasto es la del pago",
         * reunión 2026-09), no la de hoy.
         */
        const [expense] = await tx.expenses.listByReference(orderId);
        // GRAVE 3 (QA reasignación), preservado: una orden "pagada" sin gasto es un estado
        // inconsistente (contabilizada/pagada son un eje independiente del cumplimiento, así que nada
        // más lo garantiza) que antes quedaba en silencio. Se detecta con el mismo código de error
        // que ya usa `registerOrderPayment`.
        if (!expense) throw new DomainError("ORDER_EXPENSE_MISSING", "La orden no tiene un gasto asociado; no se puede marcar como pagada");
        const payments = (await tx.orderPayments.listByOrder(orderId)).filter((payment) => !payment.annulled);
        const balance = expense.total - sumPaid(payments);
        if (balance > 0) throw new DomainError("SALDO_PENDIENTE", `La orden tiene un saldo pendiente de ${balance}; registre el pago del saldo antes de marcarla pagada`);
        const { day: today } = colombiaDateParts(this.now());
        const lastPaymentDate = payments.reduce<string | undefined>((latest, payment) => (!latest || payment.date > latest ? payment.date : latest), undefined);
        order.paidAt = this.now().toISOString();
        // saveExpense no sirve para fijar esta fecha: su `on conflict do nothing` nunca actualiza un
        // gasto ya guardado (ver markPaid en contracts.ts). El chequeo de 0 filas se conserva: no
        // debería dispararse nunca (ya se comprobó arriba que el gasto existe), pero sigue siendo la
        // única señal de un estado inconsistente si algún día dejara de ser así.
        const paidRows = await tx.expenses.markPaid(order.id, lastPaymentDate ?? today);
        if (paidRows === 0) throw new DomainError("ORDER_EXPENSE_MISSING", "La orden no tiene un gasto asociado; no se puede marcar como pagada");
      }
      await tx.orders.save(order);
      await this.audit("orden", order.id, "estado_administrativo_actualizado", actor, { status }, this.origin(context), tx.audit);
      return (await tx.orders.get(order.id)) ?? order;
    });
  }
  /**
   * Reunión agosto 2026: registra un pago PARCIAL de una orden — el gesto nuevo, más frecuente, que
   * ni "contabilizar" ni "pagar el saldo" (arriba) cubren por sí solos. NO toca `adminStatus`/`paidAt`:
   * cerrar la orden como "pagada" sigue siendo un gesto aparte y deliberado (ver la nota grande de
   * compatibilidad en `updateOrderAdminStatus`), nunca algo que un abono parcial dispare solo. Igual
   * que `registerPettyCash`, devuelve {payment, order} — `order` con `paidAmount` fresco — para que
   * la pantalla actualice la columna "Pagado / Total" sin un segundo viaje.
   */
  async registerOrderPayment(orderId: string, input: OrderPaymentInput, context: RequestContext): Promise<{ payment: OrderPayment; order: Order }> {
    const actor = this.actor(context); assertPermission(actor.roles, "payment:register", this.authOrigin(context));
    return this.transaction(`order:${orderId}`, async (tx) => {
      const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
      // Mismo criterio que ORDER_ALREADY_PAID en updateOrderStatus: una orden ya pagada no admite más
      // pagos — revertir uno exige un flujo de devolución que no existe todavía.
      if (order.adminStatus === "pagada") throw new DomainError("ORDER_ALREADY_PAID", "La orden ya está pagada; no admite más pagos");
      const [expense] = await tx.expenses.listByReference(orderId);
      if (!expense) throw new DomainError("ORDER_EXPENSE_MISSING", "La orden no tiene un gasto asociado; no se puede registrar el pago");
      // RF-510: los anulados no cuentan (sumPaid) — anular un pago libera su saldo para el reemplazo.
      const paid = sumPaid(await tx.orderPayments.listByOrder(orderId));
      assertPaymentWithinOrder(expense.total, paid, input.amount);
      const payment: OrderPayment = { id: this.deps.ids.next(), orderId, date: input.date, amount: input.amount, method: input.method, externalReference: input.externalReference, note: input.note?.trim() || undefined, registeredBy: actor.id };
      await tx.orderPayments.save(payment);
      await this.audit("orden", orderId, "pago_registrado", actor, { paymentId: payment.id, amount: input.amount, method: input.method, date: input.date }, this.origin(context), tx.audit);
      return { payment, order: (await tx.orders.get(orderId)) ?? order };
    });
  }
  /**
   * RF-510 (adenda de pagos): anular ≠ borrar. El pago queda en el historial, tachado, con motivo/quién/
   * cuándo, y deja de contar para el saldo (`sumPaid`, trigger de la base, `Order.paidAmount`). Mismo
   * permiso que registrar. Si la orden ya había cerrado su eje administrativo como "pagada" con ese pago,
   * anularlo la DEVUELVE a "contabilizada" y borra la fecha de pago del gasto: es la única reversa
   * admitida de `assertAdminTransition` (pagada es terminal para cualquier otro gesto), porque una orden
   * con saldo abierto no puede seguir diciendo que está pagada — ese es justamente el error que se está
   * corrigiendo (E2E #6 del PRD: "anular el pago 2 con motivo → vuelve a parcial").
   */
  async annulOrderPayment(orderId: string, paymentId: string, reason: string, context: RequestContext): Promise<{ payment: OrderPayment; order: Order }> {
    const actor = this.actor(context); assertPermission(actor.roles, "payment:register", this.authOrigin(context));
    return this.transaction(`order:${orderId}`, async (tx) => {
      const order = await tx.orders.get(orderId); if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
      const payment = await tx.orderPayments.get(orderId, paymentId); if (!payment) throw new DomainError("NOT_FOUND", "Pago no encontrado");
      assertCanAnnulPayment(payment, reason);
      const annulled = await tx.orderPayments.annul(orderId, paymentId, { reason: reason.trim(), actorId: actor.id, at: this.now().toISOString() });
      if (!annulled) throw new DomainError("PAYMENT_ALREADY_ANNULLED", "El pago ya está anulado");
      await this.audit("orden", orderId, "pago_anulado", actor, { paymentId, amount: payment.amount, method: payment.method, date: payment.date, reason: reason.trim() }, this.origin(context), tx.audit);
      if (order.adminStatus === "pagada") {
        order.adminStatus = "contabilizada"; order.paidAt = undefined;
        await tx.expenses.markPaid(orderId, null);
        await tx.orders.save(order);
        await this.audit("orden", orderId, "estado_administrativo_actualizado", actor, { status: "contabilizada", reason: "pago_anulado", paymentId }, this.origin(context), tx.audit);
      }
      return { payment: annulled, order: (await tx.orders.get(orderId)) ?? order };
    });
  }
  /**
   * RF-708 (cierre de caja): "filtro medio de pago = caja + rango de fechas ES el cierre de caja"
   * (PRD §4.3). Devuelve los pagos VIGENTES con medio `efectivo` (la caja menor, A1) fechados en el rango,
   * con su orden resuelta, para la vista de cierre y su Excel. Permiso `expense:read` (revisor,
   * contabilidad, admin Mizar/Sixteam: los mismos que ven el gasto), sin visibilidad por fila — todos
   * esos roles son elevados en `listVisibleOrders`.
   */
  async listCashPayments(query: CashPaymentsQuery, context: RequestContext): Promise<CashPayment[]> {
    const actor = this.actor(context); assertPermission(actor.roles, "expense:read", this.authOrigin(context));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(query.from) || !/^\d{4}-\d{2}-\d{2}$/.test(query.to) || query.from > query.to) throw new DomainError("INVALID_INPUT", "El rango del cierre debe ser dos fechas YYYY-MM-DD, desde ≤ hasta");
    return this.deps.orderPayments.listCash({ from: query.from, to: query.to, costCenterId: query.costCenterId || undefined });
  }
  /** Visibilidad de UNA orden reutilizando `listOrders` (permiso order:read + visibilidad por fila ya
   *  resuelta ahí) en vez de duplicar el criterio isElevated/aprobador/solicitante — mismo patrón que
   *  ya usa app/api/orders/[id]/document/route.ts (`(await service.listOrders(...)).find(...)`). */
  private async getVisibleOrder(orderId: string, context: RequestContext): Promise<Order> {
    const order = (await this.listOrders(context)).find((candidate) => candidate.id === orderId);
    if (!order) throw new DomainError("NOT_FOUND", "Orden no encontrada");
    return order;
  }
  /** Reunión agosto 2026: historial de pagos de una orden, para el panel "Pagos" de su ficha. */
  async listOrderPayments(orderId: string, context: RequestContext): Promise<OrderPayment[]> {
    await this.getVisibleOrder(orderId, context);
    return this.deps.orderPayments.listByOrder(orderId);
  }
  async redistribute(expenseId: string, total: number, shares: ExpenseShare[], context: RequestContext): Promise<void> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); if (shares.some((share) => share.expenseId !== expenseId)) throw new DomainError("INVALID_SHARE", "Todas las líneas deben pertenecer al gasto"); await this.transaction(`expense:${expenseId}`, async (tx) => { const expense = await tx.expenses.get(expenseId); if (!expense) throw new DomainError("NOT_FOUND", "Gasto no encontrado"); if (expense.total !== total) throw new DomainError("EXPENSE_TOTAL_MISMATCH", "El total del reparto no coincide con el gasto"); validateShares(expense.total, shares); await tx.expenses.saveShares(shares); await this.audit("gasto", expenseId, "repartido", actor, { total: expense.total }, this.origin(context), tx.audit); }); }
  async registerPettyCash(input: PettyCashInput, context: RequestContext): Promise<{ entry: PettyCash; expense: Expense }> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:create", this.authOrigin(context));
    if (!input.workId || !input.concept.trim() || !input.tagId || !input.cashBoxId || !input.paymentMethod) throw new DomainError("INVALID_INPUT", "Campos de caja obligatorios");
    assertCop(input.amount, "Valor"); if (input.amount === 0) throw new DomainError("INVALID_MONEY", "El valor debe ser mayor a cero");
    assertCop(input.iva ?? 0, "IVA");
    const entry: PettyCash = { id: this.deps.ids.next(), ...input, registeredBy: actor.id };
    return this.transaction(undefined, async (tx) => {
      // La caja debe existir y estar activa — mismo criterio que `works`/`costCenters` en review().
      const cashBox = await tx.catalogs.get("cashBoxes", input.cashBoxId);
      if (!cashBox || !cashBox.active) throw new DomainError("INVALID_INPUT", "La caja indicada no existe o está inactiva");
      if (input.costCenterId) {
        const costCenter = await tx.catalogs.get("costCenters", input.costCenterId);
        if (!costCenter || !costCenter.active) throw new DomainError("INVALID_INPUT", "El centro de costo indicado no existe o está inactivo");
      }
      const expense = await tx.pettyCash.save(entry);
      await this.audit("caja_menor", entry.id, "registrada", actor, { expenseId: expense.id }, this.origin(context), tx.audit);
      await this.audit("gasto", expense.id, "registrado", actor, { origin: "caja_menor" }, this.origin(context), tx.audit);
      return { entry, expense };
    });
  }
  private assertCanReadRequisitions(context: RequestContext): Actor { const actor = this.actor(context); if (!["requisition:read", "requisition:read:own", "requisition:read:assigned"].some((permission) => hasPermission(actor.roles, permission, this.authOrigin(context)))) throw new DomainError("FORBIDDEN", "No puede consultar requisiciones"); return actor; }
  async listRequisitions(context: RequestContext): Promise<Requisition[]> { const actor = this.assertCanReadRequisitions(context); return this.deps.requisitions.listVisibleTo(actor) as Promise<Requisition[]>; }
  /**
   * H3: contraparte paginada de `listRequisitions` — `query` siempre viene informado (la ruta HTTP
   * decide cuándo llamar a esta vs. a `listRequisitions`, ver app/api/requisitions/route.ts), así que el
   * repositorio SIEMPRE devuelve `Page<Requisition>`; `isPage` lo confirma en tiempo de ejecución en vez
   * de forzarlo con un cast.
   */
  async listRequisitionsPage(query: ListQuery, context: RequestContext): Promise<Page<Requisition>> {
    const actor = this.assertCanReadRequisitions(context);
    const result = await this.deps.requisitions.listVisibleTo(actor, query);
    return isPage(result) ? result : { rows: result, nextCursor: null };
  }
  /**
   * H2 (docs/plan-rendimiento.md): antes esto era `listRequisitions(context).find(...)` — cargaba
   * TODAS las requisiciones visibles del actor (con sus ítems) solo para descartar todas menos una,
   * O(n) por cada consulta de detalle. Ahora es una única fila por id (`deps.requisitions.get`, que ya
   * trae los ítems — ver PostgresPorts.getRequisition en postgres-repositories.ts) más una
   * comprobación de visibilidad en memoria que replica EXACTAMENTE la regla de `listVisibleRequisitions`
   * del adaptador Postgres (isElevated + fallback aprobador/solicitante): si esa regla cambia allá,
   * debe cambiar aquí también. El gate de permiso (¿puede leer requisiciones EN ABSOLUTO?) se conserva
   * igual que antes, antes de tocar la base — un actor sin ningún `requisition:read*` sigue viendo
   * FORBIDDEN, no NOT_FOUND.
   */
  async getRequisition(id: string, context: RequestContext): Promise<Requisition> {
    const actor = this.actor(context);
    if (!["requisition:read", "requisition:read:own", "requisition:read:assigned"].some((permission) => hasPermission(actor.roles, permission, this.authOrigin(context)))) throw new DomainError("FORBIDDEN", "No puede consultar requisiciones");
    const requisition = await this.requisition(id);
    this.assertVisibleRequisition(actor, requisition);
    return requisition;
  }
  /** Mismo criterio que `isElevated` en lib/infrastructure/postgres-repositories.ts: elevados ven
   *  cualquier requisición; el aprobador solo la suya (aprobador_id); el solicitante solo la suya
   *  (solicitante_id). NOT_FOUND en vez de FORBIDDEN — igual que el `.find()` que reemplaza — para no
   *  revelar la existencia de una requisición ajena. */
  private assertVisibleRequisition(actor: Actor, requisition: Requisition): void {
    const elevated = actor.roles.some((role) => ["revisor", "contabilidad", "admin_mizar", "admin_sixteam"].includes(role));
    if (elevated) return;
    // El aprobador POR ÍTEM también la ve: si no, recibe el aviso de WhatsApp y la ficha le responde
    // "no encontrada" — que es como se ve desde fuera un permiso que se quedó corto.
    if (actor.roles.includes("aprobador")) { if (requisition.approverId === actor.id || requisition.items.some((line) => line.approverId === actor.id)) return; throw new DomainError("NOT_FOUND", "Requisición no encontrada"); }
    if (requisition.requesterId === actor.id) return;
    throw new DomainError("NOT_FOUND", "Requisición no encontrada");
  }
  async getRequisitionHistory(id: string, context: RequestContext): Promise<AuditEvent[]> { await this.getRequisition(id, context); return this.deps.audit.list("requisicion", id); }
  /**
   * H2: endpoint compuesto para el detalle (`GET /api/requisitions/:id/detail`) — antes el cliente
   * pedía la requisición, TODAS las órdenes y TODOS los gastos por separado (`orders.listByRequisition`
   * y `expenses.listByReference` ya existían sin usarse desde aquí) más el historial: 4+ peticiones y
   * viajes redundantes. `getRequisition` ya deja la visibilidad resuelta (NOT_FOUND si no aplica); orders/
   * expenses se devuelven vacíos (no FORBIDDEN) cuando el actor no tiene el permiso de lectura
   * correspondiente — mismo criterio de "degradar en vez de fallar" que ya usa el bootstrap de catálogos,
   * para que un solicitante viendo su propia requisición no tumbe el detalle completo por no poder leer
   * órdenes/gastos.
   */
  async getRequisitionDetail(id: string, context: RequestContext): Promise<{ requisition: Requisition; orders: Order[]; expenses: Expense[]; history: AuditEvent[] }> {
    const requisition = await this.getRequisition(id, context);
    const actor = this.actor(context), origin = this.authOrigin(context);
    const [orders, expenses, history] = await Promise.all([
      hasPermission(actor.roles, "order:read", origin) ? this.deps.orders.listByRequisition(id) : Promise.resolve([]),
      hasPermission(actor.roles, "expense:read", origin) ? this.deps.expenses.listByReference(id) : Promise.resolve([]),
      this.deps.audit.list("requisicion", id),
    ]);
    return { requisition, orders, expenses, history };
  }
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
  async listOrders(context: RequestContext): Promise<Order[]> { const actor = this.actor(context); assertPermission(actor.roles, "order:read", this.authOrigin(context)); return this.deps.orders.listVisibleTo(actor) as Promise<Order[]>; }
  /** H3: contraparte paginada de `listOrders` — mismo criterio que `listRequisitionsPage`. */
  async listOrdersPage(query: ListQuery, context: RequestContext): Promise<Page<Order>> {
    const actor = this.actor(context); assertPermission(actor.roles, "order:read", this.authOrigin(context));
    const result = await this.deps.orders.listVisibleTo(actor, query);
    return isPage(result) ? result : { rows: result, nextCursor: null };
  }
  async listExpenses(context: RequestContext): Promise<Expense[]> { const actor = this.actor(context); assertPermission(actor.roles, "expense:read", this.authOrigin(context)); return this.deps.expenses.listVisibleTo(actor) as Promise<Expense[]>; }
  /** H3: contraparte paginada de `listExpenses` — mismo criterio que `listRequisitionsPage`. */
  async listExpensesPage(query: ListQuery, context: RequestContext): Promise<Page<Expense>> {
    const actor = this.actor(context); assertPermission(actor.roles, "expense:read", this.authOrigin(context));
    const result = await this.deps.expenses.listVisibleTo(actor, query);
    return isPage(result) ? result : { rows: result, nextCursor: null };
  }
  /**
   * H2: respalda `GET /api/orders?requisitionId=` — `orders.listByRequisition` no aplica ninguna
   * visibilidad por sí solo (a diferencia de `listVisibleOrders`), así que la comprobación viene de
   * `getRequisition` (permiso + visibilidad por fila de la requisición dueña). `order:read` se exige
   * ANTES de tocar la requisición para que quien no puede leer órdenes en absoluto siga viendo
   * FORBIDDEN y no gaste una consulta.
   */
  async listOrdersByRequisition(requisitionId: string, context: RequestContext): Promise<Order[]> {
    const actor = this.actor(context);
    assertPermission(actor.roles, "order:read", this.authOrigin(context));
    await this.getRequisition(requisitionId, context);
    return this.deps.orders.listByRequisition(requisitionId);
  }
  /** H2: respalda `GET /api/expenses?referenceId=` — `referenceId` es el id de la requisición dueña
   *  (directa o vía una de sus órdenes, ver `listByReference` en postgres-repositories.ts); mismo
   *  criterio que listOrdersByRequisition. */
  async listExpensesByReference(referenceId: string, context: RequestContext): Promise<Expense[]> {
    const actor = this.actor(context);
    assertPermission(actor.roles, "expense:read", this.authOrigin(context));
    await this.getRequisition(referenceId, context);
    return this.deps.expenses.listByReference(referenceId);
  }
  async listPettyCash(context: RequestContext): Promise<PettyCash[]> { const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context)); return this.deps.pettyCash.list() as Promise<PettyCash[]>; }
  /** H3: contraparte paginada de `listPettyCash` — mismo criterio que `listRequisitionsPage`. La caja
   *  menor no tiene visibilidad por actor propia (ver PettyCashRepository en contracts.ts). */
  async listPettyCashPage(query: ListQuery, context: RequestContext): Promise<Page<PettyCash>> {
    const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:read", this.authOrigin(context));
    const result = await this.deps.pettyCash.list(query);
    return isPage(result) ? result : { rows: result, nextCursor: null };
  }
  /**
   * H3 (docs/plan-rendimiento.md, Fase 3): antes este método cargaba las TRES colecciones completas
   * (`listVisibleTo` sin límite, con ítems) y calculaba `calculateDashboard`/`groupExpenseBy*` en JS —
   * funciona con cientos de filas, se degrada linealmente con el histórico (meta: `/api/dashboard` <
   * 300 ms con 5 000 requisiciones). Ahora:
   *  1. `byStatus`/`pendingOrders`/`periodExpense`/`inProcessValue`/`expenseByWork`/`expenseByTag`/
   *     `expenseByPeriod` se agregan en SQL (dashboardByStatus/dashboardPendingCount/dashboardAggregates)
   *     con la MISMA visibilidad por actor que `listVisibleTo` — nunca se trae una fila de detalle solo
   *     para sumar o contar.
   *  2. `buildAttentionQueue`/`buildRecentActivity` (lib/domain/rules.ts, SIN cambiar) siguen recibiendo
   *     arreglos en memoria, pero acotados: la cola de atención solo pide requisiciones en los 4 estados
   *     que le interesan (sin ítems, `listVisibleHeaders`) y órdenes candidatas a alguna acción
   *     (`listAttentionCandidates`); la actividad reciente pide las 8 más recientes de cada colección
   *     (`listVisibleHeaders`/`listRecentlyUpdated`) en vez de ordenar/cortar un arreglo completo.
   *  3. `workByRequisition` (dentro de buildAttentionQueue/buildRecentActivity) resuelve `workId` de una
   *     orden buscando su requisición dueña en el arreglo de requisiciones que se le pasó — pero TODA
   *     orden nace de una requisición YA `aprobada` (estado terminal), que nunca cae dentro de los 4
   *     estados acotados de arriba ni, casi nunca, dentro del top-8 por `updated_at`. Sin corrección, el
   *     `workId` de cualquier orden en estas dos vistas quedaría vacío — una regresión real frente al
   *     comportamiento actual (que sí lo resuelve, porque hoy carga TODAS las requisiciones). El
   *     `orderWorkById` de abajo lo rellena desde la propia fila de la orden, que desde H3 ya trae su
   *     `workId` por el join a requisiciones (ver `order(row)` en postgres-repositories.ts) — sin volver
   *     a tocar rules.ts.
   * El resultado final tiene EXACTAMENTE la misma forma que antes (`DashboardMetrics`).
   */
  async dashboard(period: string, context: RequestContext): Promise<DashboardMetrics> {
    const actor = this.actor(context); assertPermission(actor.roles, "dashboard:read", this.authOrigin(context)); if (!/^\d{4}-\d{2}$/.test(period)) throw new DomainError("INVALID_INPUT", "Periodo inválido");
    const [byStatus, pendingOrders, expenseAggregates] = await Promise.all([
      this.deps.requisitions.dashboardByStatus(actor),
      this.deps.orders.dashboardPendingCount(actor),
      this.deps.expenses.dashboardAggregates(actor, period),
    ]);
    const metrics: DashboardMetrics = {
      byStatus, pendingOrders, periodExpense: expenseAggregates.periodExpense, inProcessValue: expenseAggregates.inProcessValue,
      expenseByWork: expenseAggregates.expenseByWork, expenseByTag: expenseAggregates.expenseByTag, expenseByPeriod: expenseAggregates.expenseByPeriod,
      // Centros de costo (UI, reunión 2026-09-12): mismo criterio que expenseByWork/expenseByTag de arriba.
      expenseByCostCenter: expenseAggregates.expenseByCostCenter,
    };
    const attentionStatuses: Requisition["status"][] = ["enviada", "en_revision", "en_aprobacion", "devuelta"];
    const [attentionRequisitions, attentionOrders, recentRequisitions, recentOrders, recentExpenses] = await Promise.all([
      this.deps.requisitions.listVisibleHeaders(actor, { status: attentionStatuses }),
      this.deps.orders.listAttentionCandidates(actor),
      this.deps.requisitions.listVisibleHeaders(actor, { orderBy: "updated_at", limit: 8 }),
      this.deps.orders.listRecentlyUpdated(actor, 8),
      this.deps.expenses.listRecentlyUpdated(actor, 8),
    ]);
    metrics.attentionQueue = buildAttentionQueue(attentionRequisitions, attentionOrders, actor);
    metrics.recentActivity = buildRecentActivity(recentRequisitions, recentOrders, recentExpenses);
    const orderWorkById = new Map<string, string | undefined>();
    for (const candidate of [...attentionOrders, ...recentOrders]) if (candidate.workId !== undefined) orderWorkById.set(candidate.id, candidate.workId);
    for (const queueItem of [...metrics.attentionQueue, ...metrics.recentActivity]) if (queueItem.kind === "orden" && !queueItem.workId) { const workId = orderWorkById.get(queueItem.id); if (workId) queueItem.workId = workId; }
    return metrics;
  }
  calculateQuotedValue(base: number, ivaRate: number) { return calculateTax(base, ivaRate); }
  lineTotal(line: ItemLine) { return calculateLineTotal(line); }
}
