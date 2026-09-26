"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): RequisitionQueueRows (interno)
// y ConnectedRequisitions, partidos de components/screens/connected.tsx. Misma lógica,
// mismos nombres.
import { useEffect, useState } from "react";
import { ArrowRight, Check, Columns3, Inbox, List, SearchX, X } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { pendingApproverIds, pendingItemsFor, sumLines } from "../../../lib/domain/rules";
import { SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import {
  channelLabel,
  emptyCatalogs,
  estadoLabel,
  money,
  pendingBeneficiaryId,
  permisosDelVisor,
  relativeAge,
  requisitionTone,
  resolveUserName,
  supplierFichaPath,
  type CatalogData,
  type RequisitionRow,
  type RequisitionsBundle,
} from "./shared";
import { loadMoreRequisitions, loadRequisitionsByStatus, mutate, setCachedRoute } from "./data";

/** Estados terminales que /revision ofrece en su filtro de estado (se piden aparte, ver
 *  `loadRequisitionsByStatus`): la bandeja muestra lo que hay que atender, y estos son consulta. */
const REVISION_ARCHIVE_STATUSES = ["aprobada", "declinada"];

// Tablero de revisión (RF-306, decisión del cliente 25-sep-2026): "Lista | Tablero" — el mismo
// selector recordado por persona (localStorage, con try/catch por el mismo motivo que
// data.ts/readSessionStore: modo privado o cuota agotada nunca debe tumbar la pantalla).
type RevisionView = "list" | "board";
const REVISION_VIEW_STORAGE_PREFIX = "mizar-revision-vista:v1";

function readStoredRevisionView(viewerId: string | undefined): RevisionView | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(`${REVISION_VIEW_STORAGE_PREFIX}:${viewerId ?? "anon"}`);
    return raw === "list" || raw === "board" ? raw : null;
  } catch {
    return null;
  }
}
function writeStoredRevisionView(viewerId: string | undefined, view: RevisionView): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(`${REVISION_VIEW_STORAGE_PREFIX}:${viewerId ?? "anon"}`, view);
  } catch {
    // Modo privado / cuota excedida: la vista elegida no sobrevive a la próxima visita, pero la
    // pantalla sigue funcionando — igual que el respaldo de rutas en data.ts.
  }
}

/** Columnas del tablero, en el orden pedido por el cliente. "en_revision" agrupa también las
 *  "devuelta" (misma bandeja de Daniel; se distinguen con una marca en la tarjeta, no con una
 *  columna aparte — así lo pidió el PRD RF-306). */
const BOARD_COLUMNS: ReadonlyArray<{ key: "enviada" | "en_revision" | "en_aprobacion" | "aprobada"; label: string }> = [
  { key: "enviada", label: "Enviada" },
  { key: "en_revision", label: "En revisión" },
  { key: "en_aprobacion", label: "En aprobación" },
  { key: "aprobada", label: "Aprobada" },
];

/** "Obra o empresa" de la tarjeta: la obra si ya se asignó (revisión), o la empresa/sociedad del
 *  solicitante cuando todavía no hay obra (un pago o una compra recién enviada). Nunca un id crudo. */
function workOrSocietyLabel(row: RequisitionRow, catalogs: CatalogData): string {
  if (row.workId) {
    const work = catalogs.works.find((option) => option.id === row.workId);
    if (work) return work.name;
  }
  if (row.societyId) {
    const society = catalogs.societies?.find((option) => option.id === row.societyId);
    if (society) return society.name;
  }
  return "Sin asignar";
}

/** Estado de una de las dos columnas del tablero que NO viajan con la página de pendientes
 *  (en_aprobacion/aprobada): se piden aparte con `loadRequisitionsByStatus`, con su propio cursor,
 *  para no mezclarlas con "Cargar más" de lo pendiente (ver comentario de `loadRequisitionsByStatus`
 *  más arriba) — el mismo criterio que ya usa `archive` para la consulta de terminales del filtro de
 *  Estado, aplicado ahora a las dos columnas del tablero que un revisor no tiene en su bandeja de
 *  "por atender". `loadedForData` guarda la referencia del bundle con el que se cargó: si `data`
 *  cambia (una revalidación tras aprobar/declinar desde la lista), deja de coincidir y se vuelve a
 *  pedir la próxima vez que el tablero esté activo.
 */
type BoardColumnState = {
  status: string;
  rows: RequisitionRow[];
  nextCursor: string | null;
  loading: boolean;
  error: string;
  loadedForData: unknown;
};
const emptyBoardColumn = (status: string): BoardColumnState => ({
  status,
  rows: [],
  nextCursor: null,
  loading: false,
  error: "",
  loadedForData: undefined,
});

// «Aprobar desde la lista» (reunión 11-sep-2026, patrón Precoro pedido por Ernesto tras la
// reunión de presentación): antes había que abrir CADA requisición en "Mis aprobaciones" solo para
// aprobarla o declinarla. `pendingItemsFor`/`pendingApproverIds` son las mismas funciones del
// dominio (lib/domain/rules.ts) que ya usa detail.tsx para "misLineas"/"otherPending" — se
// reutilizan tal cual para no duplicar la herencia aprobador-por-ítem (itemApproverId) aquí.
type ApproverRowActions = {
  viewerId: string;
  /** M-5 (lib/domain/rules.ts, mismo bypass que detail.tsx): admin_sixteam decide CUALQUIER
   *  requisición en aprobación, no solo las que tiene asignadas — ver `pendingItemsForActor`. */
  isAdminSixteam: boolean;
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
  busyId: string | null;
  onApprove: (row: RequisitionRow) => void;
  onDecline: (row: RequisitionRow) => void;
};

