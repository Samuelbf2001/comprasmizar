// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): capa de datos sin React —
// resolución de ruta, caché en memoria por pathname y mutaciones. Extraído tal cual de
// components/screens/connected.tsx (hoy un barrel); misma lógica, mismos nombres, con
// `export` añadido en las funciones que ahora cruzan el límite de módulo hacia screen.tsx
// y hacia cada pantalla (dashboard.tsx, new-requisition.tsx, requisitions.tsx, detail.tsx,
// orders.tsx, expenses.tsx).
//
// Fase 3 cliente (docs/plan-rendimiento.md, hallazgos H2/H3/H6): `loadRoute` pasa a consumir
// los endpoints compuestos/paginados que la Fase 3 de servidor ya dejó listos (ver el propio
// plan, sección "Fase 1/Fase 3 — endpoints nuevos"); los catálogos ganan una caché propia por
// sesión (TTL 5 min, deduplicada) separada del caché de rutas; y `mutate` deja de vaciar TODA
// la caché tras cualquier escritura — invalida solo los tipos de ruta que esa URL puede afectar.
import type { Role } from "../../../lib/demo-data";
import { apiRequest } from "../../../lib/http/friendly-error";
import type { RouteKind } from "../skeletons";
import { permisosDelVisor, type ViewerPermissions } from "./shared";
import type {
  AttachmentRow,
  AuditRow,
  CatalogData,
  DashboardBundle,
  DashboardMetricsPayload,
  DetailBundle,
  ExpenseBundle,
  ExpenseRow,
  IncomeRow,
  LoadState,
  OrderRow,
  OrdersBundle,
  PettyRow,
  ReportBundle,
  ReportRow,
  RequisitionRow,
  RequisitionsBundle,
} from "./shared";

export function routeKind(pathname: string): RouteKind | undefined {
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
  if (pathname.startsWith("/gastos")) return "expenses";
  // RF-1301 (Reportes, reunión 2026-09-11): /reportes tenía el mismo RouteKind que /gastos ("expenses")
  // y reutilizaba ConnectedExpenses con un puñado de `if (pathname.startsWith("/reportes"))` — el reporte
  // de requisiciones (filtros por aprobador/etiqueta, Excel, compilado mensual) necesita su propio bundle
  // (consecutivo, aprobador(es), estado, ítems — nada de eso vive en /api/expenses), así que gana su
  // propio kind en vez de seguir forzando dos pantallas distintas dentro de la misma.
  if (pathname.startsWith("/reportes")) return "reports";
  if (pathname.startsWith("/catalogos") || pathname.startsWith("/proveedores"))
    return "catalogs";
}

async function readJson(url: string): Promise<unknown> {
  return apiRequest(url, { cache: "no-store" });
}

// H3 (docs/plan-rendimiento.md, Fase 3): a qué estados filtra cada bandeja de requisiciones en
// el servidor (antes se descargaban TODAS y se filtraba en cliente). `/revision` necesita
// también `aprobada` (no solo enviada/en_revision/devuelta) porque requisitions.tsx separa, de
// ese mismo conjunto, el grupo "Listas para generar orden" (BLOQUEANTE 2). `/requisiciones/mis`
// no filtra por estado: un solicitante debe ver el ciclo completo de las suyas.
export function requisitionsStatusFilter(pathname: string): string | undefined {
  if (pathname.startsWith("/revision")) return "enviada,en_revision,devuelta,aprobada";
  if (pathname.startsWith("/aprobaciones")) return "en_aprobacion";
  return undefined;
}

const REQUISITIONS_PAGE_LIMIT = 100;

function requisitionsPageUrl(pathname: string, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(REQUISITIONS_PAGE_LIMIT) });
  const status = requisitionsStatusFilter(pathname);
  if (status) params.set("status", status);
  if (cursor) params.set("cursor", cursor);
  return `/api/requisitions?${params.toString()}`;
}

// «Aprobar desde la lista»: `viewerId` viaja igual que en el detalle (ver el comentario del GET en
// app/api/requisitions/route.ts) — opcional porque `loadMoreRequisitions` reusa este mismo tipo y
// a esa llamada (solo rows/nextCursor le importan) no le hace falta declararlo.
type RequisitionsPage = { rows: RequisitionRow[]; nextCursor: string | null; viewerId?: string };

