/** Domain vocabulary. Monetary values are integer Colombian pesos (COP). */
export type Role = "solicitante" | "revisor" | "aprobador" | "contabilidad" | "admin_mizar" | "admin_sixteam";
export type RequisitionStatus = "enviada" | "en_revision" | "en_aprobacion" | "aprobada" | "devuelta" | "declinada";
export type RequisitionType = "compra" | "pago";
export type RequisitionChannel = "web" | "publico" | "whatsapp";
export type OrderType = "OC" | "OP";
export type OrderStatus = "generada" | "cumplida" | "no_cumplida" | "no_necesario";
/** Reunión 2026-08-31: decisión del aprobador por ítem. Ausente en una fila cargada de BD = 'pendiente' (default de columna). */
export type ItemStatus = "pendiente" | "aprobado" | "declinado";
/** Reunión 2026-08-31: eje administrativo/contable de una orden, independiente de OrderStatus (cumplimiento). */
export type OrderAdminStatus = "pendiente" | "contabilizada" | "pagada";
/** Reunión agosto 2026: "saber cuánto se ha pagado de cada orden" — medio con el que se hizo un pago parcial.
 *  `efectivo` ES la caja menor (adenda de pagos, A1): la UI lo rotula "Caja (efectivo)", el enum no cambia. */
export type PaymentMethod = "efectivo" | "transferencia" | "cheque" | "tarjeta" | "otro";
/** RF-508: estado de pago DERIVADO de Σ pagos vigentes vs total de la orden (`paymentStatus()` en rules.ts). Nunca se guarda. */
export type PaymentStatus = "pendiente" | "parcial" | "pagada";
/**
 * Reunión con el cliente (Ernesto, 11-sep-2026): «TODOS los gastos (cajas, bancos, personales) quedan
 * en el sistema por centro de costo». `cajas` (migración 202609120003) generaliza la caja menor de obra
 * a cualquier "dónde vive la plata": la caja menor original de una obra, la caja administrativa que
 * cierra Daniel a inicio de mes, una cuenta de banco o una caja personal.
 */
export type CashBoxType = "caja_menor" | "administrativa" | "banco" | "personal";
/** Reunión 2026-09-12: un cierre mensual es, por caja, "abierto" (movimientos editables) o "cerrado"
 *  (el trigger `validar_periodo_caja_abierto` rechaza altas/ediciones de ese mes para esa caja). */
export type CashCloseStatus = "abierto" | "cerrado";
/** RF-007 (adenda de pagos): el catálogo de centros de costo crece más allá de las obras — gastos administrativos, personales de socios, de la empresa (PROIM). */
export type CostCenterType = "obra" | "administrativo" | "personal" | "empresa";
export type Money = number;

/**
 * `permissions` es la lista EFECTIVA del actor (unión de sus roles con el override de
 * `configuracion.permisos_por_rol_v1` ya aplicado, ver `resolveActorPermissions`). La resuelve la
 * infraestructura al autenticar y la cuelga aquí para que el dominio siga siendo puro: `hasPermission`
 * la usa tal cual y nunca consulta la base. Ausente = "usa los defaults de lib/domain/rules.ts".
 */