/**
 * Ítems de ESTA fila que decide QUIEN MIRA — la misma pregunta que `misLineas` resuelve en
 * detail.tsx, aquí para la lista. Un aprobador normal solo ve/decide los suyos (`pendingItemsFor`,
 * que ya aplica la herencia `itemApproverId`); admin_sixteam (M-5) puede con cualquier ítem
 * TODAVÍA pendiente de la requisición, esté o no asignado a él — igual que el servicio
 * (`omnipotente` en `decideItems`/`approve`, procurement-service.ts) y que detail.tsx.
 */
function pendingItemsForActor(row: RequisitionRow, viewerId: string, isAdminSixteam: boolean) {
  if (isAdminSixteam) return row.items.filter((item) => (item.status ?? "pendiente") === "pendiente");
  return pendingItemsFor(viewerId, row.items, row.approverId);
}

function RequisitionQueueRows({
  rows,
  catalogs,
  go,
  markActive,
  approverActions,
  canOpenSupplier = false,
}: {
  rows: RequisitionRow[];
  catalogs: CatalogData;
  go: (path: string) => void;
  markActive?: boolean;
  /** QA H5: quien puede completar la ficha (revisor/admin Sixteam) recibe el enlace; el resto, solo la marca. */
  canOpenSupplier?: boolean;
  /** Columnas de "Aprobar desde la lista" — ausente en /revision (nunca hay fila `en_aprobacion`
   *  ahí) y en el grupo "Listas para generar orden" (ya `aprobada`), así que esas tablas quedan
   *  exactamente igual que antes. */
  approverActions?: ApproverRowActions;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {approverActions && <th className="align-center"><span className="sr-only">Seleccionar</span></th>}
            <th>Requisición</th>
            <th>Solicitante</th>
            <th className="align-right">Nº de ítems</th>
            <th className="align-right">Valor estimado</th>
            <th>Antigüedad</th>
            <th>Estado</th>
            {approverActions && <th>Tu decisión</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // «Aprobar desde la lista»: ítems VIGENTES (pendientes) que decide QUIEN MIRA — misma
            // herencia que detail.tsx (itemApproverId, vía pendingItemsFor). Vacío = ya decidió los
            // suyos (la fila sigue en_aprobacion esperando a otro aprobador) o no le toca ninguno.
            const misPendientes = approverActions
              ? pendingItemsForActor(row, approverActions.viewerId, approverActions.isAdminSixteam)
              : [];
            const puedeActuar = row.status === "en_aprobacion" && misPendientes.length > 0;
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
            const beneficiaryId = pendingBeneficiaryId(row);
            return (
              <tr key={row.id} data-testid={markActive ? "active-requisition" : "requisition-queue-row"}>
                {approverActions && (
                  <td className="align-center">
                    {puedeActuar && (
                      <input
                        type="checkbox"
                        checked={approverActions.selected.has(row.id)}
                        disabled={approverActions.busyId === row.id}
                        aria-label={`Seleccionar ${row.consecutive}`}
                        onChange={() => approverActions.onToggleSelected(row.id)}
                      />
                    )}
                  </td>
                )}
                <td>
                  <div className="request-id">
                    <button className="request-link" type="button" onClick={() => go(`/requisiciones/${row.id}`)}>
                      <b>
                        {row.consecutive}{" "}
                        {/* RF pendiente (feat/solicitud-de-pago): distingue de un vistazo una solicitud
                            de pago de una compra en la bandeja — sin esto las dos se ven idénticas hasta
                            abrir el detalle. Chip solo aquí: detail.tsx/orders.tsx quedan fuera del
                            encargo (otro agente los está rediseñando). */}
                        <Tone tone={row.type === "pago" ? "warning" : "muted"} outline>
                          {row.type === "pago" ? "Pago" : "Compra"}
                        </Tone>
                      </b>
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
                  {row.beneficiaryPendingNormalization && (
                    <span className="table-sub" data-testid="beneficiary-pending">
                      <Tone tone="warning">Beneficiario pendiente de completar</Tone>{" "}
                      {canOpenSupplier && beneficiaryId && (
                        <a
                          className="text-link"
                          href={supplierFichaPath(beneficiaryId)}
                          aria-label={`Completar la ficha del beneficiario de ${row.consecutive}`}
                          onClick={(event) => {
                            event.preventDefault();
                            go(supplierFichaPath(beneficiaryId));
                          }}
                        >
                          Completar ficha
                        </a>
                      )}
                    </span>
                  )}
                </td>
                {approverActions && (
                  <td data-testid="approver-row-actions">
                    {puedeActuar && (
                      <div className="button-row">
                        <button
                          className="button button-dark cell-action"
                          type="button"
                          disabled={approverActions.busyId === row.id}
                          onClick={() => approverActions.onApprove(row)}
                        >
                          <Check aria-hidden="true" size={14} /> Aprobar
                        </button>
                        <button
                          className="button button-secondary cell-action"
                          type="button"
                          disabled={approverActions.busyId === row.id}
                          onClick={() => approverActions.onDecline(row)}
                        >
                          <X aria-hidden="true" size={14} /> Declinar
                        </button>
                      </div>
                    )}
                  </td>
                )}
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

/** Una tarjeta del tablero — mismos campos que pidió el cliente (RF-306): consecutivo, obra o
 *  empresa, solicitante, n.º de ítems, valor estimado, antigüedad y canal; el aprobador solo en la
 *  columna "En aprobación" (no aplica antes de que exista); la marca "Devuelta" solo en esas filas
 *  dentro de "En revisión" (el resto de la columna no la necesita: ya dice "En revisión" el
 *  encabezado). Es un <button> — clic abre el detalle, igual que la fila de la lista. */
function BoardCard({
  row,
  catalogs,
  go,
  showApprover,
}: {
  row: RequisitionRow;
  catalogs: CatalogData;
  go: (path: string) => void;
  showApprover: boolean;
}) {
  const total = sumLines(row.items);
  const requesterLabel = row.externalRequester?.name ?? resolveUserName(catalogs, row.requesterId, "Solicitante interno");
  return (
    <button
      className="kanban-card"
      type="button"
      onClick={() => go(`/requisiciones/${row.id}`)}
    >
      <div className="kanban-card-top">
        <b>{row.consecutive}</b>
        {row.status === "devuelta" && <Tone tone="danger" dot>Devuelta</Tone>}
      </div>
      <strong>{workOrSocietyLabel(row, catalogs)}</strong>
      <small>{requesterLabel} · {row.items.length} ítem{row.items.length === 1 ? "" : "s"} · {relativeAge(row.updatedAt)}</small>
      <div className="kanban-foot">
        <span className="money">{total > 0 ? money.format(total) : "Sin cotizar"}</span>
        <Tone tone="muted">{channelLabel(row.channel)}</Tone>
      </div>
      {showApprover && (
        <small className="kanban-approver">Aprobador: {resolveUserName(catalogs, row.approverId, "Por asignar")}</small>
      )}
    </button>
  );
}

/** Una columna del tablero: encabezado (h3, "las columnas tienen encabezado" — accesibilidad
 *  pedida por el PRD), contador, tarjetas y, si aplica, su propio "Cargar más" — separado a
 *  propósito del "Cargar más" de lo pendiente (ver BoardColumnState, más arriba). */
function BoardColumn({
  columnKey,
  label,
  rows,
  catalogs,
  go,
  loading,
  error,
  hasMore,
  onLoadMore,
}: {
  columnKey: string;
  label: string;
  rows: RequisitionRow[];
  catalogs: CatalogData;
  go: (path: string) => void;
  loading?: boolean;
  error?: string;
  hasMore?: boolean;
  onLoadMore?: () => void;
}) {
  const headingId = `board-column-${columnKey}`;
  return (
    <section className="kanban-column" aria-labelledby={headingId}>
      <div className="kanban-head">
        <h3 id={headingId}>{label}</h3>
        <span>{rows.length}</span>
      </div>
      {rows.map((row) => (
        <BoardCard key={row.id} row={row} catalogs={catalogs} go={go} showApprover={columnKey === "en_aprobacion"} />
      ))}
      {!loading && !rows.length && !error && <p className="muted-copy kanban-empty">Sin requisiciones aquí.</p>}
      {loading && <p className="muted-copy" role="status">Cargando…</p>}
      {error && <p className="field-error" role="alert">{error}</p>}
      {onLoadMore && hasMore && (
        <button className="button button-secondary" type="button" disabled={loading} onClick={onLoadMore}>
          {loading ? "Cargando…" : "Cargar más"}
        </button>
      )}
    </section>
  );
}

export function ConnectedRequisitions({
  data,
  pathname,
  go,
  refresh,
  role,
}: {
  data: RequisitionsBundle;
  pathname: string;
  go: (path: string) => void;
  /** «Aprobar desde la lista»: recarga el bundle tras aprobar/declinar, igual que
   *  detail.tsx/orders.tsx — opcional para no romper las pruebas/llamadas existentes que aún no
   *  la pasan (esta pantalla, antes de este cambio, nunca mutaba nada). */
  refresh?: () => void | Promise<void>;
  /** M-5 (mismo bypass que detail.tsx): admin_sixteam decide CUALQUIER requisición en_aprobacion,
   *  no solo las asignadas — ver `pendingItemsForActor`. Opcional por el mismo motivo que
   *  `refresh`: sin rol, se trata como un aprobador normal (nunca como "decide todo"). */
  role?: Role;
}) {
  const catalogs = data?.catalogs ?? emptyCatalogs;
  const isRevision = pathname.startsWith("/revision");
  const isApprovalInbox = pathname.startsWith("/aprobaciones");
  // M-5: el portillo del maestro NO es un permiso del catálogo (mismo criterio que
  // `canOverrideAssignedApprover` en lib/domain/rules.ts), así que se queda decidido por rol.
  const isAdminSixteam = role === "Administrador Sixteam";
  // Completar la ficha del beneficiario, en cambio, exige "supplier:manage" — el permiso que pide
  // PATCH /api/suppliers/:id y que ahora se edita desde Configuración.
  const canOpenSupplier = role ? permisosDelVisor(data, role)("supplier:manage") : false;
  // H3 (docs/plan-rendimiento.md): `data.rows` es ahora UNA página (100 filas server-side); el
  // estado local guarda las páginas ya cargadas con "Cargar más" y se reinicia cuando `data`
  // cambia (nueva ruta o revalidación con una página fresca) para no arrastrar páginas viejas.
  // Se ajusta DURANTE el render (no en un efecto) siguiendo el patrón que React recomienda para
  // "reiniciar estado cuando cambia una prop" (mismo patrón que ya usa screen.tsx con
  // `routeState.pathname !== pathname`) — evita el round-trip extra de un efecto y el lint
  // react-hooks/set-state-in-effect.
  const [pageState, setPageState] = useState(() => ({
    data,
    rows: Array.isArray(data?.rows) ? data.rows : [],
    nextCursor: data?.nextCursor ?? null,
  }));
  if (pageState.data !== data) {
    setPageState({
      data,
      rows: Array.isArray(data?.rows) ? data.rows : [],
      nextCursor: data?.nextCursor ?? null,
    });
  }
  const allRows = pageState.data === data ? pageState.rows : (Array.isArray(data?.rows) ? data.rows : []);
  const nextCursor = pageState.data === data ? pageState.nextCursor : (data?.nextCursor ?? null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError("");
    try {
      const page = await loadMoreRequisitions(pathname, nextCursor);
      const merged = [...allRows, ...page.rows];
      setPageState({ data, rows: merged, nextCursor: page.nextCursor });
      // H3: se refleja también en la caché de ruta para que, al volver a esta bandeja, las
      // páginas ya traídas con "Cargar más" sigan ahí (no solo la primera).
      setCachedRoute(pathname, "requisitions", { ...data, rows: merged, nextCursor: page.nextCursor });
    } catch (error) {
      setLoadMoreError(
        error instanceof Error ? error.message : "No fue posible cargar más requisiciones.",
      );
    } finally {
      setLoadingMore(false);
    }
  };
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
  // Consulta de terminales en /revision (aprobada/declinada): filas traídas del servidor con su
  // propio cursor, solo mientras ese estado está elegido en el filtro.
  const [archive, setArchive] = useState<{ status: string; rows: RequisitionRow[]; nextCursor: string | null } | null>(null),
    [archiveLoading, setArchiveLoading] = useState(false),
    [archiveError, setArchiveError] = useState("");
  const archiveStatus = isRevision && REVISION_ARCHIVE_STATUSES.includes(statusFilter) ? statusFilter : null;
  const loadArchive = async (status: string, cursor?: string) => {
    setArchiveLoading(true);
    setArchiveError("");
    if (!cursor) setArchive({ status, rows: [], nextCursor: null });
    try {
      const page = await loadRequisitionsByStatus(status, cursor);
      const pageRows = Array.isArray(page?.rows) ? page.rows : [];
      setArchive((current) => ({
        status,
        rows: cursor && current?.status === status ? [...current.rows, ...pageRows] : pageRows,
        nextCursor: page?.nextCursor ?? null,
      }));
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "No fue posible cargar las requisiciones.");
    } finally {
      setArchiveLoading(false);
    }
  };
  const changeStatusFilter = (value: string) => {
    setStatusFilter(value);
    if (isRevision && REVISION_ARCHIVE_STATUSES.includes(value)) void loadArchive(value);
  };
  // Filas sobre las que actúan los filtros de cliente: las de la bandeja, o las del estado terminal
  // elegido (que ya vienen filtradas por estado desde el servidor).
  const baseRows = archiveStatus ? (archive?.status === archiveStatus ? archive.rows : []) : rows;
  const statusOptions = Array.from(
    new Set([...rows.map((row) => row.status), ...(isRevision ? REVISION_ARCHIVE_STATUSES : [])]),
  ).sort();
  const channelOptions = Array.from(
    new Set(baseRows.map((row) => row.channel)),
  ).sort();
  // Tablero (RF-306): obra/canal/etiqueta/fecha son los filtros que el tablero comparte con la
  // lista — el estado NO (las columnas del tablero SON el estado); se separa en su propia función
  // para que ambas vistas apliquen exactamente el mismo criterio sin duplicarlo.
  const matchesCommonFilters = (row: RequisitionRow): boolean => {
    if (workFilter && row.workId !== workFilter) return false;
    if (channelFilter && row.channel !== channelFilter) return false;
    if (tagFilter && row.tagId !== tagFilter) return false;
    if (dateFrom && !(row.requiredDate && row.requiredDate >= dateFrom))
      return false;
    if (dateTo && !(row.requiredDate && row.requiredDate <= dateTo))
      return false;
    return true;
  };
  const filteredRows = baseRows.filter(
    (row) => (!statusFilter || row.status === statusFilter) && matchesCommonFilters(row),
  );
  const clearFilters = () => {
    setWorkFilter("");
    setStatusFilter("");
    setArchive(null);
    setChannelFilter("");
    setTagFilter("");
    setDateFrom("");
    setDateTo("");
  };

  // Tablero de revisión (RF-306): selector recordado por persona (localStorage). Arranca en "list"
  // en el servidor y en el primer render del cliente (mismo motivo de hidratación que
  // getPersistedRoute en data.ts: el servidor no puede saber qué eligió este navegador) y adopta lo
  // guardado DESPUÉS de montar.
  const [view, setView] = useState<RevisionView>("list");
  const viewerId = data?.viewerId;
  useEffect(() => {
    if (!isRevision) return;
    const stored = readStoredRevisionView(viewerId);
    if (stored) setView(stored);
  }, [isRevision, viewerId]);
  const changeView = (next: RevisionView) => {
    setView(next);
    writeStoredRevisionView(viewerId, next);
  };
  // Las dos columnas que NO viajan en la página de pendientes (ver BoardColumnState más arriba):
  // se piden aparte, solo mientras el tablero está activo, y se reinician cuando `data` cambia
  // (una revalidación tras aprobar/declinar desde la lista) para no arrastrar cifras viejas.
  const [boardEnAprobacion, setBoardEnAprobacion] = useState<BoardColumnState>(() => emptyBoardColumn("en_aprobacion"));
  const [boardAprobada, setBoardAprobada] = useState<BoardColumnState>(() => emptyBoardColumn("aprobada"));
  const loadBoardColumn = async (
    column: BoardColumnState,
    setColumn: (updater: (current: BoardColumnState) => BoardColumnState) => void,
    cursor?: string,
  ) => {
    setColumn((current) => ({ ...current, loading: true, error: "" }));
    try {
      const page = await loadRequisitionsByStatus(column.status, cursor);
      const pageRows = Array.isArray(page?.rows) ? page.rows : [];
      setColumn((current) => ({
        ...current,
        rows: cursor ? [...current.rows, ...pageRows] : pageRows,
        nextCursor: page?.nextCursor ?? null,
        loading: false,
        loadedForData: data,
      }));
    } catch (error) {
      setColumn((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : "No fue posible cargar las requisiciones.",
      }));
    }
  };
  useEffect(() => {
    if (!isRevision || view !== "board") return;
    if (boardEnAprobacion.loadedForData !== data && !boardEnAprobacion.loading) void loadBoardColumn(boardEnAprobacion, setBoardEnAprobacion);
    if (boardAprobada.loadedForData !== data && !boardAprobada.loading) void loadBoardColumn(boardAprobada, setBoardAprobada);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRevision, view, data, boardEnAprobacion.loadedForData, boardEnAprobacion.loading, boardAprobada.loadedForData, boardAprobada.loading]);
  // Columnas "Enviada"/"En revisión" (con las "devuelta" adentro): mismas filas que ya trae la
  // página de pendientes (allRows), sin el estado "aprobada" (esa va aparte, ver boardAprobada) y
  // con los mismos filtros de obra/canal/etiqueta/fecha que la lista.
  const boardPendingRows = isRevision
    ? allRows.filter((row) => row.status !== "aprobada" && matchesCommonFilters(row))
    : [];
  const boardColumnRows: Record<string, RequisitionRow[]> = {
    enviada: boardPendingRows.filter((row) => row.status === "enviada"),
    en_revision: boardPendingRows.filter((row) => row.status === "en_revision" || row.status === "devuelta"),
    en_aprobacion: boardEnAprobacion.rows.filter(matchesCommonFilters),
    aprobada: boardAprobada.rows.filter(matchesCommonFilters),
  };

  // «Aprobar desde la lista» — quién mira (lo pone el servidor, ver el comentario de
  // RequisitionsBundle.viewerId en ./shared): sin él no hay forma honesta de calcular "sus ítems",
  // así que las acciones de esta sección quedan apagadas (ver `approverActions`, más abajo).
  // (`viewerId` ya se declaró arriba, junto al tablero — se reutiliza tal cual aquí.)
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [success, setSuccess] = useState("");
  type BulkOutcome = { id: string; consecutive: string; outcome: "aprobada" | "pendiente" | "fallida"; detail?: string };
  const [bulkSummary, setBulkSummary] = useState<BulkOutcome[] | null>(null);
  const toggleSelected = (id: string) =>
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Mismo `POST .../actions` de siempre, en serie: si `decide_items` falla, `approve` nunca se
  // manda (idéntico criterio que `run()` en detail.tsx — ver el porqué en su comentario). Devuelve
  // la respuesta de la ÚLTIMA acción (la requisición actualizada) para poder decir con certeza en
  // qué quedó, en vez de adivinarlo por cuál botón se pulsó.
  const runActions = async (id: string, bodies: Array<Record<string, unknown>>): Promise<unknown> => {
    let last: unknown;
    for (const body of bodies) {
      last = await mutate(`/api/requisitions/${id}/actions`, "POST", body);
    }
    return last;
  };
  // `Faltan N aprobador(es) por decidir sus ítems` (APPROVAL_PENDING_OTHERS, procurement-service.ts):
  // no es un fallo del usuario que acaba de decidir los suyos, es el flujo normal de un reparto por
  // ítem — mismo regex que ya usa detail.tsx para el mismo mensaje.
  const pendingOthersCount = (message: string): string | null => /Faltan (\d+) aprobador/.exec(message)?.[1] ?? null;
  const decideBody = (items: RequisitionRow["items"], status: "aprobado" | "declinado", declineReason?: string) => ({
    action: "decide_items",
    decisions: items.map((line) => ({
      itemId: line.id,
      status,
      quantity: Number(line.quantity),
      ...(status === "declinado" ? { declineReason } : {}),
    })),
  });
  /**
   * Ajuste del coordinador (tras revisión): "Declinar" desde la lista manda el MISMO lote que el
   * detalle — `[decide_items, approve]`, nunca solo `decide_items`. Sin el `approve` final, la
   * ÚLTIMA declinación dejaba la requisición `en_aprobacion` para siempre (nadie volvía a tocarla
   * hasta abrir el detalle): exactamente el vacío silencioso que "aprobar/declinar desde la lista"
   * quería evitar. `approve()` es quien decide cómo cierra (`declinada` si con esto ya no queda
   * ningún ítem vigente, `aprobada` si queda alguno, `APPROVAL_PENDING_OTHERS` si faltan otros
   * aprobadores) — por eso el mensaje final se lee de la respuesta del servidor, no se adivina por
   * el botón que se pulsó: declinar TUS ítems no implica que la requisición completa quede
   * declinada si otros ítems, de otro aprobador, siguen o quedan aprobados.
   */
  const settleRow = async (row: RequisitionRow, status: "aprobado" | "declinado", declineReason?: string) => {
    if (!viewerId || busyId) return;
    const misPendientes = pendingItemsForActor(row, viewerId, isAdminSixteam);
    if (!misPendientes.length) return;
    setBusyId(row.id);
    setFeedback("");
    setSuccess("");
    try {
      const resultado = (await runActions(row.id, [decideBody(misPendientes, status, declineReason), { action: "approve" }])) as
        | { status?: string }
        | undefined;
      await refresh?.();
      const estadoFinal = resultado?.status;
      setSuccess(
        estadoFinal === "declinada"
          ? `${row.consecutive}: quedó declinada.`
          : estadoFinal === "aprobada"
            ? `${row.consecutive}: quedó aprobada.`
            : `${row.consecutive}: tus decisiones quedaron guardadas.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Acción no completada.";
      const n = pendingOthersCount(message);
      if (n) {
        await refresh?.();
        setSuccess(
          `${row.consecutive}: tus ${misPendientes.length} ítem${misPendientes.length === 1 ? "" : "s"} quedaron decididos; falta${n === "1" ? "" : "n"} ${n} aprobador${n === "1" ? "" : "es"}.`,
        );
      } else {
        setFeedback(`${row.consecutive}: ${message}`);
      }
    } finally {
      setBusyId(null);
    }
  };
  const handleApproveRow = async (row: RequisitionRow) => {
    if (!viewerId || busyId) return;
    const misPendientes = pendingItemsForActor(row, viewerId, isAdminSixteam);
    if (!misPendientes.length) return;
    // M-5: admin_sixteam nunca ve "otro aprobador pendiente" — el servicio le salta esa comprobación
    // (`omnipotente`, procurement-service.ts) igual que a detail.tsx.
    const otherPending = !isAdminSixteam && pendingApproverIds(row.items, row.approverId).some((id) => id !== viewerId);
    const total = sumLines(misPendientes);
    const cuantos = isAdminSixteam ? "los" : "tus";
    const result = await confirm({
      title: otherPending ? "Aprobar tus ítems" : "Aprobar requisición",
      description: `${row.consecutive}: se aprobarán ${cuantos} ${misPendientes.length} ítem${misPendientes.length === 1 ? "" : "s"} (${money.format(total)}).${
        otherPending
          ? " Faltan ítems que decide otro aprobador: la requisición sigue en aprobación hasta que todos terminen."
          : " La requisición quedará aprobada de forma definitiva."
      }`,
      confirmLabel: otherPending ? "Aprobar mis ítems" : "Aprobar requisición",
    });
    if (!result.ok) return;
    await settleRow(row, "aprobado");
  };
  const handleDeclineRow = async (row: RequisitionRow) => {
    if (!viewerId || busyId) return;
    const misPendientes = pendingItemsForActor(row, viewerId, isAdminSixteam);
    if (!misPendientes.length) return;
    const cuantos = isAdminSixteam ? "los" : "tus";
    const result = await confirm({
      title: isAdminSixteam ? "Declinar ítems pendientes" : "Declinar tus ítems",
      description: `${row.consecutive}: se declinarán ${cuantos} ${misPendientes.length} ítem${misPendientes.length === 1 ? "" : "s"} pendientes con el motivo que escribas. Si con esto no queda ningún ítem vigente, la requisición quedará declinada.`,
      confirmLabel: "Declinar",
      danger: true,
      reason: { label: "Motivo para declinar", required: true, rows: 3 },
    });
    if (!result.ok) return;
    await settleRow(row, "declinado", result.reason ?? "");
  };
  // Filas seleccionables: mismo criterio que puedeActuar en RequisitionQueueRows (en_aprobacion +
  // al menos un ítem pendiente que le toque a este actor, con el mismo bypass M-5 de admin_sixteam)
  // — evita ofrecer la casilla en filas donde no hay nada que aprobar en lote.
  const selectableRows = viewerId
    ? filteredRows.filter((row) => row.status === "en_aprobacion" && pendingItemsForActor(row, viewerId, isAdminSixteam).length > 0)
    : [];
  const selectedRows = selectableRows.filter((row) => selectedIds.has(row.id));
  const handleBulkApprove = async () => {
    if (!viewerId || bulkBusy || !selectedRows.length) return;
    const result = await confirm({
      title: `Aprobar ${selectedRows.length} requisición${selectedRows.length === 1 ? "" : "es"} seleccionada${selectedRows.length === 1 ? "" : "s"}`,
      description: `Se aprobarán ${isAdminSixteam ? "los" : "tus"} ítems pendientes en cada una, en secuencia. Si a alguna le faltan ítems de otro aprobador, esa quedará pendiente en vez de aprobada.`,
      confirmLabel: `Aprobar ${selectedRows.length}`,
    });
    if (!result.ok) return;
    setBulkBusy(true);
    setFeedback("");
    setSuccess("");
    setBulkSummary(null);
    const outcomes: BulkOutcome[] = [];
    // En SECUENCIA, no en paralelo: cada POST toca la misma fila de `requisiciones` (advisory lock
    // en el servidor, ver ProcurementService.transaction) — mandarlas en paralelo no ganaría nada y
    // complicaría leer, fila por fila, cuál falló y por qué.
    for (const row of selectedRows) {
      const misPendientes = pendingItemsForActor(row, viewerId, isAdminSixteam);
      try {
        await runActions(row.id, [decideBody(misPendientes, "aprobado"), { action: "approve" }]);
        outcomes.push({ id: row.id, consecutive: row.consecutive, outcome: "aprobada" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Acción no completada.";
        const n = pendingOthersCount(message);
        if (n) outcomes.push({ id: row.id, consecutive: row.consecutive, outcome: "pendiente", detail: `Faltan ${n} aprobador(es).` });
        else outcomes.push({ id: row.id, consecutive: row.consecutive, outcome: "fallida", detail: message });
      }
    }
    setBulkBusy(false);
    setSelectedIds(new Set());
    await refresh?.();
    setBulkSummary(outcomes);
  };
  const approverActions =
    isApprovalInbox && viewerId
      ? {
          viewerId,
          isAdminSixteam,
          selected: selectedIds,
          onToggleSelected: toggleSelected,
          busyId,
          onApprove: (row: RequisitionRow) => void handleApproveRow(row),
          onDecline: (row: RequisitionRow) => void handleDeclineRow(row),
        }
      : undefined;

  return (
    <>
      <SectionTitle
        eyebrow="Requisiciones"
        title={title}
        // MENOR (QA 2026-08-31): microcopy para Mizar, no para el equipo de desarrollo —
        // antes decía "La API aplica alcance por actor antes de devolver cada fila".
        description="Solo ves las requisiciones que corresponden a tu rol."
        // Tablero (RF-306): solo en /revision — grupo de botones con estado presionado
        // (accesibilidad pedida por el PRD), mismo patrón visual que "Tipo de requisición" en
        // new-requisition.tsx (.view-switch + aria-pressed).
        action={
          isRevision ? (
            <div className="title-actions">
              <div role="group" aria-label="Tipo de vista de la bandeja">
                <button
                  type="button"
                  className={`view-switch${view === "list" ? " is-active" : ""}`}
                  aria-pressed={view === "list"}
                  onClick={() => changeView("list")}
                >
                  <List aria-hidden="true" size={15} /> Lista
                </button>
                <button
                  type="button"
                  className={`view-switch${view === "board" ? " is-active" : ""}`}
                  aria-pressed={view === "board"}
                  onClick={() => changeView("board")}
                >
                  <Columns3 aria-hidden="true" size={15} /> Tablero
                </button>
              </div>
            </div>
          ) : undefined
        }
      />
      {/* En /revision el filtro se muestra aunque la bandeja esté vacía: es la única puerta a las
          aprobadas y declinadas. */}
      {(rows.length > 0 || isRevision) && (
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
          {/* El tablero reemplaza este filtro: sus columnas SON el estado — mostrarlo a la vez
              sería un control que ya no mapea a nada (mizar-ui: "si necesitas una leyenda para
              explicar un control, el mapeo está mal"). */}
          {!(isRevision && view === "board") && (
            <label className="field">
              <span>Estado</span>
              <select
                value={statusFilter}
                onChange={(event) => changeStatusFilter(event.target.value)}
              >
                {/* En /revision "todos" son los que están por atender; los terminales van aparte. */}
                <option value="">{isRevision ? "Por atender" : "Todos"}</option>
                {statusOptions.map((status) => (
                  <option key={status} value={status}>
                    {estadoLabel(status)}
                  </option>
                ))}
              </select>
            </label>
          )}
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
      {isRevision && view === "list" && readyForOrderRows.length > 0 && (
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
          <RequisitionQueueRows rows={readyForOrderRows} catalogs={catalogs} go={go} canOpenSupplier={canOpenSupplier} />
        </section>
      )}
      {/* «Aprobar desde la lista»: barra de selección múltiple — solo en /aprobaciones y solo
          cuando hay al menos una fila con ítems propios pendientes que marcar. Sobria a propósito
          (un único botón): el pedido de la reunión 11-sep fue "aprobar sin abrir cada requisición",
          no una barra de acciones masivas completa. */}
      {isApprovalInbox && selectableRows.length > 0 && (
        <div className="filter-bar" data-testid="bulk-approve-bar">
          <Tone tone="muted">{selectedRows.length} seleccionada{selectedRows.length === 1 ? "" : "s"}</Tone>
          <button
            className="button button-dark"
            type="button"
            disabled={!selectedRows.length || bulkBusy}
            onClick={() => void handleBulkApprove()}
          >
            {bulkBusy ? "Aprobando…" : `Aprobar seleccionadas (${selectedRows.length})`}
          </button>
        </div>
      )}
      {view === "list" && (
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
        {bulkSummary && (
          <div className="connected-bulk-summary" role="status" data-testid="bulk-approve-summary">
            <p className="field-success connected-feedback">
              <b>
                {bulkSummary.filter((o) => o.outcome === "aprobada").length} aprobada
                {bulkSummary.filter((o) => o.outcome === "aprobada").length === 1 ? "" : "s"}
              </b>
              {", "}
              {bulkSummary.filter((o) => o.outcome === "pendiente").length} pendiente
              {bulkSummary.filter((o) => o.outcome === "pendiente").length === 1 ? "" : "s"} de otros
              {", "}
              {bulkSummary.filter((o) => o.outcome === "fallida").length} fallida
              {bulkSummary.filter((o) => o.outcome === "fallida").length === 1 ? "" : "s"}.
            </p>
            <ul className="connected-bulk-summary-list">
              {bulkSummary.map((outcome) => (
                <li key={outcome.id}>
                  {outcome.consecutive}: {outcome.outcome === "aprobada" ? "aprobada" : outcome.outcome === "pendiente" ? "pendiente" : "no se pudo aprobar"}
                  {outcome.detail ? ` — ${outcome.detail}` : ""}
                </li>
              ))}
            </ul>
            <button className="button button-secondary" type="button" onClick={() => setBulkSummary(null)}>
              Cerrar
            </button>
          </div>
        )}
        <div className="panel-head">
          <div>
            <h2>{filteredRows.length} visibles</h2>
            <p className="panel-sub">Toca una fila para abrir el detalle.</p>
          </div>
          <Tone tone="muted">Orden cronológico</Tone>
        </div>
        {archiveStatus && archiveLoading && baseRows.length === 0 ? (
          <p className="muted-copy" role="status">Cargando…</p>
        ) : archiveStatus && archiveError && baseRows.length === 0 ? (
          <p className="field-error" role="alert">{archiveError}</p>
        ) : baseRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
            <h3>Sin requisiciones en esta vista</h3>
            <p>
              {archiveStatus
                ? `No hay requisiciones en estado «${estadoLabel(archiveStatus)}».`
                : "No hay requisiciones que correspondan a tu rol en esta bandeja."}
            </p>
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
          <RequisitionQueueRows
            rows={filteredRows}
            catalogs={catalogs}
            go={go}
            markActive={isRevision && !archiveStatus}
            approverActions={approverActions}
            canOpenSupplier={canOpenSupplier}
          />
        )}
        {archiveStatus && archive?.status === archiveStatus && archive.nextCursor && (
          <div className="button-row">
            <button
              className="button button-secondary"
              type="button"
              disabled={archiveLoading}
              onClick={() => void loadArchive(archiveStatus, archive.nextCursor ?? undefined)}
            >
              {archiveLoading ? "Cargando…" : "Cargar más"}
            </button>
            {archiveError && (
              <p className="field-error" role="alert">
                {archiveError}
              </p>
            )}
          </div>
        )}
        {/* H3 (docs/plan-rendimiento.md): "Cargar más" pide la página siguiente con el mismo
            filtro de servidor (mismo status por bandeja) y ANEXA — no reemplaza — las filas ya
            visibles, incluidas las que los filtros de cliente de arriba ocultan en este momento. */}
        {nextCursor && !archiveStatus && (
          <div className="button-row">
            <button
              className="button button-secondary"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Cargando…" : "Cargar más"}
            </button>
            {loadMoreError && (
              <p className="field-error" role="alert">
                {loadMoreError}
              </p>
            )}
          </div>
        )}
      </section>
      )}
      {/* Tablero (RF-306): alterna con TODA la vista de lista de arriba (grupo "Listas para
          generar orden" incluido) — mismos datos/filtros, sin arrastrar y soltar; los cambios de
          estado se siguen haciendo desde el detalle de cada tarjeta. */}
      {isRevision && view === "board" && (
        // Sin envolver en .panel: igual que el tablero de la demo (workflow.tsx), cada columna
        // ya trae su propia superficie (fondo, borde, radio) — un .panel encima solo añadiría
        // `overflow:hidden` que recortaría el scroll horizontal propio de .kanban en móvil.
        <section aria-label="Tablero de revisión">
          <h2 className="sr-only">Tablero de la bandeja de revisión</h2>
          <div className="kanban">
            {BOARD_COLUMNS.map((column) => (
              <BoardColumn
                key={column.key}
                columnKey={column.key}
                label={column.label}
                rows={boardColumnRows[column.key]}
                catalogs={catalogs}
                go={go}
                loading={column.key === "en_aprobacion" ? boardEnAprobacion.loading : column.key === "aprobada" ? boardAprobada.loading : undefined}
                error={column.key === "en_aprobacion" ? boardEnAprobacion.error : column.key === "aprobada" ? boardAprobada.error : undefined}
                hasMore={column.key === "en_aprobacion" ? Boolean(boardEnAprobacion.nextCursor) : column.key === "aprobada" ? Boolean(boardAprobada.nextCursor) : false}
                onLoadMore={
                  column.key === "en_aprobacion"
                    ? () => void loadBoardColumn(boardEnAprobacion, setBoardEnAprobacion, boardEnAprobacion.nextCursor ?? undefined)
                    : column.key === "aprobada"
                      ? () => void loadBoardColumn(boardAprobada, setBoardAprobada, boardAprobada.nextCursor ?? undefined)
                      : undefined
                }
              />
            ))}
          </div>
          {/* Mismo "Cargar más" que ya usa la lista para lo pendiente (enviada/en_revision/
              devuelta) — comparten cursor y página; ver el comentario de `loadMore` más arriba. */}
          {nextCursor && (
            <div className="button-row">
              <button
                className="button button-secondary"
                type="button"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Cargando…" : "Cargar más pendientes"}
              </button>
              {loadMoreError && (
                <p className="field-error" role="alert">
                  {loadMoreError}
                </p>
              )}
            </div>
          )}
        </section>
      )}
      {confirmDialog}
    </>
  );
}

