"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedExpenses, partido de
// components/screens/connected.tsx. Misma lógica, mismos nombres.
import { useState, type FormEvent } from "react";
import { ArrowRight, Inbox, Plus, SearchX, Trash2, X } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { SectionTitle, Tone } from "../screen-primitives";
import { AttachmentPicker } from "../attachment-upload";
import {
  groupExpensesByWorkAndTag,
  localTodayISO,
  money,
  originLabel,
  uploadOperationalAttachment,
  type AttachmentProgress,
  type ExpenseBundle,
  type ExpenseRow,
  type PettyRow,
} from "./shared";
import { mutate } from "./data";

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
  // Reunión 2026-09: "la fecha del gasto es la del pago" — un gasto sin `date` es un compromiso
  // (orden generada, aún sin pagar), no un gasto de ningún mes todavía. Se separa ANTES de filtrar
  // por periodo: el filtro de periodo solo tiene sentido sobre lo ya pagado (mismo criterio que
  // groupExpenseByPeriod en el dominio), y lo comprometido se muestra aparte, siempre visible.
  const paidRows = rows.filter((row) => row.date !== undefined);
  const unpaidRows = rows.filter((row) => row.date === undefined);
  const filteredRows = paidRows.filter(
    (row) =>
      (!expenseWorkFilter || row.workId === expenseWorkFilter) &&
      (!periodFilter || row.period === periodFilter),
  );
  const filteredUnpaidRows = unpaidRows.filter(
    (row) => !expenseWorkFilter || row.workId === expenseWorkFilter,
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
        title="Gastos por obra"
        description="Lectura autorizada del libro común de gastos, incluidas las entradas de caja menor."
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
                    <th>Fecha orden</th>
                    <th>Fecha pago</th>
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
                      <td>{row.orderDate}</td>
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
        {canCreate && (
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