export interface Actor { id: string; roles: readonly Role[]; permissions?: readonly string[]; }
export interface AuditEvent { entity: string; entityId: string; event: string; actorId?: string; at: Date; data?: Record<string, unknown>; origin?: "web" | "mcp" | "kapso"; }
export interface ItemLine {
  id: string; itemId?: string; description?: string; quantity: number; unit: string;
  /** Unit prices in COP. A line total is quantity × its corresponding unit price. */
  possibleSupplier?: string; productLink?: string; finalSupplierId?: string; unitBase?: Money; unitIva?: Money; unitTotal?: Money;
  /** Reunión 2026-08-31: decisión del aprobador por ítem; ausente = pendiente. Declinar exige declineReason. */
  status?: ItemStatus; declineReason?: string;
  /**
   * Quién decide ESTE ítem. Ernesto, 11-sep-2026: «así como se puede declinar por ítem, se puede
   * designar un aprobador para todo o aprobadores por ítems».
   *
   * AUSENTE = HEREDA el de la cabecera (`Requisition.approverId`), y esa herencia es lo que deja
   * intacto todo lo que ya está en vuelo: una requisición sin ningún aprobador por ítem se decide
   * exactamente como hasta hoy. Usa `itemApproverId()` para resolverlo; leer este campo a pelo se
   * salta la herencia y hace creer que el ítem no tiene aprobador.
   */
  approverId?: string;
  /** Fracción 0..1 (0.19, no 19). Ausente = línea legacy sin tasa capturada; ver calculateLineAmounts para el fallback. */
  ivaRate?: number; discountRate?: number;
}
export interface Requisition {
  id: string; consecutive: string; type: RequisitionType;
  /** Reunión 2026-08-31: el solicitante elige empresa, no obra; la obra (centro de costo) la asigna el revisor.
   *  Opcional: solo puede faltar en el canal público, cuyo enlace ya está anclado a una obra concreta y cuya
   *  sociedad deriva la base (trigger `requisiciones_0_derivar_sociedad`) — nunca se le pide al público. */
  societyId?: string; workId?: string; requesterId?: string;
  externalRequester?: { name: string; phone?: string }; channel: RequisitionChannel; requiredDate?: string;
  observations?: string; tagId?: string; approverId?: string;
  /**
   * DECISIÓN DEL DUEÑO (Ernesto, 2026-09-12): «obra y centro de costo están correlacionados, pero
   * varias obras pueden ir a un centro de costo; en la requisición debe salir predeterminado el centro
   * asociado a esa obra y poder cambiarse». Este es el valor EFECTIVO (editable) — nace heredado del
   * `costCenterId` de la obra (ver `resolveCostCenter` en lib/domain/rules.ts, la ÚNICA definición de
   * esa herencia) y el revisor puede cambiarlo en `review()`. `gastos.centro_costo_id` es una copia
   * congelada de este valor al momento de generarse, no una referencia viva: ver `Expense.costCenterId`.
   */
  costCenterId?: string; status: RequisitionStatus;
  /**
   * RF-009 (adenda de pagos): sociedad a cuyo nombre viene el soporte — lo que contabiliza el contador —
   * independiente del centro de costo (lo que ve Claudia). Default en dominio = sociedad del centro de
   * costo, si no la de la obra, si no la de la requisición (`resolveBilledCompany`, lib/domain/rules.ts);
   * el revisor puede cambiarla en `review()`. `gastos.empresa_facturada_id` es una copia congelada al
   * generar la orden, igual que `Expense.costCenterId`. En la base es NOT NULL (default por trigger).
   */
  billedCompanyId?: string;
  /** Forma de pago capturada en la revisión, persistida en `requisiciones.forma_pago` y copiada a cada
   *  orden generada (`ordenes.forma_pago`). Ver procurement-service.ts. */
  paymentTerms?: string;
  declineReason?: string; returnReason?: string; /** Trusted Kapso event ID only; DB enforces uniqueness. */ kapsoEventId?: string; items: ItemLine[];
  /** RF-1102: última modificación (ISO), poblada solo por el adaptador Postgres; ausente en objetos construidos en memoria. */
  updatedAt?: string;
  /** Reunión 2026-09-11 (Reportes, RF-1301): fecha de radicación (ISO), poblada solo por el adaptador
   *  Postgres (columna `created_at`, nunca escrita desde el dominio). El reporte de requisiciones la usa
   *  como columna "fecha" y como base del filtro de periodo/mes — la misma columna que `from`/`to` ya
   *  filtraban en `listVisibleRequisitions` sin necesidad de exponerla hasta ahora. */
  createdAt?: string;
  /** QA H5 (adenda de pagos): en un pago, el beneficiario sigue `pendiente_normalizacion` (llegó del
   *  portal o de WhatsApp solo con identificación y nombre). Proyección de lectura para la bandeja y el
   *  detalle: la pueblan la lista paginada del adaptador Postgres y la ruta del detalle; nunca se escribe. */
  beneficiaryPendingNormalization?: boolean;
}
export interface Order {
  id: string; consecutive: string; type: OrderType; requisitionId: string; supplierId?: string; itemIds: string[]; status: OrderStatus;
  /** Reunión 2026-08-31: eje administrativo/contable, independiente de `status` (cumplimiento). */
  adminStatus: OrderAdminStatus; generatedAt?: string; accountedAt?: string; paidAt?: string; paymentTerms?: string;
  /** RF-1102: ver Requisition.updatedAt. */ updatedAt?: string;
  /**
   * H3 (docs/plan-rendimiento.md): consecutivo y obra de la requisición dueña, resueltos por join en el
   * mismo SELECT del adaptador Postgres (ver `order(row)` en postgres-repositories.ts). Aditivos y
   * opcionales para no romper ningún consumidor existente: la pantalla de órdenes descargaba TODAS las
   * requisiciones solo para mostrar estos dos datos (H2); ahora viajan en la propia fila de la orden.
   * Ausentes cuando el llamador usa un camino que no hace ese join (p. ej. los fakes en memoria de los
   * tests, o cualquier lectura de orden que no pase por listVisibleOrders/listByRequisition/getOrder).
   */
  requisitionConsecutive?: string; workId?: string;
  /**
   * Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): la pantalla de órdenes necesita la
   * fecha REQUERIDA de la requisición de origen (para el filtro "Desde/Hasta" que ya existía) y sus
   * líneas CON PRECIO (para la columna "Valor" y el total de la ficha) sin volver a descargar TODAS las
   * requisiciones (la razón de ser de H2/H3). Ambas viajan por el mismo join que ya resuelve
   * `requisitionConsecutive`/`workId` arriba — ver `order(row)` en postgres-repositories.ts, que arma
   * `lines` con un `json_agg` de `requisicion_items` sobre las líneas de ESTA orden (vía `orden_items`).
   * Aditivos y opcionales por la misma razón que los dos campos de arriba: ausentes en los caminos que
   * no hacen ese join (fakes en memoria de los tests, o cualquier lectura que no pase por
   * listVisibleOrders/listByRequisition/getOrder/listOrders).
   * BLOQUEANTE 1 (QA 2026-08-31): `lines` transporta los mismos campos crudos que persiste
   * `requisicion_items` (valorBase/ivaRate/descuentoRate/cantidad…) — el total NUNCA se calcula en SQL;
   * lo sigue calculando `calculateLineTotal`/`sumLines` (lib/domain/rules.ts), la única fuente de verdad,
   * también usada por el PDF.
   */
  requiredDate?: string; lines?: ItemLine[];
  /**
   * Reunión agosto 2026: "cuánto se ha pagado de cada orden" con pagos parciales, SIN romper el
   * marcado de "pagada" que ya usan la pantalla de órdenes y updateOrderAdminStatus — por eso esto es
   * un campo ADITIVO y derivado (sum(valor) de `pagos_orden`, nunca escrito directamente en
   * `ordenes`), no una sustitución de `adminStatus`/`paidAt`. Resuelto en el mismo SELECT que ya trae
   * `requisitionConsecutive`/`lines` (ver `order(row)` en postgres-repositories.ts, un
   * `left join lateral` sobre `pagos_orden`, no una consulta por orden). Ausente en los mismos
   * caminos donde `requisitionConsecutive`/`lines` también lo están (fakes en memoria de los tests,
   * lecturas que no hacen ese join) — nunca `0` falso que insinúe "sin pagos" cuando en realidad es
   * "no se preguntó".
   */
  paidAmount?: Money;
  /**
   * Centros de costo (UI, reunión 2026-09-12): centro de costo EFECTIVO de la requisición dueña
   * (`Requisition.costCenterId`), resuelto por el mismo join que ya trae `requisitionConsecutive`/
   * `workId` (ver `orderSelectColumns()`/`order(row)` en postgres-repositories.ts) — la orden no tiene
   * centro de costo propio, hereda el de su requisición de origen. Ausente en los mismos caminos donde
   * `requisitionConsecutive`/`workId` también lo están (fakes en memoria de los tests, lecturas que no
   * hacen ese join).
   */
  costCenterId?: string;
  /**
   * RF-508/RF-509 (adenda de pagos, N1): estado de pago derivado, fecha del último pago vigente y medios
   * usados, resueltos en el MISMO `left join lateral` que `paidAmount` (solo pagos NO anulados). Ausentes
   * en los mismos caminos que `paidAmount`; `paymentStatus` además falta cuando la orden no tiene gasto
   * contra el que medir (p. ej. `no_necesario` con el gasto ya anulado).
   */
  paymentStatus?: PaymentStatus; lastPaymentAt?: string; paymentMethods?: PaymentMethod[];
  /** RF-009: empresa facturada de la requisición dueña, por el mismo join que `costCenterId` (misma ausencia en fakes). */
  billedCompanyId?: string;
}
/**
 * Un pago parcial de una orden. `date`/`amount`/`method` son obligatorios; `externalReference`
 * (referencia de la transferencia/consignación), `note` y `registeredBy` son opcionales — ver
 * `pagos_orden` (202609120002 y 202609150001) y `ProcurementService.registerOrderPayment`.
 * RF-510: un pago se ANULA, nunca se borra — `annulled` (ausente = vigente) con motivo/quién/cuándo; un
 * pago anulado no cuenta para el saldo (`sumPaid`) pero sigue en el historial. `attachmentId` es el
 * comprobante (adjunto con entidad `pago_orden`, el más reciente), resuelto en lectura: el comprobante se
 * sube DESPUÉS de registrar el pago, contra su id, por la misma ruta de adjuntos que caja_menor.
 */