// Usado por requisitions.tsx para el botón "Cargar más": misma URL/filtro que la carga inicial,
// con el cursor de la página siguiente.
export async function loadMoreRequisitions(
  pathname: string,
  cursor: string,
): Promise<RequisitionsPage> {
  return (await readJson(requisitionsPageUrl(pathname, cursor))) as RequisitionsPage;
}

// DECISIÓN DE ERNESTO (2026-09-17): la interfaz decide por PERMISO EFECTIVO, no por nombre de rol.
// Los permisos llegan en el bootstrap de catálogos (ver GET app/api/catalogs/route.ts) y de ahí SUBEN
// al nivel del bundle, que es lo que recibe cada pantalla.
function permisosDelBootstrap(catalogs: unknown): ViewerPermissions {
  const payload = (catalogs ?? {}) as ViewerPermissions;
  return { viewerPermissions: payload.viewerPermissions, rolePermissions: payload.rolePermissions };
}

export async function loadRoute(pathname: string, role: Role): Promise<unknown> {
  const kind = routeKind(pathname);
  // La pantalla de catálogos no pasa por este bootstrap (tiene el suyo, /api/catalogs/manage) y se
  // sirve tal cual; pedirle además /api/catalogs sería una llamada que hoy no hace.
  if (kind === "catalogs") return readJson("/api/catalogs/manage");
  const bundle = (await routeBundle(pathname, role, kind)) as Record<string, unknown>;
  // Los permisos se pegan AQUÍ, una sola vez y para TODOS los `kind`, justo por el hallazgo H3: la
  // normalización del detalle rearma el bundle campo a campo y ya se comió una vez `viewerId`/
  // `viewerRoles`. Añadirlos en cada rama volvería a dejar ese error al alcance de un descuido.
  return { ...bundle, ...permisosDelBootstrap(await getCatalogs()) };
}

