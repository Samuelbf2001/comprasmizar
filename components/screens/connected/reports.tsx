"use client";

// RF-1301 (Reportes, reunión 2026-09-11): pantalla conectada de /reportes, centrada en REQUISICIONES:
// filtros por obra, periodo, aprobador, etiqueta y centro de costo; descarga en Excel del resultado
// filtrado; y un compilado mensual agrupado por centro de costo, con "Aprobadas por mí" por defecto para
// el rol Aprobador (Juliana pidió exactamente eso en la reunión).
// RF-707 (adenda de pagos): filtro por empresa facturada y un bloque de ÓRDENES — "comprometido"
// (Σ órdenes generadas) frente a "pagado" (Σ pagos vigentes) por centro de costo y por periodo — con sus
// propios filtros de medio y estado de pago (una requisición no tiene pagos; la orden sí).
import { Fragment, useEffect, useState } from "react";
import { ArrowDownToLine, Inbox, SearchX } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { requisitionCountsInTotal } from "../../../lib/domain/rules";
import {
  filterOrderReportRows,
  groupCommittedVsPaid,
  requisitionPaymentStatuses,
  summarizeCommittedVsPaid,
  type CommittedVsPaidGroup,
  type OrderReportRow,
} from "../../../lib/services/report-service";
import { apiRequest, friendlyErrorText } from "../../../lib/http/friendly-error";
import { SectionTitle, Tone } from "../screen-primitives";
import { MEDIO_PAGO_OPTIONS, PAYMENT_STATUS_LABELS, paymentStatusLabel } from "./payment-labels";
import {
  emptyCatalogs,
  estadoLabel,
  formatIsoDate,
  groupReportRowsByCostCenter,
  money,
  permisosDelVisor,
  type ReportBundle,
  type ReportRow,
} from "./shared";

// `billedCompanyId` ya viaja en GET /api/reports (ReportRow en lib/services/report-service.ts); el tipo
// de shared.tsx no se toca en la ola 2, así que se extiende aquí.
type ReportRowWithCompany = ReportRow & { billedCompanyId?: string };

function namesFor(ids: string[], options: { id: string; name: string }[]): string {
  if (!ids.length) return "—";
  return ids.map((id) => options.find((option) => option.id === id)?.name ?? "—").join(", ");
}

// Los cálculos de "Comprometido vs pagado" viven en lib/services/report-service.ts (una sola copia, la
// misma que usa el Excel); se reexportan para quien ya los importaba desde aquí.
export { groupCommittedVsPaid, type CommittedVsPaidGroup };

