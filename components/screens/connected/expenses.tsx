"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedExpenses, partido de
// components/screens/connected.tsx. Misma lógica, mismos nombres.
//
// Cajas, ingresos y cierres (cliente, 11-sep-2026): «TODOS los gastos (cajas, bancos, personales)
// quedan en el sistema por centro de costo; Daniel cierra la caja administrativa a inicio de mes e
// ingresa esos gastos para el reporte; cruce de ingresos/salidas». La pantalla pasa de un solo bloque
// (gastos + caja menor) a TRES pestañas — Gastos, Ingresos, Cierre mensual — cada una con un único
// botón primario, mismo patrón de pestañas que catalog-admin.tsx (clase `catalog-admin-tabs`
// reutilizada, no duplicada).
import { useEffect, useState, type FormEvent } from "react";
import {
  ArrowDownToLine,
  ArrowRight,
  Inbox,
  Plus,
  SearchX,
  Trash2,
  X,
} from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { apiRequest, friendlyErrorText } from "../../../lib/http/friendly-error";
import { SectionTitle, Tone } from "../screen-primitives";
import { AttachmentPicker } from "../attachment-upload";
import {
  cashBoxTypeLabel,
  groupExpensesByWorkAndTag,
  localTodayISO,
  money,
  originLabel,
  paymentMethodLabel,
  resolveWorkCostCenter,
  uploadOperationalAttachment,
  type AttachmentProgress,
  type CashCloseRow,
  type ExpenseBundle,
  type ExpenseRow,
  type IncomeRow,
  type PettyRow,
} from "./shared";
import { mutate } from "./data";

