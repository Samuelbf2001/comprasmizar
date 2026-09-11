// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): módulo puro sin React ni
// recharts — tipos y helpers compartidos por las pantallas de components/screens/connected/*.
// Se extrajo tal cual de components/screens/connected.tsx (ahora un barrel de reexportación);
// misma lógica, mismos nombres. Se añade `export` donde antes no hacía falta (todo vivía en
// el mismo archivo) para que dashboard.tsx, new-requisition.tsx, requisitions.tsx, detail.tsx,
// orders.tsx, expenses.tsx, data.ts y screen.tsx puedan importarlo.
import type { Role } from "../../../lib/demo-data";
import { uploadSignedAttachment, type AttachmentMetadata } from "../attachment-upload";
import type { RouteKind } from "../skeletons";
import type { FriendlyError } from "../../../lib/http/friendly-error";

// RF-1105 (percepción de carga): mientras carga se distingue el esqueleto de ESA ruta
// (`kind`) de un error o de datos ya listos; en "ready" `revalidating` marca que hay
// datos previos visibles mientras se refresca en segundo plano (stale-while-revalidate).
export type LoadState =
  | { state: "loading"; kind: RouteKind }
  | { state: "error"; message: string; friendly?: FriendlyError }
  // `revalidationFailed`: había datos visibles y la recarga en segundo plano falló. Se siguen
  // mostrando —tapar un dashboard de dinero por un fallo de red pasajero sería peor— pero SE AVISA.
  // Antes ese fallo se tragaba en silencio y la pantalla quedaba con datos viejos y aspecto de
  // recién cargados: después de aprobar una requisición, el usuario veía el estado anterior sin que
  // nada le dijera que lo que estaba mirando podía no ser lo último.
  | { state: "ready"; data: unknown; revalidating: boolean; revalidationFailed?: boolean };