async function routeBundle(pathname: string, role: Role, kind: RouteKind | undefined): Promise<unknown> {
  if (kind === "dashboard") {
    // RF-1102/RF-706/RF-1103: se agrega /api/catalogs (ya accesible para cualquier rol autenticado,
    // ver GET en app/api/catalogs/route.ts) solo para resolver nombres de obra/etiqueta en la cola de
    // atención, la actividad reciente y los gráficos; /api/dashboard sigue siendo la única fuente de
    // autorización y cifras.
    const [metrics, catalogs] = await Promise.all([
      readJson(`/api/dashboard?period=${new Date().toISOString().slice(0, 7)}`),
      getCatalogs(),
    ]);
    return {
      metrics: metrics as DashboardMetricsPayload,
      catalogs: catalogs as CatalogData,
    } satisfies DashboardBundle;
  }
  if (kind === "new") return getCatalogs();
  if (kind === "detail") {
    // H2: un único GET compuesto (`/api/requisitions/:id/detail`) reemplaza lo que antes eran
    // 4 llamadas en paralelo (requisición, órdenes completas, gastos completos, historial) MÁS
    // una por ítem para adjuntos (1+N). El servidor ya filtra órdenes/gastos a esta requisición
    // (orders.listByRequisition/expenses.listByReference) y ya alcanza por permiso
    // (order:read/expense:read) — no hace falta repetir ningún filtro en cliente. Los adjuntos
    // llegan con `entity`/`entityId` por fila (requisicion o requisicion_item), listos para usar
    // tal cual en detail.tsx (requesterAttachments/quoteAttachments).
    const id = encodeURIComponent(pathname.split("/").pop() ?? "");
    const [detail, catalogs] = await Promise.all([
      readJson(`/api/requisitions/${id}/detail`),
      getCatalogs(),
    ]);
    const payload = detail as {
      requisition: RequisitionRow;
      orders: OrderRow[];
      expenses: ExpenseRow[];
      history: AuditRow[];
      attachments: AttachmentRow[];
      viewerId?: string;
      viewerRoles?: DetailBundle["viewerRoles"];
    };
    // QA H3: sin `viewerId`/`viewerRoles` el detalle no sabe quién mira — «Aprobar yo mismo» no se
    // pintaba nunca y el maestro no veía las acciones de aprobación de lo que tiene asignado.
    return {
      requisition: payload.requisition,
      viewerId: payload.viewerId,
      viewerRoles: payload.viewerRoles,
      catalogs: catalogs as CatalogData,
      orders: payload.orders,
      expenses: payload.expenses,
      history: payload.history,
      attachments: payload.attachments,
    } satisfies DetailBundle;
  }
  if (kind === "requisitions") {
    // BLOQUEANTE 2: sin las órdenes no hay forma de distinguir, en /revision, una `aprobada`
    // que ya generó su(s) orden(es) de una que sigue esperando el paso "Generar órdenes" (que
    // vive en el detalle). H2/H3: `/api/orders` solo se pide en /revision (el único lugar donde
    // requisitions.tsx lo usa, ver readyForOrderRows) — /aprobaciones y /requisiciones/mis ya no
    // lo descargan para nada. `/api/requisitions` pasa a pedirse paginado (100 filas) y filtrado
    // por estado en el servidor en vez de traer TODA la bandeja para filtrar en cliente.
    const isRevision = pathname.startsWith("/revision");
    // Quién puede leer órdenes lo dice "order:read", no la lista de nombres de rol que estaba clavada
    // aquí: sin permiso, `/api/orders` responde 403 y tumbaría la bandeja entera. Se encadena a los
    // catálogos (que traen los permisos) en vez de esperarlos: la página de requisiciones sigue
    // pidiéndose en paralelo, y los catálogos están en caché de sesión casi siempre.
    const catalogsRequest = getCatalogs();
    const ordersRequest = isRevision
      ? catalogsRequest.then((loaded) =>
          permisosDelVisor(permisosDelBootstrap(loaded), role)("order:read")
            ? readJson("/api/orders")
            : [],
        )
      : Promise.resolve([]);
    const [page, catalogs, orders] = await Promise.all([
      readJson(requisitionsPageUrl(pathname)),
      catalogsRequest,
      ordersRequest,
    ]);
    const { rows, nextCursor, viewerId } = page as RequisitionsPage;
    return {
      rows,
      nextCursor,
      viewerId,
      catalogs: catalogs as CatalogData,
      orders: orders as OrderRow[],
    } satisfies RequisitionsBundle;
  }
  if (kind === "orders") {
    // H2/H3: ya no se descargan TODAS las requisiciones solo para resolver el consecutivo y la
    // obra de cada orden — `requisitionConsecutive`/`workId` ya viajan en cada `OrderRow` (join
    // en el mismo SELECT, ver `order(row)` en lib/infrastructure/postgres-repositories.ts).
    // orders.tsx carga bajo demanda (al abrir la ficha de una orden) los ítems con precio de su
    // requisición de origen, igual que ya hace con el expediente del proveedor.
    const [rows, catalogs] = await Promise.all([
      readJson("/api/orders"),
      getCatalogs(),
    ]);
    return {
      rows: rows as OrderRow[],
      catalogs: catalogs as CatalogData,
    } satisfies OrdersBundle;
  }
  if (kind === "expenses") {
    // Adenda de pagos (A10): "Cierre de caja" consulta los pagos por caja bajo demanda
    // (`/api/reports/cash-close?from&to`, ver expenses.tsx); aquí solo viaja el libro de gastos con
    // sus catálogos. Caja menor directa, ingresos y adjuntos de caja_menor ya no se piden (rutas
    // retiradas con 410); los campos siguen en el bundle, vacíos, para no tocar shared.tsx.
    const [expenses, catalogs] = await Promise.all([
      readJson("/api/expenses"),
      getCatalogs(),
    ]);
    return {
      expenses: expenses as ExpenseRow[],
      catalogs: catalogs as CatalogData,
      pettyCash: [] as PettyRow[],
      pettyAttachments: {},
      incomes: [] as IncomeRow[],
    } satisfies ExpenseBundle;
  }
  if (kind === "reports") {
    // RF-1301 (Reportes): igual que /gastos, se trae TODO lo visible para el actor (visibilidad ya
    // acotada en el servidor, ver ReportService.listReport) y los cuatro filtros (obra, mes, aprobador,
    // etiqueta) se aplican en cliente sobre esta misma colección — el mismo criterio que ya usa
    // ConnectedExpenses para obra/periodo, así que un cambio de filtro no dispara una llamada nueva.
    const [report, catalogs] = await Promise.all([
      readJson("/api/reports"),
      getCatalogs(),
    ]);
    return {
      rows: (report as { rows: ReportRow[] }).rows,
      catalogs: catalogs as CatalogData,
    } satisfies ReportBundle;
  }
  throw new Error("Ruta operativa no soportada.");
}