export interface OrderPayment { id: string; orderId: string; date: string; amount: Money; method: PaymentMethod; externalReference?: string; note?: string; registeredBy?: string; annulled?: boolean; annulmentReason?: string; annulledBy?: string; annulledAt?: string; attachmentId?: string; }
/**
 * RF-708 (cierre de caja): un pago VIGENTE con medio `efectivo` en un rango de fechas, con los datos de
 * su orden resueltos por join para la vista de cierre (`ProcurementService.listCashPayments`).
 */
export interface CashPayment extends OrderPayment { orderConsecutive: string; orderType: OrderType; requisitionId: string; requisitionConsecutive: string; workId?: string; costCenterId?: string; billedCompanyId?: string; supplierId?: string; }
/**
 * Decisión del cliente (reunión 2026-09, literal): "que quede como fechas aparte cuándo se sube y
 * cuándo se paga; la del gasto es la del pago". `orderDate`: fecha en que nace el registro (generación
 * de la orden, o el movimiento de caja menor); nunca cambia. `date`/`period` (mes de `date`): fecha y
 * periodo del GASTO, es decir del PAGO — ausentes mientras la orden que lo originó no se ha pagado
 * (es un compromiso, todavía no un gasto). Para `origin: "caja_menor"` ambas fechas coinciden siempre
 * (se paga en el acto).
 */