export type ConnectedProps = {
  pathname: string;
  role: Role;
  /**
   * Rol de la lente "Ver como" cuando está puesta, y `null` cuando se mira con el rol propio.
   *
   * `role` ya viene siendo el de la lente (mizar-app.tsx la resuelve antes de bajar la prop), así
   * que las pantallas no pueden distinguir "no puedes" de "este rol no puede". Sin ese matiz, un
   * Administrador Sixteam mirando Órdenes como Contabilidad lee "Tu rol no puede cambiar el estado
   * de entrega" y entiende que su cuenta está mal configurada, cuando solo está mirando prestado.
   */
  viewingAs?: Role | null;
  go: (path: string) => void;
};
export type NamedOption = { id: string; name: string };
// Reunión 2026-08-31: `works` trae `societyId` desde /api/catalogs (sociedad_id as "societyId") para que
// la revisión pueda filtrar obras por la empresa de la requisición.
export type CatalogData = {
  works: Array<NamedOption & { societyId?: string }>;
  // Reunión 2026-09: approverId por etiqueta es SOLO la sugerencia por defecto (prerellena el select de
  // aprobador al elegir etiqueta en la revisión); el aprobador real de la requisición ya no se deriva de
  // aquí — lo elige el revisor (ver `approvers`, abajo).
  tags: Array<NamedOption & { approverId?: string }>;
  suppliers: NamedOption[];
  items: Array<NamedOption & { unit: string; status: string }>;
  features: Record<string, boolean>;
  societies?: NamedOption[];
  approvers?: NamedOption[];
  access?: Record<string, boolean>;
  // HUECO 2 (QA reunión 2026-08-31): lista mínima id+nombre (GET /api/catalogs) para resolver el
  // solicitante interno y el actor de cada línea del historial, que solo traen el UUID — ver
  // resolveUserName más abajo. Nunca trae correo ni teléfono.
  users?: NamedOption[];
};
// HUECO 2: nunca se debe llegar a mostrar el UUID crudo; si el id no aparece en `catalogs.users`
// (usuario borrado del bootstrap, dato ausente, etc.) se conserva el fallback genérico ya existente.
export function resolveUserName(catalogs: CatalogData, id: string | undefined, fallback: string): string {
  if (!id) return "—";
  return catalogs.users?.find((user) => user.id === id)?.name ?? fallback;
}
// Reunión 2026-08-31: decisión por ítem (revisor y aprobador) e IVA/Desc como fracción (0.19, no 19);
// `unitIva` se conserva solo para leer filas legacy que aún no tienen `ivaRate`.
export type ItemStatus = "pendiente" | "aprobado" | "declinado";
export type RequisitionItem = {
  id: string;
  itemId?: string;
  description?: string;
  quantity: number;
  unit: string;
  possibleSupplier?: string;
  productLink?: string;
  finalSupplierId?: string;
  /** Aprobador de ESTE ítem. Ausente = lo decide el de la cabecera (misma herencia que el dominio). */
  approverId?: string;
  unitBase?: number;
  unitIva?: number;
  status?: ItemStatus;
  declineReason?: string;
  ivaRate?: number;
  discountRate?: number;
};
// Reunión 2026-08-31: el solicitante elige empresa, no obra (la asigna el revisor); `workId` y
// `requiredDate` quedan opcionales. El antiguo campo "frente o actividad" sale del modelo: se
// fusionó en `observations`.
export type RequisitionRow = {
  id: string;
  consecutive: string;
  type: "compra" | "pago";
  societyId?: string;
  workId?: string;
  requesterId?: string;
  externalRequester?: { name: string; phone?: string };
  channel: string;
  requiredDate?: string;
  observations?: string;
  tagId?: string;
  approverId?: string;
  paymentTerms?: string;
  status: string;
  returnReason?: string;
  declineReason?: string;
  items: RequisitionItem[];
  // GRAVE 1/BLOQUEANTE 2 (QA 2026-08-31): el servidor ya devuelve `updatedAt` en cada requisición
  // (Requisition.updatedAt en lib/domain/model.ts); solo faltaba declararlo aquí para usarlo como
  // proxy de antigüedad en la bandeja. No hay `createdAt` expuesto por la API.
  updatedAt?: string;
};
// Reunión 2026-08-31: eje administrativo/contable (pendiente → contabilizada → pagada), independiente
// del `status` de cumplimiento que ya existía.
export type OrderAdminStatus = "pendiente" | "contabilizada" | "pagada";
export type OrderRow = {
  id: string;
  consecutive: string;
  type: "OC" | "OP";
  requisitionId: string;
  supplierId?: string;
  status: string;
  adminStatus?: OrderAdminStatus;
  itemIds?: string[];
  // RF eje administrativo: las tres fechas del ciclo de vida contable de la orden (ISO datetime).
  generatedAt?: string;
  accountedAt?: string;
  paidAt?: string;
  // H2/H3 (docs/plan-rendimiento.md): join que ya trae el servidor en el mismo SELECT (ver
  // `order(row)` en lib/infrastructure/postgres-repositories.ts) — orders.tsx ya no necesita
  // descargar TODAS las requisiciones solo para resolver el consecutivo y la obra de cada orden.
  requisitionConsecutive?: string;
  workId?: string;
  // Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): mismo join que
  // requisitionConsecutive/workId, ahora sumando la fecha REQUERIDA de la requisición de origen y sus
  // líneas con precio — restauran la columna "Valor" y el filtro por fecha requerida de orders.tsx sin
  // volver a descargar TODAS las requisiciones ni pedir la requisición de origen bajo demanda al abrir
  // la ficha. `lines` usa el mismo tipo de línea que `RequisitionRow.items` (mismo shape que ItemLine en
  // el servidor); el total sigue calculándose con `calculateLineTotal`/`sumLines`
  // (lib/domain/rules.ts) — nunca aquí (BLOQUEANTE 1, QA 2026-08-31).
  requiredDate?: string;
  lines?: RequisitionItem[];
};
// Reunión 2026-09: "la fecha del gasto es la del pago" — orderDate (nace con el registro) siempre
// viaja; date/period (fecha y periodo de PAGO) faltan mientras la orden no se ha pagado.
export type ExpenseRow = {
  id: string;
  workId: string;
  origin: string;
  referenceId: string;
  tagId?: string;
  orderDate: string;
  date?: string;
  total: number;
  period?: string;
};
export type AttachmentRow = {
  id: string;
  entity: "requisicion" | "requisicion_item" | "caja_menor";
  entityId: string;
  type: "soporte" | "cotizacion" | "foto";
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt?: string;
};
export type PettyRow = {
  id: string;
  workId: string;
  date: string;
  concept: string;
  tagId: string;
  amount: number;
};
// RF-405: `actorId` ya viaja en el JSON de /api/requisitions/:id/history (AuditEvent.actorId
// en lib/domain/model.ts); faltaba en este tipo de cliente y por eso nunca se mostraba.
export type AuditRow = {
  event: string;
  at: string;
  actorId?: string;
  data?: Record<string, unknown>;
};
export type DetailBundle = {
  requisition: RequisitionRow;
  /** Quién está mirando. Lo pone el servidor desde la sesión: la pantalla necesita saber qué ítems
   *  decide esta persona, y preguntárselo al cliente sería dejar que se lo invente. */
  viewerId?: string;
  catalogs: CatalogData;
  orders: OrderRow[];
  expenses: ExpenseRow[];
  history: AuditRow[];
  attachments: AttachmentRow[];
};
export type ExpenseBundle = {
  expenses: ExpenseRow[];
  catalogs: CatalogData;
  pettyCash: PettyRow[];
  pettyAttachments: Record<string, AttachmentRow[]>;
};
// BLOQUEANTE 2: `orders` es opcional porque solo se pide cuando el rol puede leerlas (mismo
// permiso que ya usa /ordenes) — sin esto, una requisición `aprobada` sin órdenes generadas no
// tenía forma de saber si ya le tocaba "Listas para generar orden" en /revision.
// H3: `nextCursor` (paginación de servidor, `?limit=100`) — `null`/`undefined` cuando no hay más
// páginas. requisitions.tsx lo usa para mostrar (o no) el botón "Cargar más".
export type RequisitionsBundle = {
  rows: RequisitionRow[];
  catalogs: CatalogData;
  orders?: OrderRow[];
  nextCursor?: string | null;
};
// H2/H3: `requisitions` (el array completo de requisiciones, solo para resolver consecutivo/obra
// por fila) se quita del bundle — nada más lo usaba y `OrderRow.requisitionConsecutive`/`workId`
// ya cubren ese caso sin descargar toda la colección (ver data.ts, kind "orders").
export type OrdersBundle = {
  rows: OrderRow[];
  catalogs: CatalogData;
};
// RF-1102: elemento de la cola de "qué espera algo de mí"; producido por
// lib/domain/rules.ts#buildAttentionQueue y expuesto tal cual por /api/dashboard.
export type DashboardQueueItem = {
  kind: "requisicion" | "orden";
  id: string;
  consecutive: string;
  workId?: string;
  status: string;
  action: string;
};
// RF-1102: evento de la actividad reciente; ver lib/domain/rules.ts#buildRecentActivity.
export type DashboardActivityItem = {
  kind: "requisicion" | "orden" | "gasto";
  id: string;
  consecutive: string;
  workId: string;
  status: string;
  at: string;
};
// RF-706/RF-1103: punto agregado de gasto (por obra, etiqueta o periodo).
export type DashboardAmountByKey = { key: string; total: number };
export type DashboardMetricsPayload = {
  byStatus?: Record<string, number>;
  inProcessValue?: number;
  periodExpense?: number;
  pendingOrders?: number;
  attentionQueue?: DashboardQueueItem[];
  recentActivity?: DashboardActivityItem[];
  expenseByWork?: DashboardAmountByKey[];
  expenseByTag?: DashboardAmountByKey[];
  expenseByPeriod?: DashboardAmountByKey[];
};
export type DashboardBundle = { metrics: DashboardMetricsPayload; catalogs: CatalogData };

