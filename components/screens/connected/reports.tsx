"use client";

// RF-1301 (Reportes, reunión 2026-09-11): pantalla conectada de /reportes. Reemplaza el uso prestado de
// ConnectedExpenses (mismo RouteKind que /gastos, ver el historial de components/screens/connected/data.ts)
// por un reporte propio, centrado en REQUISICIONES (no en gastos): filtros por obra, periodo, aprobador y
// etiqueta; descarga en Excel del resultado filtrado; y un compilado mensual agrupado por obra/centro de
// costo, con "Aprobadas por mí" por defecto para el rol Aprobador (Juliana pidió exactamente eso en la
// reunión). El diseño de filtros queda abierto a sumar "centro de costo" el día que exista esa entidad —
// hoy centro de costo ≈ obra (ver ReportFilters en lib/services/report-service.ts).
import { useState } from "react";
import { ArrowDownToLine, Inbox, SearchX } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { SectionTitle, Tone } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  formatIsoDate,
  groupReportRowsByWork,
  money,
  type ReportBundle,
  type ReportRow,
} from "./shared";

// Únicos roles con permiso de servidor "report:export" (lib/domain/rules.ts) — Revisor solo tiene
// "report:read" (ve el reporte, no el botón), la misma asimetría que ya tenía el XLSX provisional de
// gastos (app/api/reports/expenses-report.ts). Repetir la lista aquí en vez de pedirla al servidor es el
// mismo patrón que ya usa el resto de connected/* (p. ej. ConnectedExpenses con `canCreate`).
const CAN_EXPORT_ROLES: readonly Role[] = ["Aprobador", "Contabilidad", "Administrador Mizar", "Administrador Sixteam"];

function namesFor(ids: string[], options: { id: string; name: string }[]): string {
  if (!ids.length) return "—";
  return ids.map((id) => options.find((option) => option.id === id)?.name ?? "—").join(", ");
}

export function ConnectedReports({
  data,
  role,
}: {
  data: ReportBundle;
  role: Role;
}) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const catalogs = data?.catalogs ?? emptyCatalogs;
  const isApprover = role === "Aprobador";
  const canExport = CAN_EXPORT_ROLES.includes(role);

  const [workFilter, setWorkFilter] = useState("");
  const [period, setPeriod] = useState("");
  const [approverFilter, setApproverFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
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
      (!isApprover || !approvedByMeOnly || row.status === "aprobada"),
  );
  const total = filteredRows.reduce((sum, row) => sum + row.total, 0);
  // "Compilado mensual" (RF-1301 punto 3, Daniel: "el compilado debe ir por obra/centro de costo"): el
  // resumen por obra solo tiene sentido cuando hay un mes elegido — sin periodo, "compilar" no significa
  // nada todavía.
  const workGroups = period ? groupReportRowsByWork(filteredRows, catalogs) : [];

  const clearFilters = () => {
    setWorkFilter("");
    setPeriod("");
    setApproverFilter("");
    setTagFilter("");
  };

  const exportParams = new URLSearchParams();
  if (workFilter) exportParams.set("workId", workFilter);
  if (tagFilter) exportParams.set("tagId", tagFilter);
  if (approverFilter) exportParams.set("approverId", approverFilter);
  if (period) exportParams.set("period", period);
  const exportHref = `/api/reports/export${exportParams.size ? `?${exportParams.toString()}` : ""}`;

  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Reporte operativo"
        description="Lectura autorizada de requisiciones, filtrable por obra, periodo, aprobador y etiqueta."
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
              <h2>{money.format(total)}</h2>
              <p className="panel-sub">Total de las requisiciones visibles para tu rol con estos filtros.</p>
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
                    <th>Etiqueta</th>
                    <th>Aprobador(es)</th>
                    <th>Estado</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row: ReportRow) => (
                    <tr key={row.id}>
                      <td>{row.consecutive}</td>
                      <td>{row.date ? formatIsoDate(row.date) : "—"}</td>
                      <td>{catalogs.works.find((work) => work.id === row.workId)?.name ?? "—"}</td>
                      <td>{catalogs.tags.find((tag) => tag.id === row.tagId)?.name ?? "—"}</td>
                      <td>{namesFor(row.approverIds, catalogs.users ?? [])}</td>
                      <td>
                        <Tone tone="muted">{estadoLabel(row.status)}</Tone>
                      </td>
                      <td>{money.format(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        {workGroups.length > 0 && (
          <section className="panel connected-summary" data-testid="report-work-subtotals">
            <div className="panel-head">
              <div>
                <h3>Compilado mensual por obra</h3>
                <p className="panel-sub">Subtotal de {period} por obra/centro de costo.</p>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Obra</th>
                    <th>Requisiciones</th>
                    <th>Subtotal</th>
                  </tr>
                </thead>
                <tbody>
                  {workGroups.map((group) => (
                    <tr key={group.workId || "sin-obra"}>
                      <td>{group.workName}</td>
                      <td>{group.rows.length}</td>
                      <td>{money.format(group.subtotal)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={2}><b>Total general</b></td>
                    <td><b>{money.format(total)}</b></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}