/**
 * `costCenterId`: INSTANTÁNEA copiada al crear el gasto (generateOrders/registerPettyCash), NUNCA
 * derivada en lectura — si la requisición de origen cambia de centro después, el gasto ya generado no
 * debe moverse solo (decisión del dueño, 2026-09-12, ver Requisition.costCenterId más arriba).
 */
/**
 * `cashBoxId`/`paymentMethod`/`registeredBy` (migración 202609120003): copia de la fila de
 * `caja_menor` que generó el gasto, NULL en origen `requisicion` (una orden no tiene un único medio de
 * pago: se paga con `pagos_orden`, cada uno con el suyo). `concept` idem: copia de
 * `caja_menor.concepto`, para que la pantalla "Gastos y caja" muestre una descripción sin ir a buscar
 * la fila de caja menor aparte. `closeId`: a qué cierre mensual quedó atado, si el movimiento de caja
 * que lo originó ya se cerró.
 */
/** `billedCompanyId` (RF-009, 202609150003): INSTANTÁNEA de `Requisition.billedCompanyId` al generar la orden, misma regla que `costCenterId`. */
/**
 * `workId` (RF-008, 202609150004): un gasto bajo un centro de costo administrativo/personal/empresa no
 * tiene obra — en la base `gastos.obra_id` es NULL. Aquí viaja como `""` (no como `undefined`) porque el
 * reporte de gastos (`app/api/reports/expenses-report.ts`, fuera de la ola 1) lo consume como `string`;
 * pasar a `workId?: string` es el parche pendiente del coordinador. Nunca se persiste "": el adaptador
 * escribe NULL.
 */