export const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
export const emptyCatalogs: CatalogData = {
  works: [],
  tags: [],
  suppliers: [],
  items: [],
  features: {},
};

// Etiquetas legibles de estado. Los valores internos (RequisitionStatus/OrderStatus en
// lib/domain/model.ts) viajan en snake_case; aquí solo se traducen para PRESENTACIÓN,
// alineadas con el lenguaje del demo ("En revisión", "En aprobación", …). No cambia el
// valor interno; si falta una clave, cae a un formato capitalizado legible.
const ESTADO_LABELS: Record<string, string> = {
  enviada: "Enviada",
  en_revision: "En revisión",
  en_aprobacion: "En aprobación",
  aprobada: "Aprobada",
  devuelta: "Devuelta",
  declinada: "Declinada",
  generada: "Generada",
  cumplida: "Cumplida",
  no_cumplida: "No cumplida",
  // GRAVE 2: "la orden" es femenino — el botón ya decía "No necesaria"; el badge decía
  // "No necesario". Se unifica al femenino en los dos.
  no_necesario: "No necesaria",
  // Reunión 2026-08-31: eje administrativo de la orden. Sin colisión con las claves de
  // arriba (cumplimiento) ni con el estado de requisición: se reutiliza el mismo mapa.
  pendiente: "Pendiente",
  contabilizada: "Contabilizada",
  pagada: "Pagada",
};
export function estadoLabel(status: string): string {
  const known = ESTADO_LABELS[status];
  if (known) return known;
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// Reunión 2026-08-31: réplica en cliente de calculateLineAmounts (lib/domain/rules.ts) solo para
// PREVIEW (el servidor recalcula y es la fuente de verdad). Compatible con líneas legacy sin ivaRate.
export function estimateLineAmounts(line: RequisitionItem): { base: number; iva: number; total: number } {
  const bruto = Math.round((line.quantity || 0) * (line.unitBase ?? 0));
  const descuento = Math.round(bruto * (line.discountRate ?? 0));
  const base = bruto - descuento;
  const iva = line.ivaRate !== undefined ? Math.round(base * line.ivaRate) : Math.round((line.quantity || 0) * (line.unitIva ?? 0));
  return { base, iva, total: base + iva };
}
export function estimateLineTotal(line: RequisitionItem): number {
  return estimateLineAmounts(line).total;
}
// MENOR (QA 2026-08-31): "Nelson y Juliana deciden sin ver la cifra total" — barra de
// Subtotal · IVA · Total al pie del bloque de ítems, en revisión y en aprobación.
// Los declinados quedan fuera del total: es la cifra que el aprobador autoriza y la que se va a
// comprar de verdad. Sumarlos inflaba el total con ítems que nadie va a pedir — el mismo criterio
// que `sumApprovedLines` aplica en el dominio para el gasto y las órdenes.
export function summarizeLines(lines: readonly RequisitionItem[]): { base: number; iva: number; total: number } {
  return lines.reduce(
    (acc, line) => {
      if (line.status === "declinado") return acc;
      const amounts = estimateLineAmounts(line);
      return { base: acc.base + amounts.base, iva: acc.iva + amounts.iva, total: acc.total + amounts.total };
    },
    { base: 0, iva: 0, total: 0 },
  );
}
// GRAVE 1/BLOQUEANTE 2: proxy de antigüedad para la bandeja. La API no expone `createdAt`
// (ver comentario en RequisitionRow.updatedAt); `updatedAt` es lo más cercano disponible y,
// para una fila que sigue en la misma etapa, coincide con "hace cuánto entró a esa etapa".
export function relativeAge(iso?: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "Hoy";
  if (days === 1) return "Ayer";
  if (days < 30) return `Hace ${days} días`;
  const months = Math.floor(days / 30);
  return `Hace ${months} mes${months === 1 ? "" : "es"}`;
}
// GRAVE 1: mismo espíritu que ESTADO_LABELS pero para el color del badge de estado de
// requisición en las bandejas (antes texto plano, sin distinción visual).
const REQUISITION_TONE: Record<string, string> = {
  enviada: "warning",
  en_revision: "warning",
  en_aprobacion: "blue",
  aprobada: "success",
  devuelta: "danger",
  declinada: "muted",
};
export function requisitionTone(status: string): string {
  return REQUISITION_TONE[status] ?? "muted";
}
// GRAVE 4 (QA 2026-08-31): antes se le hacía replace de "_" por espacio a `entry.event` tal cual, mostrando fragmentos crudos
// ("items decididos", "estado administrativo actualizado") sin acentos ni mayúsculas. Los valores
// de AuditEvent.event (lib/services/procurement-service.ts) viajan ya en snake_case en español;
// aquí solo se traducen para PRESENTACIÓN. Si aparece un evento nuevo sin mapear, el fallback
// capitalizado sigue siendo mejor que un guion bajo crudo en pantalla.
const EVENT_LABELS: Record<string, string> = {
  creada: "Requisición creada",
  entrada_revision: "Entró a revisión",
  retomada_revision: "Volvió a revisión",
  revisada: "Revisión guardada",
  enviada_aprobacion: "Enviada a aprobación",
  items_decididos: "Decisión por ítem",
  aprobada: "Requisición aprobada",
  devuelta: "Devuelta a revisión",
  declinada: "Requisición declinada",
  proveedores_asignados: "Proveedores asignados",
  generada: "Orden generada",
  registrado: "Gasto registrado",
  documento_descargado: "Documento descargado",
  estado_cumplimiento_actualizado: "Estado de entrega actualizado",
  estado_administrativo_actualizado: "Estado de contabilidad actualizado",
  cabecera_editada: "Cabecera editada",
};
export function eventLabel(event: string): string {
  const known = EVENT_LABELS[event];
  if (known) return known;
  const text = event.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// GRAVE 4: mismo motivo que EVENT_LABELS — Expense.origin (lib/domain/model.ts) es "requisicion" |
// "caja_menor"; se traduce para presentación en vez de mostrar el guion bajo crudo.
const ORIGIN_LABELS: Record<string, string> = {
  requisicion: "Requisición",
  caja_menor: "Caja menor",
};
export function originLabel(origin: string): string {
  const known = ORIGIN_LABELS[origin];
  if (known) return known;
  const text = origin.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Fecha de HOY en horario local (YYYY-MM-DD). toISOString() usa UTC y en Colombia
// (UTC-5) daría "mañana" entre las 7pm y la medianoche.
export function localTodayISO(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const SIN_ETIQUETA = "__sin_etiqueta__";
export type ExpenseWorkGroup = {
  workId: string;
  workName: string;
  subtotal: number;
  tags: Array<{ tagId: string; tagName: string; subtotal: number }>;
};
// RF-702: el Excel de Mizar solo trae un total general; aquí se agrega el subtotal por
// etiqueta (tipo de gasto) dentro de cada obra, que es justo lo que el cliente pidió ver.
// Se agrupa en cliente sobre las filas ya autorizadas por /api/expenses (mismo criterio
// que los demás filtros de esta pantalla: cabe en memoria y evita otra ruta de servicio).
export function groupExpensesByWorkAndTag(
  rows: ExpenseRow[],
  catalogs: CatalogData,
): ExpenseWorkGroup[] {
  // GRAVE 4: un id crudo nunca debe llegar a pantalla; si el catálogo no trae el nombre
  // (obra/etiqueta borrada o desincronizada), se muestra "—" en vez del UUID.
  const workName = (id: string) =>
    catalogs.works.find((work) => work.id === id)?.name ?? "—";
  const tagName = (id: string) =>
    id === SIN_ETIQUETA
      ? "Sin etiqueta"
      : (catalogs.tags.find((tag) => tag.id === id)?.name ?? id);
  const workOrder: string[] = [];
  const byWork = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!byWork.has(row.workId)) {
      byWork.set(row.workId, new Map());
      workOrder.push(row.workId);
    }
    const tagKey = row.tagId ?? SIN_ETIQUETA;
    const tagMap = byWork.get(row.workId) as Map<string, number>;
    tagMap.set(tagKey, (tagMap.get(tagKey) ?? 0) + Number(row.total || 0));
  }
  return workOrder
    .map((workId) => {
      const tagMap = byWork.get(workId) as Map<string, number>;
      const tags = Array.from(tagMap.entries())
        .map(([tagId, subtotal]) => ({ tagId, tagName: tagName(tagId), subtotal }))
        .sort((a, b) => a.tagName.localeCompare(b.tagName, "es"));
      return {
        workId,
        workName: workName(workId),
        subtotal: tags.reduce((sum, tag) => sum + tag.subtotal, 0),
        tags,
      };
    })
    .sort((a, b) => a.workName.localeCompare(b.workName, "es"));
}

// DD/MM/AAAA, el formato que usa Mizar. El sufijo T00:00:00 fuerza interpretacion
// local: sin el, "2026-08-26" se lee como medianoche UTC y en Colombia (GMT-5) se
// muestra el dia anterior.
const isoDate = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });
export function formatIsoDate(value: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : isoDate.format(date);
}

