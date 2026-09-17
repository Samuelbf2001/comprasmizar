"use client";

// A10 (docs/TASKS-pagos-y-caja.md · adenda §4.3, RF-708): la caja menor deja de ser un módulo aparte
// (gasto directo sin aprobación, ingresos, cierre mensual por caja) y pasa a ser un pago con medio
// "Caja (efectivo)" sobre una orden normal. Esta pantalla es ahora el CIERRE DE CAJA: los pagos en
// efectivo vigentes de un rango de fechas, con su orden, comprobante y descarga en Excel. Conserva, como
// segunda pestaña, el libro de gastos con el reparto entre obras (RF-305) y los subtotales por etiqueta
// (RF-702), que nunca dependieron de la caja. Las tablas `cajas`/`ingresos`/`cierres_caja`/`caja_menor`
// quedan dormidas (la convención del repo prohíbe DROP); los ingresos vuelven en la fase 2 (adenda §7).
import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Inbox,
  Paperclip,
  Plus,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import type { CashCloseReport } from "../../../lib/services/report-service";
import { apiRequest, friendlyErrorText } from "../../../lib/http/friendly-error";
import { SectionTitle, Tone } from "../screen-primitives";
import {
  formatIsoDate,
  groupExpensesByWorkAndTag,
  localTodayISO,
  money,
  originLabel,
  permisosDelVisor,
  type ExpenseBundle,
  type ExpenseRow,
} from "./shared";
import { mutate } from "./data";

type Tab = "cierre" | "gastos";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "cierre", label: "Cierre de caja" },
  { key: "gastos", label: "Libro de gastos" },
];

function isoOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** Lunes a viernes de la semana de `todayIso` (el cierre semanal de Daniel es el viernes, PRD §4.3).
 *  En domingo devuelve la semana que acaba de terminar: es la que se cierra, no la que empieza mañana. */
export function weekRange(todayIso: string): { from: string; to: string } {
  const today = new Date(`${todayIso}T00:00:00`);
  const weekday = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() + (weekday === 0 ? -6 : 1 - weekday));
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  return { from: isoOf(monday), to: isoOf(friday) };
}
/** Primer y último día del mes de `todayIso`. */
export function monthRangeOf(todayIso: string): { from: string; to: string } {
  const [year, month] = todayIso.split("-").map(Number);
  return { from: `${todayIso.slice(0, 7)}-01`, to: isoOf(new Date(year, month, 0)) };
}