export interface Expense { id: string; workId: string; origin: "requisicion" | "caja_menor"; referenceId: string; tagId?: string; supplierId?: string; orderDate: string; date?: string; base: Money; iva: Money; total: Money; period?: string; costCenterId?: string; billedCompanyId?: string; cashBoxId?: string; concept?: string; paymentMethod?: PaymentMethod; registeredBy?: string; closeId?: string; }
export interface ExpenseShare { expenseId: string; workId: string; amount: Money; }
/**
 * `cashBoxId`/`paymentMethod`/`iva` (migración 202609120003): la caja menor ya no es exclusiva de la
 * caja de obra clásica — generaliza a cualquier caja del catálogo `cajas` (`ProcurementService.
 * registerPettyCash` es también el camino del "gasto directo" de la pestaña Gastos y caja). `iva`:
 * hasta esa migración el gasto generado forzaba IVA=0; ahora un gasto directo de caja SÍ puede
 * llevarlo. `closeId`: igual que `Expense.closeId`, a qué cierre mensual quedó atado.
 */
export interface PettyCash { id: string; workId: string; date: string; concept: string; tagId: string; amount: Money; registeredBy: string; attachmentUrl?: string; cashBoxId?: string; paymentMethod?: PaymentMethod; iva?: Money; closeId?: string; costCenterId?: string; }
/**
 * Catálogo de cajas (migración 202609120003): dónde vive la plata. `costCenterId`: centro DEFAULT de
 * esta caja (mismo patrón que `CatalogWork.costCenterId`), únicamente informativo — ningún movimiento
 * lo hereda todavía (el centro efectivo de un movimiento de caja menor sigue viniendo de su obra).
 * `societyId` ausente = caja compartida entre empresas.
 */
export interface CashBox { id: string; name: string; type: CashBoxType; societyId?: string; costCenterId?: string; active: boolean; }
/**
 * Un ingreso de caja/banco/personal (migración 202609120003). Tabla APARTE de `Expense` a propósito:
 * nunca un gasto en negativo. `workId` es OPCIONAL (a diferencia de `PettyCash.workId`): un ingreso
 * puede no venir de ninguna obra concreta (p. ej. un anticipo de cliente todavía sin asignar).
 */
export interface Income { id: string; cashBoxId: string; costCenterId: string; workId?: string; date: string; concept: string; amount: Money; paymentMethod: PaymentMethod; thirdParty?: string; registeredBy: string; closeId?: string; period?: string; }
/**
 * Un cierre mensual de una caja (migración 202609120003, tabla `cierres_caja`). `CashService.
 * closeCashPeriod` es la única vía de escritura: calcula los totales, etiqueta los movimientos del
 * periodo con `id` MIENTRAS el cierre sigue "abierto" y solo al final marca `status: "cerrado"`.
 * Reabrir (`reopenCashPeriod`) es exclusivo de admin_sixteam.
 */
export interface CashClose { id: string; cashBoxId: string; period: string; status: CashCloseStatus; openingBalance: Money; totalIncome: Money; totalExpense: Money; closingBalance: Money; closedBy?: string; closedAt?: string; }
/** Una fila de la vista `movimientos_centro_costo` (migración 202609120003): el cruce ingresos(+)/
 *  gastos(-) por centro de costo que pide el reporte. `origin`: "ingreso", "gasto_requisicion" o
 *  "gasto_caja_menor". `amount` ya viene con el signo aplicado (negativo para gastos). */
