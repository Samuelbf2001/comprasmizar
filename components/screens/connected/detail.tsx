"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedRequisitionDetail,
// partido de components/screens/connected.tsx. Misma lógica, mismos nombres.
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Check, Pencil, X } from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import { SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import { AttachmentPicker } from "../attachment-upload";
import {
  emptyCatalogs,
  estadoLabel,
  estimateLineTotal,
  eventLabel,
  formatIsoDate,
  money,
  resolveUserName,
  summarizeLines,
  uploadOperationalAttachment,
  type DetailBundle,
  type NamedOption,
  type RequisitionItem,
} from "./shared";
import { mutate } from "./data";

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
    // Reunión 2026-09: el aprobador lo elige el revisor (ya no lo deriva la etiqueta). Se inicializa con
    // el ya asignado si lo hay; elegir una etiqueta con aprobador por defecto lo prerellena SOLO si esto
    // sigue vacío (ver el onChange de la etiqueta, abajo) — nunca pisa una elección ya hecha.
    [approverId, setApproverId] = useState(requisition.approverId ?? ""),
    // Reunión 2026-08-31: la obra la asigna el revisor (filtrada por la empresa de la
    // requisición) y la forma de pago se captura aquí también.
    [workId, setWorkId] = useState(requisition.workId ?? ""),
    [paymentTerms, setPaymentTerms] = useState(requisition.paymentTerms ?? "ANTICIPADO"),
    [editingHeader, setEditingHeader] = useState(false),
    [headerForm, setHeaderForm] = useState({ requiredDate: requisition.requiredDate ?? "", observations: requisition.observations ?? "" }),
    [headerBusy, setHeaderBusy] = useState(false),
    [headerFeedback, setHeaderFeedback] = useState(""),
    [lines, setLines] = useState<RequisitionItem[]>(requisition?.items ?? []),
    [supplierOptions, setSupplierOptions] = useState<NamedOption[]>(
      catalogs.suppliers,
    ),
    [comment, setComment] = useState(""),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [supplierStatus, setSupplierStatus] = useState(""),
    [quickSupplierItemId, setQuickSupplierItemId] = useState<string | null>(
      null,
    ),
    [quickSupplierName, setQuickSupplierName] = useState(""),
    [quickSupplierNit, setQuickSupplierNit] = useState(""),
    [quickSupplierError, setQuickSupplierError] = useState(""),
    [quickSupplierBusy, setQuickSupplierBusy] = useState(false),
    // Cotización del comprador: adjunto propio, distinto del soporte del solicitante.
    [quoteFile, setQuoteFile] = useState<File | null>(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteFeedback, setQuoteFeedback] = useState(""),
    // Bloqueante de atasco (reunión 2026-08-31): selección local de proveedor por ítem, para el bloque
    // "Generar órdenes" — vive aparte de `lines` (el borrador editable de la revisión) porque este
    // bloque solo existe cuando la requisición ya está `aprobada` y `lines` deja de ser relevante.
    [assignSupplierChoice, setAssignSupplierChoice] = useState<Record<string, string>>({});
  const quickSupplierNameRef = useRef<HTMLInputElement | null>(null),
    quickSupplierDialogRef = useRef<HTMLFormElement | null>(null),
    quickSupplierTriggerRef = useRef<HTMLButtonElement | null>(null),
    quickSupplierWasOpen = useRef(false),
    quickSupplierSubmitting = useRef(false);
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
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
  // Reunión 2026-09: el IVA del 19 % se repetía a mano en cada ítem, y ese tecleo repetido
  // era la mayor parte del coste de revisar. Las acciones masivas solo tocan las líneas
  // vigentes: aplicar un proveedor o una tasa a una línea ya declinada no significa nada.
  const applyToAllLines = (patch: Partial<RequisitionItem>) =>
    setLines((current) =>
      current.map((line) => (line.status === "declinado" ? line : { ...line, ...patch })),
    );
  // Cotización del comprador: sube directo (la requisición ya existe) y refresca para que
  // aparezca en "Cotizaciones del comprador", separada de los adjuntos del solicitante.
  const uploadQuote = async () => {
    if (!quoteFile) return;
    setQuoteBusy(true);
    setQuoteFeedback("");
    try {
      await uploadOperationalAttachment({
        entity: "requisicion",
        entityId: requisition.id,
        type: "cotizacion",
        file: quoteFile,
      });
      setQuoteFile(null);
      refresh();
    } catch (error) {
      setQuoteFeedback(error instanceof Error ? error.message : "No fue posible cargar la cotización.");
    } finally {
      setQuoteBusy(false);
    }
  };
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
  // RF: cabecera editable. Solo el revisor/admin y solo mientras la requisición aún admite cambios.
  const headerEditable = isReviewer && ["enviada", "en_revision", "devuelta"].includes(requisition.status);
  const saveHeader = async () => {
    setHeaderBusy(true);
    setHeaderFeedback("");
    try {
      await mutate(`/api/requisitions/${requisition.id}`, "PATCH", {
        requiredDate: headerForm.requiredDate || undefined,
        observations: headerForm.observations.trim() || null,
      });
      setEditingHeader(false);
      refresh();
    } catch (error) {
      setHeaderFeedback(error instanceof Error ? error.message : "No fue posible guardar la cabecera.");
    } finally {
      setHeaderBusy(false);
    }
  };
  const supplierGroups = [
    ...new Set(
      lines
        .map((item) => item.finalSupplierId)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  // Reunión 2026-08-31: obras de la empresa de la requisición (la obra la asigna el revisor).
  const workOptions = catalogs.works.filter((work) => work.societyId === requisition.societyId);
  // Insumos del bloque "Generar órdenes": ítems aprobados (todo lo que no esté declinado) de la
  // requisición ya guardada en el servidor (no de `lines`, que es el borrador editable local),
  // agrupados por proveedor final; los que faltan quedan aparte para anticipar SUPPLIER_REQUIRED.
  const approvedForOrders = requisition.items.filter((item) => item.status !== "declinado");
  const missingSupplierItems = approvedForOrders.filter((item) => !item.finalSupplierId);
  const orderSupplierGroupsMap = new Map<string, RequisitionItem[]>();
  for (const item of approvedForOrders) {
    if (!item.finalSupplierId) continue;
    orderSupplierGroupsMap.set(item.finalSupplierId, [...(orderSupplierGroupsMap.get(item.finalSupplierId) ?? []), item]);
  }
  const orderSupplierGroups = [...orderSupplierGroupsMap.entries()];
  // GRAVE 4: "—" en vez del UUID crudo cuando el proveedor no aparece en ninguna de las dos fuentes.
  const supplierName = (id: string) => supplierOptions.find((s) => s.id === id)?.name ?? catalogs.suppliers.find((s) => s.id === id)?.name ?? "—";
  // Adjuntos del solicitante (soportes/fotos) vs. cotizaciones del comprador: dos cosas
  // distintas para quien aprueba, antes mezcladas en una sola lista.
  const requesterAttachments = attachments.filter((attachment) => attachment.type !== "cotizacion");
  const quoteAttachments = attachments.filter((attachment) => attachment.type === "cotizacion");
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
                {requisition.workId
                  ? (catalogs.works.find((work) => work.id === requisition.workId)?.name ?? requisition.workId)
                  : "por asignar en la revisión"}
              </p>
            </div>
            <Tone tone="muted">
              <span data-testid="requisition-status">
                {estadoLabel(requisition.status)}
              </span>
            </Tone>
          </div>
          {isReviewer &&
          ["en_revision", "devuelta"].includes(requisition.status) ? (
            <div className="connected-review">
              <label className="field">
                {/* Reunión 2026-09: la etiqueta ya solo clasifica el gasto (alimenta el reporte por
                    etiqueta) — quién aprueba se elige aparte, abajo. */}
                <span>Etiqueta</span>
                <select
                  required
                  value={tagId}
                  onChange={(event) => {
                    const nextTagId = event.target.value;
                    setTagId(nextTagId);
                    // Sugerencia por defecto: solo prerellena si el revisor aún no eligió aprobador —
                    // nunca pisa una elección ya hecha, y el select de abajo sigue siendo editable.
                    if (!approverId) {
                      const suggested = catalogs.tags.find((tag) => tag.id === nextTagId)?.approverId;
                      if (suggested) setApproverId(suggested);
                    }
                  }}
                >
                  <option value="">Selecciona una etiqueta</option>
                  {catalogs.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Aprobador</span>
                <select
                  required
                  value={approverId}
                  aria-invalid={Boolean(feedback && !approverId)}
                  onChange={(event) => setApproverId(event.target.value)}
                >
                  <option value="">Selecciona un aprobador</option>
                  {(catalogs.approvers ?? []).map((user) => (
                    <option key={user.id} value={user.id}>
                      {user.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                {/* Reunión 2026-08-31: la obra (centro de costo) la asigna el revisor, filtrada
                    por la empresa de la requisición; obligatoria para enviar a aprobación.
                    GRAVE 3: si la empresa no tiene obras, `workOptions` queda vacío y antes el
                    <select> se veía con una sola opción fantasma ("Selecciona una obra") sin
                    explicar por qué el flujo estaba atascado — un callejón sin salida absoluto. */}
                <span>Obra</span>
                <select
                  required
                  value={workId}
                  disabled={workOptions.length === 0}
                  aria-invalid={Boolean(feedback && !workId)}
                  aria-describedby={workOptions.length === 0 ? "work-empty-reason" : undefined}
                  onChange={(event) => setWorkId(event.target.value)}
                >
                  <option value="">
                    {workOptions.length === 0 ? "Sin obras registradas" : "Selecciona una obra"}
                  </option>
                  {workOptions.map((work) => (
                    <option key={work.id} value={work.id}>
                      {work.name}
                    </option>
                  ))}
                </select>
                {workOptions.length === 0 && (
                  <small className="field-error" role="alert" id="work-empty-reason">
                    Esta empresa no tiene obras registradas: pídele a un administrador que cree
                    al menos una antes de poder enviar la requisición a aprobación.
                  </small>
                )}
              </label>
              <label className="field">
                <span>Forma de pago</span>
                <input
                  maxLength={240}
                  value={paymentTerms}
                  onChange={(event) => setPaymentTerms(event.target.value)}
                />
              </label>
              {/* Reunión 2026-09 (QA UX): la revisión era un <fieldset> por ítem en rejilla de
                  5 columnas — 7 controles + 1 botón cada uno, que envolvían a dos filas y
                  dejaban celdas huecas. Con 5 ítems eran 43 elementos y ~1.750px de scroll, y
                  el tabulado pasaba por un botón entre el precio de un ítem y el del siguiente.
                  Daniel comparaba eso contra escribir un WhatsApp, así que la densidad no era
                  cosmética: decidía la adopción. Ahora es una fila por ítem, con las acciones
                  masivas arriba (el 19 % se teclaba cinco veces) y el proveedor nuevo se crea
                  una sola vez en la barra en vez de un botón por línea. */}
              <div className="review-bulk" role="group" aria-label="Aplicar a todos los ítems vigentes">
                <span className="review-bulk-title">Aplicar a todos:</span>
                <label className="review-bulk-field">
                  <span>IVA</span>
                  <select
                    aria-label="Aplicar un IVA a todos los ítems vigentes"
                    value=""
                    onChange={(event) => {
                      if (event.target.value === "") return;
                      applyToAllLines({ ivaRate: Number(event.target.value) });
                      event.target.value = "";
                    }}
                  >
                    <option value="">Elegir…</option>
                    <option value="0">0 % a todos</option>
                    <option value="0.05">5 % a todos</option>
                    <option value="0.19">19 % a todos</option>
                  </select>
                </label>
                <label className="review-bulk-field">
                  <span>Proveedor</span>
                  <select
                    aria-label="Aplicar un proveedor a todos los ítems vigentes"
                    value=""
                    onChange={(event) => {
                      if (event.target.value === "") return;
                      applyToAllLines({ finalSupplierId: event.target.value });
                      event.target.value = "";
                    }}
                  >
                    <option value="">Elegir…</option>
                    {supplierOptions.map((supplier) => (
                      <option key={supplier.id} value={supplier.id}>
                        {supplier.name} a todos
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="button button-secondary quick-supplier-trigger"
                  type="button"
                  disabled={busy || lines.length === 0}
                  onClick={(event) => openQuickSupplier(lines[0]?.id ?? "", event.currentTarget)}
                >
                  + Crear proveedor
                </button>
              </div>
              <div className="review-table-scroll">
                <table className="review-table">
                  <thead>
                    <tr>
                      <th scope="col">Ítem</th>
                      <th scope="col" className="align-right">Cant.</th>
                      <th scope="col">Und.</th>
                      <th scope="col" className="align-right">Precio unit.</th>
                      <th scope="col">IVA %</th>
                      <th scope="col" className="align-right">Desc %</th>
                      <th scope="col">Proveedor</th>
                      <th scope="col" className="align-right">Total</th>
                      <th scope="col"><span className="sr-only">Acciones</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const nombre =
                        line.description ||
                        catalogs.items.find((item) => item.id === line.itemId)?.name ||
                        "Ítem";
                      const declinado = line.status === "declinado";
                      return (
                        <Fragment key={line.id}>
                          <tr className={declinado ? "review-row-declined" : undefined}>
                            <th scope="row" className="review-row-name">
                              {nombre}
                              {declinado && <Tone tone="danger" dot>Declinado</Tone>}
                            </th>
                            <td>
                              <input
                                className="cell-input align-right"
                                type="number"
                                step="0.001"
                                min="0.001"
                                disabled={declinado}
                                aria-label={`Cantidad de ${nombre}`}
                                value={line.quantity}
                                onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                              />
                            </td>
                            <td>
                              <input
                                className="cell-input cell-narrow"
                                disabled={declinado}
                                aria-label={`Unidad de ${nombre}`}
                                value={line.unit}
                                onChange={(event) => updateLine(line.id, { unit: event.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                className="cell-input align-right"
                                type="number"
                                min="0"
                                step="1"
                                disabled={declinado}
                                aria-label={`Precio unitario de ${nombre}`}
                                value={line.unitBase ?? 0}
                                onChange={(event) => updateLine(line.id, { unitBase: Number(event.target.value) })}
                              />
                            </td>
                            <td>
                              <select
                                className="cell-input cell-narrow"
                                disabled={declinado}
                                aria-label={`IVA de ${nombre}`}
                                value={String(line.ivaRate ?? 0)}
                                onChange={(event) => updateLine(line.id, { ivaRate: Number(event.target.value) })}
                              >
                                <option value="0">0</option>
                                <option value="0.05">5</option>
                                <option value="0.19">19</option>
                              </select>
                            </td>
                            <td>
                              <input
                                className="cell-input cell-narrow align-right"
                                type="number"
                                min="0"
                                max="100"
                                step="1"
                                disabled={declinado}
                                aria-label={`Descuento de ${nombre}`}
                                value={line.discountRate !== undefined ? Math.round(line.discountRate * 100) : 0}
                                onChange={(event) => updateLine(line.id, { discountRate: Number(event.target.value) / 100 })}
                              />
                            </td>
                            <td>
                              <select
                                className="cell-input"
                                id={`supplier-${line.id}`}
                                disabled={declinado}
                                aria-label={`Proveedor de ${nombre}`}
                                value={line.finalSupplierId ?? ""}
                                onChange={(event) => updateLine(line.id, { finalSupplierId: event.target.value || undefined })}
                              >
                                <option value="">Por definir</option>
                                {supplierOptions.map((supplier) => (
                                  <option key={supplier.id} value={supplier.id}>
                                    {supplier.name}
                                  </option>
                                ))}
                              </select>
                            </td>
                            <td className="align-right money">
                              {declinado ? "—" : money.format(estimateLineTotal(line))}
                            </td>
                            <td>
                              <button
                                className={`button button-secondary cell-action ${declinado ? "decision-approve" : "decision-decline"}`}
                                type="button"
                                onClick={() =>
                                  updateLine(line.id, {
                                    status: declinado ? undefined : "declinado",
                                    declineReason: declinado ? undefined : line.declineReason,
                                  })
                                }
                              >
                                {declinado
                                  ? <><Check aria-hidden="true" size={15} /> Reactivar</>
                                  : <><X aria-hidden="true" size={15} /> Declinar</>}
                              </button>
                            </td>
                          </tr>
                          {declinado && (
                            <tr className="review-row-declined">
                              <td colSpan={9}>
                                <label className="field field-wide">
                                  <span>Motivo por el que se declina {nombre}</span>
                                  <textarea
                                    required
                                    rows={2}
                                    value={line.declineReason ?? ""}
                                    onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                                  />
                                </label>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* MENOR (QA 2026-08-31): "Nelson y Juliana deciden sin ver la cifra total" —
                  no existía en ninguna parte. Barra de Subtotal · IVA · Total al pie del
                  bloque de ítems, visible en revisión y en aprobación. */}
              <div className="connected-line-summary" data-testid="line-summary">
                {(() => {
                  const totals = summarizeLines(lines);
                  return (
                    <>
                      <span>Subtotal <b className="money">{money.format(totals.base)}</b></span>
                      <span>IVA <b className="money">{money.format(totals.iva)}</b></span>
                      <span className="connected-line-summary-total">Total <b className="money">{money.format(totals.total)}</b></span>
                    </>
                  );
                })()}
              </div>
              {supplierStatus && (
                <p className="field-success" role="status">
                  {supplierStatus}
                </p>
              )}
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={
                    busy ||
                    !tagId ||
                    lines.some((line) => line.status === "declinado" && !line.declineReason?.trim())
                  }
                  type="button"
                  onClick={() =>
                    void run({
                      action: "review",
                      tagId,
                      ...(approverId ? { approverId } : {}),
                      ...(workId ? { workId } : {}),
                      ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
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
                          status,
                          declineReason,
                          ivaRate,
                          discountRate,
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
                          ...(status ? { status } : {}),
                          ...(status === "declinado" && declineReason ? { declineReason } : {}),
                          ...(ivaRate !== undefined ? { ivaRate } : {}),
                          ...(discountRate !== undefined ? { discountRate } : {}),
                        }),
                      ),
                    })
                  }
                >
                  Guardar revisión
                </button>
                <button
                  className="button button-dark"
                  // El proveedor ya NO bloquea el envío a aprobación (aprobar y designar proveedor
                  // son roles distintos); sí lo bloquean etiqueta, obra y aprobador, que el backend exige.
                  disabled={busy || requisition.status === "devuelta" || !tagId || !workId || !approverId}
                  type="button"
                  onClick={() => void run({ action: "send_for_approval" })}
                >
                  Enviar a aprobación
                </button>
                {/* GRAVE 3: regla única del repo — todo `disabled` lleva texto adyacente con la
                    razón y el siguiente paso, no solo un `title`. */}
                {!busy && requisition.status !== "devuelta" && (!tagId || !workId || !approverId) && (
                  <p className="field-error" role="alert">
                    {!workId && workOptions.length === 0
                      ? "Falta asignar la obra. Esta empresa no tiene obras registradas: pídele a un administrador que la cree."
                      : !workId
                        ? "Falta asignar la obra."
                        : !tagId
                          ? "Falta elegir la etiqueta."
                          : "Falta elegir el aprobador."}
                  </p>
                )}
              </div>
            </div>
          ) : isApprover && requisition.status === "en_aprobacion" ? (
            <div className="connected-review" data-testid="approval-decisions">
              {lines.map((line) => (
                <fieldset className={`review-line${line.status === "declinado" ? " review-line-declined" : ""}`} key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)?.name ||
                      "Ítem"}
                  </legend>
                  <label className="field">
                    <span>Cantidad aprobada</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantity}
                      onChange={(event) => updateLine(line.id, { quantity: Number(event.target.value) })}
                    />
                  </label>
                  {/* Dos botones en vez de un desplegable: con el <select> decidir un ítem eran tres
                      gestos (abrir, elegir, cerrar) y el estado actual no se veía sin abrirlo. */}
                  <div className="field">
                    <span className="field-label" id={`decision-${line.id}`}>Decisión</span>
                    {/* Solo símbolos: rotularlos "Aprobar"/"Declinar" pondría un segundo botón
                        "Aprobar" al lado del que aprueba la requisición entera, y decidir un ítem
                        no es lo mismo que aprobarla. El nombre accesible sí lo dice completo. */}
                    <div className="decision-toggle" role="group" aria-labelledby={`decision-${line.id}`}>
                      <button
                        aria-label="Aprobar este ítem"
                        aria-pressed={line.status !== "declinado"}
                        className="decision-approve"
                        title="Aprobar este ítem"
                        type="button"
                        onClick={() => updateLine(line.id, { status: "aprobado", declineReason: undefined })}
                      >
                        <Check aria-hidden="true" size={18} />
                      </button>
                      <button
                        aria-label="Declinar este ítem"
                        aria-pressed={line.status === "declinado"}
                        className="decision-decline"
                        title="Declinar este ítem"
                        type="button"
                        onClick={() => updateLine(line.id, { status: "declinado", declineReason: line.declineReason })}
                      >
                        <X aria-hidden="true" size={18} />
                      </button>
                    </div>
                  </div>
                  {line.status === "declinado" && (
                    <label className="field field-wide">
                      <span>Motivo de declinación</span>
                      <textarea
                        required
                        value={line.declineReason ?? ""}
                        onChange={(event) => updateLine(line.id, { declineReason: event.target.value })}
                      />
                    </label>
                  )}
                  <strong>{money.format(estimateLineTotal(line))}</strong>
                </fieldset>
              ))}
              {/* MENOR: misma barra de totales que en revisión — el aprobador tampoco veía
                  la cifra total antes de decidir. */}
              <div className="connected-line-summary" data-testid="line-summary">
                {(() => {
                  const totals = summarizeLines(lines);
                  return (
                    <>
                      <span>Subtotal <b className="money">{money.format(totals.base)}</b></span>
                      <span>IVA <b className="money">{money.format(totals.iva)}</b></span>
                      <span className="connected-line-summary-total">Total <b className="money">{money.format(totals.total)}</b></span>
                    </>
                  );
                })()}
              </div>
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={busy || lines.some((line) => line.status === "declinado" && !line.declineReason?.trim())}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "decide_items",
                      decisions: lines.map((line) => {
                        const status = line.status === "declinado" ? "declinado" : "aprobado";
                        return {
                          itemId: line.id,
                          status,
                          ...(status === "declinado" ? { declineReason: (line.declineReason ?? "").trim() } : {}),
                          quantity: Number(line.quantity),
                        };
                      }),
                    })
                  }
                >
                  Guardar decisiones
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
                    <th>IVA %</th>
                    <th>Estado</th>
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
                      <td>{item.ivaRate !== undefined ? `${Math.round(item.ivaRate * 100)} %` : money.format(item.unitIva ?? 0)}</td>
                      <td>
                        {item.status === "declinado" ? (
                          <Tone tone="danger" dot>
                            Declinado{item.declineReason ? ` · ${item.declineReason}` : ""}
                          </Tone>
                        ) : (
                          <Tone tone="muted" dot>Vigente</Tone>
                        )}
                      </td>
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
                <dd>{estadoLabel(requisition.status)}</dd>
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
                    : // HUECO 2: el nombre ya viaja en catalogs.users (GET /api/catalogs, id+nombre
                      // solamente); "Solicitante interno" se conserva como fallback honesto — nunca se
                      // muestra el UUID crudo si el id no aparece en esa lista.
                      resolveUserName(catalogs, requisition.requesterId, "Solicitante interno")}
                </dd>
              </div>
              <div>
                {/* Reunión 2026-09: el aprobador ya no se deriva de la etiqueta — lo elige el revisor en
                    la revisión (ver el <select> "Aprobador", arriba). Se muestra aquí para toda la
                    ficha, incluida la vista de solo lectura de roles que no revisan. */}
                <dt>Aprobador</dt>
                <dd data-testid="requisition-approver">
                  {resolveUserName(catalogs, requisition.approverId, "Sin aprobador asignado")}
                </dd>
              </div>
              <div>
                <dt>Fecha requerida</dt>
                <dd>{requisition.requiredDate ? formatIsoDate(requisition.requiredDate) : "—"}</dd>
              </div>
              <div>
                <dt>Observaciones</dt>
                <dd>{requisition.observations || "—"}</dd>
              </div>
            </dl>
            {/* BLOQUEANTE (QA reasignación, reunión 2026-09): si el aprobador asignado deja de ser
                elegible (baja, cambio de rol) mientras la requisición está en_aprobacion, antes no había
                salida por la aplicación — approve()/returnForCorrection() exigen ser el aprobador exacto
                y ese usuario ya no puede entrar. Reutiliza `approverId`/`setApproverId` (mismo estado que
                el <select> de la revisión, arriba): no colisionan porque nunca se muestran a la vez. */}
            {isReviewer && requisition.status === "en_aprobacion" && (
              <div className="connected-review" data-testid="reassign-approver">
                <label className="field">
                  <span>Reasignar aprobador</span>
                  <select value={approverId} onChange={(event) => setApproverId(event.target.value)}>
                    <option value="">Selecciona un aprobador</option>
                    {(catalogs.approvers ?? []).map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted-copy">Si el aprobador asignado no puede atenderla, reasígnala aquí.</p>
                <button
                  className="button button-secondary"
                  disabled={busy || !approverId || approverId === requisition.approverId}
                  type="button"
                  onClick={() => void run({ action: "reassign_approver", approverId })}
                >
                  Reasignar aprobador
                </button>
              </div>
            )}
            {headerEditable && !editingHeader && (
              <button className="button button-secondary" type="button" onClick={() => { setHeaderForm({ requiredDate: requisition.requiredDate ?? "", observations: requisition.observations ?? "" }); setEditingHeader(true); }}>
                <Pencil aria-hidden="true" size={14} /> Editar cabecera
              </button>
            )}
            {headerEditable && editingHeader && (
              <div className="connected-header-edit">
                <label className="field">
                  <span>Fecha requerida</span>
                  <input type="date" value={headerForm.requiredDate} onChange={(event) => setHeaderForm({ ...headerForm, requiredDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>Observaciones</span>
                  <textarea maxLength={1024} value={headerForm.observations} onChange={(event) => setHeaderForm({ ...headerForm, observations: event.target.value })} />
                </label>
                {headerFeedback && <p className="field-error" role="alert">{headerFeedback}</p>}
                <div className="form-footer">
                  <button className="button button-secondary" type="button" onClick={() => setEditingHeader(false)} disabled={headerBusy}>Cancelar</button>
                  <button className="button button-dark" type="button" onClick={() => void saveHeader()} disabled={headerBusy}>{headerBusy ? "Guardando…" : "Guardar cambios"}</button>
                </div>
              </div>
            )}
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
                  {/* GRAVE 4: este "Declinar" mata la requisición ENTERA (distinto del "Declinar"
                      por ítem, arriba, que solo afecta esa línea) — mismo verbo, alcances
                      radicalmente distintos. Se renombra para que no se confundan. */}
                  <button
                    className="button button-danger"
                    disabled={busy || !comment.trim()}
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Declinar toda la requisición",
                        description: `La requisición ${requisition.consecutive} quedará declinada de forma definitiva y no se podrá reactivar.`,
                        confirmLabel: "Declinar toda la requisición",
                        danger: true,
                      });
                      if (!ok) return;
                      void run({ action: "decline", reason: comment });
                    }}
                  >
                    <X aria-hidden="true" size={16} /> Declinar toda la requisición
                  </button>
                </>
              )}
            {isApprover && requisition.status === "en_aprobacion" && (
              <>
                {/* Reunión 2026-08-31: aprobar y generar la orden son pasos distintos ahora — este
                    botón solo transiciona el estado. La división por proveedor ya es siempre el
                    comportamiento normal (el checkbox "Completo" desaparece). */}
                <button
                  className="button button-dark"
                  disabled={busy}
                  type="button"
                  onClick={async () => {
                    const ok = await confirm({
                      title: "Aprobar la requisición",
                      description: `La requisición ${requisition.consecutive} quedará aprobada de forma definitiva y no podrá regresar a revisión. Genera las órdenes después, desde el bloque "Generar órdenes".`,
                      confirmLabel: "Aprobar",
                    });
                    if (!ok) return;
                    void run({ action: "approve" });
                  }}
                >
                  <Check aria-hidden="true" size={16} /> Aprobar
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
                  <X aria-hidden="true" size={16} /> Devolver a revisión
                </button>
              </>
            )}
            {feedback && (
              <p className="field-error" role="alert">
                {feedback}
              </p>
            )}
          </section>
          {/* Reunión 2026-08-31: "Generar órdenes" es su propio paso, con botón propio — el
              cliente dijo literalmente que no la veía. Reutiliza el resumen de asignación por
              proveedor como preview; muestra qué grupos saldrán y qué falta antes de intentarlo. */}
          {isReviewer && requisition.status === "aprobada" && orders.length === 0 ? (
            <section className="panel connected-summary" data-testid="generate-orders-panel">
              <h3>Generar órdenes</h3>
              <p className="panel-sub">Ítems aprobados agrupados por proveedor; se genera una orden por grupo.</p>
              {orderSupplierGroups.map(([supplierId, items]) => (
                <p key={supplierId} data-testid="order-supplier-group">
                  <b>{supplierName(supplierId)}</b> · {items.length} ítem{items.length === 1 ? "" : "s"} ·{" "}
                  {money.format(items.reduce((sum, item) => sum + estimateLineTotal(item), 0))}
                </p>
              ))}
              {missingSupplierItems.length > 0 && (
                <div className="missing-supplier-assign" data-testid="missing-supplier-warning">
                  <p className="field-error" role="alert">
                    {missingSupplierItems.length} ítem{missingSupplierItems.length === 1 ? "" : "s"} aprobado{missingSupplierItems.length === 1 ? "" : "s"} sin proveedor asignado: elige uno abajo para poder generar la orden.
                  </p>
                  {missingSupplierItems.map((item) => (
                    <label className="field" key={item.id}>
                      <span>{item.description || item.itemId || "Ítem sin descripción"}</span>
                      <select
                        value={assignSupplierChoice[item.id] ?? ""}
                        onChange={(event) =>
                          setAssignSupplierChoice((current) => ({ ...current, [item.id]: event.target.value }))
                        }
                      >
                        <option value="">Selecciona un proveedor</option>
                        {supplierOptions.map((supplier) => (
                          <option key={supplier.id} value={supplier.id}>
                            {supplier.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={busy || !missingSupplierItems.some((item) => assignSupplierChoice[item.id])}
                    onClick={() => {
                      const assignments = missingSupplierItems
                        .filter((item) => assignSupplierChoice[item.id])
                        .map((item) => ({ itemId: item.id, supplierId: assignSupplierChoice[item.id] }));
                      void run({ action: "assign_suppliers", assignments });
                    }}
                  >
                    Asignar proveedor{missingSupplierItems.length === 1 ? "" : "es"}
                  </button>
                </div>
              )}
              {/* GRAVE 3: todo `disabled` lleva texto adyacente con la razón y el siguiente
                  paso, no solo un `title` — antes, si el aprobador declinaba todos los ítems,
                  este botón quedaba muerto y mudo (el `title` solo cubría el caso de proveedor
                  faltante). */}
              {orderSupplierGroups.length === 0 && missingSupplierItems.length === 0 && (
                <p className="field-error" role="alert">
                  No hay ítems aprobados con proveedor asignado: el aprobador declinó todos los
                  ítems o ninguno tiene proveedor todavía. No hay nada que generar.
                </p>
              )}
              <button
                className="button button-dark"
                type="button"
                disabled={busy || missingSupplierItems.length > 0 || orderSupplierGroups.length === 0}
                aria-disabled={missingSupplierItems.length > 0 || orderSupplierGroups.length === 0}
                title={
                  missingSupplierItems.length > 0
                    ? "Asigna proveedor a cada ítem aprobado antes de generar órdenes."
                    : orderSupplierGroups.length === 0
                      ? "No hay ítems aprobados con proveedor asignado."
                      : undefined
                }
                onClick={async () => {
                  const ok = await confirm({
                    title: "Generar órdenes",
                    description: `Se generará${orderSupplierGroups.length === 1 ? "" : "n"} ${orderSupplierGroups.length} orden(es), una por proveedor. Esta acción no se puede deshacer.`,
                    confirmLabel: "Generar órdenes",
                  });
                  if (!ok) return;
                  void run({ action: "generate_orders" });
                }}
              >
                Generar órdenes
              </button>
            </section>
          ) : (
            supplierGroups.length > 0 && (
              <section className="panel connected-summary">
                <h3>Asignación por proveedor</h3>
                {supplierGroups.map((supplierId) => (
                  <p key={supplierId} data-testid="supplier-allocation">
                    {supplierName(supplierId)}
                  </p>
                ))}
              </section>
            )
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
          {/* Reunión 2026-08-31: separa visualmente los adjuntos del SOLICITANTE (soportes,
              fotos) de las COTIZACIONES del comprador — son dos cosas distintas para quien
              aprueba y antes se mezclaban en una sola lista. */}
          <section className="panel connected-summary">
            <h3>Adjuntos del solicitante</h3>
            {requesterAttachments.length ? (
              <div className="attachment-list">
                {requesterAttachments.map((attachment) => (
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
            <h3>Cotizaciones del comprador</h3>
            {quoteAttachments.length ? (
              <div className="attachment-list">
                {quoteAttachments.map((attachment) => (
                  <a
                    className="attachment-link"
                    key={attachment.id}
                    href={`/api/attachments/${attachment.entity}/${encodeURIComponent(attachment.entityId)}/${encodeURIComponent(attachment.id)}/download`}
                    download={attachment.name}
                  >
                    <b>Cotización</b> · {attachment.name}
                  </a>
                ))}
              </div>
            ) : (
              <p>Sin cotizaciones cargadas para esta requisición.</p>
            )}
            {isReviewer && ["en_revision", "devuelta"].includes(requisition.status) && (
              <div className="connected-header-edit">
                <AttachmentPicker
                  id="requisition-quote"
                  label="Adjuntar cotización"
                  help="PDF, JPG, PNG o WebP · máximo 10 MB"
                  file={quoteFile}
                  onFile={setQuoteFile}
                  onError={setQuoteFeedback}
                  disabled={quoteBusy}
                />
                {quoteFeedback && (
                  <p className="field-error" role="alert">{quoteFeedback}</p>
                )}
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={!quoteFile || quoteBusy}
                  onClick={() => void uploadQuote()}
                >
                  {quoteBusy ? "Cargando…" : "Subir cotización"}
                </button>
              </div>
            )}
          </section>
          <section className="panel connected-summary">
            <h3>Historial de trazabilidad</h3>
            {history.length ? (
              history.map((entry, index) => (
                <p key={`${entry.at}-${index}`} data-testid="audit-event">
                  <b>{eventLabel(entry.event)}</b> ·{" "}
                  {new Date(entry.at).toLocaleString("es-CO")} ·{" "}
                  {/* RF-405: AuditEvent.actorId ya viajaba en el JSON del historial; sin
                      esto la trazabilidad no decía qué usuario ejecutó cada transición.
                      HUECO 2: el nombre ya viaja en catalogs.users; "Usuario interno" se conserva
                      como fallback honesto — nunca se muestra el UUID crudo. */}
                  <span data-testid="audit-actor">
                    {entry.actorId ? resolveUserName(catalogs, entry.actorId, "Usuario interno") : "Automático"}
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
                <X aria-hidden="true" size={16} />
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
      {confirmDialog}
    </>
  );
}

