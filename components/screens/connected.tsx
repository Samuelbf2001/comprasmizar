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
  Inbox,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Truck,
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
import { SectionTitle, Tone } from "./screen-primitives";
import { ConnectedCatalogAdmin } from "./catalog-admin";
import {
  AttachmentPicker,
  IMAGE_MIME_TYPES,
  uploadSignedAttachment,
  type AttachmentMetadata,
} from "./attachment-upload";
import { RouteSkeleton, type RouteKind } from "./skeletons";

// RF-1105 (percepción de carga): mientras carga se distingue el esqueleto de ESA ruta
// (`kind`) de un error o de datos ya listos; en "ready" `revalidating` marca que hay
// datos previos visibles mientras se refresca en segundo plano (stale-while-revalidate).
type LoadState =
  | { state: "loading"; kind: RouteKind }
  | { state: "error"; message: string }
  | { state: "ready"; data: unknown; revalidating: boolean };
type ConnectedProps = {
  pathname: string;
  role: Role;
  go: (path: string) => void;
};
type NamedOption = { id: string; name: string };
type CatalogData = {
  works: NamedOption[];
  tags: NamedOption[];
  suppliers: NamedOption[];
  items: Array<NamedOption & { unit: string; status: string }>;
  features: Record<string, boolean>;
  societies?: NamedOption[];
  approvers?: NamedOption[];
  access?: Record<string, boolean>;
};
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
};
type RequisitionRow = {
  id: string;
  consecutive: string;
  type: "compra" | "pago";
  workId: string;
  requesterId?: string;
  externalRequester?: { name: string; phone?: string };
  channel: string;
  requiredDate: string;
  destination?: string;
  observations?: string;
  tagId?: string;
  approverId?: string;
  status: string;
  returnReason?: string;
  declineReason?: string;
  items: RequisitionItem[];
};
type OrderRow = {
  id: string;
  consecutive: string;
  type: "OC" | "OP";
  requisitionId: string;
  supplierId?: string;
  status: string;
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
type RequisitionsBundle = { rows: RequisitionRow[]; catalogs: CatalogData };
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
  const workName = (id: string) =>
    catalogs.works.find((work) => work.id === id)?.name ?? id;
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
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const value = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "Tu rol no tiene permiso para consultar estos datos."
        : response.status === 401
          ? "La sesión expiró. Vuelve a iniciar sesión."
          : value?.message || "No fue posible consultar el servicio.",
    );
  return value;
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
    const [rows, catalogs] = await Promise.all([
      readJson("/api/requisitions"),
      readJson("/api/catalogs"),
    ]);
    return {
      rows: rows as RequisitionRow[],
      catalogs: catalogs as CatalogData,
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
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(
      value?.message ||
        (response.status === 403
          ? "No tienes permiso para esta acción."
          : "La operación no pudo completarse."),
    );
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
                message:
                  error instanceof Error ? error.message : "Fallo de consulta.",
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
          <span className="empty-icon">!</span>
          <h3>No pudimos cargar esta vista</h3>
          <p>{load.message}</p>
          <button
            className="button button-dark"
            type="button"
            onClick={refresh}
          >
            <RefreshCw size={15} /> Reintentar
          </button>
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
            <BarChart3 size={20} />
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
                <Bar dataKey="total" fill="#245645" radius={[0, 4, 4, 0]} />
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
            <BarChart3 size={20} />
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
                  stroke="#e3e6df"
                />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                <YAxis hide />
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
                <Bar dataKey="total" fill="#235e83" radius={[4, 4, 0, 0]} />
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
  const workName = (id?: string) =>
    (id && catalogs.works.find((work) => work.id === id)?.name) || id || "—";
  const tagName = (key: string) =>
    key
      ? (catalogs.tags.find((tag) => tag.id === key)?.name ?? key)
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
        eyebrow="Datos conectados"
        title="Pulso de compras"
        description="Métricas calculadas por el servicio para tu rol y el periodo actual."
      />
      <div className="stats-grid">
        <article className="stat-card stat-amber">
          <span className="stat-icon"><Inbox size={17} /></span>
          <span className="stat-label">En revisión</span>
          <strong>{metrics.byStatus?.en_revision ?? 0}</strong>
          <span className="stat-meta">requisiciones visibles</span>
        </article>
        <article className="stat-card stat-blue">
          <span className="stat-icon"><CheckCircle2 size={17} /></span>
          <span className="stat-label">En aprobación</span>
          <strong>{metrics.byStatus?.en_aprobacion ?? 0}</strong>
          <span className="stat-meta">{money.format(metrics.inProcessValue ?? 0)}</span>
        </article>
        <article className="stat-card stat-orange">
          <span className="stat-icon"><Truck size={17} /></span>
          <span className="stat-label">Compras pendientes</span>
          <strong>{metrics.pendingOrders ?? 0}</strong>
          <span className="stat-meta">generadas o no cumplidas</span>
        </article>
        <article className="stat-card stat-forest">
          <span className="stat-icon"><BarChart3 size={17} /></span>
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
                <Inbox size={20} />
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
                    <Truck size={16} />
                  ) : (
                    <Inbox size={16} />
                  )}
                </span>
                <span>
                  <strong>
                    {item.consecutive} · {item.action}
                  </strong>
                  <small>
                    {workName(item.workId)} ·{" "}
                    {item.status.replaceAll("_", " ")}
                  </small>
                </span>
                <ArrowRight size={15} />
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
                <RefreshCw size={20} />
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
                        {item.status.replaceAll("_", " ")}
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
        <ShieldCheck size={18} />
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
  type: "soporte" | "foto";
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
  const [type, setType] = useState<"compra" | "pago">("compra"),
    [workId, setWorkId] = useState(catalogs.works[0]?.id ?? ""),
    [requiredDate, setRequiredDate] = useState(
      new Date().toISOString().slice(0, 10),
    );
  const [destination, setDestination] = useState(""),
    [observations, setObservations] = useState(""),
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
    if (!workId || !requiredDate || invalidLine) {
      setFeedback(
        !workId || !requiredDate
          ? "Selecciona la obra y la fecha requerida."
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
        workId,
        requiredDate,
        ...(destination.trim() ? { destination: destination.trim() } : {}),
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
        eyebrow="Captura interna conectada"
        title="Nueva requisición"
        description="Los datos se validan y guardan en una sola transacción; los ítems nuevos quedan pendientes de normalización."
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
              <span>Obra</span>
              <select
                required
                value={workId}
                aria-invalid={Boolean(feedback && !workId)}
                onChange={(event) => setWorkId(event.target.value)}
              >
                <option value="">Selecciona una obra</option>
                {catalogs.works.map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Fecha requerida</span>
              <input
                required
                type="date"
                value={requiredDate}
                onChange={(event) => setRequiredDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Frente o actividad</span>
              <input
                maxLength={500}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>Observaciones</span>
              <textarea
                maxLength={3000}
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
              <Plus size={14} /> Agregar ítem
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
                  <Trash2 size={15} />
                </button>
              </fieldset>
            ))}
          </div>
        </div>
        <div className="form-footer">
          {feedback ? (
            <p className="field-error" role="alert">
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
          ) : (
            <span>Los valores cotizados se completan durante la revisión.</span>
          )}
          {createdId && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => go(`/requisiciones/${createdId}`)}
            >
              Ver requisición <ArrowRight size={14} />
            </button>
          )}
          <button
            className="button button-dark"
            disabled={busy || Boolean(createdId) || !catalogs.works.length}
            type="submit"
          >
            {busy ? "Guardando…" : "Crear requisición"} <ArrowRight size={14} />
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
            <input type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
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
  const rows = Array.isArray(data?.rows)
    ? data.rows.filter((row) =>
        pathname.startsWith("/revision")
          ? ["enviada", "en_revision", "devuelta"].includes(row.status)
          : pathname.startsWith("/aprobaciones")
            ? row.status === "en_aprobacion"
            : true,
      )
    : [];
  const title = pathname.startsWith("/revision")
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
        eyebrow="Datos conectados"
        title={title}
        description="La API aplica alcance por actor antes de devolver cada fila."
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
                  {status.replaceAll("_", " ")}
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
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{filteredRows.length} visibles</h2>
            <p className="panel-sub">
              Sin datos sintéticos ni mezcla entre roles.
            </p>
          </div>
          <Tone tone="muted">Orden cronológico</Tone>
        </div>
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">—</span>
            <h3>Sin requisiciones en esta vista</h3>
            <p>El resultado proviene del backend autenticado.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">—</span>
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
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requisición</th>
                  <th>Obra</th>
                  <th>Tipo</th>
                  <th>Canal</th>
                  <th>Etiqueta</th>
                  <th>Fecha requerida</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={
                      pathname.startsWith("/revision")
                        ? "active-requisition"
                        : undefined
                    }
                  >
                    <td>
                      <b>{row.consecutive}</b>
                    </td>
                    <td>
                      {catalogs.works.find((work) => work.id === row.workId)
                        ?.name ?? row.workId}
                    </td>
                    <td>{row.type}</td>
                    <td>{row.channel}</td>
                    <td>
                      {row.tagId
                        ? (catalogs.tags.find((tag) => tag.id === row.tagId)
                            ?.name ?? row.tagId)
                        : "—"}
                    </td>
                    <td>{row.requiredDate ? formatIsoDate(row.requiredDate) : "—"}</td>
                    <td>{row.status.replaceAll("_", " ")}</td>
                    <td>
                      <button
                        className="text-link"
                        type="button"
                        onClick={() => go(`/requisiciones/${row.id}`)}
                      >
                        Abrir <ArrowRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    [lines, setLines] = useState<RequisitionItem[]>(requisition?.items ?? []),
    [supplierOptions, setSupplierOptions] = useState<NamedOption[]>(
      catalogs.suppliers,
    ),
    [comment, setComment] = useState(""),
    [multiSupplier, setMultiSupplier] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [supplierStatus, setSupplierStatus] = useState(""),
    [quickSupplierItemId, setQuickSupplierItemId] = useState<string | null>(
      null,
    ),
    [quickSupplierName, setQuickSupplierName] = useState(""),
    [quickSupplierNit, setQuickSupplierNit] = useState(""),
    [quickSupplierError, setQuickSupplierError] = useState(""),
    [quickSupplierBusy, setQuickSupplierBusy] = useState(false);
  const quickSupplierNameRef = useRef<HTMLInputElement | null>(null),
    quickSupplierDialogRef = useRef<HTMLFormElement | null>(null),
    quickSupplierTriggerRef = useRef<HTMLButtonElement | null>(null),
    quickSupplierWasOpen = useRef(false),
    quickSupplierSubmitting = useRef(false);
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
  const supplierGroups = [
      ...new Set(
        lines
          .map((item) => item.finalSupplierId)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    multiSupplierEnabled = catalogs.features.ordenes_multi_proveedor === true;
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
                {catalogs.works.find((work) => work.id === requisition.workId)
                  ?.name ?? requisition.workId}
              </p>
            </div>
            <Tone tone="muted">
              <span data-testid="requisition-status">
                {requisition.status.replaceAll("_", " ")}
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
              {lines.map((line) => (
                <fieldset className="review-line" key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)
                        ?.name ||
                      "Ítem"}
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
                  <label className="field">
                    <span>IVA unitario COP</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={line.unitIva ?? 0}
                      onChange={(event) =>
                        updateLine(line.id, {
                          unitIva: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <strong>
                    {money.format(
                      line.quantity *
                        ((line.unitBase ?? 0) + (line.unitIva ?? 0)),
                    )}
                  </strong>
                </fieldset>
              ))}
              {supplierStatus && (
                <p className="field-success" role="status">
                  {supplierStatus}
                </p>
              )}
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={busy || !tagId}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "review",
                      tagId,
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
                          unitIva,
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
                          unitIva: Math.round(unitIva ?? 0),
                        }),
                      ),
                    })
                  }
                >
                  Guardar revisión
                </button>
                <button
                  className="button button-dark"
                  disabled={busy || requisition.status === "devuelta" || !tagId}
                  type="button"
                  onClick={() => void run({ action: "send_for_approval" })}
                >
                  Enviar a aprobación
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
                    <th>IVA unit.</th>
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
                      <td>{money.format(item.unitIva ?? 0)}</td>
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
                <dd>{requisition.status.replaceAll("_", " ")}</dd>
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
                    : requisition.requesterId
                      ? `Usuario ${requisition.requesterId}`
                      : "—"}
                </dd>
              </div>
              <div>
                <dt>Destino</dt>
                <dd>{requisition.destination || "—"}</dd>
              </div>
              <div>
                <dt>Observaciones</dt>
                <dd>{requisition.observations || "—"}</dd>
              </div>
            </dl>
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
                  <button
                    className="button button-danger"
                    disabled={busy || !comment.trim()}
                    type="button"
                    onClick={() =>
                      void run({ action: "decline", reason: comment })
                    }
                  >
                    Declinar
                  </button>
                </>
              )}
            {isApprover && requisition.status === "en_aprobacion" && (
              <>
                {multiSupplierEnabled && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={multiSupplier}
                      onChange={(event) =>
                        setMultiSupplier(event.target.checked)
                      }
                    />{" "}
                    Dividir OC por proveedor (Completo)
                  </label>
                )}
                <button
                  className="button button-dark"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "approve",
                      multiSupplier: multiSupplierEnabled && multiSupplier,
                    })
                  }
                >
                  Aprobar y generar orden
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
          {supplierGroups.length > 0 && (
            <section className="panel connected-summary">
              <h3>Asignación por proveedor</h3>
              {supplierGroups.map((supplierId) => (
                <p key={supplierId} data-testid="supplier-allocation">
                  {supplierOptions.find(
                    (supplier) => supplier.id === supplierId,
                  )?.name ?? supplierId}
                </p>
              ))}
            </section>
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
          <section className="panel connected-summary">
            <h3>Soportes y fotos</h3>
            {attachments.length ? (
              <div className="attachment-list">
                {attachments.map((attachment) => (
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
            <h3>Historial de trazabilidad</h3>
            {history.length ? (
              history.map((entry, index) => (
                <p key={`${entry.at}-${index}`} data-testid="audit-event">
                  <b>{entry.event.replaceAll("_", " ")}</b> ·{" "}
                  {new Date(entry.at).toLocaleString("es-CO")} ·{" "}
                  {/* RF-405: AuditEvent.actorId ya viajaba en el JSON del historial; sin
                      esto la trazabilidad no decía qué usuario ejecutó cada transición. */}
                  <span data-testid="audit-actor">
                    {entry.actorId ? `Usuario ${entry.actorId}` : "Usuario automático"}
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
                ×
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
    </>
  );
}

export function ConnectedOrders({
  data,
  role,
  refresh,
}: {
  data: OrdersBundle;
  role: Role;
  refresh: () => void;
}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [],
    requisitions = Array.isArray(data?.requisitions) ? data.requisitions : [],
    catalogs = data?.catalogs ?? emptyCatalogs,
    [feedback, setFeedback] = useState(""),
    canUpdate = role === "Revisor" || role === "Administrador Sixteam";
  // La orden no guarda obra ni fecha propias (solo requisicion_id): se derivan
  // uniendo con /api/requisitions, que ya llega autorizado para todo rol que
  // puede leer órdenes. Evita tocar el dominio/infraestructura solo por un filtro.
  const requisitionById = new Map(
    requisitions.map((requisition) => [requisition.id, requisition]),
  );
  const [workFilter, setWorkFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    [supplierFilter, setSupplierFilter] = useState(""),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState("");
  const statusOptions = Array.from(
    new Set(rows.map((row) => row.status)),
  ).sort();
  const filteredRows = rows.filter((row) => {
    const linked = requisitionById.get(row.requisitionId);
    if (workFilter && linked?.workId !== workFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
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
    setSupplierFilter("");
    setDateFrom("");
    setDateTo("");
  };
  const setStatus = async (id: string, status: string) => {
    setFeedback("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { status });
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar la orden.",
      );
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
            <span>Estado</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {status.replaceAll("_", " ")}
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
        </div>
      )}
      <section className="panel">
        {feedback && (
          <p className="field-error connected-feedback" role="alert">
            {feedback}
          </p>
        )}
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">—</span>
            <h3>Sin órdenes visibles</h3>
            <p>El servicio no devolvió órdenes para tu alcance.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">—</span>
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
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const linked = requisitionById.get(row.requisitionId);
                  return (
                    <tr key={row.id}>
                      <td>
                        <b>{row.consecutive}</b>
                      </td>
                      <td>{row.type}</td>
                      <td>
                        {linked
                          ? (catalogs.works.find(
                              (work) => work.id === linked.workId,
                            )?.name ?? linked.workId)
                          : "—"}
                      </td>
                      <td>{linked?.consecutive ?? row.requisitionId}</td>
                      <td>{linked?.requiredDate || "—"}</td>
                      <td>
                        {row.supplierId
                          ? (catalogs.suppliers.find(
                              (supplier) => supplier.id === row.supplierId,
                            )?.name ?? row.supplierId)
                          : "Por definir"}
                      </td>
                      <td>{row.status.replaceAll("_", " ")}</td>
                      <td>
                        {canUpdate && row.status === "generada" ? (
                          <select
                            aria-label={`Cumplimiento de ${row.consecutive}`}
                            defaultValue=""
                            onChange={(event) =>
                              event.target.value &&
                              void setStatus(row.id, event.target.value)
                            }
                          >
                            <option value="">Actualizar…</option>
                            <option value="cumplida">Cumplida</option>
                            <option value="no_cumplida">No cumplida</option>
                            <option value="no_necesario">No necesaria</option>
                          </select>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
    [date, setDate] = useState(new Date().toISOString().slice(0, 10)),
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
              <span className="empty-icon">—</span>
              <h3>Sin gastos visibles</h3>
              <p>El servicio no devolvió movimientos para tu alcance.</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">—</span>
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
                      <td>{row.origin.replaceAll("_", " ")}</td>
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
                            Repartir <ArrowRight size={13} />
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
                ×
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
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setShareLines((current) => [...current, newShareLine()])}
            >
              <Plus size={14} /> Agregar obra
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
                <span className="empty-icon">—</span>
                <h3>Sin movimientos de caja menor</h3>
                <p>
                  Los registros aparecerán aquí después de una captura
                  autorizada.
                </p>
              </div>
            ) : filteredPettyRows.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon">—</span>
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
              <div className="attachment-error" role="alert">
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
