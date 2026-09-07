"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowRight,
  BarChart3,
  CheckCircle2,
  FileText,
  Inbox,
  Pencil,
  Plus,
  RefreshCw,
  SearchX,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Truck,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Role } from "../../lib/demo-data";
import { SectionTitle, Tone, useConfirmDialog } from "./screen-primitives";
import { ConnectedCatalogAdmin } from "./catalog-admin";
import {
  AttachmentPicker,
  IMAGE_MIME_TYPES,
  uploadSignedAttachment,
  type AttachmentMetadata,
} from "./attachment-upload";
import { RouteSkeleton, type RouteKind } from "./skeletons";
import { apiRequest, friendlyErrorText, isFriendlyApiError, type FriendlyError } from "../../lib/http/friendly-error";
// BLOQUEANTE 1 (QA 2026-08-31): la ficha de la orden sumaba precios UNITARIOS (ignorando
// cantidad, descuento y el campo legacy unitIva) y por eso mostraba una cifra distinta a la
// del PDF, que ya usaba estas mismas funciones. Se importan tal cual — son la fuente de verdad
// también en el servidor — en vez de reimplementar la aritmética en el cliente.
import { calculateLineTotal, sumLines } from "../../lib/domain/rules";

// RF-1105 (percepción de carga): mientras carga se distingue el esqueleto de ESA ruta
// (`kind`) de un error o de datos ya listos; en "ready" `revalidating` marca que hay
// datos previos visibles mientras se refresca en segundo plano (stale-while-revalidate).
type LoadState =
  | { state: "loading"; kind: RouteKind }
  | { state: "error"; message: string; friendly?: FriendlyError }
  | { state: "ready"; data: unknown; revalidating: boolean };