export function ConnectedReports({
  data,
  role,
}: {
  data: ReportBundle;
  role: Role;
}) {
  const rows = (Array.isArray(data?.rows) ? data.rows : []) as ReportRowWithCompany[];
  const catalogs = data?.catalogs ?? emptyCatalogs;
  const societies = catalogs.societies ?? [];
  const costCenters = catalogs.costCenters ?? [];
  // "Aprobadas por mí" por defecto es una preferencia de PRESENTACIÓN del rol Aprobador (lo pidió
  // Juliana), no una acción con permiso detrás: se queda decidida por rol.
  const isApprover = role === "Aprobador";
  // Descargar el reporte, en cambio, es "report:export" — el mismo permiso que exige el servidor y que
  // ahora se edita desde Configuración (Revisor solo tiene "report:read": entra y no descarga).
  const canExport = permisosDelVisor(data, role)("report:export");

  const [workFilter, setWorkFilter] = useState("");
  const [period, setPeriod] = useState("");
  const [approverFilter, setApproverFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  // Centros de costo (UI, 2026-09-12): filtro adicional, independiente de "Obra" — una requisición
  // puede compartir centro con otras obras.
  const [costCenterFilter, setCostCenterFilter] = useState("");
  // RF-707: empresa facturada (a quién viene el soporte), independiente del centro de costo.
  const [billedCompanyFilter, setBilledCompanyFilter] = useState("");
  // RF-1301 punto 3: por defecto, un aprobador entra viendo solo lo que YA aprobó (no lo pendiente ni lo
  // declinado) — puede destildarlo para ver el resto de lo que tiene asignado en el mes.
  const [approvedByMeOnly, setApprovedByMeOnly] = useState(isApprover);

  // Mismo criterio que ConnectedExpenses (RF-703: filtrar en cliente sobre lo ya autorizado por
  // GET /api/reports en vez de otra ruta de servicio por cada combinación de filtros): sin useMemo,
  // como el resto de connected/* — el volumen de requisiciones visibles cabe de sobra en un `.filter()`
  // por render.
  const filteredRows = rows.filter(
    (row) =>
      (!workFilter || row.workId === workFilter) &&
      (!period || row.date?.slice(0, 7) === period) &&
      (!approverFilter || row.approverIds.includes(approverFilter)) &&
      (!tagFilter || row.tagId === tagFilter) &&
      (!costCenterFilter || row.costCenterId === costCenterFilter) &&
      (!billedCompanyFilter || row.billedCompanyId === billedCompanyFilter) &&
      (!isApprover || !approvedByMeOnly || row.status === "aprobada"),
  );
  // Hallazgo del ensayo 2026-09-22: el total es el valor VIGENTE solicitado — devueltas y declinadas se
  // listan con su estado pero no suman (regla única: `requisitionCountsInTotal`, lib/domain/rules.ts).
  const total = filteredRows.reduce((sum, row) => sum + (requisitionCountsInTotal(row.status) ? row.total : 0), 0);
  const excludedRows = filteredRows.filter((row) => !requisitionCountsInTotal(row.status));
  const excludedSummary = (["devuelta", "declinada"] as const)
    .map((status) => {
      const statusRows = excludedRows.filter((row) => row.status === status);
      return { status, count: statusRows.length, total: statusRows.reduce((sum, row) => sum + row.total, 0) };
    })
    .filter((entry) => entry.count > 0);
  // "Compilado mensual" (RF-1301 punto 3, Daniel: "el compilado debe ir por obra/centro de costo"): el
  // resumen por centro de costo (con la obra como subnivel) solo tiene sentido cuando hay un mes
  // elegido — sin periodo, "compilar" no significa nada todavía.
  const costCenterGroups = period ? groupReportRowsByCostCenter(filteredRows, catalogs) : [];

  // ── Órdenes: comprometido vs pagado (RF-707) ──────────────────────────────────────────────────
  // Se piden una vez al montar (todo lo visible para el actor, como /api/reports) y se filtran en
  // cliente con los mismos filtros de arriba más medio/estado de pago. Sin bandera "loading": `null`
  // sin error significa "consultando"; el efecto solo hace setState dentro de then/catch.
  const [orderRows, setOrderRows] = useState<OrderReportRow[] | null>(null);
  const [ordersError, setOrdersError] = useState("");
  const [paymentMethodFilter, setPaymentMethodFilter] = useState("");
  const [paymentStatusFilter, setPaymentStatusFilter] = useState("");
  useEffect(() => {
    let active = true;
    apiRequest<{ rows: OrderReportRow[] }>("/api/reports/orders")
      .then((loaded) => {
        if (active) setOrderRows(Array.isArray(loaded?.rows) ? loaded.rows : []);
      })
      .catch((error) => {
        if (active) setOrdersError(friendlyErrorText(error, "No fue posible consultar las órdenes."));
      });
    return () => {
      active = false;
    };
  }, []);
  const filteredOrders = filterOrderReportRows(orderRows ?? [], {
    workId: workFilter,
    period,
    costCenterId: costCenterFilter,
    billedCompanyId: billedCompanyFilter,
    paymentMethod: paymentMethodFilter,
    paymentStatus: paymentStatusFilter,
  });
  const { committed, paid, balance } = summarizeCommittedVsPaid(filteredOrders);
  // Estado de pago por requisición: sobre TODAS sus órdenes comprometidas (no solo las filtradas por
  // medio/estado de pago), igual que la columna del Excel.
  const paymentStatusByRequisition = requisitionPaymentStatuses(orderRows ?? []);
  const requisitionPaymentLabel = (id: string) => {
    if (orderRows === null) return "—";
    const status = paymentStatusByRequisition.get(id);
    return status ? paymentStatusLabel(status) : "Sin orden";
  };
  const costCenterName = (id: string) => (id ? (costCenters.find((costCenter) => costCenter.id === id)?.name ?? "—") : "Sin centro de costo");
  const byCostCenter = groupCommittedVsPaid(filteredOrders, (row) => row.costCenterId)
    .sort((a, b) => costCenterName(a.key).localeCompare(costCenterName(b.key), "es"));
  const byPeriod = groupCommittedVsPaid(filteredOrders, (row) => row.period)
    .sort((a, b) => b.key.localeCompare(a.key));
  const ordersLoading = orderRows === null && !ordersError;

  const clearFilters = () => {
    setWorkFilter("");
    setPeriod("");
    setApproverFilter("");
    setTagFilter("");
    setCostCenterFilter("");
    setBilledCompanyFilter("");
    setPaymentMethodFilter("");
    setPaymentStatusFilter("");
  };

  const exportParams = new URLSearchParams();
  if (workFilter) exportParams.set("workId", workFilter);
  if (tagFilter) exportParams.set("tagId", tagFilter);
  if (approverFilter) exportParams.set("approverId", approverFilter);
  if (costCenterFilter) exportParams.set("costCenterId", costCenterFilter);
  if (billedCompanyFilter) exportParams.set("billedCompanyId", billedCompanyFilter);
  if (period) exportParams.set("period", period);
  // El bloque "Comprometido vs pagado" del Excel usa también los filtros propios de ese bloque.
  if (paymentMethodFilter) exportParams.set("paymentMethod", paymentMethodFilter);
  if (paymentStatusFilter) exportParams.set("paymentStatus", paymentStatusFilter);
  const exportHref = `/api/reports/export${exportParams.size ? `?${exportParams.toString()}` : ""}`;

  const balanceRow = (group: CommittedVsPaidGroup, label: string) => (
    <tr key={group.key || "sin-clave"}>
      <td>{label}</td>
      <td>{group.orders}</td>
      <td className="money">{money.format(group.committed)}</td>
      <td className="money">{money.format(group.paid)}</td>
      <td className="money">{money.format(group.committed - group.paid)}</td>
    </tr>
  );

  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Reporte operativo"
        description="Lectura autorizada de requisiciones, filtrable por obra, periodo, aprobador, etiqueta, centro de costo y empresa facturada; y el comprometido frente a lo pagado por orden."
        action={
          canExport ? (
            <a className="button button-dark" href={exportHref}>
              <ArrowDownToLine aria-hidden="true" size={15} /> Descargar Excel
            </a>
          ) : undefined
        }
      />
      {rows.length > 0 && (
        <div className="filter-bar">
          <label className="field">
            <span>Obra</span>
            <select value={workFilter} onChange={(event) => setWorkFilter(event.target.value)}>
              <option value="">Todas</option>
              {catalogs.works.map((work) => (
                <option key={work.id} value={work.id}>{work.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Mes</span>
            <input type="month" value={period} onChange={(event) => setPeriod(event.target.value)} />
          </label>
          <label className="field">
            <span>Aprobador</span>
            <select value={approverFilter} onChange={(event) => setApproverFilter(event.target.value)}>
              <option value="">Todos</option>
              {(catalogs.approvers ?? []).map((approver) => (
                <option key={approver.id} value={approver.id}>{approver.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Etiqueta</span>
            <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="">Todas</option>
              {catalogs.tags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Centro de costo</span>
            <select value={costCenterFilter} onChange={(event) => setCostCenterFilter(event.target.value)}>
              <option value="">Todos</option>
              {costCenters.map((costCenter) => (
                <option key={costCenter.id} value={costCenter.id}>{costCenter.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Empresa facturada</span>
            <select value={billedCompanyFilter} onChange={(event) => setBilledCompanyFilter(event.target.value)}>
              <option value="">Todas</option>
              {societies.map((society) => (
                <option key={society.id} value={society.id}>{society.name}</option>
              ))}
            </select>
          </label>
          {isApprover && (
            <label className="filter-button">
              <input
                type="checkbox"
                checked={approvedByMeOnly}
                onChange={(event) => setApprovedByMeOnly(event.target.checked)}
              />
              Aprobadas por mí
            </label>
          )}
        </div>
      )}
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2 data-testid="report-total">{money.format(total)}</h2>
              <p className="panel-sub">
                Valor vigente de las requisiciones visibles para tu rol con estos filtros (enviadas, en revisión, en aprobación y aprobadas).
              </p>
              {excludedSummary.length > 0 && (
                <p className="panel-sub" data-testid="report-excluded">
                  No suman al total:{" "}
                  {excludedSummary
                    .map((entry) => `${entry.count} ${entry.status === "devuelta" ? (entry.count === 1 ? "devuelta" : "devueltas") : entry.count === 1 ? "declinada" : "declinadas"} por ${money.format(entry.total)}`)
                    .join(" y ")}
                  . Siguen en la tabla con su estado.
                </p>
              )}
            </div>
            <Tone tone="muted">{filteredRows.length} requisiciones</Tone>
          </div>
          {rows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
              <h3>Sin requisiciones visibles</h3>
              <p>El servicio no devolvió requisiciones para tu alcance.</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
              <h3>Sin resultados para estos filtros</h3>
              <p>Ajusta o limpia los filtros para ver más requisiciones.</p>
              <button className="button button-secondary" type="button" onClick={clearFilters}>
                Limpiar filtros
              </button>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Consecutivo</th>
                    <th>Fecha</th>
                    <th>Obra</th>
                    <th>Centro de costo</th>
                    <th>Empresa facturada</th>
                    <th>Etiqueta</th>
                    <th>Aprobador(es)</th>
                    <th>Estado</th>
                    <th>Estado de pago</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.consecutive}</td>
                      <td>{row.date ? formatIsoDate(row.date) : "—"}</td>
                      <td>{catalogs.works.find((work) => work.id === row.workId)?.name ?? "—"}</td>
                      <td>{costCenters.find((costCenter) => costCenter.id === row.costCenterId)?.name ?? "—"}</td>
                      <td>{societies.find((society) => society.id === row.billedCompanyId)?.name ?? "—"}</td>
                      <td>{catalogs.tags.find((tag) => tag.id === row.tagId)?.name ?? "—"}</td>
                      <td>{namesFor(row.approverIds, catalogs.users ?? [])}</td>
                      <td>
                        <Tone tone="muted">{estadoLabel(row.status)}</Tone>
                      </td>
                      <td>{requisitionPaymentLabel(row.id)}</td>
                      <td>
                        {requisitionCountsInTotal(row.status) ? (
                          money.format(row.total)
                        ) : (
                          <s title="No suma al total" aria-label={`${money.format(row.total)}, no suma al total`}>{money.format(row.total)}</s>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {costCenterGroups.length > 0 && (
          <section className="panel connected-summary" data-testid="report-costcenter-subtotals">
            <div className="panel-head">
              <div>
                <h3>Compilado mensual por centro de costo</h3>
                <p className="panel-sub">Subtotal de {period} por centro de costo, con la obra como desglose.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Centro de costo</th>
                    <th>Obra</th>
                    <th>Requisiciones</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {costCenterGroups.map((group) => (
                    <Fragment key={group.costCenterId || "sin-centro"}>
                      {group.works.map((work, index) => (
                        <tr key={work.workId || "sin-obra"}>
                          {index === 0 && (
                            <td rowSpan={group.works.length}>{group.costCenterName}</td>
                          )}
                          <td>{work.workName}</td>
                          <td>{work.rows.length}</td>
                          <td>{money.format(work.subtotal)}</td>
                        </tr>
                      ))}
                      <tr className="report-costcenter-subtotal-row">
                        <td colSpan={2}><b>Subtotal {group.costCenterName}</b></td>
                        <td><b>{group.rows.length}</b></td>
                        <td><b>{money.format(group.subtotal)}</b></td>
                      </tr>
                    </Fragment>
                  ))}
                  <tr>
                    <td colSpan={3}><b>Total general</b></td>
                    <td><b>{money.format(total)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
      <section className="panel" data-testid="report-committed-vs-paid">
        <div className="panel-head">
          <div>
            <h2>Comprometido vs pagado</h2>
            <p className="panel-sub">
              Órdenes generadas (lo comprometido) frente a sus pagos vigentes, con los filtros de arriba; los pagos anulados no cuentan.
            </p>
          </div>
          <div className="title-actions">
            <label className="field">
              <span>Medio de pago</span>
              <select value={paymentMethodFilter} onChange={(event) => setPaymentMethodFilter(event.target.value)}>
                <option value="">Todos</option>
                {MEDIO_PAGO_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Estado de pago</span>
              <select value={paymentStatusFilter} onChange={(event) => setPaymentStatusFilter(event.target.value)}>
                <option value="">Todos</option>
                {(Object.keys(PAYMENT_STATUS_LABELS) as Array<keyof typeof PAYMENT_STATUS_LABELS>).map((status) => (
                  <option key={status} value={status}>{PAYMENT_STATUS_LABELS[status]}</option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {ordersLoading ? (
          <p className="muted-copy" role="status">Consultando las órdenes…</p>
        ) : ordersError ? (
          <p className="field-error" role="alert">{ordersError}</p>
        ) : (
          <>
            <div className="stats-strip">
              <div>
                <span>Comprometido</span>
                <b data-testid="report-committed">{money.format(committed)}</b>
              </div>
              <div>
                <span>Pagado</span>
                <b data-testid="report-paid">{money.format(paid)}</b>
              </div>
              <div>
                <span>Saldo por pagar</span>
                <b data-testid="report-balance">{money.format(balance)}</b>
              </div>
              <div>
                <span>Órdenes</span>
                <b data-testid="report-orders-count">{filteredOrders.length}</b>
              </div>
            </div>
            {filteredOrders.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
                <h3>Sin órdenes para estos filtros</h3>
                <p>Ajusta o limpia los filtros para ver el comprometido y lo pagado.</p>
              </div>
            ) : (
              <>
                <div className="table-wrap" data-testid="report-by-costcenter">
                  <table>
                    <thead>
                      <tr>
                        <th>Centro de costo</th>
                        <th>Órdenes</th>
                        <th>Comprometido</th>
                        <th>Pagado</th>
                        <th>Saldo</th>
                      </tr>
                    </thead>
                    <tbody>{byCostCenter.map((group) => balanceRow(group, costCenterName(group.key)))}</tbody>
                  </table>
                </div>
                <div className="table-wrap" data-testid="report-by-period">
                  <table>
                    <thead>
                      <tr>
                        <th>Periodo (mes de la orden)</th>
                        <th>Órdenes</th>
                        <th>Comprometido</th>
                        <th>Pagado</th>
                        <th>Saldo</th>
                      </tr>
                    </thead>
                    <tbody>{byPeriod.map((group) => balanceRow(group, group.key || "Sin fecha"))}</tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}
      </section>
    </>
  );
}