// Nota de la división (Fase 2, H4): `AttachmentProgress` y `uploadOperationalAttachment`
// vivían junto a ConnectedNewRequisition en connected.tsx, pero detail.tsx (cotización del
// comprador) y expenses.tsx (soportes de caja menor) también los llaman — se mueven aquí
// (el único módulo común a los tres) en vez de duplicarlos. Misma lógica.
export type AttachmentProgress = {
  completed: number;
  total: number;
  stage: "preparing" | "uploading" | "completing";
};

export async function uploadOperationalAttachment({
  entity,
  entityId,
  type,
  file,
  onProgress,
}: {
  entity: "requisicion" | "requisicion_item" | "caja_menor";
  entityId: string;
  type: "soporte" | "foto" | "cotizacion";
  file: File;
  onProgress?: (stage: AttachmentProgress["stage"]) => void;
}) {
  const metadata: AttachmentMetadata = {
    type,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  };
  return uploadSignedAttachment({
    prepareUrl: `/api/attachments/${entity}/${encodeURIComponent(entityId)}`,
    completeUrl: (attachmentId) =>
      `/api/attachments/${entity}/${encodeURIComponent(entityId)}/${encodeURIComponent(attachmentId)}/complete`,
    file,
    metadata,
    onProgress,
  });
}