export interface CostCenterMovement { costCenterId: string; period: string; origin: string; amount: Money; }
/** RF-1102: un elemento de la cola de "qué espera algo de mí" en el dashboard conectado. */
export interface DashboardQueueItem { kind: "requisicion" | "orden"; id: string; consecutive: string; workId?: string; status: string; action: string; }
/** RF-1102: un evento de la lista de actividad reciente del dashboard conectado. */
export interface DashboardActivityItem { kind: "requisicion" | "orden" | "gasto"; id: string; consecutive: string; workId?: string; status: string; at: string; }
/** RF-706/RF-1103: un punto agregado (obra, etiqueta o periodo) para los gráficos ejecutivos de gasto. */
export interface DashboardAmountByKey { key: string; total: Money; }
export interface DashboardMetrics {
  byStatus: Record<RequisitionStatus, number>; inProcessValue: Money; periodExpense: Money; pendingOrders: number;
  /** RF-1102/RF-706/RF-1103: agregados por el servicio después de calculateDashboard(); opcionales para no romper llamadas existentes. */
  attentionQueue?: DashboardQueueItem[]; recentActivity?: DashboardActivityItem[];
  expenseByWork?: DashboardAmountByKey[]; expenseByTag?: DashboardAmountByKey[]; expenseByPeriod?: DashboardAmountByKey[];
  /** Centros de costo (UI, reunión 2026-09-12): gasto agrupado por centro de costo, mismo criterio y
   *  mismo carácter opcional que `expenseByWork`/`expenseByTag` — ver `groupExpenseByCostCenter`
   *  (lib/domain/rules.ts) y `dashboardAggregates` (lib/infrastructure/postgres-repositories.ts). */
  expenseByCostCenter?: DashboardAmountByKey[];
}

/** Supplier records are deliberately separate from the generic catalogue shape: bank data must never leak through catalogue/bootstrap responses. */
export interface SupplierContact { name?: string; phone?: string; email?: string; address?: string; }
export interface SupplierBankDetails { bankName?: string; accountType?: "ahorros" | "corriente"; accountNumber?: string; accountHolder?: string; accountHolderNit?: string; }
/** RF-601 (adenda de pagos): NIT = empresa; CC/CE/PAS = persona natural (topógrafo, maestro de obra, un socio). */
export type SupplierIdentificationType = "NIT" | "CC" | "CE" | "PAS";
/**
 * RF-601/RF-606: `identificationType` + `identification` son la identidad del tercero (unicidad por
 * tipo + identificación normalizada, migración 202609150002); `nit` se conserva como espejo LEGADO de
 * `identification` cuando el tipo es NIT (NULL para personas) — lo mantiene un trigger, no el código.
 * `pendingNormalization`: creado al vuelo desde un canal externo con solo identificación + nombre; Daniel
 * completa la ficha. Los tres son opcionales en el tipo por los objetos legado en memoria (fakes de
 * test): desde Postgres siempre viajan (defaults NIT / false).
 */
export interface Supplier { id: string; name: string; nit?: string | null; identificationType?: SupplierIdentificationType; identification?: string | null; pendingNormalization?: boolean; contact: SupplierContact; bankDetails: SupplierBankDetails; active: boolean; }
/** RF-606: lo mínimo con lo que un canal externo (portal, WhatsApp) o el alta rápida identifican a un beneficiario. */
export interface BeneficiaryInput { identificationType: SupplierIdentificationType; identification: string; name: string; phone?: string; }
export type SupplierDocumentType = "rut" | "camara_comercio" | "certificacion_bancaria" | "certificado_calidad";
/** A document record only exists after its private Storage object passed server-side HEAD validation. */
export interface SupplierDocument { id: string; supplierId: string; type: SupplierDocumentType; name: string; mimeType: string; sizeBytes: number; uploadedBy?: string; uploadedAt: string; storagePath: string; }
export interface SupplierOrderHistory { id: string; consecutive: string; type: OrderType; status: OrderStatus; generatedAt: string; total: Money; }

/** A generic private support always belongs to one allowed parent; Storage keys remain internal. */
export type AttachmentEntity = "requisicion" | "requisicion_item" | "caja_menor" | "pago_orden";
export interface PrivateAttachment { id: string; entity: AttachmentEntity; entityId: string; type: string; name: string; mimeType: string; sizeBytes: number; uploadedBy?: string; uploadedAt: string; storagePath: string; }

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "DomainError"; }
}