// H2/H6 (docs/plan-rendimiento.md): los catálogos (`/api/catalogs`) casi no cambian dentro de
// una sesión (obras/etiquetas/proveedores/ítems no varían minuto a minuto) pero HOY se piden en
// cada ruta con `cache: "no-store"` — 6 pantallas visitadas seguidas piden lo mismo 6 veces.
// Slot de módulo PROPIO, separado de `routeCache` a propósito: `clearRouteCache()` (tras
// aprobar/declinar/crear/etc.) NO debe tocar los catálogos, solo `invalidateCatalogs()` (tras
// una mutación de catálogo/proveedor, ver `mutate` más abajo). TTL de 5 minutos; mientras hay una
// petición en vuelo, cualquier ruta que la pida en paralelo recibe la MISMA promesa (dedup).
const CATALOGS_TTL_MS = 5 * 60_000;
let catalogsCache: { data: unknown; fetchedAt: number } | null = null;
let catalogsInFlight: Promise<unknown> | null = null;

function getCatalogs(): Promise<unknown> {
  if (catalogsCache && Date.now() - catalogsCache.fetchedAt < CATALOGS_TTL_MS) {
    return Promise.resolve(catalogsCache.data);
  }
  if (catalogsInFlight) return catalogsInFlight;
  const request = readJson("/api/catalogs")
    .then((data) => {
      catalogsCache = { data, fetchedAt: Date.now() };
      return data;
    })
    .finally(() => {
      catalogsInFlight = null;
    });
  catalogsInFlight = request;
  return request;
}

// RF-1105 (percepción de carga): cache en memoria por ruta (pathname) para que volver a
// una pantalla ya visitada pinte contenido de inmediato mientras se revalida en segundo
// plano. Límite razonable de entradas (LRU simple) para no crecer sin control en una
// sesión larga. Vive a nivel de módulo (no de componente) para sobrevivir a la
// navegación entre rutas dentro de la misma sesión de la SPA.
const ROUTE_CACHE_LIMIT = 24;
const routeCache = new Map<string, { kind: RouteKind; data: unknown }>();

// H6: respaldo ligero en sessionStorage — sobrevive a una recarga de página o a abrir la misma
// sesión en otra pestaña (el Map en memoria, no). Con TTL corto (5 min): pasado ese tiempo se
// prefiere el esqueleto de carga a una cifra de dinero potencialmente vieja. Todo dentro de
// try/catch: sessionStorage puede lanzar en modo privado o con la cuota agotada, y eso nunca debe
// tumbar la navegación — la caché en memoria sigue funcionando igual sin el respaldo.
const SESSION_CACHE_KEY = "mizar-route-cache:v1";
const SESSION_CACHE_TTL_MS = 5 * 60_000;
// sessionStorage tiene cuota total pequeña (~5 MB en la mayoría de navegadores); un detalle con
// muchos adjuntos/ítems no vale la pena persistirlo si por sí solo se acerca a eso.
const MAX_PERSISTED_DETAIL_BYTES = 200_000;

type PersistedRouteEntry = { kind: RouteKind; data: unknown; savedAt: number };
type PersistedRouteStore = Record<string, PersistedRouteEntry>;

function readSessionStore(): PersistedRouteStore {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return {};
    const raw = window.sessionStorage.getItem(SESSION_CACHE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as PersistedRouteStore) : {};
  } catch {
    return {};
  }
}

function writeSessionStore(store: PersistedRouteStore): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    window.sessionStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(store));
  } catch {
    // Modo privado / cuota excedida: el respaldo se pierde, la caché en memoria sigue sirviendo.
  }
}

function persistRouteEntry(pathname: string, kind: RouteKind, data: unknown): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    if (kind === "detail") {
      const size = JSON.stringify(data).length;
      if (size > MAX_PERSISTED_DETAIL_BYTES) return;
    }
    const store = readSessionStore();
    store[pathname] = { kind, data, savedAt: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > ROUTE_CACHE_LIMIT) {
      const oldestKey = keys.sort((a, b) => store[a].savedAt - store[b].savedAt)[0];
      delete store[oldestKey];
    }
    writeSessionStore(store);
  } catch {
    // JSON.stringify no debería fallar aquí (sin ciclos), pero por si acaso: nunca debe tumbar
    // la navegación por un respaldo que es, por definición, opcional.
  }
}

function removeFromSessionStore(
  predicate: (pathname: string, entry: PersistedRouteEntry) => boolean,
): void {
  try {
    if (typeof window === "undefined" || !window.sessionStorage) return;
    const store = readSessionStore();
    let changed = false;
    for (const [pathname, entry] of Object.entries(store)) {
      if (predicate(pathname, entry)) {
        delete store[pathname];
        changed = true;
      }
    }
    if (changed) writeSessionStore(store);
  } catch {
    // Ídem: el respaldo es opcional, nunca debe lanzar hacia el llamador.
  }
}

