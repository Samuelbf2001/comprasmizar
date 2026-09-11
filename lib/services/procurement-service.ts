import { DomainError, approvedLines, assertAdminTransition, assertCop, assertHasApprovedLine, assertPermission, assertTransition, buildAttentionQueue, combinedDeclineReason, itemApproverId, pendingApproverIds, buildRecentActivity, calculateTax, calculateLineAmounts, calculateLineTotal, colombiaDateParts, groupOrderItems, hasPermission, normalizeItemName, orderTypeFor, sumLines, validateShares, type Actor, type AuditEvent, type DashboardMetrics, type Expense, type ExpenseShare, type ItemLine, type ItemStatus, type Order, type OrderAdminStatus, type OrderStatus, type PettyCash, type Requisition, type RequisitionChannel, type RequisitionType } from "../domain";
import type { AuditRepository, CatalogSupplier, CatalogWork, RequestContext, ServiceDependencies, TransactionRepositories } from "./contracts";
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

export interface CreateRequisitionInput { type: RequisitionType; societyId?: string; workId?: string; requiredDate?: string; channel: RequisitionChannel; requesterId?: string; externalRequester?: { name: string; phone?: string }; observations?: string; items: ItemLine[]; publicCode?: string; publicLinkToken?: string; kapsoEventId?: string; }
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
export interface ReviewInput { tagId: string; approverId?: string | null; workId?: string; paymentTerms?: string; items: ItemLine[]; }
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
      await this.audit("requisicion", id, "revisada", actor, { tagId: input.tagId, approverId: requisition.approverId, workId: input.workId, paymentTerms: input.paymentTerms }, this.origin(context), tx.audit);
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
  async sendForApproval(id: string, context: RequestContext): Promise<Requisition> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); return this.transaction(`requisition:${id}`, async (tx) => { const requisition = await tx.requisitions.get(id); if (!requisition) throw new DomainError("NOT_FOUND", "Requisición no encontrada"); const vigentes = approvedLines(requisition.items), incompleteLines = vigentes.some((line) => calculateLineTotal(line) <= 0); if (!requisition.workId || !requisition.tagId || !requisition.approverId || !vigentes.length || incompleteLines) throw new DomainError("REVIEW_INCOMPLETE", "Obra, etiqueta y valor cotizado mayor a cero son obligatorios en cada ítem vigente"); await this.transition(requisition, "en_aprobacion", actor, "enviada_aprobacion", undefined, this.origin(context), tx.audit); await tx.requisitions.save(requisition);
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
        const expense: Expense = { id: this.deps.ids.next(), workId: requisition.workId, origin: "requisicion", referenceId: order.id, tagId: requisition.tagId, supplierId, orderDate, base, iva, total: sumLines(groupLines) };
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
        order.paidAt = this.now().toISOString();
        // Reunión 2026-09: "la fecha del gasto es la del pago" — al marcar la orden pagada, se fija
        // (misma transacción) la fecha de pago del gasto que esa orden generó, en hora Colombia
        // (colombiaDateParts, mismo criterio que generateOrders). saveExpense no sirve para esto: su
        // `on conflict do nothing` nunca actualiza un gasto ya guardado.
        const { day: paidDate } = colombiaDateParts(this.now());
        // GRAVE 3 (QA reasignación): 0 filas actualizadas significa que esta orden no tiene gasto propio
        // — un estado inconsistente (contabilizada/pagada son un eje independiente del cumplimiento, así
        // que nada más lo garantiza) que antes quedaba en "pagada" en silencio. Se falla explícito en vez
        // de dejarla pasar: una orden "pagada" sin gasto es peor que rechazar la transición.
        const paidRows = await tx.expenses.markPaid(order.id, paidDate);
        if (paidRows === 0) throw new DomainError("ORDER_EXPENSE_MISSING", "La orden no tiene un gasto asociado; no se puede marcar como pagada");
      }
      await tx.orders.save(order);
      await this.audit("orden", order.id, "estado_administrativo_actualizado", actor, { status }, this.origin(context), tx.audit);
      return order;
    });
  }
  async redistribute(expenseId: string, total: number, shares: ExpenseShare[], context: RequestContext): Promise<void> { const actor = this.actor(context); assertPermission(actor.roles, "requisition:review", this.authOrigin(context)); if (shares.some((share) => share.expenseId !== expenseId)) throw new DomainError("INVALID_SHARE", "Todas las líneas deben pertenecer al gasto"); await this.transaction(`expense:${expenseId}`, async (tx) => { const expense = await tx.expenses.get(expenseId); if (!expense) throw new DomainError("NOT_FOUND", "Gasto no encontrado"); if (expense.total !== total) throw new DomainError("EXPENSE_TOTAL_MISMATCH", "El total del reparto no coincide con el gasto"); validateShares(expense.total, shares); await tx.expenses.saveShares(shares); await this.audit("gasto", expenseId, "repartido", actor, { total: expense.total }, this.origin(context), tx.audit); }); }
  async registerPettyCash(input: PettyCashInput, context: RequestContext): Promise<{ entry: PettyCash; expense: Expense }> { const actor = this.actor(context); assertPermission(actor.roles, "petty_cash:create", this.authOrigin(context)); if (!input.workId || !input.concept.trim() || !input.tagId) throw new DomainError("INVALID_INPUT", "Campos de caja menor obligatorios"); assertCop(input.amount, "Valor"); if (input.amount === 0) throw new DomainError("INVALID_MONEY", "El valor debe ser mayor a cero"); const entry: PettyCash = { id: this.deps.ids.next(), ...input, registeredBy: actor.id }; return this.transaction(undefined, async (tx) => { const expense = await tx.pettyCash.save(entry); await this.audit("caja_menor", entry.id, "registrada", actor, { expenseId: expense.id }, this.origin(context), tx.audit); await this.audit("gasto", expense.id, "registrado", actor, { origin: "caja_menor" }, this.origin(context), tx.audit); return { entry, expense }; }); }
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