export function ConnectedExpenses({
  data,
  role,
  refresh,
}: {
  data: ExpenseBundle;
  role: Role;
  /** Recarga los datos de la ruta. Devuelve una promesa: espérala antes de soltar el estado ocupado,
   *  o la pantalla se rehabilita mostrando todavía los datos anteriores. */
  refresh: () => void | Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("cierre");
  // DECISIÓN DE ERNESTO (2026-09-17): por permiso efectivo del visor, no por nombre de rol — es lo
  // mismo que exige el servidor y lo único que respeta los permisos editados en Configuración.
  const puede = permisosDelVisor(data, role);
  const rows = Array.isArray(data.expenses) ? data.expenses : [],
    costCenters = data.catalogs.costCenters ?? [],
    // Repartir un gasto entre obras (RF-305) exige "requisition:review", que es lo que comprueba
    // ProcurementService.redistribute.
    canCreate = puede("requisition:review"),
    canExport = puede("report:export");

  // ── Cierre de caja (RF-708) ──────────────────────────────────────────────────────────────────
  // Se consulta bajo demanda por rango (no viaja en el bundle de la ruta: el rango lo elige el usuario).
  // Sin bandera "loading" propia: `report === null` sin error significa "consultando" — mismo criterio que
  // loadRoute en screen.tsx: el efecto solo hace setState dentro de then/catch, y los manejadores de
  // cambio de filtro son quienes vuelven a poner `report` en null (regla react-hooks/set-state-in-effect).
  const today = localTodayISO();
  const initialRange = weekRange(today);
  const [from, setFrom] = useState(initialRange.from),
    [to, setTo] = useState(initialRange.to),
    [closeCostCenter, setCloseCostCenter] = useState(""),
    [report, setReport] = useState<CashCloseReport | null>(null),
    [closeError, setCloseError] = useState("");
  const rangeValid = Boolean(from && to && from <= to);
  useEffect(() => {
    if (tab !== "cierre" || !rangeValid) return;
    let active = true;
    const params = new URLSearchParams({ from, to });
    if (closeCostCenter) params.set("costCenterId", closeCostCenter);
    apiRequest<CashCloseReport>(`/api/reports/cash-close?${params.toString()}`)
      .then((loaded) => {
        if (active) setReport(loaded);
      })
      .catch((error) => {
        if (active) setCloseError(friendlyErrorText(error, "No fue posible consultar el cierre de caja."));
      });
    return () => {
      active = false;
    };
  }, [tab, from, to, closeCostCenter, rangeValid]);
  const applyRange = (next: { from: string; to: string }) => {
    setFrom(next.from);
    setTo(next.to);
    setReport(null);
    setCloseError("");
  };
  const selectCloseCostCenter = (value: string) => {
    setCloseCostCenter(value);
    setReport(null);
    setCloseError("");
  };
  const closeLoading = rangeValid && !report && !closeError;
  const closeRows = report?.rows ?? [];
  const closeOrders = new Set(closeRows.map((row) => row.orderId)).size;
  const closeWithReceipt = closeRows.filter((row) => row.attachmentId).length;
  const closeExportParams = new URLSearchParams({ from, to, format: "xlsx" });
  if (closeCostCenter) closeExportParams.set("costCenterId", closeCostCenter);
  const closeExportHref = `/api/reports/cash-close?${closeExportParams.toString()}`;

  // ── Libro de gastos ──────────────────────────────────────────────────────────────────────────
  // RF-703: obra y periodo (corte mensual) ya llegan en el payload autorizado de /api/expenses; filtrar
  // en cliente sobre lo ya recibido evita otra ruta para un cruce que cabe en memoria.
  const [expenseWorkFilter, setExpenseWorkFilter] = useState(""),
    [expenseCostCenterFilter, setExpenseCostCenterFilter] = useState(""),
    [periodFilter, setPeriodFilter] = useState("");
  // Reunión 2026-09: "la fecha del gasto es la del pago" — un gasto sin `date` es un compromiso (orden
  // generada, aún sin pagar), no un gasto de ningún mes todavía. Se separa ANTES de filtrar por periodo.
  const paidRows = rows.filter((row) => row.date !== undefined);
  const unpaidRows = rows.filter((row) => row.date === undefined);
  const filteredRows = paidRows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!expenseCostCenterFilter || row.costCenterId === expenseCostCenterFilter) &&
      (!periodFilter || row.period === periodFilter),
  );
  const filteredUnpaidRows = unpaidRows.filter(
    (row) => !expenseWorkFilter || row.workId === expenseWorkFilter,
  );
  const total = filteredRows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const unpaidTotal = filteredUnpaidRows.reduce((sum, row) => sum + Number(row.total || 0), 0);
  const clearExpenseFilters = () => {
    setExpenseWorkFilter("");
    setExpenseCostCenterFilter("");
    setPeriodFilter("");
  };
  const exportParams = new URLSearchParams();
  if (expenseWorkFilter) exportParams.set("workId", expenseWorkFilter);
  if (periodFilter) exportParams.set("period", periodFilter);
  exportParams.set("format", "xlsx");
  const exportHref = `/api/reports/expenses?${exportParams.toString()}`;
  // RF-702: subtotal por etiqueta dentro de cada obra sobre las mismas filas ya filtradas.
  const expenseGroups = groupExpensesByWorkAndTag(filteredRows, data.catalogs);
  // RF-305: el backend (validateShares en lib/domain/rules.ts, invocado por
  // ProcurementService.redistribute vía PUT /api/expenses/:id/shares) ya exige que la suma cuadre al
  // peso, sin obra repetida; esta UI solo existe para poder invocarlo.
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
  const shareExpense = shareExpenseId ? rows.find((row) => row.id === shareExpenseId) : undefined;
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
  const shareWorkIds = shareLines.map((line) => line.workId).filter((value) => value);
  const shareHasDuplicateWork = new Set(shareWorkIds).size !== shareWorkIds.length;
  const shareTotal = shareLines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0);
  const shareAllFilled = shareLines.every(
    (line) => line.workId && Number.isInteger(Number(line.amount)) && Number(line.amount) > 0,
  );
  const shareBalanced = shareExpense ? shareTotal === shareExpense.total : false;
  const shareValid = Boolean(
    shareExpense && shareLines.length > 0 && shareAllFilled && !shareHasDuplicateWork && shareBalanced,
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
        shares: shareLines.map((line) => ({ workId: line.workId, amount: Number(line.amount) })),
      });
      setShareSuccess("El gasto quedó repartido entre las obras seleccionadas.");
      refresh();
    } catch (error) {
      setShareFeedback(error instanceof Error ? error.message : "No fue posible repartir el gasto.");
    } finally {
      setShareBusy(false);
    }
  };

  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Cierre de caja"
        description="Pagos hechos por caja (efectivo) sobre órdenes, por rango de fechas, con su comprobante. El libro de gastos queda en la segunda pestaña."
      />
      <div className="catalog-admin-tabs" role="tablist" aria-label="Cierre de caja">
        {TABS.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            id={`expenses-tab-${option.key}`}
            aria-controls="expenses-tab-panel"
            aria-selected={tab === option.key}
            className={tab === option.key ? "is-active" : ""}
            onClick={() => setTab(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <section role="tabpanel" id="expenses-tab-panel" aria-labelledby={`expenses-tab-${tab}`}>
        {tab === "cierre" && (
          <>
            <div className="filter-bar">
              <label className="field">
                <span>Desde</span>
                <input
                  type="date"
                  value={from}
                  aria-invalid={!rangeValid}
                  onChange={(event) => applyRange({ from: event.target.value, to })}
                />
              </label>
              <label className="field">
                <span>Hasta</span>
                <input
                  type="date"
                  value={to}
                  aria-invalid={!rangeValid}
                  onChange={(event) => applyRange({ from, to: event.target.value })}
                />
              </label>
              <button type="button" className="filter-button" onClick={() => applyRange(weekRange(today))}>
                Esta semana
              </button>
              <button type="button" className="filter-button" onClick={() => applyRange(monthRangeOf(today))}>
                Este mes
              </button>
              <label className="field">
                <span>Centro de costo</span>
                <select value={closeCostCenter} onChange={(event) => selectCloseCostCenter(event.target.value)}>
                  <option value="">Todos</option>
                  {costCenters.map((costCenter) => (
                    <option key={costCenter.id} value={costCenter.id}>
                      {costCenter.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!rangeValid && (
              <p className="field-error" role="alert">
                La fecha inicial debe ser igual o anterior a la final.
              </p>
            )}
            <div className="stats-strip" data-testid="cash-close-summary">
              <div>
                <span>Pagado por caja</span>
                <b data-testid="cash-close-total">{report ? money.format(report.total) : "—"}</b>
              </div>
              <div>
                <span>Pagos</span>
                <b>{report ? closeRows.length : "—"}</b>
              </div>
              <div>
                <span>Órdenes</span>
                <b>{report ? closeOrders : "—"}</b>
              </div>
              <div>
                <span>Con comprobante</span>
                <b>{report ? `${closeWithReceipt} de ${closeRows.length}` : "—"}</b>
              </div>
            </div>
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Pagos por caja</h2>
                  <p className="panel-sub">
                    Del {formatIsoDate(from)} al {formatIsoDate(to)} · solo pagos vigentes con medio Caja (efectivo); los anulados no cuentan.
                  </p>
                </div>
                <div className="title-actions">
                  {canExport && (
                    <a className="button button-secondary" href={closeExportHref}>
                      <ArrowDownToLine aria-hidden="true" size={15} /> Descargar Excel
                    </a>
                  )}
                  {report && <Tone tone="muted">{closeRows.length} pagos</Tone>}
                </div>
              </div>
              {closeLoading ? (
                <p className="muted-copy" role="status">
                  Consultando los pagos por caja…
                </p>
              ) : closeError ? (
                <p className="field-error" role="alert">
                  {closeError}
                </p>
              ) : !rangeValid || closeRows.length === 0 ? (
                <div className="empty-state">
                  <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
                  <h3>Sin pagos por caja en este rango</h3>
                  <p>Los pagos aparecen aquí cuando se registran sobre una orden con medio Caja (efectivo).</p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Fecha</th>
                        <th>Orden</th>
                        <th>Beneficiario</th>
                        <th>Centro de costo</th>
                        <th>Empresa facturada</th>
                        <th>Nota</th>
                        <th>Comprobante</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {closeRows.map((row) => (
                        <tr key={row.id} data-testid="cash-close-row">
                          <td>{formatIsoDate(row.date)}</td>
                          <td>
                            <b>{row.orderConsecutive}</b>
                            <br />
                            <small className="muted-copy">{row.requisitionConsecutive}</small>
                          </td>
                          <td>{row.supplierName}</td>
                          <td>{row.costCenterName}</td>
                          <td>{row.billedCompanyName}</td>
                          <td>{row.note || row.externalReference || "—"}</td>
                          <td>
                            {row.attachmentId ? (
                              <a
                                className="text-link"
                                href={`/api/attachments/pago_orden/${encodeURIComponent(row.id)}/${encodeURIComponent(row.attachmentId)}/download`}
                              >
                                <Paperclip aria-hidden="true" size={13} /> Ver
                              </a>
                            ) : (
                              <span className="muted-copy">Sin comprobante</span>
                            )}
                          </td>
                          <td className="money">{money.format(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={7}>
                          <b>Total del rango</b>
                        </td>
                        <td className="money">
                          <b>{money.format(report?.total ?? 0)}</b>
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </section>
          </>
        )}

        {tab === "gastos" && (
          <>
            {rows.length > 0 && (
              <div className="filter-bar">
                <label className="field">
                  <span>Filtrar por obra</span>
                  <select value={expenseWorkFilter} onChange={(event) => setExpenseWorkFilter(event.target.value)}>
                    <option value="">Todas</option>
                    {data.catalogs.works.map((work) => (
                      <option key={work.id} value={work.id}>
                        {work.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Centro de costo</span>
                  <select
                    value={expenseCostCenterFilter}
                    onChange={(event) => setExpenseCostCenterFilter(event.target.value)}
                  >
                    <option value="">Todos</option>
                    {costCenters.map((costCenter) => (
                      <option key={costCenter.id} value={costCenter.id}>
                        {costCenter.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Periodo</span>
                  <input type="month" value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value)} />
                </label>
              </div>
            )}
            <div className="connected-detail-grid">
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>{money.format(total)}</h2>
                    <p className="panel-sub">Total de las filas visibles para tu rol.</p>
                  </div>
                  <div className="title-actions">
                    {canExport && (
                      <a className="button button-secondary" href={exportHref}>
                        <ArrowDownToLine aria-hidden="true" size={15} /> Descargar XLSX provisional
                      </a>
                    )}
                    <Tone tone="muted">{filteredRows.length} movimientos</Tone>
                  </div>
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
                    <button className="button button-secondary" type="button" onClick={clearExpenseFilters}>
                      Limpiar filtros
                    </button>
                  </div>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Fecha orden</th>
                          <th>Fecha pago</th>
                          <th>Obra</th>
                          <th>Centro de costo</th>
                          <th>Origen</th>
                          <th>Periodo</th>
                          <th>Total</th>
                          {canCreate && <th>Acciones</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRows.map((row) => (
                          <tr key={row.id}>
                            <td>{row.orderDate}</td>
                            <td>{row.date}</td>
                            <td>{data.catalogs.works.find((work) => work.id === row.workId)?.name ?? row.workId}</td>
                            <td>{costCenters.find((costCenter) => costCenter.id === row.costCenterId)?.name ?? "—"}</td>
                            <td>{originLabel(row.origin)}</td>
                            <td>{row.period}</td>
                            <td>{money.format(row.total)}</td>
                            {canCreate && (
                              <td>
                                <button
                                  className="text-link"
                                  type="button"
                                  data-testid="expense-share-trigger"
                                  aria-label={`Repartir gasto de la orden del ${row.orderDate} por ${money.format(row.total)}`}
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
              {filteredUnpaidRows.length > 0 && (
                // Mientras una orden generada no se paga, su valor es un COMPROMISO, no un gasto de ningún
                // mes: grupo propio, nunca mezclado con la tabla de gastos (pagados) de arriba.
                <section className="panel" data-testid="expense-unpaid-group">
                  <div className="panel-head">
                    <div>
                      <h3>Comprometido, pendiente de pago</h3>
                      <p className="panel-sub">
                        Órdenes ya generadas que todavía no se han pagado — no cuentan en el gasto de ningún
                        periodo hasta que se paguen.
                      </p>
                    </div>
                    <Tone tone="warning">{money.format(unpaidTotal)}</Tone>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Fecha orden</th>
                          <th>Obra</th>
                          <th>Origen</th>
                          <th>Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredUnpaidRows.map((row) => (
                          <tr key={row.id}>
                            <td>{row.orderDate}</td>
                            <td>{data.catalogs.works.find((work) => work.id === row.workId)?.name ?? row.workId}</td>
                            <td>{originLabel(row.origin)}</td>
                            <td>{money.format(row.total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
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
                            <tr key={`${group.workId}-${tag.tagId}`} data-testid="expense-subtotal-tag">
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
                <form className="panel connected-summary" onSubmit={submitShares} noValidate data-testid="expense-share-form">
                  <div className="panel-head">
                    <div>
                      <h3>Repartir gasto entre obras</h3>
                      <p className="panel-sub">
                        Gasto de la orden del {shareExpense.orderDate} por {money.format(shareExpense.total)}.
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
                          onChange={(event) => updateShareLine(line.key, { workId: event.target.value })}
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
                          onChange={(event) => updateShareLine(line.key, { amount: event.target.value })}
                        />
                      </label>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`Quitar obra ${index + 1} del reparto`}
                        disabled={shareLines.length === 1}
                        onClick={() => setShareLines((current) => current.filter((item) => item.key !== line.key))}
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
                    <button className="button button-dark" type="submit" disabled={!shareValid || shareBusy}>
                      {shareBusy ? "Guardando…" : "Confirmar reparto"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </>
        )}
      </section>
    </>
  );
}