type Tab = "gastos" | "ingresos" | "cierre";
const TABS: Array<{ key: Tab; label: string }> = [
  { key: "gastos", label: "Gastos" },
  { key: "ingresos", label: "Ingresos" },
  { key: "cierre", label: "Cierre mensual" },
];
// EXACTAMENTE los valores de `public.medio_pago` (202609120002_pagos_orden.sql).
const PAYMENT_METHODS = ["efectivo", "transferencia", "cheque", "tarjeta", "otro"] as const;
function periodOf(dateIso: string): string {
  return dateIso.slice(0, 7);
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
  const [tab, setTab] = useState<Tab>("gastos");
  const rows = Array.isArray(data.expenses) ? data.expenses : [],
    sourcePettyRows = Array.isArray(data.pettyCash) ? data.pettyCash : [],
    sourceIncomeRows = Array.isArray(data.incomes) ? data.incomes : [],
    pettyAttachments = data.pettyAttachments ?? {},
    cashBoxes = data.catalogs.cashBoxes ?? [],
    costCenters = data.catalogs.costCenters ?? [],
    // petty_cash:create es revisor/admin_sixteam — el "gasto directo" sigue siendo registerPettyCash.
    canCreate = role === "Revisor" || role === "Administrador Sixteam",
    // income:register/petty_cash:read comparten EXACTAMENTE el mismo conjunto de roles (lib/domain/rules.ts):
    // revisor, contabilidad, admin_sixteam.
    canReadPettyCash = canCreate || role === "Contabilidad",
    canRegisterIncome = canReadPettyCash,
    // cash:close es contabilidad/admin_sixteam — SIN revisor (cerrar caja es un gesto contable).
    canCloseCash = role === "Contabilidad" || role === "Administrador Sixteam",
    canReopenCash = role === "Administrador Sixteam",
    // report:export (XLSX provisional): mismo criterio ya usado para el botón que existía antes de
    // separar Reportes — Contabilidad/Administrador Mizar/Administrador Sixteam.
    canExport = role === "Contabilidad" || role === "Administrador Mizar" || role === "Administrador Sixteam";
  const [workId, setWorkId] = useState(data.catalogs.works[0]?.id ?? ""),
    [tagId, setTagId] = useState(data.catalogs.tags[0]?.id ?? ""),
    [cashBoxId, setCashBoxId] = useState(cashBoxes[0]?.id ?? ""),
    [costCenterId, setCostCenterId] = useState(resolveWorkCostCenter(data.catalogs, data.catalogs.works[0]?.id ?? "")),
    [paymentMethod, setPaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("efectivo"),
    [date, setDate] = useState(localTodayISO()),
    [concept, setConcept] = useState(""),
    [baseAmount, setBaseAmount] = useState(""),
    [ivaAmount, setIvaAmount] = useState(""),
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
    [expenseCashBoxFilter, setExpenseCashBoxFilter] = useState(""),
    [expenseCostCenterFilter, setExpenseCostCenterFilter] = useState(""),
    [periodFilter, setPeriodFilter] = useState("");
  // Reunión 2026-09: "la fecha del gasto es la del pago" — un gasto sin `date` es un compromiso
  // (orden generada, aún sin pagar), no un gasto de ningún mes todavía. Se separa ANTES de filtrar
  // por periodo: el filtro de periodo solo tiene sentido sobre lo ya pagado (mismo criterio que
  // groupExpenseByPeriod en el dominio), y lo comprometido se muestra aparte, siempre visible.
  const paidRows = rows.filter((row) => row.date !== undefined);
  const unpaidRows = rows.filter((row) => row.date === undefined);
  const filteredRows = paidRows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!expenseCashBoxFilter || row.cashBoxId === expenseCashBoxFilter) &&
      (!expenseCostCenterFilter || row.costCenterId === expenseCostCenterFilter) &&
      (!periodFilter || row.period === periodFilter),
  );
  const filteredUnpaidRows = unpaidRows.filter(
    (row) => !expenseWorkFilter || row.workId === expenseWorkFilter,
  );
  const filteredPettyRows = pettyRows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!expenseCashBoxFilter || row.cashBoxId === expenseCashBoxFilter) &&
      (!expenseCostCenterFilter || row.costCenterId === expenseCostCenterFilter) &&
      (!periodFilter || row.date.slice(0, 7) === periodFilter),
  );
  const total = filteredRows.reduce(
    (sum, row) => sum + Number(row.total || 0),
    0,
  );
  const unpaidTotal = filteredUnpaidRows.reduce(
    (sum, row) => sum + Number(row.total || 0),
    0,
  );
  const pettyTotal = filteredPettyRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
  const clearExpenseFilters = () => {
    setExpenseWorkFilter("");
    setExpenseCashBoxFilter("");
    setExpenseCostCenterFilter("");
    setPeriodFilter("");
  };
  const exportParams = new URLSearchParams();
  if (workId) exportParams.set("workId", workId);
  if (periodFilter) exportParams.set("period", periodFilter);
  exportParams.set("format", "xlsx");
  const exportHref = `/api/reports/expenses?${exportParams.toString()}`;
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
      setFeedback("El gasto ya fue creado; consulta la lista para gestionar el soporte pendiente.");
      return;
    }
    const base = Number(baseAmount), iva = ivaAmount.trim() ? Number(ivaAmount) : 0;
    if (
      !workId ||
      !tagId ||
      !cashBoxId ||
      !paymentMethod ||
      !date ||
      !concept.trim() ||
      !Number.isFinite(base) ||
      base <= 0 ||
      !Number.isFinite(iva) ||
      iva < 0
    ) {
      setFeedback(
        "Completa obra, caja, medio de pago, fecha, concepto y un valor base mayor a cero.",
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
        amount: base,
        iva,
        cashBoxId,
        paymentMethod,
        ...(costCenterId ? { costCenterId } : {}),
      })) as { entry?: { id?: string } };
      createdEntityId = created.entry?.id ?? "";
      if (!createdEntityId) throw new Error("El servicio no devolvió el identificador del gasto.");
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
        setSuccess("Gasto registrado y recibo cargado correctamente.");
      } else {
        setSuccess("Gasto registrado correctamente.");
      }
      setReceiptFile(null);
      refresh();
    } catch (error) {
      setFeedback(
        createdEntityId
          ? `El gasto sí fue creado; el recibo quedó pendiente. ${
              error instanceof Error ? error.message : "No fue posible completar la carga."
            }`
          : error instanceof Error
            ? error.message
            : "No fue posible registrar el gasto.",
      );
      setBusy(false);
    }
  };

  // ── Ingresos ─────────────────────────────────────────────────────────────────────────────────
  const [localIncomeRows, setLocalIncomeRows] = useState<IncomeRow[]>([]);
  const incomeRows = [
    ...sourceIncomeRows,
    ...localIncomeRows.filter((local) => !sourceIncomeRows.some((row) => row.id === local.id)),
  ];
  const [incomeWorkFilter, setIncomeWorkFilter] = useState(""),
    [incomeCashBoxFilter, setIncomeCashBoxFilter] = useState(""),
    [incomeCostCenterFilter, setIncomeCostCenterFilter] = useState(""),
    [incomePeriodFilter, setIncomePeriodFilter] = useState("");
  const filteredIncomeRows = incomeRows.filter(
    (row) =>
      (!incomeWorkFilter || row.workId === incomeWorkFilter) &&
      (!incomeCashBoxFilter || row.cashBoxId === incomeCashBoxFilter) &&
      (!incomeCostCenterFilter || row.costCenterId === incomeCostCenterFilter) &&
      (!incomePeriodFilter || periodOf(row.date) === incomePeriodFilter),
  );
  const incomeTotal = filteredIncomeRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const clearIncomeFilters = () => {
    setIncomeWorkFilter("");
    setIncomeCashBoxFilter("");
    setIncomeCostCenterFilter("");
    setIncomePeriodFilter("");
  };
  const [incomeCashBoxId, setIncomeCashBoxId] = useState(cashBoxes[0]?.id ?? ""),
    [incomeCostCenterId, setIncomeCostCenterId] = useState(costCenters[0]?.id ?? ""),
    [incomeWorkId, setIncomeWorkId] = useState(""),
    [incomeDate, setIncomeDate] = useState(localTodayISO()),
    [incomeConcept, setIncomeConcept] = useState(""),
    [incomeAmount, setIncomeAmount] = useState(""),
    [incomePaymentMethod, setIncomePaymentMethod] = useState<(typeof PAYMENT_METHODS)[number]>("efectivo"),
    [incomeThirdParty, setIncomeThirdParty] = useState(""),
    [incomeBusy, setIncomeBusy] = useState(false),
    [incomeFeedback, setIncomeFeedback] = useState(""),
    [incomeSuccess, setIncomeSuccess] = useState("");
  const submitIncome = async (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(incomeAmount);
    if (
      !incomeCashBoxId ||
      !incomeCostCenterId ||
      !incomeDate ||
      !incomeConcept.trim() ||
      !incomePaymentMethod ||
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      setIncomeFeedback("Completa caja, centro de costo, fecha, concepto y un valor mayor a cero.");
      return;
    }
    setIncomeBusy(true);
    setIncomeFeedback("");
    setIncomeSuccess("");
    try {
      const created = (await mutate("/api/incomes", "POST", {
        cashBoxId: incomeCashBoxId,
        costCenterId: incomeCostCenterId,
        date: incomeDate,
        concept: incomeConcept.trim(),
        amount,
        paymentMethod: incomePaymentMethod,
        ...(incomeWorkId ? { workId: incomeWorkId } : {}),
        ...(incomeThirdParty.trim() ? { thirdParty: incomeThirdParty.trim() } : {}),
      })) as IncomeRow;
      setLocalIncomeRows((current) => [...current, created]);
      setIncomeConcept("");
      setIncomeAmount("");
      setIncomeThirdParty("");
      setIncomeSuccess("Ingreso registrado correctamente.");
      refresh();
    } catch (error) {
      setIncomeFeedback(friendlyErrorText(error, "No fue posible registrar el ingreso."));
    } finally {
      setIncomeBusy(false);
    }
  };

  // ── Cierre mensual ───────────────────────────────────────────────────────────────────────────
  const currentMonth = localTodayISO().slice(0, 7);
  // Sin bandera "closeLoading" propia: mientras `closeSummary` sigue en null (limpiado a mano en los
  // `onChange` de caja/mes, un manejador de evento, NUNCA dentro del cuerpo del efecto) y no hay
  // `closeFeedback`, la pantalla ya sabe que está "consultando" — mismo criterio que loadRoute en
  // screen.tsx: el efecto solo llama a setState dentro de then/catch, nunca de forma síncrona en su
  // propio cuerpo (regla react-hooks/set-state-in-effect).
  const [closeCashBoxId, setCloseCashBoxId] = useState(cashBoxes[0]?.id ?? ""),
    [closePeriod, setClosePeriod] = useState(currentMonth),
    [closeSummary, setCloseSummary] = useState<CashCloseRow | null>(null),
    [closeBusy, setCloseBusy] = useState(false),
    [closeFeedback, setCloseFeedback] = useState(""),
    [closeSuccess, setCloseSuccess] = useState("");
  useEffect(() => {
    if (tab !== "cierre" || !closeCashBoxId || !closePeriod) return;
    let active = true;
    apiRequest<CashCloseRow>(`/api/cash-closes?cashBoxId=${encodeURIComponent(closeCashBoxId)}&period=${encodeURIComponent(closePeriod)}`)
      .then((summary) => {
        if (active) setCloseSummary(summary);
      })
      .catch((error) => {
        if (active) setCloseFeedback(friendlyErrorText(error, "No fue posible consultar el cierre de esta caja."));
      });
    return () => {
      active = false;
    };
  }, [tab, closeCashBoxId, closePeriod]);
  const selectCloseCashBox = (value: string) => {
    setCloseCashBoxId(value);
    setCloseSummary(null);
    setCloseFeedback("");
    setCloseSuccess("");
  };
  const selectClosePeriod = (value: string) => {
    setClosePeriod(value);
    setCloseSummary(null);
    setCloseFeedback("");
    setCloseSuccess("");
  };
  const closeCashPeriod = async () => {
    setCloseBusy(true);
    setCloseFeedback("");
    setCloseSuccess("");
    try {
      const closed = await mutate("/api/cash-closes", "POST", { cashBoxId: closeCashBoxId, period: closePeriod, action: "close" }) as CashCloseRow;
      setCloseSummary(closed);
      setCloseSuccess("El mes quedó cerrado. Sus movimientos ya no admiten altas ni ediciones.");
      refresh();
    } catch (error) {
      setCloseFeedback(friendlyErrorText(error, "No fue posible cerrar el mes."));
    } finally {
      setCloseBusy(false);
    }
  };
  const reopenCashPeriod = async () => {
    setCloseBusy(true);
    setCloseFeedback("");
    setCloseSuccess("");
    try {
      const reopened = await mutate("/api/cash-closes", "POST", { cashBoxId: closeCashBoxId, period: closePeriod, action: "reopen" }) as CashCloseRow;
      setCloseSummary(reopened);
      setCloseSuccess("El mes quedó reabierto.");
      refresh();
    } catch (error) {
      setCloseFeedback(friendlyErrorText(error, "No fue posible reabrir el mes."));
    } finally {
      setCloseBusy(false);
    }
  };

  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Gastos y caja"
        description="Lectura autorizada del libro común de gastos, ingresos y cierres mensuales por caja."
      />
      <div className="catalog-admin-tabs" role="tablist" aria-label="Gastos y caja">
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
        {tab === "gastos" && (
          <>
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
                  <span>Caja</span>
                  <select
                    value={expenseCashBoxFilter}
                    onChange={(event) => setExpenseCashBoxFilter(event.target.value)}
                  >
                    <option value="">Todas</option>
                    {cashBoxes.map((cashBox) => (
                      <option key={cashBox.id} value={cashBox.id}>
                        {cashBox.name}
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
                            <td>
                              {data.catalogs.works.find(
                                (work) => work.id === row.workId,
                              )?.name ?? row.workId}
                            </td>
                            <td>
                              {costCenters.find((costCenter) => costCenter.id === row.costCenterId)?.name ?? "—"}
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
                // Reunión 2026-09: "la fecha del gasto es la del pago" — mientras una orden generada no se
                // paga, su valor es un COMPROMISO, no un gasto de ningún mes: se muestra en un grupo propio,
                // nunca mezclado con la tabla de gastos (pagados) de arriba, para que ese dinero no
                // desaparezca de la vista hasta que se pague.
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
                            <td>
                              {data.catalogs.works.find(
                                (work) => work.id === row.workId,
                              )?.name ?? row.workId}
                            </td>
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
                      <h2>Caja</h2>
                      <p className="panel-sub">
                        Movimientos de caja registrados por el servicio.
                      </p>
                    </div>
                    <Tone tone="muted">{money.format(pettyTotal)}</Tone>
                  </div>
                  {pettyRows.length === 0 ? (
                    <div className="empty-state">
                      <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
                      <h3>Sin movimientos de caja</h3>
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
                            <th>Caja</th>
                            <th>Medio de pago</th>
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
                              <td>
                                {cashBoxes.find((cashBox) => cashBox.id === row.cashBoxId)?.name ?? "—"}
                              </td>
                              <td>{row.paymentMethod ? paymentMethodLabel(row.paymentMethod) : "—"}</td>
                              <td>{money.format(row.amount + (row.iva ?? 0))}</td>
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
              {canCreate && (
                <form
                  className="panel connected-summary"
                  onSubmit={submit}
                  noValidate
                >
                  <h3>Registrar gasto directo</h3>
                  <label className="field">
                    <span>Caja</span>
                    <select
                      required
                      value={cashBoxId}
                      aria-invalid={Boolean(feedback && !cashBoxId)}
                      onChange={(event) => setCashBoxId(event.target.value)}
                    >
                      {cashBoxes.length === 0 && <option value="">Sin cajas activas</option>}
                      {cashBoxes.map((cashBox) => (
                        <option key={cashBox.id} value={cashBox.id}>
                          {cashBox.name} ({cashBoxTypeLabel(cashBox.type)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Obra</span>
                    <select
                      required
                      value={workId}
                      aria-invalid={Boolean(feedback && !workId)}
                      aria-describedby="petty-cash-error"
                      onChange={(event) => {
                        setWorkId(event.target.value);
                        setCostCenterId(resolveWorkCostCenter(data.catalogs, event.target.value));
                      }}
                    >
                      {data.catalogs.works.map((work) => (
                        <option key={work.id} value={work.id}>
                          {work.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>
                      Centro de costo <small>predeterminado el de la obra, editable</small>
                    </span>
                    <select
                      value={costCenterId}
                      disabled={!costCenters.length}
                      onChange={(event) => setCostCenterId(event.target.value)}
                    >
                      <option value="">
                        {costCenters.length ? "Sin centro de costo" : "No hay centros de costo activos"}
                      </option>
                      {costCenters.map((costCenter) => (
                        <option key={costCenter.id} value={costCenter.id}>
                          {costCenter.name}
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
                    <span>Medio de pago</span>
                    <select
                      required
                      value={paymentMethod}
                      onChange={(event) => setPaymentMethod(event.target.value as (typeof PAYMENT_METHODS)[number])}
                    >
                      {PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {paymentMethodLabel(method)}
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
                    <span>Valor base COP</span>
                    <input
                      required
                      type="number"
                      min="1"
                      step="1"
                      value={baseAmount}
                      aria-invalid={Boolean(
                        feedback &&
                          (!Number.isFinite(Number(baseAmount)) || Number(baseAmount) <= 0),
                      )}
                      aria-describedby="petty-cash-error"
                      onChange={(event) => setBaseAmount(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>IVA COP <small>opcional</small></span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={ivaAmount}
                      onChange={(event) => setIvaAmount(event.target.value)}
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
                    disabled={busy || Boolean(createdId) || !workId || !tagId || !cashBoxId}
                    type="submit"
                  >
                    {busy ? "Registrando…" : "Registrar gasto"}
                  </button>
                </form>
              )}
            </div>
          </>
        )}

        {tab === "ingresos" && (
          <>
            {incomeRows.length > 0 && (
              <div className="filter-bar">
                <label className="field">
                  <span>Filtrar por obra</span>
                  <select value={incomeWorkFilter} onChange={(event) => setIncomeWorkFilter(event.target.value)}>
                    <option value="">Todas</option>
                    {data.catalogs.works.map((work) => (
                      <option key={work.id} value={work.id}>
                        {work.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Caja</span>
                  <select value={incomeCashBoxFilter} onChange={(event) => setIncomeCashBoxFilter(event.target.value)}>
                    <option value="">Todas</option>
                    {cashBoxes.map((cashBox) => (
                      <option key={cashBox.id} value={cashBox.id}>
                        {cashBox.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Centro de costo</span>
                  <select value={incomeCostCenterFilter} onChange={(event) => setIncomeCostCenterFilter(event.target.value)}>
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
                  <input type="month" value={incomePeriodFilter} onChange={(event) => setIncomePeriodFilter(event.target.value)} />
                </label>
              </div>
            )}
            <div className="connected-detail-grid">
              <section className="panel">
                <div className="panel-head">
                  <div>
                    <h2>{money.format(incomeTotal)}</h2>
                    <p className="panel-sub">Total de ingresos visibles para tu rol.</p>
                  </div>
                  <Tone tone="muted">{filteredIncomeRows.length} ingresos</Tone>
                </div>
                {!canRegisterIncome ? (
                  <p className="catalog-readonly-note" role="note">
                    Modo lectura: registrar ingresos es de Revisor, Contabilidad o Administrador Sixteam.
                  </p>
                ) : null}
                {incomeRows.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
                    <h3>Sin ingresos visibles</h3>
                    <p>Los registros aparecerán aquí después de una captura autorizada.</p>
                  </div>
                ) : filteredIncomeRows.length === 0 ? (
                  <div className="empty-state">
                    <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
                    <h3>Sin resultados para estos filtros</h3>
                    <p>Ajusta o limpia los filtros para ver más ingresos.</p>
                    <button className="button button-secondary" type="button" onClick={clearIncomeFilters}>
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
                          <th>Caja</th>
                          <th>Centro de costo</th>
                          <th>Obra</th>
                          <th>Tercero</th>
                          <th>Medio de pago</th>
                          <th>Valor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredIncomeRows.map((row) => (
                          <tr key={row.id}>
                            <td>{row.date}</td>
                            <td>{row.concept}</td>
                            <td>{cashBoxes.find((cashBox) => cashBox.id === row.cashBoxId)?.name ?? "—"}</td>
                            <td>{costCenters.find((costCenter) => costCenter.id === row.costCenterId)?.name ?? "—"}</td>
                            <td>{row.workId ? (data.catalogs.works.find((work) => work.id === row.workId)?.name ?? "—") : "—"}</td>
                            <td>{row.thirdParty || "—"}</td>
                            <td>{paymentMethodLabel(row.paymentMethod)}</td>
                            <td>{money.format(row.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              {canRegisterIncome && (
                <form className="panel connected-summary" onSubmit={submitIncome} noValidate>
                  <h3>Registrar ingreso</h3>
                  <label className="field">
                    <span>Caja</span>
                    <select
                      required
                      value={incomeCashBoxId}
                      aria-invalid={Boolean(incomeFeedback && !incomeCashBoxId)}
                      onChange={(event) => setIncomeCashBoxId(event.target.value)}
                    >
                      {cashBoxes.length === 0 && <option value="">Sin cajas activas</option>}
                      {cashBoxes.map((cashBox) => (
                        <option key={cashBox.id} value={cashBox.id}>
                          {cashBox.name} ({cashBoxTypeLabel(cashBox.type)})
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Centro de costo</span>
                    <select
                      required
                      value={incomeCostCenterId}
                      aria-invalid={Boolean(incomeFeedback && !incomeCostCenterId)}
                      onChange={(event) => setIncomeCostCenterId(event.target.value)}
                    >
                      {costCenters.length === 0 && <option value="">Sin centros activos</option>}
                      {costCenters.map((costCenter) => (
                        <option key={costCenter.id} value={costCenter.id}>
                          {costCenter.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Obra <small>opcional</small></span>
                    <select value={incomeWorkId} onChange={(event) => setIncomeWorkId(event.target.value)}>
                      <option value="">Sin obra</option>
                      {data.catalogs.works.map((work) => (
                        <option key={work.id} value={work.id}>
                          {work.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Medio de pago</span>
                    <select
                      required
                      value={incomePaymentMethod}
                      onChange={(event) => setIncomePaymentMethod(event.target.value as (typeof PAYMENT_METHODS)[number])}
                    >
                      {PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {paymentMethodLabel(method)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Fecha</span>
                    <input
                      required
                      type="date"
                      value={incomeDate}
                      aria-invalid={Boolean(incomeFeedback && !incomeDate)}
                      onChange={(event) => setIncomeDate(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Concepto</span>
                    <textarea
                      required
                      maxLength={500}
                      value={incomeConcept}
                      aria-invalid={Boolean(incomeFeedback && !incomeConcept.trim())}
                      onChange={(event) => setIncomeConcept(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Valor COP</span>
                    <input
                      required
                      type="number"
                      min="1"
                      step="1"
                      value={incomeAmount}
                      aria-invalid={Boolean(
                        incomeFeedback && (!Number.isFinite(Number(incomeAmount)) || Number(incomeAmount) <= 0),
                      )}
                      onChange={(event) => setIncomeAmount(event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Tercero <small>opcional</small></span>
                    <input
                      type="text"
                      maxLength={240}
                      value={incomeThirdParty}
                      onChange={(event) => setIncomeThirdParty(event.target.value)}
                    />
                  </label>
                  {incomeFeedback && (
                    <p className="field-error" role="alert">
                      {incomeFeedback}
                    </p>
                  )}
                  {incomeSuccess && (
                    <p className="field-success" role="status">
                      {incomeSuccess}
                    </p>
                  )}
                  <button
                    className="button button-dark"
                    disabled={incomeBusy || !incomeCashBoxId || !incomeCostCenterId}
                    type="submit"
                  >
                    {incomeBusy ? "Registrando…" : "Registrar ingreso"}
                  </button>
                </form>
              )}
            </div>
          </>
        )}

        {tab === "cierre" && (
          <div className="connected-detail-grid">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>Cierre mensual por caja</h2>
                  <p className="panel-sub">
                    Un mes cerrado deja de admitir altas o ediciones de sus movimientos.
                  </p>
                </div>
              </div>
              <div className="field-grid">
                <label className="field">
                  <span>Caja</span>
                  <select value={closeCashBoxId} onChange={(event) => selectCloseCashBox(event.target.value)}>
                    {cashBoxes.length === 0 && <option value="">Sin cajas activas</option>}
                    {cashBoxes.map((cashBox) => (
                      <option key={cashBox.id} value={cashBox.id}>
                        {cashBox.name} ({cashBoxTypeLabel(cashBox.type)})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Mes</span>
                  <input type="month" value={closePeriod} onChange={(event) => selectClosePeriod(event.target.value)} />
                </label>
              </div>
              {!closeSummary && !closeFeedback ? (
                <p className="muted-copy" role="status">
                  Consultando el cierre de esta caja…
                </p>
              ) : closeSummary ? (
                <>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Saldo inicial</th>
                          <th>Ingresos</th>
                          <th>Gastos</th>
                          <th>Saldo final</th>
                          <th>Estado</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>{money.format(closeSummary.openingBalance)}</td>
                          <td>{money.format(closeSummary.totalIncome)}</td>
                          <td>{money.format(closeSummary.totalExpense)}</td>
                          <td>
                            <b>{money.format(closeSummary.closingBalance)}</b>
                          </td>
                          <td>
                            <span className={`badge ${closeSummary.status === "cerrado" ? "badge-success" : "badge-muted"}`}>
                              {closeSummary.status === "cerrado" ? "Cerrado" : "Abierto"}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  {closeFeedback && (
                    <p className="field-error" role="alert">
                      {closeFeedback}
                    </p>
                  )}
                  {closeSuccess && (
                    <p className="field-success" role="status">
                      {closeSuccess}
                    </p>
                  )}
                  <div className="form-footer">
                    {closeSummary.status === "abierto" && canCloseCash && (
                      <button
                        className="button button-dark"
                        type="button"
                        disabled={closeBusy || !closeCashBoxId}
                        onClick={closeCashPeriod}
                      >
                        {closeBusy ? "Cerrando…" : "Cerrar mes"}
                      </button>
                    )}
                    {closeSummary.status === "cerrado" && canReopenCash && (
                      <button
                        className="button button-secondary"
                        type="button"
                        disabled={closeBusy}
                        onClick={reopenCashPeriod}
                      >
                        {closeBusy ? "Reabriendo…" : "Reabrir"}
                      </button>
                    )}
                    {closeSummary.status === "abierto" && !canCloseCash && (
                      <p className="catalog-readonly-note" role="note">
                        Modo lectura: cerrar el mes es de Contabilidad o Administrador Sixteam.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                closeFeedback && (
                  <p className="field-error" role="alert">
                    {closeFeedback}
                  </p>
                )
              )}
            </section>
          </div>
        )}
      </section>
    </>
  );
}
