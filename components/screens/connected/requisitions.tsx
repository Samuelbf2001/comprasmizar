"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): RequisitionQueueRows (interno)
// y ConnectedRequisitions, partidos de components/screens/connected.tsx. Misma lógica,
// mismos nombres.
import { useState } from "react";
import { ArrowRight, Inbox, SearchX } from "lucide-react";
import { sumLines } from "../../../lib/domain/rules";
import { SectionTitle, Tone } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  money,
  relativeAge,
  requisitionTone,
  resolveUserName,
  type CatalogData,
  type RequisitionRow,
  type RequisitionsBundle,
} from "./shared";
import { loadMoreRequisitions, setCachedRoute } from "./data";

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
    </>
  );
}