type ConnectedProps = {
  pathname: string;
  role: Role;
  go: (path: string) => void;
};
type NamedOption = { id: string; name: string };
// Reunión 2026-08-31: `works` trae `societyId` desde /api/catalogs (sociedad_id as "societyId") para que
// la revisión pueda filtrar obras por la empresa de la requisición.
type CatalogData = {
  works: Array<NamedOption & { societyId?: string }>;
  tags: NamedOption[];
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
function resolveUserName(catalogs: CatalogData, id: string | undefined, fallback: string): string {
  if (!id) return "—";
  return catalogs.users?.find((user) => user.id === id)?.name ?? fallback;
}
// Reunión 2026-08-31: decisión por ítem (revisor y aprobador) e IVA/Desc como fracción (0.19, no 19);
// `unitIva` se conserva solo para leer filas legacy que aún no tienen `ivaRate`.
type ItemStatus = "pendiente" | "aprobado" | "declinado";
type RequisitionItem = {
  id: string;
  itemId?: string;
  description?: string;
  quantity: number;
  unit: string;
  possibleSupplier?: string;
  productLink?: string;
  finalSupplierId?: string;
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
type RequisitionRow = {
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
type OrderAdminStatus = "pendiente" | "contabilizada" | "pagada";
type OrderRow = {
  id: string;
  consecutive: string;
  type: "OC" | "OP";
  requisitionId: string;
  supplierId?: string;
  status: string;
  adminStatus?: OrderAdminStatus;
  itemIds?: string[];
};
type ExpenseRow = {
  id: string;
  workId: string;
  origin: string;
  referenceId: string;
  tagId?: string;
  date: string;
  total: number;
  period: string;
};
type AttachmentRow = {
  id: string;
  entity: "requisicion" | "requisicion_item" | "caja_menor";
  entityId: string;
  type: "soporte" | "cotizacion" | "foto";
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt?: string;
};
type PettyRow = {
  id: string;
  workId: string;
  date: string;
  concept: string;
  tagId: string;
  amount: number;
};
// RF-405: `actorId` ya viaja en el JSON de /api/requisitions/:id/history (AuditEvent.actorId
// en lib/domain/model.ts); faltaba en este tipo de cliente y por eso nunca se mostraba.
type AuditRow = {
  event: string;
  at: string;
  actorId?: string;
  data?: Record<string, unknown>;
};
type DetailBundle = {
  requisition: RequisitionRow;
  catalogs: CatalogData;
  orders: OrderRow[];
  expenses: ExpenseRow[];
  history: AuditRow[];
  attachments: AttachmentRow[];
};
type ExpenseBundle = {
  expenses: ExpenseRow[];
  catalogs: CatalogData;
  pettyCash: PettyRow[];
  pettyAttachments: Record<string, AttachmentRow[]>;
};
// BLOQUEANTE 2: `orders` es opcional porque solo se pide cuando el rol puede leerlas (mismo
// permiso que ya usa /ordenes) — sin esto, una requisición `aprobada` sin órdenes generadas no
// tenía forma de saber si ya le tocaba "Listas para generar orden" en /revision.
type RequisitionsBundle = { rows: RequisitionRow[]; catalogs: CatalogData; orders?: OrderRow[] };
type OrdersBundle = {
  rows: OrderRow[];
  requisitions: RequisitionRow[];
  catalogs: CatalogData;
};
// RF-1102: elemento de la cola de "qué espera algo de mí"; producido por
// lib/domain/rules.ts#buildAttentionQueue y expuesto tal cual por /api/dashboard.
type DashboardQueueItem = {
  kind: "requisicion" | "orden";
  id: string;
  consecutive: string;
  workId?: string;
  status: string;
  action: string;
};
// RF-1102: evento de la actividad reciente; ver lib/domain/rules.ts#buildRecentActivity.
type DashboardActivityItem = {
  kind: "requisicion" | "orden" | "gasto";
  id: string;
  consecutive: string;
  workId: string;
  status: string;
  at: string;
};
// RF-706/RF-1103: punto agregado de gasto (por obra, etiqueta o periodo).
type DashboardAmountByKey = { key: string; total: number };
type DashboardMetricsPayload = {
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
type DashboardBundle = { metrics: DashboardMetricsPayload; catalogs: CatalogData };

const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const emptyCatalogs: CatalogData = {
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
function estadoLabel(status: string): string {
  const known = ESTADO_LABELS[status];
  if (known) return known;
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
// Reunión 2026-08-31: réplica en cliente de calculateLineAmounts (lib/domain/rules.ts) solo para
// PREVIEW (el servidor recalcula y es la fuente de verdad). Compatible con líneas legacy sin ivaRate.
function estimateLineAmounts(line: RequisitionItem): { base: number; iva: number; total: number } {
  const bruto = Math.round((line.quantity || 0) * (line.unitBase ?? 0));
  const descuento = Math.round(bruto * (line.discountRate ?? 0));
  const base = bruto - descuento;
  const iva = line.ivaRate !== undefined ? Math.round(base * line.ivaRate) : Math.round((line.quantity || 0) * (line.unitIva ?? 0));
  return { base, iva, total: base + iva };
}
function estimateLineTotal(line: RequisitionItem): number {
  return estimateLineAmounts(line).total;
}
// MENOR (QA 2026-08-31): "Nelson y Juliana deciden sin ver la cifra total" — barra de
// Subtotal · IVA · Total al pie del bloque de ítems, en revisión y en aprobación.
function summarizeLines(lines: readonly RequisitionItem[]): { base: number; iva: number; total: number } {
  return lines.reduce(
    (acc, line) => {
      const amounts = estimateLineAmounts(line);
      return { base: acc.base + amounts.base, iva: acc.iva + amounts.iva, total: acc.total + amounts.total };
    },
    { base: 0, iva: 0, total: 0 },
  );
}
// GRAVE 1/BLOQUEANTE 2: proxy de antigüedad para la bandeja. La API no expone `createdAt`
// (ver comentario en RequisitionRow.updatedAt); `updatedAt` es lo más cercano disponible y,
// para una fila que sigue en la misma etapa, coincide con "hace cuánto entró a esa etapa".
function relativeAge(iso?: string): string {
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
function requisitionTone(status: string): string {
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
function eventLabel(event: string): string {
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
function originLabel(origin: string): string {
  const known = ORIGIN_LABELS[origin];
  if (known) return known;
  const text = origin.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Fecha de HOY en horario local (YYYY-MM-DD). toISOString() usa UTC y en Colombia
// (UTC-5) daría "mañana" entre las 7pm y la medianoche.
function localTodayISO(): string {
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

function routeKind(pathname: string): RouteKind | undefined {
  if (pathname === "/" || pathname === "/inicio") return "dashboard";
  if (pathname === "/requisiciones/nueva") return "new";
  if (pathname.startsWith("/aprobaciones/") && pathname !== "/aprobaciones/")
    return "detail";
  if (pathname.startsWith("/requisiciones/") && !pathname.endsWith("/mis"))
    return "detail";
  if (
    pathname.startsWith("/revision") ||
    pathname.startsWith("/aprobaciones") ||
    pathname.startsWith("/requisiciones/mis")
  )
    return "requisitions";
  if (pathname.startsWith("/ordenes")) return "orders";
  if (pathname.startsWith("/gastos") || pathname.startsWith("/reportes"))
    return "expenses";
  if (pathname.startsWith("/catalogos") || pathname.startsWith("/proveedores"))
    return "catalogs";
}

async function readJson(url: string): Promise<unknown> {
  return apiRequest(url, { cache: "no-store" });
}

async function loadRoute(pathname: string, role: Role): Promise<unknown> {
  const kind = routeKind(pathname);
  if (kind === "dashboard") {
    // RF-1102/RF-706/RF-1103: se agrega /api/catalogs (ya accesible para cualquier rol autenticado,
    // ver GET en app/api/catalogs/route.ts) solo para resolver nombres de obra/etiqueta en la cola de
    // atención, la actividad reciente y los gráficos; /api/dashboard sigue siendo la única fuente de
    // autorización y cifras.
    const [metrics, catalogs] = await Promise.all([
      readJson(`/api/dashboard?period=${new Date().toISOString().slice(0, 7)}`),
      readJson("/api/catalogs"),
    ]);
    return {
      metrics: metrics as DashboardMetricsPayload,
      catalogs: catalogs as CatalogData,
    } satisfies DashboardBundle;
  }
  if (kind === "new") return readJson("/api/catalogs");
  if (kind === "detail") {
    const id = encodeURIComponent(pathname.split("/").pop() ?? "");
    const canReadOrders = [
      "Revisor",
      "Aprobador",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const canReadExpenses = [
      "Revisor",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const [requisition, catalogs, orders, expenses, history] =
      await Promise.all([
        readJson(`/api/requisitions/${id}`),
        readJson("/api/catalogs"),
        canReadOrders ? readJson("/api/orders") : Promise.resolve([]),
        canReadExpenses ? readJson("/api/expenses") : Promise.resolve([]),
        readJson(`/api/requisitions/${id}/history`),
      ]);
    const current = requisition as RequisitionRow,
      orderRows = orders as OrderRow[];
    const attachmentPayloads = await Promise.all([
      readJson(`/api/attachments/requisicion/${id}`),
      ...current.items.map((item) =>
        readJson(`/api/attachments/requisicion_item/${encodeURIComponent(item.id)}`),
      ),
    ]);
    const attachments = attachmentPayloads.flatMap((payload, index) => {
      const rows = payload as { attachments?: AttachmentRow[] };
      if (!Array.isArray(rows.attachments)) return [];
      const entity: AttachmentRow["entity"] =
        index === 0 ? "requisicion" : "requisicion_item";
      const entityId = index === 0 ? current.id : current.items[index - 1]?.id;
      return rows.attachments.map((attachment) => ({
        ...attachment,
        entity,
        entityId: entityId ?? "",
      }));
    });
    return {
      requisition: current,
      catalogs: catalogs as CatalogData,
      orders: orderRows.filter((row) => row.requisitionId === current.id),
      expenses: (expenses as ExpenseRow[]).filter(
        (row) =>
          row.referenceId === current.id ||
          orderRows.some(
            (order) =>
              order.requisitionId === current.id &&
              order.id === row.referenceId,
          ),
      ),
      history: history as AuditRow[],
      attachments,
    } satisfies DetailBundle;
  }
  if (kind === "requisitions") {
    // BLOQUEANTE 2: sin las órdenes no hay forma de distinguir, en /revision, una `aprobada`
    // que ya generó su(s) orden(es) de una que sigue esperando el paso "Generar órdenes" (que
    // vive en el detalle). Se pide con el mismo permiso que ya protege /ordenes (order:read);
    // para roles sin ese permiso (p. ej. solicitante en /requisiciones/mis) se omite en vez de
    // dejar que el 403 tumbe el Promise.all completo.
    const canReadOrders = [
      "Revisor",
      "Aprobador",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const [rows, catalogs, orders] = await Promise.all([
      readJson("/api/requisitions"),
      readJson("/api/catalogs"),
      canReadOrders ? readJson("/api/orders") : Promise.resolve([]),
    ]);
    return {
      rows: rows as RequisitionRow[],
      catalogs: catalogs as CatalogData,
      orders: orders as OrderRow[],
    } satisfies RequisitionsBundle;
  }
  if (kind === "orders") {
    const [rows, requisitions, catalogs] = await Promise.all([
      readJson("/api/orders"),
      readJson("/api/requisitions"),
      readJson("/api/catalogs"),
    ]);
    return {
      rows: rows as OrderRow[],
      requisitions: requisitions as RequisitionRow[],
      catalogs: catalogs as CatalogData,
    } satisfies OrdersBundle;
  }
  if (kind === "expenses") {
    const canReadPettyCash = [
      "Revisor",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const [expenses, catalogs, pettyCash] = await Promise.all([
      readJson("/api/expenses"),
      readJson("/api/catalogs"),
      canReadPettyCash ? readJson("/api/petty-cash") : Promise.resolve([]),
    ]);
    return {
      expenses: expenses as ExpenseRow[],
      catalogs: catalogs as CatalogData,
      pettyCash: pettyCash as PettyRow[],
      pettyAttachments: Object.fromEntries(
        await Promise.all(
          (pettyCash as PettyRow[]).map(async (row) => {
            const payload = (await readJson(
              `/api/attachments/caja_menor/${encodeURIComponent(row.id)}`,
            )) as { attachments?: AttachmentRow[] };
            return [
              row.id,
              Array.isArray(payload.attachments)
                ? payload.attachments.map((attachment) => ({
                    ...attachment,
                    entity: "caja_menor" as const,
                    entityId: row.id,
                  }))
                : [],
            ];
          }),
        ),
      ),
    } satisfies ExpenseBundle;
  }
  if (kind === "catalogs") return readJson("/api/catalogs/manage");
  throw new Error("Ruta operativa no soportada.");
}

// RF-1105 (percepción de carga): cache en memoria por ruta (pathname) para que volver a
// una pantalla ya visitada pinte contenido de inmediato mientras se revalida en segundo
// plano. Límite razonable de entradas (LRU simple) para no crecer sin control en una
// sesión larga. Vive a nivel de módulo (no de componente) para sobrevivir a la
// navegación entre rutas dentro de la misma sesión de la SPA.
const ROUTE_CACHE_LIMIT = 24;
const routeCache = new Map<string, { kind: RouteKind; data: unknown }>();

function getCachedRoute(pathname: string) {
  return routeCache.get(pathname);
}

function setCachedRoute(pathname: string, kind: RouteKind, data: unknown): void {
  routeCache.delete(pathname);
  routeCache.set(pathname, { kind, data });
  if (routeCache.size > ROUTE_CACHE_LIMIT) {
    const oldestKey = routeCache.keys().next().value;
    if (oldestKey !== undefined) routeCache.delete(oldestKey);
  }
}

// Se exporta para que las pruebas puedan partir de un estado limpio (el cache es un
// singleton de módulo) y porque `mutate` la usa aquí mismo: tras aprobar, declinar,
// crear una requisición, actualizar una orden, repartir un gasto o registrar caja menor,
// TODA la caché se limpia. Es dinero y estados de aprobación: más vale refrescar de más
// que arrastrar una cifra vieja a una bandeja o un dashboard ya visitados.
export function clearRouteCache(): void {
  routeCache.clear();
}

async function mutate(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): Promise<unknown> {
  const value = await apiRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  clearRouteCache();
  return value;
}

export function isConnectedReadRoute(pathname: string): boolean {
  return Boolean(routeKind(pathname));
}

// RF-1105: primera carga de `pathname` (sin datos en cache) -> esqueleto de esa ruta.
// Con datos en cache -> los muestra de inmediato y arranca revalidando en segundo plano
// (así "volver a una pantalla ya visitada" no vuelve a mostrar el esqueleto).
function initialLoadState(
  pathname: string,
  kind: RouteKind | undefined,
): LoadState {
  if (!kind) return { state: "loading", kind: "dashboard" };
  const cached = getCachedRoute(pathname);
  if (cached) return { state: "ready", data: cached.data, revalidating: true };
  return { state: "loading", kind };
}

export function ConnectedScreen({ pathname, role, go }: ConnectedProps) {
  const kind = useMemo(() => routeKind(pathname), [pathname]);
  const [version, setVersion] = useState(0);
  const [routeState, setRouteState] = useState(() => ({
    pathname,
    load: initialLoadState(pathname, kind),
  }));
  // Cambio de ruta: adopta de inmediato el cache (o el esqueleto) de la ruta nueva en
  // lugar de esperar al efecto de abajo. Sin esto habría un cuadro mostrando el
  // contenido de la ruta ANTERIOR bajo el `kind` de la ruta nueva. Es el patrón
  // documentado de React para "ajustar estado cuando cambia una prop".
  if (routeState.pathname !== pathname) {
    setRouteState({ pathname, load: initialLoadState(pathname, kind) });
  }
  const load =
    routeState.pathname === pathname
      ? routeState.load
      : initialLoadState(pathname, kind);
  const setLoad = (updater: LoadState | ((current: LoadState) => LoadState)) => {
    setRouteState((current) => ({
      pathname: current.pathname,
      load:
        typeof updater === "function"
          ? (updater as (value: LoadState) => LoadState)(current.load)
          : updater,
    }));
  };
  // RF-1105: refrescar (manual o tras aprobar/declinar/crear, ver `mutate`) NUNCA borra
  // datos ya visibles: si hay datos previos se marcan `revalidating` (stale-while-
  // revalidate); solo si no hay nada que mostrar cae al esqueleto de carga.
  const refresh = () => {
    setLoad((current) =>
      current.state === "ready"
        ? { ...current, revalidating: true }
        : kind
          ? { state: "loading", kind }
          : current,
    );
    setVersion((value) => value + 1);
  };
  useEffect(() => {
    if (!kind) return;
    let active = true;
    void loadRoute(pathname, role)
      .then((data) => {
        if (!active) return;
        setCachedRoute(pathname, kind, data);
        setLoad({ state: "ready", data, revalidating: false });
      })
      .catch((error) => {
        if (!active) return;
        setLoad((current) =>
          // Si ya había datos visibles (revalidación fallida), se conservan tal cual:
          // no se tapa un dashboard de dinero con un error por un fallo de red pasajero.
          current.state === "ready"
            ? { ...current, revalidating: false }
            : {
                state: "error",
                message: friendlyErrorText(error, "No fue posible consultar el servicio."),
                friendly: isFriendlyApiError(error) ? error.friendly : undefined,
              },
        );
      });
    return () => {
      active = false;
    };
  }, [pathname, role, version, kind]);
  if (!kind) return null;
  if (load.state === "loading")
    return <RouteSkeleton kind={load.kind} pathname={pathname} />;
  if (
    load.state === "error" &&
    kind === "catalogs" &&
    role === "Administrador Mizar"
  )
    return (
      <ConnectedCatalogAdmin
        pathname={pathname}
        role={role}
        initialData={emptyCatalogs}
      />
    );
  if (load.state === "error")
    return (
      <>
        <SectionTitle
          eyebrow="Sesión autenticada"
          title="Datos no disponibles"
          description={`Rol activo: ${role}`}
        />
        <div className="panel state-panel" role="alert">
          <span className="empty-icon"><TriangleAlert aria-hidden="true" size={21} /></span>
          <h3>{load.friendly?.title ?? "No pudimos cargar esta vista"}</h3>
          <p>{load.friendly?.message ?? load.message}</p>
          {load.friendly?.solution && (
            <p className="state-panel-hint">{load.friendly.solution}</p>
          )}
          <div className="button-row">
            <button
              className="button button-dark"
              type="button"
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" size={15} /> Reintentar
            </button>
            {load.friendly?.action?.kind === "link" && (
              <a className="button button-secondary" href={load.friendly.action.href}>
                {load.friendly.action.label}
              </a>
            )}
          </div>
        </div>
      </>
    );
  const revalidating = load.revalidating;
  return (
    <div
      aria-busy={revalidating}
      className={revalidating ? "is-revalidating" : undefined}
    >
      {revalidating && (
        <>
          <div className="revalidating-bar" aria-hidden="true" />
          <span className="sr-only" role="status">
            Actualizando información…
          </span>
        </>
      )}
      {kind === "dashboard" && (
        <ConnectedDashboard data={load.data} go={go} />
      )}
      {kind === "new" && (
        <ConnectedNewRequisition catalogs={load.data as CatalogData} go={go} />
      )}
      {kind === "detail" && (
        <ConnectedRequisitionDetail
          data={load.data as DetailBundle}
          role={role}
          go={go}
          refresh={refresh}
        />
      )}
      {kind === "requisitions" && (
        <ConnectedRequisitions
          data={load.data as RequisitionsBundle}
          pathname={pathname}
          go={go}
        />
      )}
      {kind === "orders" && (
        <ConnectedOrders
          data={load.data as OrdersBundle}
          role={role}
          refresh={refresh}
          go={go}
        />
      )}
      {kind === "catalogs" && (
        <ConnectedCatalogAdmin
          pathname={pathname}
          role={role}
          initialData={load.data as CatalogData}
        />
      )}
      {kind === "expenses" && (
        <ConnectedExpenses
          data={load.data as ExpenseBundle}
          pathname={pathname}
          role={role}
          refresh={refresh}
        />
      )}
    </div>
  );
}

const shortDate = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "short",
});
function formatShortDate(value: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : shortDate.format(date);
}
// DD/MM/AAAA, el formato que usa Mizar. El sufijo T00:00:00 fuerza interpretacion
// local: sin el, "2026-08-26" se lee como medianoche UTC y en Colombia (GMT-5) se
// muestra el dia anterior.
const isoDate = new Intl.DateTimeFormat("es-CO", { day: "2-digit", month: "2-digit", year: "numeric" });
function formatIsoDate(value: string): string {
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : isoDate.format(date);
}
function queueDestination(item: DashboardQueueItem): string {
  return item.kind === "requisicion" ? `/requisiciones/${item.id}` : "/ordenes";
}
function activityDestination(item: DashboardActivityItem): string {
  if (item.kind === "requisicion") return `/requisiciones/${item.id}`;
  return item.kind === "orden" ? "/ordenes" : "/gastos";
}
// RF-706/RF-1103: gráfico ejecutivo horizontal (recharts) con su tabla equivalente como alternativa
// textual accesible; `role="img"` + `aria-label` en el contenedor visual describe el mismo resumen
// para lectores de pantalla, y la tabla queda siempre visible con las cifras exactas.
function DashboardBarChart({
  title,
  emptyHint,
  rows,
}: {
  title: string;
  emptyHint: string;
  rows: Array<{ label: string; total: number }>;
}) {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">Gráfico ejecutivo</div>
          <h2>{title}</h2>
        </div>
        {rows.length > 0 && <Tone tone="muted">{money.format(total)}</Tone>}
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <BarChart3 aria-hidden="true" size={20} />
          </span>
          <h3>Sin datos</h3>
          <p>{emptyHint}</p>
        </div>
      ) : (
        <>
          <div
            className="chart-visual"
            role="img"
            aria-label={`${title}: ${rows.map((row) => `${row.label}, ${money.format(row.total)}`).join("; ")}`}
          >
            <ResponsiveContainer
              width="100%"
              height={Math.max(150, rows.length * 36)}
            >
              <BarChart
                data={rows}
                layout="vertical"
                margin={{ top: 4, right: 24, left: 4, bottom: 4 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={116}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
                <Bar dataKey="total" fill="var(--green)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="table-wrap chart-table">
            <table>
              <thead>
                <tr>
                  <th>Concepto</th>
                  <th className="align-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.label}>
                    <td>{row.label}</td>
                    <td className="align-right money">
                      {money.format(row.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
function DashboardPeriodChart({ rows }: { rows: DashboardAmountByKey[] }) {
  const points = rows.map((row) => ({ period: row.key, total: row.total }));
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div>
          <div className="eyebrow">Gráfico ejecutivo</div>
          <h2>Gasto por periodo</h2>
        </div>
      </div>
      {points.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">
            <BarChart3 aria-hidden="true" size={20} />
          </span>
          <h3>Sin datos</h3>
          <p>No hay gastos registrados en los últimos periodos.</p>
        </div>
      ) : (
        <>
          <div
            className="chart-visual"
            role="img"
            aria-label={`Gasto por periodo: ${points.map((point) => `${point.period}, ${money.format(point.total)}`).join("; ")}`}
          >
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={points}
                margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="var(--line)"
                />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis hide />
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
                <Bar dataKey="total" fill="var(--blue)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="table-wrap chart-table">
            <table>
              <thead>
                <tr>
                  <th>Periodo</th>
                  <th className="align-right">Total</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point) => (
                  <tr key={point.period}>
                    <td>{point.period}</td>
                    <td className="align-right money">
                      {money.format(point.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
export function ConnectedDashboard({
  data,
  go,
}: {
  data: unknown;
  go: (path: string) => void;
}) {
  const bundle = data as Partial<DashboardBundle>;
  const metrics = bundle.metrics ?? {};
  const catalogs = bundle.catalogs ?? emptyCatalogs;
  // GRAVE 4: nunca cae al id crudo — "—"/"Sin etiqueta" son honestos, un UUID no lo es.
  const workName = (id?: string) =>
    (id && catalogs.works.find((work) => work.id === id)?.name) || "—";
  const tagName = (key: string) =>
    key
      ? (catalogs.tags.find((tag) => tag.id === key)?.name ?? "—")
      : "Sin etiqueta";
  const queue = metrics.attentionQueue ?? [];
  const activity = metrics.recentActivity ?? [];
  const byWork = (metrics.expenseByWork ?? []).map((row) => ({
    label: workName(row.key),
    total: row.total,
  }));
  const byTag = (metrics.expenseByTag ?? []).map((row) => ({
    label: tagName(row.key),
    total: row.total,
  }));
  return (
    <>
      <SectionTitle
        eyebrow="Panel"
        title="Pulso de compras"
        description="Métricas de tu rol para el periodo actual."
      />
      <div className="stats-grid">
        <article className="stat-card stat-amber">
          <span className="stat-icon"><Inbox aria-hidden="true" size={17} /></span>
          <span className="stat-label">En revisión</span>
          <strong>{metrics.byStatus?.en_revision ?? 0}</strong>
          <span className="stat-meta">requisiciones visibles</span>
        </article>
        <article className="stat-card stat-blue">
          <span className="stat-icon"><CheckCircle2 aria-hidden="true" size={17} /></span>
          <span className="stat-label">En aprobación</span>
          <strong>{metrics.byStatus?.en_aprobacion ?? 0}</strong>
          <span className="stat-meta">{money.format(metrics.inProcessValue ?? 0)}</span>
        </article>
        <article className="stat-card stat-orange">
          <span className="stat-icon"><Truck aria-hidden="true" size={17} /></span>
          <span className="stat-label">Compras pendientes</span>
          <strong>{metrics.pendingOrders ?? 0}</strong>
          <span className="stat-meta">generadas o no cumplidas</span>
        </article>
        <article className="stat-card stat-forest">
          <span className="stat-icon"><BarChart3 aria-hidden="true" size={17} /></span>
          <span className="stat-label">Gasto del periodo</span>
          <strong>{money.format(metrics.periodExpense ?? 0)}</strong>
          <span className="stat-meta">según alcance del rol</span>
        </article>
      </div>
      <div className="dashboard-grid">
        {/* RF-1102: cola de "qué espera algo de mí", calculada en el servicio (buildAttentionQueue)
            sobre las mismas colecciones ya filtradas por rol; esta vista solo la renderiza. */}
        <section className="panel panel-alerts">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Atención requerida</div>
              <h2>Qué espera algo de ti</h2>
            </div>
            <Tone tone={queue.length ? "warning" : "muted"}>
              {queue.length} pendientes
            </Tone>
          </div>
          {queue.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Inbox aria-hidden="true" size={20} />
              </span>
              <h3>Sin pendientes</h3>
              <p>
                No hay requisiciones ni órdenes esperando una acción tuya en
                este momento.
              </p>
            </div>
          ) : (
            queue.map((item) => (
              <button
                key={`${item.kind}-${item.id}`}
                className="alert-item"
                type="button"
                onClick={() => go(queueDestination(item))}
              >
                <span className="alert-icon amber">
                  {item.kind === "orden" ? (
                    <Truck aria-hidden="true" size={16} />
                  ) : (
                    <Inbox aria-hidden="true" size={16} />
                  )}
                </span>
                <span>
                  <strong>
                    {item.consecutive} · {item.action}
                  </strong>
                  <small>
                    {workName(item.workId)} ·{" "}
                    {estadoLabel(item.status)}
                  </small>
                </span>
                <ArrowRight aria-hidden="true" size={15} />
              </button>
            ))
          )}
        </section>
        {/* RF-1102: actividad reciente (buildRecentActivity); combina requisiciones, órdenes y gastos
            visibles por el actor, ordenados por su marca de tiempo real más reciente. */}
        <section className="panel recent-panel">
          <div className="panel-head">
            <div>
              <div className="eyebrow">Actividad reciente</div>
              <h2>Últimos movimientos</h2>
            </div>
          </div>
          {activity.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <RefreshCw aria-hidden="true" size={20} />
              </span>
              <h3>Sin movimientos</h3>
              <p>Todavía no hay actividad reciente visible para tu rol.</p>
            </div>
          ) : (
            <ul className="activity-list">
              {activity.map((item) => (
                <li key={`${item.kind}-${item.id}`}>
                  <button
                    type="button"
                    onClick={() => go(activityDestination(item))}
                  >
                    <span>
                      <strong>{item.consecutive}</strong>
                      <small>
                        {workName(item.workId)} ·{" "}
                        {estadoLabel(item.status)}
                      </small>
                    </span>
                    <time dateTime={item.at}>{formatShortDate(item.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      {/* RF-706/RF-1103: gráficos ejecutivos de gasto por obra, por etiqueta y por periodo. */}
      <div className="chart-grid">
        <DashboardBarChart
          title="Gasto por obra"
          emptyHint="No hay gastos registrados en el periodo visible para tu rol."
          rows={byWork}
        />
        <DashboardBarChart
          title="Gasto por etiqueta"
          emptyHint="No hay gastos con etiqueta asignada en el periodo visible."
          rows={byTag}
        />
        <DashboardPeriodChart rows={metrics.expenseByPeriod ?? []} />
      </div>
      <div className="panel integration-evidence">
        <ShieldCheck aria-hidden="true" size={18} />
        <div>
          <b>Sin cifras de demostración</b>
          <p>
            Esta vista solo renderiza la respuesta autenticada de
            `/api/dashboard`.
          </p>
        </div>
      </div>
    </>
  );
}

type DraftLine = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  possibleSupplier: string;
  productLink: string;
  photo: File | null;
};
const newLine = (): DraftLine => ({
  key: crypto.randomUUID(),
  itemId: "",
  description: "",
  quantity: "1",
  unit: "unidad",
  possibleSupplier: "",
  productLink: "",
  photo: null,
});

type AttachmentProgress = {
  completed: number;
  total: number;
  stage: "preparing" | "uploading" | "completing";
};

async function uploadOperationalAttachment({
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

export function ConnectedNewRequisition({
  catalogs = emptyCatalogs,
  go,
}: {
  catalogs: CatalogData;
  go: (path: string) => void;
}) {
  // Reunión 2026-08-31: el solicitante elige EMPRESA, no obra (la asigna el revisor en la
  // revisión); la fecha requerida pasa a opcional (sin default de hoy ni validación de fecha
  // pasada) para no bloquear a quien no la conoce todavía.
  const [type, setType] = useState<"compra" | "pago">("compra"),
    [societyId, setSocietyId] = useState(catalogs.societies?.[0]?.id ?? ""),
    [requiredDate, setRequiredDate] = useState("");
  const [observations, setObservations] = useState(""),
    [supportFile, setSupportFile] = useState<File | null>(null),
    [lines, setLines] = useState<DraftLine[]>([newLine()]),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [uploadProgress, setUploadProgress] = useState<AttachmentProgress | null>(null),
    [success, setSuccess] = useState(""),
    [createdId, setCreatedId] = useState("");
  const updateLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (createdId) {
      setFeedback("La requisición ya fue creada; consulta el detalle para gestionar los soportes pendientes.");
      return;
    }
    const invalidLine = lines.find(
      (line) =>
        (!line.itemId && !line.description.trim()) ||
        !line.unit.trim() ||
        !Number.isFinite(Number(line.quantity)) ||
        Number(line.quantity) <= 0 ||
        (line.productLink.trim() &&
          !/^https:\/\//i.test(line.productLink.trim())),
    );
    if (!societyId || invalidLine) {
      setFeedback(
        !societyId
          ? "Selecciona la empresa."
          : "Completa cada ítem con descripción o catálogo, cantidad, unidad y un link HTTPS válido.",
      );
      return;
    }
    setBusy(true);
    setFeedback("");
    setSuccess("");
    let createdEntityId = "";
    try {
      const created = (await mutate("/api/requisitions", "POST", {
        type,
        societyId,
        ...(requiredDate ? { requiredDate } : {}),
        ...(observations.trim() ? { observations: observations.trim() } : {}),
        items: lines.map((line) => ({
          ...(line.itemId
            ? { itemId: line.itemId }
            : { description: line.description.trim() }),
          quantity: Number(line.quantity),
          unit: line.unit.trim(),
          ...(line.possibleSupplier.trim()
            ? { possibleSupplier: line.possibleSupplier.trim() }
            : {}),
          ...(line.productLink.trim()
            ? { productLink: line.productLink.trim() }
            : {}),
        })),
      })) as RequisitionRow;
      createdEntityId = created.id;
      setCreatedId(created.id);
      const uploads: Array<{
        entity: "requisicion" | "requisicion_item";
        entityId: string;
        type: "soporte" | "foto";
        file: File;
      }> = [];
      let pendingWithoutItemId = 0;
      if (supportFile) {
        uploads.push({
          entity: "requisicion",
          entityId: created.id,
          type: "soporte",
          file: supportFile,
        });
      }
      lines.forEach((line, index) => {
        const itemId = created.items?.[index]?.id;
        if (line.photo && itemId) {
          uploads.push({
            entity: "requisicion_item",
            entityId: itemId,
            type: "foto",
            file: line.photo,
          });
        } else if (line.photo) {
          pendingWithoutItemId += 1;
        }
      });
      if (!uploads.length) {
        if (pendingWithoutItemId) {
          setFeedback(
            `La requisición fue creada; ${pendingWithoutItemId} foto quedó pendiente porque el servicio no devolvió el ítem.`,
          );
          return;
        }
        setSuccess("Requisición creada correctamente.");
        go(`/requisiciones/${created.id}`);
        return;
      }
      setUploadProgress({ completed: 0, total: uploads.length, stage: "preparing" });
      for (const [index, upload] of uploads.entries()) {
        await uploadOperationalAttachment({
          ...upload,
          onProgress: (stage) =>
            setUploadProgress({ completed: index, total: uploads.length, stage }),
        });
        setUploadProgress({
          completed: index + 1,
          total: uploads.length,
          stage: "completing",
        });
      }
      if (pendingWithoutItemId) {
        setFeedback(
          `La requisición fue creada y ${uploads.length} soporte(s) cargaron; ${pendingWithoutItemId} foto(s) quedaron pendientes porque el servicio no devolvió el ítem.`,
        );
        return;
      }
      setSuccess(
        `Requisición creada y ${uploads.length === 1 ? "archivo cargado" : `${uploads.length} archivos cargados`} correctamente.`,
      );
    } catch (error) {
      setFeedback(
        createdEntityId
          ? `La requisición sí fue creada; el soporte quedó pendiente. ${
              error instanceof Error ? error.message : "No fue posible completar la carga."
            }`
          : error instanceof Error
            ? error.message
            : "No fue posible crear la requisición.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna"
        title="Nueva requisición"
        // MENOR (QA 2026-08-31): "pendientes de normalización" es vocabulario de base de
        // datos, no del cliente — se explica qué significa para quien lo lee.
        description="Los ítems que no estén en el catálogo quedan a la espera de que un administrador los agregue."
      />
      <form className="panel connected-form" onSubmit={submit} noValidate>
        <div className="form-section">
          <div className="field-grid">
            <label className="field">
              <span>Tipo</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as "compra" | "pago")
                }
              >
                <option value="compra">Compra</option>
                <option value="pago">Pago</option>
              </select>
            </label>
            <label className="field">
              <span>Empresa</span>
              {/* GRAVE 3: sin empresas registradas el <select> antes se veía con una sola
                  opción fantasma ("Selecciona una empresa") y el formulario parecía completo
                  aunque el botón "Crear requisición" nunca fuera a habilitarse. */}
              <select
                required
                value={societyId}
                disabled={!(catalogs.societies ?? []).length}
                aria-invalid={Boolean(feedback && !societyId)}
                aria-describedby={
                  (catalogs.societies ?? []).length ? "requisition-form-error" : "society-empty-reason"
                }
                onChange={(event) => setSocietyId(event.target.value)}
              >
                <option value="">
                  {(catalogs.societies ?? []).length ? "Selecciona una empresa" : "Sin empresas registradas"}
                </option>
                {(catalogs.societies ?? []).map((society) => (
                  <option key={society.id} value={society.id}>
                    {society.name}
                  </option>
                ))}
              </select>
              {!(catalogs.societies ?? []).length && (
                <small className="field-error" role="alert" id="society-empty-reason">
                  No hay empresas registradas todavía: pídele a un Administrador Mizar que cree
                  al menos una antes de poder crear la requisición.
                </small>
              )}
            </label>
            <label className="field">
              {/* RF reunión 2026-08-31: fecha opcional, sin default de hoy ni bloqueo por fecha pasada. */}
              <span>Fecha requerida (opcional)</span>
              <input
                type="date"
                value={requiredDate}
                onChange={(event) => setRequiredDate(event.target.value)}
              />
            </label>
            <label className="field field-wide">
              {/* RF reunión 2026-08-31: "Frente o actividad" se elimina y se fusiona aquí. */}
              <span>Observaciones <small>di a dónde va la compra</small></span>
              <textarea
                maxLength={3000}
                placeholder="Ej. Frente norte, bodega 3, torre B piso 4…"
                value={observations}
                onChange={(event) => setObservations(event.target.value)}
              />
            </label>
            <AttachmentPicker
              id="requisition-support"
              label="Soporte general (opcional)"
              help="PDF, JPG, PNG o WebP · máximo 10 MB"
              file={supportFile}
              onFile={setSupportFile}
              onError={setFeedback}
              disabled={busy}
            />
          </div>
        </div>
        <div className="form-section">
          <div className="panel-head connected-head">
            <div>
              <h2>Ítems</h2>
              <p className="panel-sub">
                Selecciona catálogo o describe una propuesta nueva.
              </p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setLines((current) => [...current, newLine()])}
            >
              <Plus aria-hidden="true" size={14} /> Agregar ítem
            </button>
          </div>
          <div className="connected-lines">
            {lines.map((line, index) => (
              <fieldset className="connected-line" key={line.key}>
                <legend>Ítem {index + 1}</legend>
                <label className="field">
                  <span>Catálogo</span>
                  <select
                    value={line.itemId}
                    onChange={(event) => {
                      const selected = catalogs.items.find(
                        (item) => item.id === event.target.value,
                      );
                      updateLine(line.key, {
                        itemId: event.target.value,
                        unit: selected?.unit ?? line.unit,
                        description: "",
                      });
                    }}
                  >
                    <option value="">Proponer nuevo</option>
                    {catalogs.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.status !== "activo" ? " · pendiente" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {!line.itemId && (
                  <label className="field">
                    <span>Descripción nueva</span>
                    <input
                      required
                      maxLength={500}
                      value={line.description}
                      aria-invalid={Boolean(
                        feedback && !line.description.trim(),
                      )}
                      aria-describedby="requisition-form-error"
                      onChange={(event) =>
                        updateLine(line.key, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span>Cantidad</span>
                  <input
                    required
                    type="number"
                    min="0.001"
                    max="1000000"
                    step="0.001"
                    value={line.quantity}
                    aria-invalid={Boolean(
                      feedback &&
                        (!Number.isFinite(Number(line.quantity)) ||
                          Number(line.quantity) <= 0),
                    )}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { quantity: event.target.value })
                    }
                  />
                </label>
                <AttachmentPicker
                  id={`requisition-item-photo-${line.key}`}
                  label="Foto del ítem (opcional)"
                  help="JPG, PNG o WebP · máximo 10 MB"
                  allowedMimeTypes={IMAGE_MIME_TYPES}
                  file={line.photo}
                  onFile={(photo) => updateLine(line.key, { photo })}
                  onError={setFeedback}
                  disabled={busy}
                />
                <label className="field">
                  <span>Unidad</span>
                  <input
                    required
                    maxLength={40}
                    value={line.unit}
                    aria-invalid={Boolean(feedback && !line.unit.trim())}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { unit: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Proveedor sugerido</span>
                  <input
                    maxLength={240}
                    value={line.possibleSupplier}
                    onChange={(event) =>
                      updateLine(line.key, {
                        possibleSupplier: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Link HTTPS</span>
                  <input
                    type="url"
                    pattern="https://.*"
                    title="Usa una URL HTTPS o deja el campo vacío."
                    placeholder="https://"
                    value={line.productLink}
                    aria-invalid={Boolean(
                      feedback &&
                        line.productLink.trim() &&
                        !/^https:\/\//i.test(line.productLink.trim()),
                    )}
                    aria-describedby="requisition-form-error"
                    onChange={(event) =>
                      updateLine(line.key, { productLink: event.target.value })
                    }
                  />
                </label>
                <button
                  className="icon-button connected-remove"
                  type="button"
                  aria-label={`Quitar ítem ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((current) =>
                      current.filter((item) => item.key !== line.key),
                    )
                  }
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </fieldset>
            ))}
          </div>
        </div>
        <div className="form-footer">
          {feedback ? (
            <p className="field-error" role="alert" id="requisition-form-error">
              {feedback}
            </p>
          ) : success ? (
            <p className="field-success" role="status">
              {success} {uploadProgress && `(${uploadProgress.completed}/${uploadProgress.total})`}
            </p>
          ) : uploadProgress && busy ? (
            <p className="muted-copy" role="status">
              {uploadProgress.stage === "preparing"
                ? "Preparando soporte…"
                : uploadProgress.stage === "uploading"
                  ? "Cargando soporte…"
                  : "Confirmando soporte…"}{" "}
              ({uploadProgress.completed}/{uploadProgress.total})
            </p>
          ) : !(catalogs.societies ?? []).length ? (
            // GRAVE 3: el solicitante veía un formulario completo y un botón que nunca
            // respondía; el remedio (crear una empresa) requiere rol Administrador Mizar, así
            // que el texto se lo dice en vez de dejarlo adivinar.
            <p className="field-error" role="alert">
              No hay empresas registradas: no es posible crear una requisición todavía. Pídele a
              un Administrador Mizar que registre al menos una empresa.
            </p>
          ) : (
            <span>Los valores cotizados se completan durante la revisión.</span>
          )}
          {createdId && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => go(`/requisiciones/${createdId}`)}
            >
              Ver requisición <ArrowRight aria-hidden="true" size={14} />
            </button>
          )}
          <button
            className="button button-dark"
            disabled={busy || Boolean(createdId) || !(catalogs.societies ?? []).length}
            type="submit"
          >
            {busy ? "Guardando…" : "Crear requisición"} <ArrowRight aria-hidden="true" size={14} />
          </button>
        </div>
      </form>
    </>
  );
}

export function DemoRequisitionScreen() {
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState("");
  const save = () =>
    setFeedback(
      supportFile || photoFile
        ? "Borrador demo guardado; los archivos cumplen la validación de carga."
        : "Borrador demo guardado.",
    );
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna"
        title="Nueva requisición"
        description="Adjunta un soporte general y una foto opcional por ítem. Esta pantalla demo no persiste datos."
      />
      <div className="panel connected-form">
        <div className="field-grid">
          <label className="field">
            <span>Obra</span>
            <select defaultValue="Torre Norte"><option>Torre Norte</option><option>Casa 18</option></select>
          </label>
          <label className="field">
            <span>Fecha requerida</span>
            <input type="date" defaultValue={localTodayISO()} />
          </label>
          <label className="field field-wide">
            <span>Observaciones</span>
            <textarea placeholder="Indica el frente o la necesidad…" />
          </label>
          <AttachmentPicker
            id="demo-requisition-support"
            label="Soporte general (opcional)"
            help="PDF, JPG, PNG o WebP · máximo 10 MB"
            file={supportFile}
            onFile={setSupportFile}
            onError={setFeedback}
          />
        </div>
        <fieldset className="connected-line">
          <legend>Ítem 1</legend>
          <label className="field"><span>Descripción</span><input defaultValue="Material de obra" /></label>
          <label className="field"><span>Cantidad</span><input type="number" min="1" defaultValue="1" /></label>
          <AttachmentPicker
            id="demo-requisition-item-photo"
            label="Foto del ítem (opcional)"
            help="JPG, PNG o WebP · máximo 10 MB"
            allowedMimeTypes={IMAGE_MIME_TYPES}
            file={photoFile}
            onFile={setPhotoFile}
            onError={setFeedback}
          />
        </fieldset>
        {feedback && <p className={feedback.includes("guardado") ? "field-success" : "field-error"} role={feedback.includes("guardado") ? "status" : "alert"}>{feedback}</p>}
        <div className="form-footer"><span className="muted-copy">Demo sin persistencia</span><button className="button button-dark" type="button" onClick={save}>Guardar borrador</button></div>
      </div>
    </>
  );
}

// GRAVE 1 (QA 2026-08-31): columnas mínimas para poder triar sin abrir cada fila — antes la
// bandeja no decía ni qué se pidió ni cuánto valía. Se reutiliza para la bandeja normal y para
// el grupo nuevo "Listas para generar orden" (BLOQUEANTE 2), que necesita el mismo criterio.
function RequisitionQueueRows({
  rows,
  catalogs,
  go,
  markActive,
}: {
  rows: RequisitionRow[];
  catalogs: CatalogData;
  go: (path: string) => void;
  markActive?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Requisición</th>
            <th>Solicitante</th>
            <th className="align-right">Nº de ítems</th>
            <th className="align-right">Valor estimado</th>
            <th>Antigüedad</th>
            <th>Estado</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const mainItem = row.items[0];
            const mainItemLabel = mainItem
              ? mainItem.description ||
                catalogs.items.find((option) => option.id === mainItem.itemId)?.name ||
                "Ítem sin descripción"
              : "Sin ítems capturados";
            const extraItems = row.items.length > 1 ? ` +${row.items.length - 1}` : "";
            // HUECO 2: el nombre ya viaja en catalogs.users (GET /api/catalogs); "Solicitante interno"
            // se conserva como fallback honesto cuando ese id no aparece en la lista.
            const requesterLabel = row.externalRequester?.name ?? resolveUserName(catalogs, row.requesterId, "Solicitante interno");
            // BLOQUEANTE 1: misma función canónica que la ficha y el PDF — nunca precios
            // unitarios sueltos. Antes de la revisión los ítems no traen precio: "Sin cotizar"
            // es más honesto que un "$ 0" que Daniel podría leer como el valor real.
            const total = sumLines(row.items);
            return (
              <tr key={row.id} data-testid={markActive ? "active-requisition" : "requisition-queue-row"}>
                <td>
                  <div className="request-id">
                    <button className="request-link" type="button" onClick={() => go(`/requisiciones/${row.id}`)}>
                      <b>{row.consecutive}</b>
                      <small>{mainItemLabel}{extraItems}</small>
                    </button>
                  </div>
                </td>
                <td>{requesterLabel}</td>
                <td className="align-right">{row.items.length}</td>
                <td className="align-right money">{total > 0 ? money.format(total) : "Sin cotizar"}</td>
                <td>{relativeAge(row.updatedAt)}</td>
                <td>
                  <Tone tone={requisitionTone(row.status)} dot>{estadoLabel(row.status)}</Tone>
                </td>
                <td>
                  <button className="icon-button" type="button" aria-label={`Abrir ${row.consecutive}`} onClick={() => go(`/requisiciones/${row.id}`)}>
                    <ArrowRight aria-hidden="true" size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ConnectedRequisitions({
  data,
  pathname,
  go,
}: {
  data: RequisitionsBundle;
  pathname: string;
  go: (path: string) => void;
}) {
  const catalogs = data?.catalogs ?? emptyCatalogs;
  const isRevision = pathname.startsWith("/revision");
  const allRows = Array.isArray(data?.rows) ? data.rows : [];
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  // BLOQUEANTE 2 (QA 2026-08-31): Daniel aprueba y la requisición desaparecía de toda bandeja —
  // "Generar órdenes" vive en el detalle de una `aprobada`, pero nada en /revision decía que
  // había una esperando ese paso. Se separan en un grupo propio y bien visible las `aprobada`
  // que TODAVÍA no generaron ninguna orden (mismo criterio que canGenerateOrders en
  // lib/domain/rules.ts, pero sin importar la función: aquí solo hace falta el conteo).
  const requisitionsWithOrders = new Set(orders.map((order) => order.requisitionId));
  const readyForOrderRows = isRevision
    ? allRows.filter((row) => row.status === "aprobada" && !requisitionsWithOrders.has(row.id))
    : [];
  const rows = allRows.filter((row) =>
    isRevision
      ? ["enviada", "en_revision", "devuelta"].includes(row.status)
      : pathname.startsWith("/aprobaciones")
        ? row.status === "en_aprobacion"
        : true,
  );
  const title = isRevision
    ? "Bandeja de revisión"
    : pathname.startsWith("/aprobaciones")
      ? "Mis aprobaciones"
      : "Mis requisiciones";
  // RF-302: los datos ya llegan autorizados desde /api/requisitions y /api/catalogs;
  // filtrar en cliente sobre ese payload evita otra ruta/servicio para algo que cabe
  // en memoria (una bandeja rara vez supera unos cientos de filas).
  const [workFilter, setWorkFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [channelFilter, setChannelFilter] = useState(""),
    [tagFilter, setTagFilter] = useState(""),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState("");
  const statusOptions = Array.from(
    new Set(rows.map((row) => row.status)),
  ).sort();
  const channelOptions = Array.from(
    new Set(rows.map((row) => row.channel)),
  ).sort();
  const filteredRows = rows.filter((row) => {
    if (workFilter && row.workId !== workFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    if (channelFilter && row.channel !== channelFilter) return false;
    if (tagFilter && row.tagId !== tagFilter) return false;
    if (dateFrom && !(row.requiredDate && row.requiredDate >= dateFrom))
      return false;
    if (dateTo && !(row.requiredDate && row.requiredDate <= dateTo))
      return false;
    return true;
  });
  const clearFilters = () => {
    setWorkFilter("");
    setStatusFilter("");
    setChannelFilter("");
    setTagFilter("");
    setDateFrom("");
    setDateTo("");
  };
  return (
    <>
      <SectionTitle
        eyebrow="Requisiciones"
        title={title}
        // MENOR (QA 2026-08-31): microcopy para Mizar, no para el equipo de desarrollo —
        // antes decía "La API aplica alcance por actor antes de devolver cada fila".
        description="Solo ves las requisiciones que corresponden a tu rol."
      />
      {rows.length > 0 && (
        <div className="filter-bar">
          <label className="field">
            <span>Obra</span>
            <select
              value={workFilter}
              onChange={(event) => setWorkFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {catalogs.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Estado</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {estadoLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Canal</span>
            <select
              value={channelFilter}
              onChange={(event) => setChannelFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {channelOptions.map((channel) => (
                <option key={channel} value={channel}>
                  {channel}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Etiqueta</span>
            <select
              value={tagFilter}
              onChange={(event) => setTagFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {catalogs.tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
        </div>
      )}
      {/* BLOQUEANTE 2 (QA 2026-08-31): antes, Daniel aprobaba y la requisición desaparecía de
          toda bandeja — "Generar órdenes" vive en el detalle, pero nada decía que había una
          esperando ese paso exacto que el cliente dijo que echaba en falta. Grupo propio,
          bien visible, con contador, encima de la bandeja normal. */}
      {isRevision && readyForOrderRows.length > 0 && (
        <section className="panel connected-ready-panel" data-testid="ready-for-order-panel">
          <div className="panel-head">
            <div>
              <h2>Listas para generar orden</h2>
              <p className="panel-sub">
                Aprobadas sin ninguna orden generada todavía — el siguiente paso está en su detalle.
              </p>
            </div>
            <Tone tone="success" dot>{readyForOrderRows.length} lista{readyForOrderRows.length === 1 ? "" : "s"}</Tone>
          </div>
          <RequisitionQueueRows rows={readyForOrderRows} catalogs={catalogs} go={go} />
        </section>
      )}
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{filteredRows.length} visibles</h2>
            <p className="panel-sub">Toca una fila para abrir el detalle.</p>
          </div>
          <Tone tone="muted">Orden cronológico</Tone>
        </div>
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
            <h3>Sin requisiciones en esta vista</h3>
            <p>No hay requisiciones que correspondan a tu rol en esta bandeja.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
            <h3>Sin resultados para estos filtros</h3>
            <p>Ajusta o limpia los filtros para ver más requisiciones.</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={clearFilters}
            >
              Limpiar filtros
            </button>
          </div>
        ) : (
          <RequisitionQueueRows rows={filteredRows} catalogs={catalogs} go={go} markActive={isRevision} />
        )}
      </section>
    </>
  );
}

export function ConnectedRequisitionDetail({
  data,
  role,
  go,
  refresh,
}: {
  data: DetailBundle;
  role: Role;
  go: (path: string) => void;
  refresh: () => void;
}) {
  const {
    requisition,
    catalogs = emptyCatalogs,
    orders = [],
    expenses = [],
    history = [],
    attachments = [],
  } = data;
  const [tagId, setTagId] = useState(requisition.tagId ?? ""),
    // Reunión 2026-08-31: la obra la asigna el revisor (filtrada por la empresa de la
    // requisición) y la forma de pago se captura aquí también.
    [workId, setWorkId] = useState(requisition.workId ?? ""),
    [paymentTerms, setPaymentTerms] = useState(requisition.paymentTerms ?? "ANTICIPADO"),
    [editingHeader, setEditingHeader] = useState(false),
    [headerForm, setHeaderForm] = useState({ requiredDate: requisition.requiredDate ?? "", observations: requisition.observations ?? "" }),
    [headerBusy, setHeaderBusy] = useState(false),
    [headerFeedback, setHeaderFeedback] = useState(""),
    [lines, setLines] = useState<RequisitionItem[]>(requisition?.items ?? []),
    [supplierOptions, setSupplierOptions] = useState<NamedOption[]>(
      catalogs.suppliers,
    ),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [supplierStatus, setSupplierStatus] = useState(""),
    [quickSupplierItemId, setQuickSupplierItemId] = useState<string | null>(
      null,
    ),
    [quickSupplierName, setQuickSupplierName] = useState(""),
    [quickSupplierNit, setQuickSupplierNit] = useState(""),
    [quickSupplierError, setQuickSupplierError] = useState(""),
    [quickSupplierBusy, setQuickSupplierBusy] = useState(false),
    // Cotización del comprador: adjunto propio, distinto del soporte del solicitante.
    [quoteFile, setQuoteFile] = useState<File | null>(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteFeedback, setQuoteFeedback] = useState(""),
    // Bloqueante de atasco (reunión 2026-08-31): selección local de proveedor por ítem, para el bloque
    // "Generar órdenes" — vive aparte de `lines` (el borrador editable de la revisión) porque este
    // bloque solo existe cuando la requisición ya está `aprobada` y `lines` deja de ser relevante.
    [assignSupplierChoice, setAssignSupplierChoice] = useState<Record<string, string>>({});
  const quickSupplierNameRef = useRef<HTMLInputElement | null>(null),
    quickSupplierDialogRef = useRef<HTMLFormElement | null>(null),
    quickSupplierTriggerRef = useRef<HTMLButtonElement | null>(null),
    quickSupplierWasOpen = useRef(false),
    quickSupplierSubmitting = useRef(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setFeedback("");
    try {
      await mutate(`/api/requisitions/${requisition.id}/actions`, "POST", body);
      // RF-1105: sin esto, tras aprobar/declinar/devolver esta misma pantalla seguía
      // mostrando el estado anterior de la requisición hasta que el usuario navegara
      // fuera y volviera. `refresh` ya no vacía la vista (stale-while-revalidate): sigue
      // mostrando lo que había mientras trae el estado real.
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "Acción no completada.",
      );
    } finally {
      setBusy(false);
    }
  };
  const updateLine = (id: string, patch: Partial<RequisitionItem>) =>
    setLines((current) =>
      current.map((line) => (line.id === id ? { ...line, ...patch } : line)),
    );
  // Cotización del comprador: sube directo (la requisición ya existe) y refresca para que
  // aparezca en "Cotizaciones del comprador", separada de los adjuntos del solicitante.
  const uploadQuote = async () => {
    if (!quoteFile) return;
    setQuoteBusy(true);
    setQuoteFeedback("");
    try {
      await uploadOperationalAttachment({
        entity: "requisicion",
        entityId: requisition.id,
        type: "cotizacion",
        file: quoteFile,
      });
      setQuoteFile(null);
      refresh();
    } catch (error) {
      setQuoteFeedback(error instanceof Error ? error.message : "No fue posible cargar la cotización.");
    } finally {
      setQuoteBusy(false);
    }
  };
  const closeQuickSupplier = () => {
    const trigger = quickSupplierTriggerRef.current;
    setQuickSupplierItemId(null);
    setQuickSupplierName("");
    setQuickSupplierNit("");
    setQuickSupplierError("");
    queueMicrotask(() => trigger?.focus());
  };
  useEffect(() => {
    if (!quickSupplierItemId) {
      if (quickSupplierWasOpen.current) {
        quickSupplierWasOpen.current = false;
        quickSupplierTriggerRef.current?.focus();
      }
      return;
    }
    quickSupplierWasOpen.current = true;
    quickSupplierNameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !quickSupplierBusy) closeQuickSupplier();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [quickSupplierBusy, quickSupplierItemId]);
  const trapQuickSupplierFocus = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const dialog = event.currentTarget;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  if (!requisition?.id)
    return (
      <div className="panel state-panel" role="alert">
        Requisición no disponible.
      </div>
    );
  const openQuickSupplier = (
    itemId: string,
    trigger: HTMLButtonElement,
  ) => {
    quickSupplierTriggerRef.current = trigger;
    setSupplierStatus("");
    setQuickSupplierError("");
    setQuickSupplierName("");
    setQuickSupplierNit("");
    setQuickSupplierItemId(itemId);
  };
  const createQuickSupplier = async (event: FormEvent) => {
    event.preventDefault();
    if (quickSupplierSubmitting.current) return;
    const name = quickSupplierName.trim();
    if (!name) {
      setQuickSupplierError("Escribe la razón social del proveedor.");
      return;
    }
    quickSupplierSubmitting.current = true;
    setQuickSupplierBusy(true);
    setQuickSupplierError("");
    try {
      const created = (await mutate("/api/suppliers", "POST", {
        name,
        ...(quickSupplierNit.trim()
          ? { nit: quickSupplierNit.trim() }
          : {}),
      })) as { id?: string; name?: string };
      if (!created.id || !created.name) {
        throw new Error("El servicio no devolvió el proveedor creado.");
      }
      setSupplierOptions((current) =>
        current.some((supplier) => supplier.id === created.id)
          ? current
          : [...current, { id: created.id as string, name: created.name as string }],
      );
      if (quickSupplierItemId) {
        updateLine(quickSupplierItemId, { finalSupplierId: created.id });
      }
      setSupplierStatus(`${created.name} quedó asignado al ítem.`);
      closeQuickSupplier();
    } catch (error) {
      setQuickSupplierError(
        error instanceof Error
          ? error.message
          : "No fue posible crear el proveedor.",
      );
    } finally {
      quickSupplierSubmitting.current = false;
      setQuickSupplierBusy(false);
    }
  };
  const isReviewer = role === "Revisor" || role === "Administrador Sixteam",
    isApprover = role === "Aprobador" || role === "Administrador Sixteam";
  // RF: cabecera editable. Solo el revisor/admin y solo mientras la requisición aún admite cambios.
  const headerEditable = isReviewer && ["enviada", "en_revision", "devuelta"].includes(requisition.status);
  const saveHeader = async () => {
    setHeaderBusy(true);
    setHeaderFeedback("");
    try {
      await mutate(`/api/requisitions/${requisition.id}`, "PATCH", {
        requiredDate: headerForm.requiredDate || undefined,
        observations: headerForm.observations.trim() || null,
      });
      setEditingHeader(false);
      refresh();
    } catch (error) {
      setHeaderFeedback(error instanceof Error ? error.message : "No fue posible guardar la cabecera.");
    } finally {
      setHeaderBusy(false);
    }
  };
  const supplierGroups = [
    ...new Set(
      lines
        .map((item) => item.finalSupplierId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  // Reunión 2026-08-31: obras de la empresa de la requisición (la obra la asigna el revisor).
  const workOptions = catalogs.works.filter((work) => work.societyId === requisition.societyId);
  // Insumos del bloque "Generar órdenes": ítems aprobados (todo lo que no esté declinado) de la
  // requisición ya guardada en el servidor (no de `lines`, que es el borrador editable local),
  // agrupados por proveedor final; los que faltan quedan aparte para anticipar SUPPLIER_REQUIRED.
  const approvedForOrders = requisition.items.filter((item) => item.status !== "declinado");
  const missingSupplierItems = approvedForOrders.filter((item) => !item.finalSupplierId);
  const orderSupplierGroupsMap = new Map<string, RequisitionItem[]>();
  for (const item of approvedForOrders) {
    if (!item.finalSupplierId) continue;
    orderSupplierGroupsMap.set(item.finalSupplierId, [...(orderSupplierGroupsMap.get(item.finalSupplierId) ?? []), item]);
  }
  const orderSupplierGroups = [...orderSupplierGroupsMap.entries()];
  // GRAVE 4: "—" en vez del UUID crudo cuando el proveedor no aparece en ninguna de las dos fuentes.
  const supplierName = (id: string) => supplierOptions.find((s) => s.id === id)?.name ?? catalogs.suppliers.find((s) => s.id === id)?.name ?? "—";
  // Adjuntos del solicitante (soportes/fotos) vs. cotizaciones del comprador: dos cosas
  // distintas para quien aprueba, antes mezcladas en una sola lista.
  const requesterAttachments = attachments.filter((attachment) => attachment.type !== "cotizacion");
  const quoteAttachments = attachments.filter((attachment) => attachment.type === "cotizacion");
  const quickSupplierItem = quickSupplierItemId
    ? lines.find((line) => line.id === quickSupplierItemId)
    : undefined;
  return (
    <>
      <SectionTitle
        eyebrow="Detalle conectado"
        title={requisition.consecutive}
        description={`${requisition.type} · ${requisition.channel} · ${requisition.requiredDate || "sin fecha"}`}
        action={
          <div className="title-actions">
            <button className="button button-secondary" type="button" onClick={refresh}>
              Actualizar
            </button>
            <button
              className="button button-secondary"
              type="button"
              onClick={() =>
                go(role === "Aprobador" ? "/aprobaciones" : "/revision")
              }
            >
              Volver
            </button>
          </div>
        }
      />
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Ítems y cotización</h2>
              <p className="panel-sub">
                Obra{" "}
                {requisition.workId
                  ? (catalogs.works.find((work) => work.id === requisition.workId)?.name ?? requisition.workId)
                  : "por asignar en la revisión"}
              </p>
            </div>
            <Tone tone="muted">
              <span data-testid="requisition-status">
                {estadoLabel(requisition.status)}
              </span>
            </Tone>
          </div>
          {isReviewer &&
          ["en_revision", "devuelta"].includes(requisition.status) ? (
            <div className="connected-review">
              <label className="field">
                <span>Etiqueta y ruta de aprobación</span>
                <select
                  required
                  value={tagId}
                  onChange={(event) => setTagId(event.target.value)}
                >
                  <option value="">Selecciona una etiqueta</option>
                  {catalogs.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {/* Reunión 2026-08-31: la obra (centro de costo) la asigna el revisor, filtrada
                    por la empresa de la requisición; obligatoria para enviar a aprobación.
                    GRAVE 3: si la empresa no tiene obras, `workOptions` queda vacío y antes el
                    <select> se veía con una sola opción fantasma ("Selecciona una obra") sin
                    explicar por qué el flujo estaba atascado — un callejón sin salida absoluto. */}
                <span>Obra</span>
                <select
                  required
                  value={workId}
                  disabled={workOptions.length === 0}
                  aria-invalid={Boolean(feedback && !workId)}
                  aria-describedby={workOptions.length === 0 ? "work-empty-reason" : undefined}
                  onChange={(event) => setWorkId(event.target.value)}
                >
                  <option value="">
                    {workOptions.length === 0 ? "Sin obras registradas" : "Selecciona una obra"}
                  </option>
                  {workOptions.map((work) => (
                    <option key={work.id} value={work.id}>
                      {work.name}
                    </option>
                  ))}
                </select>
                {workOptions.length === 0 && (
                  <small className="field-error" role="alert" id="work-empty-reason">
                    Esta empresa no tiene obras registradas: pídele a un administrador que cree
                    al menos una antes de poder enviar la requisición a aprobación.
                  </small>
                )}
              </label>
              <label className="field">
                <span>Forma de pago</span>
                <input
                  maxLength={240}
                  value={paymentTerms}
                  onChange={(event) => setPaymentTerms(event.target.value)}
                />
              </label>
              {lines.map((line) => (
                // MENOR (QA 2026-08-31): antes un ítem declinado solo cambiaba el badge del
                // <legend> — mismo borde y fondo que uno vigente. `.review-line-declined` le
                // da borde de alerta y atenúa los campos que ya no aplican (ver globals.css).
                <fieldset className={`review-line${line.status === "declinado" ? " review-line-declined" : ""}`} key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)
                        ?.name ||
                      "Ítem"}
                    {line.status === "declinado" && (
                      <Tone tone="danger" dot>Declinado</Tone>
                    )}
                  </legend>
                  <label className="field">
                    <span>Cantidad</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.id, {
                          quantity: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Unidad</span>
                    <input
                      value={line.unit}
                      onChange={(event) =>
                        updateLine(line.id, { unit: event.target.value })
                      }
                    />
                  </label>
                  <div className="field supplier-assignment-field">
                    <label className="field-label" htmlFor={`supplier-${line.id}`}>
                      Proveedor final
                    </label>
                    <select
                      id={`supplier-${line.id}`}
                      value={line.finalSupplierId ?? ""}
                      onChange={(event) =>
                        updateLine(line.id, {
                          finalSupplierId: event.target.value || undefined,
                        })
                      }
                    >
                      <option value="">Por definir</option>
                      {supplierOptions.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button button-secondary quick-supplier-trigger"
                      type="button"
                      disabled={busy}
                      onClick={(event) =>
                        openQuickSupplier(line.id, event.currentTarget)
                      }
                      aria-label={`Crear proveedor para ${line.description || "este ítem"}`}
                    >
                      + Crear proveedor
                    </button>
                  </div>
                  <label className="field">
                    <span>Base unitaria COP</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={line.unitBase ?? 0}
                      onChange={(event) =>
                        updateLine(line.id, {
                          unitBase: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  {/* Reunión 2026-08-31: "IVA unitario COP" se sustituye por IVA % (fracción en la
                      API: 19 % se envía como 0.19) y se añade Desc %. */}
                  <label className="field">
                    <span>IVA %</span>
                    <select
                      value={String(line.ivaRate ?? 0)}
                      onChange={(event) =>
                        updateLine(line.id, { ivaRate: Number(event.target.value) })
                      }
                    >
                      <option value="0">0 %</option>
                      <option value="0.05">5 %</option>
                      <option value="0.19">19 %</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Desc %</span>
                    <input
                      type="number"
                      min="0"
                      max="100"
                      step="1"
                      value={line.discountRate !== undefined ? Math.round(line.discountRate * 100) : 0}
                      onChange={(event) =>
                        updateLine(line.id, { discountRate: Number(event.target.value) / 100 })
                      }
                    />
                  </label>
                  <div className="field">
                    <label className="field-label" htmlFor={`decline-${line.id}`}>Estado del ítem</label>
                    <select
                      id={`decline-${line.id}`}
                      value={line.status === "declinado" ? "declinado" : "pendiente"}
                      onChange={(event) =>
                        updateLine(line.id, {
                          status: event.target.value === "declinado" ? "declinado" : undefined,
                          declineReason: event.target.value === "declinado" ? line.declineReason : undefined,
                        })
                      }
                    >
                      <option value="pendiente">Vigente</option>
                      <option value="declinado">Declinar</option>
                    </select>
                  </div>
                  {line.status === "declinado" && (
                    <label className="field field-wide">
                      <span>Motivo de declinación</span>
                      <textarea
                        required
                        value={line.declineReason ?? ""}
                        onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                      />
                    </label>
                  )}
                  <strong>{money.format(estimateLineTotal(line))}</strong>
                </fieldset>
              ))}
              {/* MENOR (QA 2026-08-31): "Nelson y Juliana deciden sin ver la cifra total" —
                  no existía en ninguna parte. Barra de Subtotal · IVA · Total al pie del
                  bloque de ítems, visible en revisión y en aprobación. */}
              <div className="connected-line-summary" data-testid="line-summary">
                {(() => {
                  const totals = summarizeLines(lines);
                  return (
                    <>
                      <span>Subtotal <b className="money">{money.format(totals.base)}</b></span>
                      <span>IVA <b className="money">{money.format(totals.iva)}</b></span>
                      <span className="connected-line-summary-total">Total <b className="money">{money.format(totals.total)}</b></span>
                    </>
                  );
                })()}
              </div>
              {supplierStatus && (
                <p className="field-success" role="status">
                  {supplierStatus}
                </p>
              )}
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={
                    busy ||
                    !tagId ||
                    lines.some((line) => line.status === "declinado" && !line.declineReason?.trim())
                  }
                  type="button"
                  onClick={() =>
                    void run({
                      action: "review",
                      tagId,
                      ...(workId ? { workId } : {}),
                      ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
                      items: lines.map(
                        ({
                          id,
                          itemId,
                          description,
                          quantity,
                          unit,
                          possibleSupplier,
                          productLink,
                          finalSupplierId,
                          unitBase,
                          status,
                          declineReason,
                          ivaRate,
                          discountRate,
                        }) => ({
                          id,
                          ...(itemId ? { itemId } : {}),
                          ...(description ? { description } : {}),
                          quantity,
                          unit,
                          ...(possibleSupplier ? { possibleSupplier } : {}),
                          ...(productLink ? { productLink } : {}),
                          ...(finalSupplierId ? { finalSupplierId } : {}),
                          unitBase: Math.round(unitBase ?? 0),
                          ...(status ? { status } : {}),
                          ...(status === "declinado" && declineReason ? { declineReason } : {}),
                          ...(ivaRate !== undefined ? { ivaRate } : {}),
                          ...(discountRate !== undefined ? { discountRate } : {}),
                        }),
                      ),
                    })
                  }
                >
                  Guardar revisión
                </button>
                <button
                  className="button button-dark"
                  // El proveedor ya NO bloquea el envío a aprobación (aprobar y designar proveedor
                  // son roles distintos); sí lo bloquean etiqueta y obra, que el backend exige.
                  disabled={busy || requisition.status === "devuelta" || !tagId || !workId}
                  type="button"
                  onClick={() => void run({ action: "send_for_approval" })}
                >
                  Enviar a aprobación
                </button>
                {/* GRAVE 3: regla única del repo — todo `disabled` lleva texto adyacente con la
                    razón y el siguiente paso, no solo un `title`. */}
                {!busy && requisition.status !== "devuelta" && (!tagId || !workId) && (
                  <p className="field-error" role="alert">
                    {!workId && workOptions.length === 0
                      ? "Falta asignar la obra. Esta empresa no tiene obras registradas: pídele a un administrador que la cree."
                      : !workId
                        ? "Falta asignar la obra."
                        : "Falta elegir la etiqueta y ruta de aprobación."}
                  </p>
                )}
              </div>
            </div>
          ) : isApprover && requisition.status === "en_aprobacion" ? (
            <div className="connected-review" data-testid="approval-decisions">
              {lines.map((line) => (
                <fieldset className={`review-line${line.status === "declinado" ? " review-line-declined" : ""}`} key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)?.name ||
                      "Ítem"}
                  </legend>
                  <label className="field">
                    <span>Cantidad aprobada</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                    />
                  </label>
                  <div className="field">
                    <label className="field-label" htmlFor={`decision-${line.id}`}>Decisión</label>
                    <select
                      id={`decision-${line.id}`}
                      value={line.status === "declinado" ? "declinado" : "aprobado"}
                      onChange={(event) =>
                        updateLine(line.id, {
                          status: event.target.value === "declinado" ? "declinado" : "aprobado",
                          declineReason: event.target.value === "declinado" ? line.declineReason : undefined,
                        })
                      }
                    >
                      <option value="aprobado">Aprobado</option>
                      <option value="declinado">Declinar</option>
                    </select>
                  </div>
                  {line.status === "declinado" && (
                    <label className="field field-wide">
                      <span>Motivo de declinación</span>
                      <textarea
                        required
                        value={line.declineReason ?? ""}
                        onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                      />
                    </label>
                  )}
                  <strong>{money.format(estimateLineTotal(line))}</strong>
                </fieldset>
              ))}
              {/* MENOR: misma barra de totales que en revisión — el aprobador tampoco veía
                  la cifra total antes de decidir. */}
              <div className="connected-line-summary" data-testid="line-summary">
                {(() => {
                  const totals = summarizeLines(lines);
                  return (
                    <>
                      <span>Subtotal <b className="money">{money.format(totals.base)}</b></span>
                      <span>IVA <b className="money">{money.format(totals.iva)}</b></span>
                      <span className="connected-line-summary-total">Total <b className="money">{money.format(totals.total)}</b></span>
                    </>
                  );
                })()}
              </div>
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={busy || lines.some((line) => line.status === "declinado" && !line.declineReason?.trim())}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "decide_items",
                      decisions: lines.map((line) => {
                        const status = line.status === "declinado" ? "declinado" : "aprobado";
                        return {
                          itemId: line.id,
                          status,
                          ...(status === "declinado" ? { declineReason: (line.declineReason ?? "").trim() } : {}),
                          quantity: Number(line.quantity),
                        };
                      }),
                    })
                  }
                >
                  Guardar decisiones
                </button>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Ítem</th>
                    <th>Cantidad</th>
                    <th>Unidad</th>
                    <th>Base unit.</th>
                    <th>IVA %</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {requisition.items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {item.description ||
                          catalogs.items.find(
                            (option) => option.id === item.itemId,
                          )?.name ||
                          "Ítem de catálogo"}
                      </td>
                      <td>{item.quantity}</td>
                      <td>{item.unit}</td>
                      <td>{money.format(item.unitBase ?? 0)}</td>
                      <td>{item.ivaRate !== undefined ? `${Math.round(item.ivaRate * 100)} %` : money.format(item.unitIva ?? 0)}</td>
                      <td>
                        {item.status === "declinado" ? (
                          <Tone tone="danger" dot>
                            Declinado{item.declineReason ? ` · ${item.declineReason}` : ""}
                          </Tone>
                        ) : (
                          <Tone tone="muted" dot>Vigente</Tone>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <aside className="connected-side">
          <section className="panel connected-summary">
            <h3>Control</h3>
            <dl>
              <div>
                <dt>Estado</dt>
                <dd>{estadoLabel(requisition.status)}</dd>
              </div>
              <div>
                {/* RF-404: requesterId/externalRequester ya viajaban en el payload de
                    /api/requisitions/:id; solo faltaba mostrarlos en el detalle. */}
                <dt>Solicitante</dt>
                <dd data-testid="requisition-requester">
                  {requisition.externalRequester
                    ? `${requisition.externalRequester.name}${
                        requisition.externalRequester.phone
                          ? ` · ${requisition.externalRequester.phone}`
                          : ""
                      }`
                    : // HUECO 2: el nombre ya viaja en catalogs.users (GET /api/catalogs, id+nombre
                      // solamente); "Solicitante interno" se conserva como fallback honesto — nunca se
                      // muestra el UUID crudo si el id no aparece en esa lista.
                      resolveUserName(catalogs, requisition.requesterId, "Solicitante interno")}
                </dd>
              </div>
              <div>
                <dt>Fecha requerida</dt>
                <dd>{requisition.requiredDate ? formatIsoDate(requisition.requiredDate) : "—"}</dd>
              </div>
              <div>
                <dt>Observaciones</dt>
                <dd>{requisition.observations || "—"}</dd>
              </div>
            </dl>
            {headerEditable && !editingHeader && (
              <button className="button button-secondary" type="button" onClick={() => { setHeaderForm({ requiredDate: requisition.requiredDate ?? "", observations: requisition.observations ?? "" }); setEditingHeader(true); }}>
                <Pencil aria-hidden="true" size={14} /> Editar cabecera
              </button>
            )}
            {headerEditable && editingHeader && (
              <div className="connected-header-edit">
                <label className="field">
                  <span>Fecha requerida</span>
                  <input type="date" value={headerForm.requiredDate} onChange={(event) => setHeaderForm({ ...headerForm, requiredDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>Observaciones</span>
                  <textarea maxLength={1024} value={headerForm.observations} onChange={(event) => setHeaderForm({ ...headerForm, observations: event.target.value })} />
                </label>
                {headerFeedback && <p className="field-error" role="alert">{headerFeedback}</p>}
                <div className="form-footer">
                  <button className="button button-secondary" type="button" onClick={() => setEditingHeader(false)} disabled={headerBusy}>Cancelar</button>
                  <button className="button button-dark" type="button" onClick={() => void saveHeader()} disabled={headerBusy}>{headerBusy ? "Guardando…" : "Guardar cambios"}</button>
                </div>
              </div>
            )}
            {requisition.returnReason && (
              <p data-testid="return-reason">
                <b>Motivo de devolución:</b> {requisition.returnReason}
              </p>
            )}
            {requisition.declineReason && (
              <p data-testid="decline-reason">
                <b>Motivo de declinación:</b> {requisition.declineReason}
              </p>
            )}
            {isReviewer && requisition.status === "enviada" && (
              <button
                className="button button-dark"
                disabled={busy}
                type="button"
                onClick={() => void run({ action: "start_review" })}
              >
                Iniciar revisión
              </button>
            )}
            {isReviewer &&
              ["en_revision", "devuelta"].includes(requisition.status) && (
                <>
                  <label className="field">
                    <span>Motivo para declinar</span>
                    <textarea
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                    />
                  </label>
                  {/* GRAVE 4: este "Declinar" mata la requisición ENTERA (distinto del "Declinar"
                      por ítem, arriba, que solo afecta esa línea) — mismo verbo, alcances
                      radicalmente distintos. Se renombra para que no se confundan. */}
                  <button
                    className="button button-danger"
                    disabled={busy || !comment.trim()}
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Declinar toda la requisición",
                        description: `La requisición ${requisition.consecutive} quedará declinada de forma definitiva y no se podrá reactivar.`,
                        confirmLabel: "Declinar toda la requisición",
                        danger: true,
                      });
                      if (!ok) return;
                      void run({ action: "decline", reason: comment });
                    }}
                  >
                    Declinar toda la requisición
                  </button>
                </>
              )}
            {isApprover && requisition.status === "en_aprobacion" && (
              <>
                {/* Reunión 2026-08-31: aprobar y generar la orden son pasos distintos ahora — este
                    botón solo transiciona el estado. La división por proveedor ya es siempre el
                    comportamiento normal (el checkbox "Completo" desaparece). */}
                <button
                  className="button button-dark"
                  disabled={busy}
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Aprobar la requisición",
                      description: `La requisición ${requisition.consecutive} quedará aprobada de forma definitiva y no podrá regresar a revisión. Genera las órdenes después, desde el bloque "Generar órdenes".`,
                      confirmLabel: "Aprobar",
                    });
                    if (!ok) return;
                    void run({ action: "approve" });
                  }}
                >
                  Aprobar
                </button>
                <label className="field">
                  <span>Comentario de devolución</span>
                  <textarea
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                  />
                </label>
                <button
                  className="button button-secondary"
                  disabled={busy || !comment.trim()}
                  type="button"
                  onClick={() => void run({ action: "return", comment })}
                >
                  Devolver a revisión
                </button>
              </>
            )}
            {feedback && (
              <p className="field-error" role="alert">
                {feedback}
              </p>
            )}
          </section>
          {/* Reunión 2026-08-31: "Generar órdenes" es su propio paso, con botón propio — el
              cliente dijo literalmente que no la veía. Reutiliza el resumen de asignación por
              proveedor como preview; muestra qué grupos saldrán y qué falta antes de intentarlo. */}
          {isReviewer && requisition.status === "aprobada" && orders.length === 0 ? (
            <section className="panel connected-summary" data-testid="generate-orders-panel">
              <h3>Generar órdenes</h3>
              <p className="panel-sub">Ítems aprobados agrupados por proveedor; se genera una orden por grupo.</p>
              {orderSupplierGroups.map(([supplierId, items]) => (
                <p key={supplierId} data-testid="order-supplier-group">
                  <b>{supplierName(supplierId)}</b> · {items.length} ítem{items.length === 1 ? "" : "s"} ·{" "}
                  {money.format(items.reduce((sum, item) => sum + estimateLineTotal(item), 0))}
                </p>
              ))}
              {missingSupplierItems.length > 0 && (
                <div className="missing-supplier-assign" data-testid="missing-supplier-warning">
                  <p className="field-error" role="alert">
                    {missingSupplierItems.length} ítem{missingSupplierItems.length === 1 ? "" : "s"} aprobado{missingSupplierItems.length === 1 ? "" : "s"} sin proveedor asignado: elige uno abajo para poder generar la orden.
                  </p>
                  {missingSupplierItems.map((item) => (
                    <label className="field" key={item.id}>
                      <span>{item.description || item.itemId || "Ítem sin descripción"}</span>
                      <select
                        value={assignSupplierChoice[item.id] ?? ""}
                        onChange={(event) =>
                          setAssignSupplierChoice((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      >
                        <option value="">Selecciona un proveedor</option>
                        {supplierOptions.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy || !missingSupplierItems.some((item) => assignSupplierChoice[item.id])}
                    onClick={() => {
                      const assignments = missingSupplierItems
                        .filter((item) => assignSupplierChoice[item.id])
                        .map((item) => ({ itemId: item.id, supplierId: assignSupplierChoice[item.id] }));
                      void run({ action: "assign_suppliers", assignments });
                    }}
                  >
                    Asignar proveedor{missingSupplierItems.length === 1 ? "" : "es"}
                  </button>
                </div>
              )}
              {/* GRAVE 3: todo `disabled` lleva texto adyacente con la razón y el siguiente
                  paso, no solo un `title` — antes, si el aprobador declinaba todos los ítems,
                  este botón quedaba muerto y mudo (el `title` solo cubría el caso de proveedor
                  faltante). */}
              {orderSupplierGroups.length === 0 && missingSupplierItems.length === 0 && (
                <p className="field-error" role="alert">
                  No hay ítems aprobados con proveedor asignado: el aprobador declinó todos los
                  ítems o ninguno tiene proveedor todavía. No hay nada que generar.
                </p>
              )}
              <button
                className="button button-dark"
                type="button"
                disabled={busy || missingSupplierItems.length > 0 || orderSupplierGroups.length === 0}
                aria-disabled={missingSupplierItems.length > 0 || orderSupplierGroups.length === 0}
                title={
                  missingSupplierItems.length > 0
                    ? "Asigna proveedor a cada ítem aprobado antes de generar órdenes."
                    : orderSupplierGroups.length === 0
                      ? "No hay ítems aprobados con proveedor asignado."
                      : undefined
                }
                onClick={async () => {
                  const ok = await confirm({
                    title: "Generar órdenes",
                    description: `Se generará${orderSupplierGroups.length === 1 ? "" : "n"} ${orderSupplierGroups.length} orden(es), una por proveedor. Esta acción no se puede deshacer.`,
                    confirmLabel: "Generar órdenes",
                  });
                  if (!ok) return;
                  void run({ action: "generate_orders" });
                }}
              >
                Generar órdenes
              </button>
            </section>
          ) : (
            supplierGroups.length > 0 && (
              <section className="panel connected-summary">
                <h3>Asignación por proveedor</h3>
                {supplierGroups.map((supplierId) => (
                  <p key={supplierId} data-testid="supplier-allocation">
                    {supplierName(supplierId)}
                  </p>
                ))}
              </section>
            )
          )}
          {orders.length > 0 && (
            <section className="panel connected-summary">
              <h3>Documentos generados</h3>
              {orders.map((order) => (
                <a
                  key={order.id}
                  href={`/api/orders/${order.id}/document`}
                  className="text-link"
                  data-testid={
                    order.type === "OP"
                      ? "payment-order"
                      : "purchase-order-document"
                  }
                >
                  <b>{order.consecutive}</b> · descargar PDF provisional
                </a>
              ))}
              {expenses.map((expense) => (
                <p
                  key={expense.id}
                  data-testid={
                    requisition.type === "pago"
                      ? "payment-expense"
                      : "expense-by-order"
                  }
                >
                  {money.format(expense.total)} · gasto automático
                </p>
              ))}
              {requisition.type === "pago" && requisition.tagId && (
                <p data-testid="payment-tag">
                  {catalogs.tags.find((tag) => tag.id === requisition.tagId)
                    ?.name ?? requisition.tagId}
                </p>
              )}
            </section>
          )}
          {/* Reunión 2026-08-31: separa visualmente los adjuntos del SOLICITANTE (soportes,
              fotos) de las COTIZACIONES del comprador — son dos cosas distintas para quien
              aprueba y antes se mezclaban en una sola lista. */}
          <section className="panel connected-summary">
            <h3>Adjuntos del solicitante</h3>
            {requesterAttachments.length ? (
              <div className="attachment-list">
                {requesterAttachments.map((attachment) => (
                  <a
                    className="attachment-link"
                    key={attachment.id}
                    href={`/api/attachments/${attachment.entity}/${encodeURIComponent(attachment.entityId)}/${encodeURIComponent(attachment.id)}/download`}
                    download={attachment.name}
                  >
                    <b>
                      {attachment.type === "foto"
                        ? `Foto del ítem ${
                            requisition.items.findIndex(
                              (item) => item.id === attachment.entityId,
                            ) + 1
                          }`
                        : "Soporte general"}
                    </b>{" "}· {attachment.name}
                  </a>
                ))}
              </div>
            ) : (
              <p>Sin soportes cargados para esta requisición.</p>
            )}
          </section>
          <section className="panel connected-summary">
            <h3>Cotizaciones del comprador</h3>
            {quoteAttachments.length ? (
              <div className="attachment-list">
                {quoteAttachments.map((attachment) => (
                  <a
                    className="attachment-link"
                    key={attachment.id}
                    href={`/api/attachments/${attachment.entity}/${encodeURIComponent(attachment.entityId)}/${encodeURIComponent(attachment.id)}/download`}
                    download={attachment.name}
                  >
                    <b>Cotización</b> · {attachment.name}
                  </a>
                ))}
              </div>
            ) : (
              <p>Sin cotizaciones cargadas para esta requisición.</p>
            )}
            {isReviewer && ["en_revision", "devuelta"].includes(requisition.status) && (
              <div className="connected-header-edit">
                <AttachmentPicker
                  id="requisition-quote"
                  label="Adjuntar cotización"
                  help="PDF, JPG, PNG o WebP · máximo 10 MB"
                  file={quoteFile}
                  onFile={setQuoteFile}
                  onError={setQuoteFeedback}
                  disabled={quoteBusy}
                />
                {quoteFeedback && (
                  <p className="field-error" role="alert">{quoteFeedback}</p>
                )}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={!quoteFile || quoteBusy}
                  onClick={() => void uploadQuote()}
                >
                  {quoteBusy ? "Cargando…" : "Subir cotización"}
                </button>
              </div>
            )}
          </section>
          <section className="panel connected-summary">
            <h3>Historial de trazabilidad</h3>
            {history.length ? (
              history.map((entry, index) => (
                <p key={`${entry.at}-${index}`} data-testid="audit-event">
                  <b>{eventLabel(entry.event)}</b> ·{" "}
                  {new Date(entry.at).toLocaleString("es-CO")} ·{" "}
                  {/* RF-405: AuditEvent.actorId ya viajaba en el JSON del historial; sin
                      esto la trazabilidad no decía qué usuario ejecutó cada transición.
                      HUECO 2: el nombre ya viaja en catalogs.users; "Usuario interno" se conserva
                      como fallback honesto — nunca se muestra el UUID crudo. */}
                  <span data-testid="audit-actor">
                    {entry.actorId ? resolveUserName(catalogs, entry.actorId, "Usuario interno") : "Automático"}
                  </span>
                  {typeof entry.data?.comment === "string"
                    ? ` · ${entry.data.comment}`
                    : ""}
                </p>
              ))
            ) : (
              <p>Sin eventos visibles para esta requisición.</p>
            )}
          </section>
        </aside>
      </div>
      {isReviewer && quickSupplierItemId && (
        <div
          className="quick-supplier-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !quickSupplierBusy) {
              closeQuickSupplier();
            }
          }}
        >
          <form
            ref={quickSupplierDialogRef}
            className="panel quick-supplier-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quick-supplier-title"
            onKeyDown={trapQuickSupplierFocus}
            onSubmit={createQuickSupplier}
          >
            <div className="panel-head">
              <div>
                <div className="eyebrow">Alta rápida</div>
                <h2 id="quick-supplier-title">Nuevo proveedor</h2>
                <p className="panel-sub">
                  Se asignará a {quickSupplierItem?.description || "este ítem"}.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Cerrar alta de proveedor"
                onClick={closeQuickSupplier}
                disabled={quickSupplierBusy}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            <div className="quick-supplier-body">
              <label className="field">
                <span>Razón social *</span>
                <input
                  ref={quickSupplierNameRef}
                  required
                  maxLength={160}
                  value={quickSupplierName}
                  onChange={(event) => setQuickSupplierName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>NIT (opcional)</span>
                <input
                  maxLength={32}
                  value={quickSupplierNit}
                  onChange={(event) => setQuickSupplierNit(event.target.value)}
                />
              </label>
              {quickSupplierError && (
                <p className="field-error" role="alert">
                  {quickSupplierError}
                </p>
              )}
            </div>
            <div className="form-footer">
              <button
                className="button button-secondary"
                type="button"
                onClick={closeQuickSupplier}
                disabled={quickSupplierBusy}
              >
                Cancelar
              </button>
              <button
                className="button button-dark"
                type="submit"
                disabled={quickSupplierBusy || !quickSupplierName.trim()}
              >
                {quickSupplierBusy ? "Creando…" : "Crear y asignar"}
              </button>
            </div>
          </form>
        </div>
      )}
      {confirmDialog}
    </>
  );
}

export function ConnectedOrders({
  data,
  role,
  refresh,
  go,
}: {
  data: OrdersBundle;
  role: Role;
  refresh: () => void;
  go: (href: string) => void;
}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [],
    requisitions = Array.isArray(data?.requisitions) ? data.requisitions : [],
    catalogs = data?.catalogs ?? emptyCatalogs,
    [feedback, setFeedback] = useState(""),
    [success, setSuccess] = useState(""),
    [openOrderId, setOpenOrderId] = useState<string | null>(null),
    canUpdate = role === "Revisor" || role === "Administrador Sixteam",
    // Reunión 2026-08-31: eje administrativo/contable, independiente del cumplimiento de arriba.
    // "contabilizada" es de contabilidad (order:account); "pagada" es del revisor (order:pay).
    canAccount = role === "Contabilidad" || role === "Administrador Sixteam",
    canPay = role === "Revisor" || role === "Administrador Sixteam";
  // Expediente del proveedor (RUT, cámara de comercio…) para que el contador lo descargue
  // junto con la orden sin buscarlo por otro lado (GET /api/suppliers/:id ya lo expone).
  const [supplierDocuments, setSupplierDocuments] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  const [dossierLoading, setDossierLoading] = useState<string | null>(null);
  // GRAVE 4: "—" en vez del UUID crudo cuando el catálogo no trae el nombre (proveedor/obra
  // borrado o desincronizado); "Por definir" sigue siendo el caso honesto de "aún sin proveedor".
  const supplierName = (id?: string) => (id ? (catalogs.suppliers.find((s) => s.id === id)?.name ?? "—") : "Por definir");
  const workName = (id?: string) => (id ? (catalogs.works.find((w) => w.id === id)?.name ?? "—") : "—");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  // La orden no guarda obra ni fecha propias (solo requisicion_id): se derivan
  // uniendo con /api/requisitions, que ya llega autorizado para todo rol que
  // puede leer órdenes. Evita tocar el dominio/infraestructura solo por un filtro.
  const requisitionById = new Map(
    requisitions.map((requisition) => [requisition.id, requisition]),
  );
  // GRAVE 2: total de la orden para la columna "Valor" — mismas funciones canónicas que la
  // ficha (BLOQUEANTE 1), sobre los ítems de la requisición de origen que pertenecen a esta orden.
  const orderTotal = (row: OrderRow): number => {
    const linked = requisitionById.get(row.requisitionId);
    const itemIds = new Set(row.itemIds ?? []);
    return sumLines((linked?.items ?? []).filter((item) => itemIds.has(item.id)));
  };
  const [workFilter, setWorkFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    // GRAVE 2: filtro propio del eje contable — "todas las pendientes de contabilizar" es
    // literalmente la tarea del contador los martes y viernes, y antes solo existía el filtro
    // de cumplimiento.
    [adminStatusFilter, setAdminStatusFilter] = useState(""),
    [supplierFilter, setSupplierFilter] = useState(""),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState("");
  const statusOptions = Array.from(
    new Set(rows.map((row) => row.status)),
  ).sort();
  const adminStatusOptions = Array.from(
    new Set(rows.map((row) => row.adminStatus ?? "pendiente")),
  ).sort();
  const filteredRows = rows.filter((row) => {
    const linked = requisitionById.get(row.requisitionId);
    if (workFilter && linked?.workId !== workFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    if (adminStatusFilter && (row.adminStatus ?? "pendiente") !== adminStatusFilter) return false;
    if (supplierFilter && row.supplierId !== supplierFilter) return false;
    if (dateFrom && !(linked?.requiredDate && linked.requiredDate >= dateFrom))
      return false;
    if (dateTo && !(linked?.requiredDate && linked.requiredDate <= dateTo))
      return false;
    return true;
  });
  const clearFilters = () => {
    setWorkFilter("");
    setStatusFilter("");
    setAdminStatusFilter("");
    setSupplierFilter("");
    setDateFrom("");
    setDateTo("");
  };
  const setStatus = async (id: string, status: string, consecutive?: string) => {
    const ref = consecutive ?? id;
    // Cambio irreversible y sin deshacer: se confirma explícitamente antes de aplicar.
    const ok = await confirm({
      title: `Marcar la orden como "${estadoLabel(status)}"`,
      description: `La orden ${ref} quedará marcada como "${estadoLabel(status)}". Esta acción es irreversible y no se puede deshacer.`,
      confirmLabel: "Confirmar",
      danger: status === "no_cumplida",
    });
    if (!ok) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { status });
      setSuccess(`La orden ${ref} quedó como "${estadoLabel(status)}".`);
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar la orden.",
      );
    }
  };
  // Reunión 2026-08-31: mismo patrón que setStatus, pero sobre el eje administrativo/contable
  // (adminStatus) en vez del de entrega (status) — son ejes independientes.
  const setAdminStatus = async (id: string, adminStatus: "contabilizada" | "pagada", consecutive?: string) => {
    const ref = consecutive ?? id;
    const ok = await confirm({
      title: `Marcar la orden como "${estadoLabel(adminStatus)}"`,
      description: `La orden ${ref} quedará marcada como "${estadoLabel(adminStatus)}" en contabilidad. Esta acción es irreversible.`,
      confirmLabel: "Confirmar",
    });
    if (!ok) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { adminStatus });
      setSuccess(`La orden ${ref} quedó como "${estadoLabel(adminStatus)}" en contabilidad.`);
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar el eje contable.",
      );
    }
  };
  // Carga perezosa (solo al abrir la ficha) del expediente del proveedor de la orden, para que
  // el contador lo descargue sin ir a buscarlo a otra pantalla.
  const loadSupplierDossier = async (supplierId: string) => {
    if (supplierDocuments[supplierId] || dossierLoading === supplierId) return;
    setDossierLoading(supplierId);
    try {
      const result = (await apiRequest(`/api/suppliers/${supplierId}`)) as {
        documents?: Array<{ id: string; name: string }>;
      };
      setSupplierDocuments((current) => ({ ...current, [supplierId]: result.documents ?? [] }));
    } catch {
      // Silencioso: el expediente es un plus de la ficha, no bloquea la ficha de la orden.
    } finally {
      setDossierLoading((current) => (current === supplierId ? null : current));
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Órdenes"
        description="OC y OP visibles según el rol autenticado; cada estado pertenece a su propia orden."
      />
      {rows.length > 0 && (
        <div className="filter-bar">
          <label className="field">
            <span>Obra</span>
            <select
              value={workFilter}
              onChange={(event) => setWorkFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {catalogs.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {/* GRAVE 2: "Entrega" en vez de "Estado" — sin esto, Estado y Estado admin. se
                leían como una sola secuencia en vez de dos ejes independientes. */}
            <span>Entrega</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {estadoLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {/* GRAVE 2: filtro propio del eje contable — el contador necesita pedir "todas
                las pendientes de contabilizar", su tarea de los martes y viernes. */}
            <span>Contabilidad</span>
            <select
              value={adminStatusFilter}
              onChange={(event) => setAdminStatusFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {adminStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {estadoLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Proveedor</span>
            <select
              value={supplierFilter}
              onChange={(event) => setSupplierFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {catalogs.suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Desde</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Hasta</span>
            <input
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          {/* RF-505: acceso directo a las compras no_cumplida para que ninguna
              quede fuera de la vista aunque cambien otros filtros. */}
          <label className="filter-button">
            <input
              type="checkbox"
              checked={statusFilter === "no_cumplida"}
              onChange={(event) =>
                setStatusFilter(event.target.checked ? "no_cumplida" : "")
              }
            />
            Solo pendientes (no cumplida)
          </label>
          {/* GRAVE 2: acceso directo a "pendiente de contabilizar" — la tarea recurrente
              del contador, antes solo alcanzable filtrando por el eje de cumplimiento. */}
          <label className="filter-button">
            <input
              type="checkbox"
              checked={adminStatusFilter === "pendiente"}
              onChange={(event) =>
                setAdminStatusFilter(event.target.checked ? "pendiente" : "")
              }
            />
            Solo pendientes de contabilizar
          </label>
        </div>
      )}
      <section className="panel">
        {feedback && (
          <p className="field-error connected-feedback" role="alert">
            {feedback}
          </p>
        )}
        {success && (
          <p className="field-success connected-feedback" role="status">
            {success}
          </p>
        )}
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
            <h3>Sin órdenes visibles</h3>
            <p>El servicio no devolvió órdenes para tu alcance.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
            <h3>Sin resultados para estos filtros</h3>
            <p>Ajusta o limpia los filtros para ver más órdenes.</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={clearFilters}
            >
              Limpiar filtros
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Tipo</th>
                  <th>Obra</th>
                  <th>Requisición</th>
                  <th>Fecha requerida</th>
                  <th>Proveedor</th>
                  {/* GRAVE 2: la contadora contabiliza por importe — antes no lo veía sin abrir cada ficha. */}
                  <th className="align-right">Valor</th>
                  {/* GRAVE 2: "Entrega"/"Contabilidad" en vez de "Estado"/"Estado admin." — dos ejes
                      independientes con su propio nombre, no una secuencia con abreviatura de sistema. */}
                  <th>Entrega</th>
                  <th>Contabilidad</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const linked = requisitionById.get(row.requisitionId);
                  const openRow = () => {
                    setOpenOrderId(row.id);
                    if (row.supplierId) void loadSupplierDossier(row.supplierId);
                  };
                  return (
                    <tr
                      key={row.id}
                      className="clickable"
                      role="button"
                      tabIndex={0}
                      aria-label={`Abrir ficha de la orden ${row.consecutive}`}
                      onClick={openRow}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openRow();
                        }
                      }}
                    >
                      <td>
                        <b>{row.consecutive}</b>
                      </td>
                      <td>{row.type}</td>
                      <td>{workName(linked?.workId)}</td>
                      <td>{linked?.consecutive ?? "—"}</td>
                      <td>{linked?.requiredDate ? formatIsoDate(linked.requiredDate) : "—"}</td>
                      <td>{supplierName(row.supplierId)}</td>
                      <td className="align-right money">{money.format(orderTotal(row))}</td>
                      <td>
                        {/* Eje de entrega: punto de color (dot), lenguaje visual propio. */}
                        <Tone
                          tone={row.status === "cumplida" ? "success" : row.status === "no_cumplida" ? "danger" : row.status === "no_necesario" ? "muted" : "warning"}
                          dot
                        >
                          {estadoLabel(row.status)}
                        </Tone>
                      </td>
                      <td>
                        {/* Eje contable: contorno sin punto — para que nunca se lea como el mismo
                            camino que el eje de entrega de la columna anterior. */}
                        <Tone
                          tone={row.adminStatus === "pagada" ? "success" : row.adminStatus === "contabilizada" ? "blue" : "muted"}
                          outline
                        >
                          {estadoLabel(row.adminStatus ?? "pendiente")}
                        </Tone>
                      </td>
                      <td className="align-right">
                        <span className="row-open" aria-hidden="true">
                          Abrir <ArrowRight size={14} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openOrderId && (() => {
        const order = rows.find((r) => r.id === openOrderId);
        if (!order) return null;
        const linked = requisitionById.get(order.requisitionId);
        const orderItemIds = new Set(order.itemIds ?? []);
        const orderItems = (linked?.items ?? []).filter((it) => orderItemIds.has(it.id));
        // BLOQUEANTE 1: mismo cálculo que el PDF (lib/reports/pdf.ts ya usa calculateLineAmounts/sumLines) —
        // antes esto sumaba precios unitarios sin cantidad ni descuento y usaba unitIva (vacío en el modelo
        // nuevo), así que 400 bultos a $38.000 se veían como "$38.000" aquí y "$18.088.000" en el PDF.
        const total = sumLines(orderItems);
        const requisitionHref = order.requisitionId ? `/requisiciones/${order.requisitionId}` : null;
        return (
          <div
            className="supplier-overlay"
            role="presentation"
            onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenOrderId(null); }}
          >
            <aside className="supplier-drawer" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">
              <div className="supplier-drawer-head">
                <div>
                  <div className="eyebrow">Ficha de {order.type === "OP" ? "orden de pago" : "orden de compra"}</div>
                  <h2 id="order-detail-title">{order.consecutive}</h2>
                </div>
                <button className="icon-button" type="button" aria-label="Cerrar ficha" onClick={() => setOpenOrderId(null)}><X aria-hidden="true" size={18} /></button>
              </div>
              <div className="supplier-drawer-body">
                {feedback && <p className="field-error" role="alert">{feedback}</p>}
                {success && <p className="supplier-success" role="status">{success}</p>}
                <div className="supplier-detail-actions">
                  {/* GRAVE 2: dos ejes independientes uno junto al otro (nunca fusionados en un
                      solo badge), cada uno con su etiqueta (antes iban pegados y sin ninguna) y
                      su propio lenguaje visual: entrega con punto de color, contabilidad con
                      contorno — para que no se lean como pasos del mismo camino. */}
                  <div className="title-actions order-axis-group">
                    <span className="order-axis">
                      <span className="order-axis-label">Entrega</span>
                      <Tone tone={order.status === "cumplida" ? "success" : order.status === "no_cumplida" ? "danger" : order.status === "no_necesario" ? "muted" : "warning"} dot>{estadoLabel(order.status)}</Tone>
                    </span>
                    <span className="order-axis">
                      <span className="order-axis-label">Contabilidad</span>
                      <Tone tone={order.adminStatus === "pagada" ? "success" : order.adminStatus === "contabilizada" ? "blue" : "muted"} outline>{estadoLabel(order.adminStatus ?? "pendiente")}</Tone>
                    </span>
                  </div>
                  <a className="button button-secondary" href={`/api/orders/${encodeURIComponent(order.id)}/document`} target="_blank" rel="noreferrer"><FileText aria-hidden="true" size={14} /> Documento</a>
                </div>
                <section className="supplier-info-grid">
                  <div><span>Tipo</span><b>{order.type === "OP" ? "Orden de pago" : "Orden de compra"}</b></div>
                  <div><span>Obra</span><b>{workName(linked?.workId)}</b></div>
                  <div><span>Proveedor</span><b>{supplierName(order.supplierId)}</b></div>
                  <div><span>Fecha requerida</span><b>{linked?.requiredDate ? formatIsoDate(linked.requiredDate) : "No registrada"}</b></div>
                  <div>
                    <span>Requisición de origen</span>
                    {requisitionHref
                      ? <b><button type="button" className="text-link" onClick={() => go(requisitionHref)}>{linked?.consecutive ?? "Abrir"} <ArrowRight aria-hidden="true" size={13} /></button></b>
                      : <b>{linked?.consecutive ?? "—"}</b>}
                  </div>
                </section>
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    <div><h3>Ítems de la orden</h3><p>{orderItems.length} ítem{orderItems.length === 1 ? "" : "s"} de esta orden.</p></div>
                    <Truck aria-hidden="true" size={17} />
                  </div>
                  {orderItems.length ? (
                    <>
                      <div className="supplier-order-total"><span>Total de la orden</span><b>{money.format(total)}</b></div>
                      <div className="table-wrap supplier-orders-table">
                        <table>
                          <thead><tr><th>Descripción</th><th className="align-right">Cantidad</th><th>Unidad</th><th className="align-right">Valor</th></tr></thead>
                          <tbody>
                            {orderItems.map((it) => (
                              <tr key={it.id}>
                                <td>{it.description || "—"}</td>
                                <td className="align-right money">{it.quantity}</td>
                                <td>{it.unit}</td>
                                <td className="align-right money">{money.format(calculateLineTotal(it))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : <p className="supplier-muted">No fue posible cargar los ítems de esta orden. Ábrela desde su requisición de origen para el detalle completo.</p>}
                </section>
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    {/* GRAVE 2: "Entrega" en vez de "Cumplimiento" — mismo nombre que la columna
                        de la lista y la etiqueta del badge de arriba. */}
                    <div><h3>Entrega</h3><p>La trazabilidad completa vive en la requisición de origen.</p></div>
                    <CheckCircle2 aria-hidden="true" size={17} />
                  </div>
                  {canUpdate && order.status === "generada" ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "cumplida", order.consecutive)}>Marcar cumplida</button>
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "no_cumplida", order.consecutive)}>No cumplida</button>
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "no_necesario", order.consecutive)}>No necesaria</button>
                    </div>
                  ) : (
                    <p className="supplier-muted">{order.status === "generada" ? "Tu rol no puede cambiar el estado de entrega de la orden." : `Esta orden ya está marcada como "${estadoLabel(order.status)}". El estado de entrega es definitivo.`}</p>
                  )}
                </section>
                {/* GRAVE 2 (QA 2026-08-31): "eje administrativo" es vocabulario del equipo de
                    desarrollo — el título y los textos ahora dicen "Contabilidad", que es el
                    lenguaje del cliente. Independiente de la entrega de arriba: el contador
                    martes y viernes marca "contabilizada"; Daniel marca "pagada" para que el
                    contador sepa que puede sacar de caja. */}
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    <div><h3>Contabilidad</h3><p>Independiente de la entrega: pendiente → contabilizada → pagada.</p></div>
                  </div>
                  {order.status === "no_necesario" ? (
                    <p className="supplier-muted">Una orden marcada &ldquo;no necesaria&rdquo; no se contabiliza ni se paga.</p>
                  ) : (order.adminStatus ?? "pendiente") === "pendiente" && canAccount ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setAdminStatus(order.id, "contabilizada", order.consecutive)}>Marcar contabilizada</button>
                    </div>
                  ) : order.adminStatus === "contabilizada" && canPay ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setAdminStatus(order.id, "pagada", order.consecutive)}>Marcar pagada</button>
                    </div>
                  ) : (
                    <p className="supplier-muted">
                      {order.adminStatus === "pagada"
                        ? "Esta orden ya está pagada. El estado de contabilidad es definitivo."
                        : `Tu rol no puede avanzar la contabilidad desde "${estadoLabel(order.adminStatus ?? "pendiente")}".`}
                    </p>
                  )}
                </section>
                {/* Bandeja del contador: descarga la orden (arriba) y el expediente del
                    proveedor sin buscarlo por otro lado. */}
                {order.supplierId && (
                  <section className="supplier-section">
                    <div className="supplier-section-head">
                      <div><h3>Expediente del proveedor</h3><p>RUT, cámara de comercio y demás documentos cargados.</p></div>
                    </div>
                    {dossierLoading === order.supplierId ? (
                      <p className="supplier-muted">Cargando expediente…</p>
                    ) : (supplierDocuments[order.supplierId] ?? []).length ? (
                      <div className="attachment-list">
                        {(supplierDocuments[order.supplierId] ?? []).map((document) => (
                          <a
                            key={document.id}
                            className="attachment-link"
                            href={`/api/suppliers/${encodeURIComponent(order.supplierId as string)}/documents/${encodeURIComponent(document.id)}/download`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {document.name}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="supplier-muted">Sin documentos cargados para este proveedor.</p>
                    )}
                  </section>
                )}
              </div>
            </aside>
          </div>
        );
      })()}
      {confirmDialog}
    </>
  );
}

export function ConnectedExpenses({
  data,
  pathname,
  role,
  refresh,
}: {
  data: ExpenseBundle;
  pathname: string;
  role: Role;
  refresh: () => void;
}) {
  const rows = Array.isArray(data.expenses) ? data.expenses : [],
    sourcePettyRows = Array.isArray(data.pettyCash) ? data.pettyCash : [],
    pettyAttachments = data.pettyAttachments ?? {},
    canCreate = role === "Revisor" || role === "Administrador Sixteam",
    canReadPettyCash = canCreate || role === "Contabilidad";
  const [workId, setWorkId] = useState(data.catalogs.works[0]?.id ?? ""),
    [tagId, setTagId] = useState(data.catalogs.tags[0]?.id ?? ""),
    [date, setDate] = useState(localTodayISO()),
    [concept, setConcept] = useState(""),
    [amount, setAmount] = useState(""),
    [receiptFile, setReceiptFile] = useState<File | null>(null),
    [feedback, setFeedback] = useState(""),
    [busy, setBusy] = useState(false),
    [uploadProgress, setUploadProgress] = useState<AttachmentProgress | null>(null),
    [success, setSuccess] = useState(""),
    [createdId, setCreatedId] = useState(""),
    [localPettyRows, setLocalPettyRows] = useState<PettyRow[]>([]);
  const pettyRows = [
    ...sourcePettyRows,
    ...localPettyRows.filter((local) => !sourcePettyRows.some((row) => row.id === local.id)),
  ];
  // RF-703: obra y periodo (corte mensual, del 1 al 30) ya llegan en el payload
  // autorizado de /api/expenses; caja menor no trae "period" propio, así que se
  // deriva del mismo modo (mes de la fecha). Filtrar en cliente sobre lo ya
  // recibido evita otra ruta para un cruce que cabe en memoria.
  const [expenseWorkFilter, setExpenseWorkFilter] = useState(""),
    [periodFilter, setPeriodFilter] = useState("");
  const filteredRows = rows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!periodFilter || row.period === periodFilter),
  );
  const filteredPettyRows = pettyRows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!periodFilter || row.date.slice(0, 7) === periodFilter),
  );
  const total = filteredRows.reduce(
    (sum, row) => sum + Number(row.total || 0),
    0,
  );
  const pettyTotal = filteredPettyRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
  const clearExpenseFilters = () => {
    setExpenseWorkFilter("");
    setPeriodFilter("");
  };
  // RF-702: subtotal por etiqueta dentro de cada obra sobre las mismas filas ya
  // filtradas por obra/periodo, para que cuadre con el total mostrado arriba.
  const expenseGroups = groupExpensesByWorkAndTag(filteredRows, data.catalogs);
  // RF-305: el backend (validateShares en lib/domain/rules.ts, invocado por
  // ProcurementService.redistribute vía PUT /api/expenses/:id/shares) ya exige que la
  // suma cuadre al peso, sin obra repetida; esta UI solo faltaba para poder invocarlo.
  type ShareLine = { key: string; workId: string; amount: string };
  const newShareLine = (workId = "", amount = ""): ShareLine => ({
    key: crypto.randomUUID(),
    workId,
    amount,
  });
  const [shareExpenseId, setShareExpenseId] = useState<string | null>(null),
    [shareLines, setShareLines] = useState<ShareLine[]>([]),
    [shareBusy, setShareBusy] = useState(false),
    [shareFeedback, setShareFeedback] = useState(""),
    [shareSuccess, setShareSuccess] = useState("");
  const shareExpense = shareExpenseId
    ? rows.find((row) => row.id === shareExpenseId)
    : undefined;
  const openShareForm = (row: ExpenseRow) => {
    setShareExpenseId(row.id);
    setShareLines([newShareLine(row.workId, String(row.total)), newShareLine()]);
    setShareFeedback("");
    setShareSuccess("");
  };
  const closeShareForm = () => {
    setShareExpenseId(null);
    setShareLines([]);
    setShareFeedback("");
    setShareSuccess("");
  };
  const updateShareLine = (key: string, patch: Partial<ShareLine>) =>
    setShareLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const shareWorkIds = shareLines
    .map((line) => line.workId)
    .filter((value) => value);
  const shareHasDuplicateWork =
    new Set(shareWorkIds).size !== shareWorkIds.length;
  const shareTotal = shareLines.reduce(
    (sum, line) => sum + (Number(line.amount) || 0),
    0,
  );
  const shareAllFilled = shareLines.every(
    (line) =>
      line.workId &&
      Number.isInteger(Number(line.amount)) &&
      Number(line.amount) > 0,
  );
  const shareBalanced = shareExpense ? shareTotal === shareExpense.total : false;
  const shareValid = Boolean(
    shareExpense &&
      shareLines.length > 0 &&
      shareAllFilled &&
      !shareHasDuplicateWork &&
      shareBalanced,
  );
  const submitShares = async (event: FormEvent) => {
    event.preventDefault();
    if (!shareExpense || !shareValid || shareBusy) return;
    setShareBusy(true);
    setShareFeedback("");
    setShareSuccess("");
    try {
      await mutate(`/api/expenses/${shareExpense.id}/shares`, "PUT", {
        total: shareExpense.total,
        shares: shareLines.map((line) => ({
          workId: line.workId,
          amount: Number(line.amount),
        })),
      });
      setShareSuccess("El gasto quedó repartido entre las obras seleccionadas.");
      refresh();
    } catch (error) {
      setShareFeedback(
        error instanceof Error ? error.message : "No fue posible repartir el gasto.",
      );
    } finally {
      setShareBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (createdId) {
      setFeedback("La caja menor ya fue creada; consulta la lista para gestionar el soporte pendiente.");
      return;
    }
    if (
      !workId ||
      !tagId ||
      !date ||
      !concept.trim() ||
      !Number.isFinite(Number(amount)) ||
      Number(amount) <= 0
    ) {
      setFeedback(
        "Completa obra, etiqueta, fecha, concepto y un valor mayor a cero.",
      );
      return;
    }
    setBusy(true);
    setFeedback("");
    setSuccess("");
    let createdEntityId = "";
    try {
      const created = (await mutate("/api/petty-cash", "POST", {
        workId,
        tagId,
        date,
        concept: concept.trim(),
        amount: Number(amount),
      })) as { entry?: { id?: string } };
      createdEntityId = created.entry?.id ?? "";
      if (!createdEntityId) throw new Error("El servicio no devolvió el identificador de caja menor.");
      setCreatedId(createdEntityId);
      if (created.entry) setLocalPettyRows((current) => [...current, created.entry as PettyRow]);
      if (receiptFile && created.entry?.id) {
        setUploadProgress({ completed: 0, total: 1, stage: "preparing" });
        await uploadOperationalAttachment({
          entity: "caja_menor",
          entityId: created.entry.id,
          type: "soporte",
          file: receiptFile,
          onProgress: (stage) =>
            setUploadProgress({ completed: 0, total: 1, stage }),
        });
        setUploadProgress({ completed: 1, total: 1, stage: "completing" });
        setSuccess("Caja menor registrada y recibo cargado correctamente.");
      } else {
        setSuccess("Caja menor registrada correctamente.");
      }
      setReceiptFile(null);
      refresh();
    } catch (error) {
      setFeedback(
        createdEntityId
          ? `La caja menor sí fue creada; el recibo quedó pendiente. ${
              error instanceof Error ? error.message : "No fue posible completar la carga."
            }`
          : error instanceof Error
            ? error.message
            : "No fue posible registrar caja menor.",
      );
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title={
          pathname.startsWith("/reportes")
            ? "Reporte operativo"
            : "Gastos por obra"
        }
        description="Lectura autorizada del libro común de gastos, incluidas las entradas de caja menor."
        action={
          pathname.startsWith("/reportes") &&
          [
            "Contabilidad",
            "Administrador Mizar",
            "Administrador Sixteam",
          ].includes(role) ? (
            <a
              className="button button-dark"
              href={`/api/reports/expenses?period=${periodFilter || new Date().toISOString().slice(0, 7)}`}
            >
              Descargar XLSX provisional
            </a>
          ) : undefined
        }
      />
      {(rows.length > 0 || pettyRows.length > 0) && (
        <div className="filter-bar">
          <label className="field">
            <span>Filtrar por obra</span>
            <select
              value={expenseWorkFilter}
              onChange={(event) => setExpenseWorkFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {data.catalogs.works.map((work) => (
                <option key={work.id} value={work.id}>
                  {work.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Periodo</span>
            <input
              type="month"
              value={periodFilter}
              onChange={(event) => setPeriodFilter(event.target.value)}
            />
          </label>
        </div>
      )}
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{money.format(total)}</h2>
              <p className="panel-sub">
                Total de las filas visibles para tu rol.
              </p>
            </div>
            <Tone tone="muted">{filteredRows.length} movimientos</Tone>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
              <h3>Sin gastos visibles</h3>
              <p>El servicio no devolvió movimientos para tu alcance.</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
              <h3>Sin resultados para estos filtros</h3>
              <p>Ajusta o limpia los filtros para ver más gastos.</p>
              <button
                className="button button-secondary"
                type="button"
                onClick={clearExpenseFilters}
              >
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Obra</th>
                    <th>Origen</th>
                    <th>Periodo</th>
                    <th>Total</th>
                    {canCreate && <th>Acciones</th>}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.date}</td>
                      <td>
                        {data.catalogs.works.find(
                          (work) => work.id === row.workId,
                        )?.name ?? row.workId}
                      </td>
                      <td>{originLabel(row.origin)}</td>
                      <td>{row.period}</td>
                      <td>{money.format(row.total)}</td>
                      {canCreate && (
                        <td>
                          <button
                            className="text-link"
                            type="button"
                            data-testid="expense-share-trigger"
                            aria-label={`Repartir gasto del ${row.date} por ${money.format(row.total)}`}
                            onClick={() => openShareForm(row)}
                          >
                            Repartir <ArrowRight aria-hidden="true" size={13} />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {filteredRows.length > 0 && (
          <section className="panel connected-summary" data-testid="expense-subtotals">
            <div className="panel-head">
              <div>
                <h3>Subtotales por obra y etiqueta</h3>
                <p className="panel-sub">
                  Desglose por tipo de gasto dentro de cada obra, con el total general al final.
                </p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Obra</th>
                    <th>Etiqueta</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {expenseGroups.flatMap((group) => [
                    ...group.tags.map((tag, index) => (
                      <tr
                        key={`${group.workId}-${tag.tagId}`}
                        data-testid="expense-subtotal-tag"
                      >
                        <td>{index === 0 ? group.workName : ""}</td>
                        <td>{tag.tagName}</td>
                        <td>{money.format(tag.subtotal)}</td>
                      </tr>
                    )),
                    <tr key={`${group.workId}-subtotal`} data-testid="expense-subtotal-work">
                      <td colSpan={2}>
                        <b>Subtotal {group.workName}</b>
                      </td>
                      <td>
                        <b>{money.format(group.subtotal)}</b>
                      </td>
                    </tr>,
                  ])}
                  <tr data-testid="expense-grand-total">
                    <td colSpan={2}>
                      <b>Total general</b>
                    </td>
                    <td>
                      <b>{money.format(total)}</b>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
        {canCreate && shareExpenseId && shareExpense && (
          <form
            className="panel connected-summary"
            onSubmit={submitShares}
            noValidate
            data-testid="expense-share-form"
          >
            <div className="panel-head">
              <div>
                <h3>Repartir gasto entre obras</h3>
                <p className="panel-sub">
                  Gasto del {shareExpense.date} por {money.format(shareExpense.total)}.
                  La suma de las líneas debe ser idéntica al total, sin obra repetida.
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="Cerrar reparto"
                onClick={closeShareForm}
                disabled={shareBusy}
              >
                <X aria-hidden="true" size={16} />
              </button>
            </div>
            {shareLines.map((line, index) => (
              <div className="field-grid" key={line.key}>
                <label className="field">
                  <span>Obra {index + 1}</span>
                  <select
                    value={line.workId}
                    onChange={(event) =>
                      updateShareLine(line.key, { workId: event.target.value })
                    }
                  >
                    <option value="">Selecciona una obra</option>
                    {data.catalogs.works.map((work) => (
                      <option key={work.id} value={work.id}>
                        {work.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Valor COP</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={line.amount}
                    onChange={(event) =>
                      updateShareLine(line.key, { amount: event.target.value })
                    }
                  />
                </label>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Quitar obra ${index + 1} del reparto`}
                  disabled={shareLines.length === 1}
                  onClick={() =>
                    setShareLines((current) =>
                      current.filter((item) => item.key !== line.key),
                    )
                  }
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </div>
            ))}
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setShareLines((current) => [...current, newShareLine()])}
            >
              <Plus aria-hidden="true" size={14} /> Agregar obra
            </button>
            <p data-testid="expense-share-summary">
              Repartido {money.format(shareTotal)} de {money.format(shareExpense.total)}
              {shareExpense.total !== shareTotal
                ? shareExpense.total > shareTotal
                  ? ` · faltan ${money.format(shareExpense.total - shareTotal)}`
                  : ` · sobran ${money.format(shareTotal - shareExpense.total)}`
                : ""}
            </p>
            {shareHasDuplicateWork && (
              <p className="field-error" role="alert">
                Cada obra debe aparecer una sola vez en el reparto.
              </p>
            )}
            {shareFeedback && (
              <p className="field-error" role="alert">
                {shareFeedback}
              </p>
            )}
            {shareSuccess && (
              <p className="field-success" role="status">
                {shareSuccess}
              </p>
            )}
            <div className="form-footer">
              <button
                className="button button-dark"
                type="submit"
                disabled={!shareValid || shareBusy}
              >
                {shareBusy ? "Guardando…" : "Confirmar reparto"}
              </button>
            </div>
          </form>
        )}
        {canReadPettyCash && (
          <section className="panel connected-summary petty-cash-list">
            <div className="panel-head">
              <div>
                <h2>Caja menor</h2>
                <p className="panel-sub">
                  Movimientos registrados por el servicio.
                </p>
              </div>
              <Tone tone="muted">{money.format(pettyTotal)}</Tone>
            </div>
            {pettyRows.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
                <h3>Sin movimientos de caja menor</h3>
                <p>
                  Los registros aparecerán aquí después de una captura
                  autorizada.
                </p>
              </div>
            ) : filteredPettyRows.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
                <h3>Sin resultados para estos filtros</h3>
                <p>Ajusta o limpia los filtros para ver más movimientos.</p>
                <button
                  className="button button-secondary"
                  type="button"
                  onClick={clearExpenseFilters}
                >
                  Limpiar filtros
                </button>
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Fecha</th>
                      <th>Concepto</th>
                      <th>Obra</th>
                      <th>Valor</th>
                      <th>Soporte</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPettyRows.map((row) => (
                      <tr key={row.id}>
                        <td>{row.date}</td>
                        <td>{row.concept}</td>
                        <td>
                          {data.catalogs.works.find(
                            (work) => work.id === row.workId,
                          )?.name ?? row.workId}
                        </td>
                        <td>{money.format(row.amount)}</td>
                        <td>
                          {(pettyAttachments[row.id] ?? []).map((attachment) => (
                            <a
                              className="text-link"
                              key={attachment.id}
                              href={`/api/attachments/caja_menor/${encodeURIComponent(row.id)}/${encodeURIComponent(attachment.id)}/download`}
                              download={attachment.name}
                            >
                              {attachment.name}
                            </a>
                          ))}
                          {!pettyAttachments[row.id]?.length && <span className="muted-copy">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
        {canCreate && !pathname.startsWith("/reportes") && (
          <form
            className="panel connected-summary"
            onSubmit={submit}
            noValidate
          >
            <h3>Registrar caja menor</h3>
            <label className="field">
              <span>Obra</span>
              <select
                required
                value={workId}
                aria-invalid={Boolean(feedback && !workId)}
                aria-describedby="petty-cash-error"
                onChange={(event) => setWorkId(event.target.value)}
              >
                {data.catalogs.works.map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Etiqueta</span>
              <select
                required
                value={tagId}
                aria-invalid={Boolean(feedback && !tagId)}
                aria-describedby="petty-cash-error"
                onChange={(event) => setTagId(event.target.value)}
              >
                {data.catalogs.tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Fecha</span>
              <input
                required
                type="date"
                value={date}
                aria-invalid={Boolean(feedback && !date)}
                aria-describedby="petty-cash-error"
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Concepto</span>
              <textarea
                required
                maxLength={500}
                value={concept}
                aria-invalid={Boolean(feedback && !concept.trim())}
                aria-describedby="petty-cash-error"
                onChange={(event) => setConcept(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Valor COP</span>
              <input
                required
                type="number"
                min="1"
                step="1"
                value={amount}
                aria-invalid={Boolean(
                  feedback &&
                    (!Number.isFinite(Number(amount)) || Number(amount) <= 0),
                )}
                aria-describedby="petty-cash-error"
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <AttachmentPicker
              id="petty-cash-receipt"
              label="Recibo o soporte (opcional)"
              help="PDF, JPG, PNG o WebP · máximo 10 MB"
              file={receiptFile}
              onFile={setReceiptFile}
              onError={setFeedback}
              disabled={busy}
            />
            {success && (
              <div className="attachment-success" role="status">
                <p className="field-success">{success}</p>
                <button className="button button-secondary" type="button" onClick={refresh}>
                  Actualizar lista
                </button>
              </div>
            )}
            {uploadProgress && busy && (
              <p className="muted-copy" role="status">
                {uploadProgress.stage === "preparing"
                  ? "Preparando recibo…"
                  : uploadProgress.stage === "uploading"
                    ? "Cargando recibo…"
                    : "Confirmando recibo…"}{" "}
                ({uploadProgress.completed}/{uploadProgress.total})
              </p>
            )}
            {feedback && (
              <div className="attachment-error" role="alert" id="petty-cash-error">
                <p className="field-error">{feedback}</p>
                {createdId && (
                  <button className="button button-secondary" type="button" onClick={refresh}>
                    Actualizar lista
                  </button>
                )}
              </div>
            )}
            <button
              className="button button-dark"
              disabled={busy || Boolean(createdId) || !workId || !tagId}
              type="submit"
            >
              {busy ? "Registrando…" : "Registrar gasto"}
            </button>
          </form>
        )}
      </div>
    </>
  );
}