// Solo la caché en memoria. DELIBERADAMENTE no mira sessionStorage: esta función alimenta el
// estado inicial de ConnectedScreen, que se calcula también en el servidor (SSR). Si aquí se
// leyera el respaldo persistido, el servidor pintaría el esqueleto (sin `window`) y el cliente, en
// su primer render, el contenido con la barra de revalidación — React lo reporta como "Hydration
// failed" y tira el árbol del servidor entero, que es justo lo que la fase de rendimiento quería
// aprovechar. El respaldo se restaura después de montar, con `getPersistedRoute` (abajo).
function getCachedRoute(pathname: string) {
  return routeCache.get(pathname);
}

// Respaldo de sessionStorage: solo cuando el Map en memoria está vacío del todo (primera lectura
// de la sesión — recarga de página o pestaña nueva) y la entrada tiene menos de 5 minutos. Si el
// Map ya tiene algo, una ruta ausente ahí es un "no cacheada todavía" real, no un cold start: no
// tiene sentido resucitar sessionStorage en ese caso. Solo debe llamarse desde un efecto de
// cliente (nunca durante el render): ver la nota de hidratación en `getCachedRoute`.
export function getPersistedRoute(pathname: string): { kind: RouteKind; data: unknown } | undefined {
  if (routeCache.size > 0) return undefined;
  try {
    const entry = readSessionStore()[pathname];
    if (!entry) return undefined;
    if (Date.now() - entry.savedAt > SESSION_CACHE_TTL_MS) return undefined;
    return { kind: entry.kind, data: entry.data };
  } catch {
    return undefined;
  }
}

export function setCachedRoute(pathname: string, kind: RouteKind, data: unknown): void {
  routeCache.delete(pathname);
  routeCache.set(pathname, { kind, data });
  if (routeCache.size > ROUTE_CACHE_LIMIT) {
    const oldestKey = routeCache.keys().next().value;
    if (oldestKey !== undefined) routeCache.delete(oldestKey);
  }
  persistRouteEntry(pathname, kind, data);
}

// Se exporta para que las pruebas puedan partir de un estado limpio (el cache es un
// singleton de módulo). A diferencia de antes, YA NO es lo único que `mutate` llama tras cada
// escritura (ver `invalidateForMutation`, más abajo) — se conserva como fallback seguro para
// URLs no mapeadas y para quien necesite vaciar todo a mano. NO toca los catálogos (slot
// separado, ver `getCatalogs`/`invalidateCatalogs`): H6 los saca a propósito de este borrado
// total porque casi nunca cambian y mutan por su propio camino.
export function clearRouteCache(): void {
  routeCache.clear();
  removeFromSessionStore(() => true);
}

function clearRouteCacheByKind(kinds: readonly RouteKind[]): void {
  for (const [pathname, entry] of routeCache) {
    if (kinds.includes(entry.kind)) routeCache.delete(pathname);
  }
  removeFromSessionStore((_pathname, entry) => kinds.includes(entry.kind));
}

// Invalidación más fina que clearRouteCacheByKind(["detail"]): cuando la URL mutada trae el id
// de la requisición (PATCH de cabecera, POST de acciones), solo se borra SU detalle
// (/requisiciones/:id o /aprobaciones/:id), no el de cualquier otra requisición cacheada.
function clearDetailCacheForRequisition(id: string): void {
  const matches = (pathname: string) =>
    pathname.endsWith(`/${id}`) &&
    (pathname.startsWith("/requisiciones/") || pathname.startsWith("/aprobaciones/"));
  for (const pathname of routeCache.keys()) {
    if (matches(pathname)) routeCache.delete(pathname);
  }
  removeFromSessionStore((pathname) => matches(pathname));
}

// H6: los catálogos viven en un slot propio (ver `getCatalogs`) que `clearRouteCache()` no toca;
// esta es la única función que debe invalidarlos — tras una mutación de catálogo/proveedor (ver
// `invalidateForMutation`) o desde catalog-admin.tsx, que escribe con su propio `apiRequest` en
// vez de `mutate` (no pasa por data.ts para nada más, así que tiene que llamarla a mano). También
// limpia la caché de ruta de kind "catalogs" (la pantalla /catalogos, /proveedores): sin esto,
// volver a esa pantalla tras editar seguiría mostrando el bundle de `/api/catalogs/manage` viejo.
export function invalidateCatalogs(): void {
  catalogsCache = null;
  catalogsInFlight = null;
  clearRouteCacheByKind(["catalogs"]);
}

