"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): RequisitionQueueRows (interno)
// y ConnectedRequisitions, partidos de components/screens/connected.tsx. Misma lógica,
// mismos nombres.
import { useState } from "react";
import { ArrowRight, Check, Inbox, SearchX, X } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { pendingApproverIds, pendingItemsFor, sumLines } from "../../../lib/domain/rules";
import { SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  money,
  pendingBeneficiaryId,
  relativeAge,
  requisitionTone,
  resolveUserName,
  supplierFichaPath,
  type CatalogData,
  type RequisitionRow,
  type RequisitionsBundle,
} from "./shared";
import { loadMoreRequisitions, mutate, setCachedRoute } from "./data";

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
  const isAdminSixteam = role === "Administrador Sixteam";
  const canOpenSupplier = role === "Revisor" || isAdminSixteam;
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

  // «Aprobar desde la lista» — quién mira (lo pone el servidor, ver el comentario de
  // RequisitionsBundle.viewerId en ./shared): sin él no hay forma honesta de calcular "sus ítems",
  // así que las acciones de esta sección quedan apagadas (ver `approverActions`, más abajo).
  const viewerId = data?.viewerId;
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
          <RequisitionQueueRows
            rows={filteredRows}
            catalogs={catalogs}
            go={go}
            markActive={isRevision}
            approverActions={approverActions}
            canOpenSupplier={canOpenSupplier}
          />
        )}
        {/* H3 (docs/plan-rendimiento.md): "Cargar más" pide la página siguiente con el mismo
            filtro de servidor (mismo status por bandeja) y ANEXA — no reemplaza — las filas ya
            visibles, incluidas las que los filtros de cliente de arriba ocultan en este momento. */}
        {nextCursor && (
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
      {confirmDialog}
    </>
  );
}