function isGenerateOrdersAction(body: unknown): boolean {
  return Boolean(
    body && typeof body === "object" && (body as { action?: unknown }).action === "generate_orders",
  );
}

// Captura el id cuando la URL es /api/requisitions/{id} o /api/requisitions/{id}/algo (acciones,
// historial…); NO matchea la URL plana /api/requisitions (alta de una requisición nueva).
const REQUISITION_ID_URL_RE = /^\/api\/requisitions\/([^/?]+)(?:\/|$)/;

// H6 (docs/plan-rendimiento.md): invalidación por afectación en vez de `clearRouteCache()` total
// tras CUALQUIER mutación. Tabla (prefijo de URL mutada -> qué se invalida):
//   /api/requisitions          -> dashboard, requisitions, reports (RF-1301: una cabecera editada,
//                                 aprobada, devuelta o declinada cambia exactamente las columnas que
//                                 reporta /reportes — estado, aprobador, etiqueta), y el detalle de ESE
//                                 id si la URL lo trae (PATCH de cabecera, POST de acciones); si la
//                                 acción es "generate_orders" también invalida "orders" (es la única
//                                 acción de requisiciones que además crea órdenes nuevas).
//   /api/orders                -> orders, detail (no se puede acotar a un id: una orden no es
//                                 una requisición), dashboard, expenses.
//   /api/expenses               -> expenses, dashboard.
//   /api/petty-cash             -> expenses, dashboard.
//   /api/incomes, /api/cash-closes -> expenses, dashboard (cajas/ingresos/cierres, 2026-09-12).
//   /api/catalogs, /api/suppliers -> invalidateCatalogs() (catálogos + caché "catalogs"); un alta
//                                 rápida de proveedor desde la revisión (detail.tsx) también pasa
//                                 por aquí porque pega a /api/suppliers.
//   cualquier otra URL          -> clearRouteCache() completo (fallo seguro: mejor refrescar de
//                                 más que arrastrar una cifra vieja a una bandeja o un dashboard).
function invalidateForMutation(url: string, body: unknown): void {
  if (url.startsWith("/api/catalogs") || url.startsWith("/api/suppliers")) {
    invalidateCatalogs();
    return;
  }
  const requisitionMatch = REQUISITION_ID_URL_RE.exec(url);
  if (url === "/api/requisitions" || requisitionMatch) {
    clearRouteCacheByKind(["dashboard", "requisitions", "reports"]);
    if (requisitionMatch) clearDetailCacheForRequisition(decodeURIComponent(requisitionMatch[1]));
    if (isGenerateOrdersAction(body)) clearRouteCacheByKind(["orders"]);
    return;
  }
  if (url.startsWith("/api/orders")) {
    clearRouteCacheByKind(["orders", "detail", "dashboard", "expenses"]);
    return;
  }
  if (url.startsWith("/api/expenses") || url.startsWith("/api/petty-cash") || url.startsWith("/api/incomes")) {
    clearRouteCacheByKind(["expenses", "dashboard"]);
    return;
  }
  // Cierres (2026-09-12): cerrar/reabrir etiqueta movimientos existentes (caja_menor/ingresos) con
  // `cierre_id` y puede cambiar sus totales — mismo alcance de invalidación que expenses/petty-cash.
  if (url.startsWith("/api/cash-closes")) {
    clearRouteCacheByKind(["expenses", "dashboard"]);
    return;
  }
  clearRouteCache();
}

export async function mutate(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): Promise<unknown> {
  const value = await apiRequest(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  invalidateForMutation(url, body);
  return value;
}

export function isConnectedReadRoute(pathname: string): boolean {
  return Boolean(routeKind(pathname));
}

// RF-1105: primera carga de `pathname` (sin datos en cache) -> esqueleto de esa ruta.
// Con datos en cache -> los muestra de inmediato y arranca revalidando en segundo plano
// (así "volver a una pantalla ya visitada" no vuelve a mostrar el esqueleto).
export function initialLoadState(
  pathname: string,
  kind: RouteKind | undefined,
): LoadState {
  if (!kind) return { state: "loading", kind: "dashboard" };
  const cached = getCachedRoute(pathname);
  if (cached) return { state: "ready", data: cached.data, revalidating: true };
  return { state: "loading", kind };
}
