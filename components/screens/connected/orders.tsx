"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedOrders, partido de
// components/screens/connected.tsx. Misma lógica, mismos nombres.
import { useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Inbox,
  SearchX,
  Truck,
  X,
} from "lucide-react";
import type { Role } from "../../../lib/demo-data";
// BLOQUEANTE 1 (QA 2026-08-31): misma fuente de verdad que la ficha y el PDF — ver el
// comentario original en components/screens/connected.tsx (import de lib/domain/rules).
import { calculateLineTotal, sumLines } from "../../../lib/domain/rules";
import { apiRequest } from "../../../lib/http/friendly-error";
import { SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  formatIsoDate,
  money,
  type OrdersBundle,
} from "./shared";
import { mutate } from "./data";

export function ConnectedOrders({
  data,
  role,
  viewingAs = null,
  refresh,
  go,
}: {
  data: OrdersBundle;
  role: Role;
  /** Rol de la lente "Ver como" si está puesta; `null` si se mira con el rol propio. Ver ConnectedProps. */
  viewingAs?: Role | null;
  /** Recarga los datos de la ruta. Devuelve una promesa: espérala antes de soltar el estado ocupado,
   *  o la pantalla se rehabilita mostrando todavía los datos anteriores. */
  refresh: () => void | Promise<void>;
  go: (href: string) => void;
}) {
  // "Tu rol no puede…" es cierto pero engañoso bajo la lente "Ver como": quien mira es
  // Administrador Sixteam y SÍ puede — solo está viendo con los ojos de otro rol. Decírselo tal cual
  // parece un problema de su cuenta. Cuando hay lente, la frase nombra el rol prestado.
  const sinPermiso = (accion: string) =>
    viewingAs ? `Estás viendo como ${viewingAs}; ese rol no ${accion}.` : `Tu rol no ${accion}.`;
  const rows = Array.isArray(data?.rows) ? data.rows : [],
    catalogs = data?.catalogs ?? emptyCatalogs,
    [feedback, setFeedback] = useState(""),
    [success, setSuccess] = useState(""),
    [openOrderId, setOpenOrderId] = useState<string | null>(null),
    canUpdate = role === "Revisor" || role === "Administrador Sixteam",
    // Reunión 2026-08-31: eje administrativo/contable, independiente del cumplimiento de arriba.
    // "contabilizada" es de contabilidad (order:account); "pagada" es del revisor (order:pay).
    canAccount = role === "Contabilidad" || role === "Administrador Sixteam",
    canPay = role === "Revisor" || role === "Administrador Sixteam";
  // Expediente del proveedor (RUT, cámara de comercio…) para que el contador lo descargue
  // junto con la orden sin buscarlo por otro lado (GET /api/suppliers/:id ya lo expone).
  const [supplierDocuments, setSupplierDocuments] = useState<Record<string, Array<{ id: string; name: string }>>>({});
  const [dossierLoading, setDossierLoading] = useState<string | null>(null);
  // Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): antes se descargaban TODAS las
  // requisiciones (con TODOS sus ítems) solo para resolver, por fila, el consecutivo/obra/fecha
  // requerida de la orden y, al abrir la ficha, el detalle de precios de sus ítems. Un intento
  // posterior de arreglar eso quitó la columna "Valor" y cambió el filtro de fecha por la de
  // GENERACIÓN de la orden (decisiones de producto que el revisor rechazó) para poder prescindir de
  // la carga bajo demanda de la requisición de origen. La solución correcta era otra: el servidor ya
  // trae `requiredDate`/`lines` en el MISMO SELECT de la orden (ver `order(row)` en
  // postgres-repositories.ts) — no hace falta ni descargar TODAS las requisiciones ni pedir la
  // requisición de origen al abrir cada ficha; `loadLinkedRequisition` (y su estado) desaparecen.
  // GRAVE 4: "—" en vez del UUID crudo cuando el catálogo no trae el nombre (proveedor/obra
  // borrado o desincronizado); "Por definir" sigue siendo el caso honesto de "aún sin proveedor".
  const supplierName = (id?: string) => (id ? (catalogs.suppliers.find((s) => s.id === id)?.name ?? "—") : "Por definir");
  const workName = (id?: string) => (id ? (catalogs.works.find((w) => w.id === id)?.name ?? "—") : "—");
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [workFilter, setWorkFilter] = useState(""),
    [statusFilter, setStatusFilter] = useState(""),
    // GRAVE 2: filtro propio del eje contable — "todas las pendientes de contabilizar" es
    // literalmente la tarea del contador los martes y viernes, y antes solo existía el filtro
    // de cumplimiento.
    [adminStatusFilter, setAdminStatusFilter] = useState(""),
    [supplierFilter, setSupplierFilter] = useState(""),
    [dateFrom, setDateFrom] = useState(""),
    [dateTo, setDateTo] = useState("");
  const statusOptions = Array.from(
    new Set(rows.map((row) => row.status)),
  ).sort();
  const adminStatusOptions = Array.from(
    new Set(rows.map((row) => row.adminStatus ?? "pendiente")),
  ).sort();
  // Revisión (corrección tras QA): filtro por `row.requiredDate` (fecha REQUERIDA de la requisición de
  // origen, la que pidió el solicitante) — semántica original, restaurada. Ya no hace falta descargar
  // TODAS las requisiciones para conocerla: viaja en el mismo join que ya resuelve
  // `requisitionConsecutive`/`workId` en cada `OrderRow` (ver el comentario largo más arriba).
  const filteredRows = rows.filter((row) => {
    if (workFilter && row.workId !== workFilter) return false;
    if (statusFilter && row.status !== statusFilter) return false;
    if (adminStatusFilter && (row.adminStatus ?? "pendiente") !== adminStatusFilter) return false;
    if (supplierFilter && row.supplierId !== supplierFilter) return false;
    if (dateFrom && !(row.requiredDate && row.requiredDate >= dateFrom)) return false;
    if (dateTo && !(row.requiredDate && row.requiredDate <= dateTo)) return false;
    return true;
  });
  const clearFilters = () => {
    setWorkFilter("");
    setStatusFilter("");
    setAdminStatusFilter("");
    setSupplierFilter("");
    setDateFrom("");
    setDateTo("");
  };
  const setStatus = async (id: string, status: string, consecutive?: string) => {
    const ref = consecutive ?? id;
    // Cambio irreversible y sin deshacer: se confirma explícitamente antes de aplicar.
    const ok = await confirm({
      title: `Marcar la orden como "${estadoLabel(status)}"`,
      description: `La orden ${ref} quedará marcada como "${estadoLabel(status)}". Esta acción es irreversible y no se puede deshacer.`,
      confirmLabel: "Confirmar",
      danger: status === "no_cumplida",
    });
    if (!ok) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { status });
      setSuccess(`La orden ${ref} quedó como "${estadoLabel(status)}".`);
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar la orden.",
      );
    }
  };
  // Reunión 2026-08-31: mismo patrón que setStatus, pero sobre el eje administrativo/contable
  // (adminStatus) en vez del de entrega (status) — son ejes independientes.
  const setAdminStatus = async (id: string, adminStatus: "contabilizada" | "pagada", consecutive?: string) => {
    const ref = consecutive ?? id;
    const ok = await confirm({
      title: `Marcar la orden como "${estadoLabel(adminStatus)}"`,
      description: `La orden ${ref} quedará marcada como "${estadoLabel(adminStatus)}" en contabilidad. Esta acción es irreversible.`,
      confirmLabel: "Confirmar",
    });
    if (!ok) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { adminStatus });
      setSuccess(`La orden ${ref} quedó como "${estadoLabel(adminStatus)}" en contabilidad.`);
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar el eje contable.",
      );
    }
  };
  // Carga perezosa (solo al abrir la ficha) del expediente del proveedor de la orden, para que
  // el contador lo descargue sin ir a buscarlo a otra pantalla.
  const loadSupplierDossier = async (supplierId: string) => {
    if (supplierDocuments[supplierId] || dossierLoading === supplierId) return;
    setDossierLoading(supplierId);
    try {
      const result = (await apiRequest(`/api/suppliers/${supplierId}`)) as {
        documents?: Array<{ id: string; name: string }>;
      };
      setSupplierDocuments((current) => ({ ...current, [supplierId]: result.documents ?? [] }));
    } catch {
      // Silencioso: el expediente es un plus de la ficha, no bloquea la ficha de la orden.
    } finally {
      setDossierLoading((current) => (current === supplierId ? null : current));
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Órdenes"
        description="OC y OP visibles según el rol autenticado; cada estado pertenece a su propia orden."
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
            {/* GRAVE 2: "Entrega" en vez de "Estado" — sin esto, Estado y Estado admin. se
                leían como una sola secuencia en vez de dos ejes independientes. */}
            <span>Entrega</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {statusOptions.map((status) => (
                <option key={status} value={status}>
                  {estadoLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            {/* GRAVE 2: filtro propio del eje contable — el contador necesita pedir "todas
                las pendientes de contabilizar", su tarea de los martes y viernes. */}
            <span>Contabilidad</span>
            <select
              value={adminStatusFilter}
              onChange={(event) => setAdminStatusFilter(event.target.value)}
            >
              <option value="">Todas</option>
              {adminStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {estadoLabel(status)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Proveedor</span>
            <select
              value={supplierFilter}
              onChange={(event) => setSupplierFilter(event.target.value)}
            >
              <option value="">Todos</option>
              {catalogs.suppliers.map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name}
                </option>
              ))}
            </select>
          </label>
          {/* Revisión (corrección tras QA): filtro sobre la fecha REQUERIDA de la requisición de
              origen (row.requiredDate, ya resuelta por el servidor) — etiquetas originales "Desde"/
              "Hasta", restauradas junto con la semántica. */}
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
          {/* RF-505: acceso directo a las compras no_cumplida para que ninguna
              quede fuera de la vista aunque cambien otros filtros. */}
          <label className="filter-button">
            <input
              type="checkbox"
              checked={statusFilter === "no_cumplida"}
              onChange={(event) =>
                setStatusFilter(event.target.checked ? "no_cumplida" : "")
              }
            />
            Solo pendientes (no cumplida)
          </label>
          {/* GRAVE 2: acceso directo a "pendiente de contabilizar" — la tarea recurrente
              del contador, antes solo alcanzable filtrando por el eje de cumplimiento. */}
          <label className="filter-button">
            <input
              type="checkbox"
              checked={adminStatusFilter === "pendiente"}
              onChange={(event) =>
                setAdminStatusFilter(event.target.checked ? "pendiente" : "")
              }
            />
            Solo pendientes de contabilizar
          </label>
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
        {rows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><Inbox aria-hidden="true" size={21} /></span>
            <h3>Sin órdenes visibles</h3>
            <p>El servicio no devolvió órdenes para tu alcance.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon"><SearchX aria-hidden="true" size={21} /></span>
            <h3>Sin resultados para estos filtros</h3>
            <p>Ajusta o limpia los filtros para ver más órdenes.</p>
            <button
              className="button button-secondary"
              type="button"
              onClick={clearFilters}
            >
              Limpiar filtros
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Tipo</th>
                  <th>Obra</th>
                  <th>Requisición</th>
                  {/* Revisión (corrección tras QA): fecha REQUERIDA de la requisición de origen
                      (row.requiredDate, ya resuelta por el servidor) — etiqueta original restaurada. */}
                  <th>Fecha requerida</th>
                  <th>Proveedor</th>
                  {/* Revisión (corrección tras QA): la columna "Valor" (importe de la orden) se
                      restaura — GRAVE 2 original: la contadora contabiliza por importe y antes no lo
                      veía sin abrir cada ficha. `row.lines` (ítems con precio de esta orden) ya viaja
                      en el mismo SELECT del servidor, así que mostrarla para TODAS las filas ya no
                      exige una llamada por orden. */}
                  <th className="align-right">Valor</th>
                  {/* GRAVE 2: "Entrega"/"Contabilidad" en vez de "Estado"/"Estado admin." — dos ejes
                      independientes con su propio nombre, no una secuencia con abreviatura de sistema. */}
                  <th>Entrega</th>
                  <th>Contabilidad</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const openRow = () => {
                    setOpenOrderId(row.id);
                    if (row.supplierId) void loadSupplierDossier(row.supplierId);
                  };
                  return (
                    <tr
                      key={row.id}
                      className="clickable"
                      role="button"
                      tabIndex={0}
                      aria-label={`Abrir ficha de la orden ${row.consecutive}`}
                      onClick={openRow}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openRow();
                        }
                      }}
                    >
                      <td>
                        <b>{row.consecutive}</b>
                      </td>
                      <td>{row.type}</td>
                      <td>{workName(row.workId)}</td>
                      <td>{row.requisitionConsecutive ?? "—"}</td>
                      <td>{row.requiredDate ? formatIsoDate(row.requiredDate) : "—"}</td>
                      <td>{supplierName(row.supplierId)}</td>
                      <td className="align-right money">{money.format(sumLines(row.lines ?? []))}</td>
                      <td>
                        {/* Eje de entrega: punto de color (dot), lenguaje visual propio. */}
                        <Tone
                          tone={row.status === "cumplida" ? "success" : row.status === "no_cumplida" ? "danger" : row.status === "no_necesario" ? "muted" : "warning"}
                          dot
                        >
                          {estadoLabel(row.status)}
                        </Tone>
                      </td>
                      <td>
                        {/* Eje contable: contorno sin punto — para que nunca se lea como el mismo
                            camino que el eje de entrega de la columna anterior. */}
                        <Tone
                          tone={row.adminStatus === "pagada" ? "success" : row.adminStatus === "contabilizada" ? "blue" : "muted"}
                          outline
                        >
                          {estadoLabel(row.adminStatus ?? "pendiente")}
                        </Tone>
                      </td>
                      <td className="align-right">
                        <span className="row-open" aria-hidden="true">
                          Abrir <ArrowRight size={14} />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {openOrderId && (() => {
        const order = rows.find((r) => r.id === openOrderId);
        if (!order) return null;
        // Revisión (corrección tras QA): `order.lines` ya viaja en el mismo SELECT del servidor (join a
        // requisicion_items vía orden_items, ver `order(row)` en postgres-repositories.ts) — son
        // exactamente los ítems de ESTA orden, ya filtrados por el servidor, sin necesidad de cargar la
        // requisición de origen bajo demanda ni de filtrar aquí por `itemIds`.
        const orderItems = order.lines ?? [];
        // BLOQUEANTE 1: mismo cálculo que el PDF (lib/reports/pdf.ts ya usa calculateLineAmounts/sumLines) —
        // antes esto sumaba precios unitarios sin cantidad ni descuento y usaba unitIva (vacío en el modelo
        // nuevo), así que 400 bultos a $38.000 se veían como "$38.000" aquí y "$18.088.000" en el PDF.
        const total = sumLines(orderItems);
        const requisitionHref = order.requisitionId ? `/requisiciones/${order.requisitionId}` : null;
        return (
          <div
            className="supplier-overlay"
            role="presentation"
            onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenOrderId(null); }}
          >
            <aside className="supplier-drawer" role="dialog" aria-modal="true" aria-labelledby="order-detail-title">
              <div className="supplier-drawer-head">
                <div>
                  <div className="eyebrow">Ficha de {order.type === "OP" ? "orden de pago" : "orden de compra"}</div>
                  <h2 id="order-detail-title">{order.consecutive}</h2>
                </div>
                <button className="icon-button" type="button" aria-label="Cerrar ficha" onClick={() => setOpenOrderId(null)}><X aria-hidden="true" size={18} /></button>
              </div>
              <div className="supplier-drawer-body">
                {feedback && <p className="field-error" role="alert">{feedback}</p>}
                {success && <p className="supplier-success" role="status">{success}</p>}
                <div className="supplier-detail-actions">
                  {/* GRAVE 2: dos ejes independientes uno junto al otro (nunca fusionados en un
                      solo badge), cada uno con su etiqueta (antes iban pegados y sin ninguna) y
                      su propio lenguaje visual: entrega con punto de color, contabilidad con
                      contorno — para que no se lean como pasos del mismo camino. */}
                  <div className="title-actions order-axis-group">
                    <span className="order-axis">
                      <span className="order-axis-label">Entrega</span>
                      <Tone tone={order.status === "cumplida" ? "success" : order.status === "no_cumplida" ? "danger" : order.status === "no_necesario" ? "muted" : "warning"} dot>{estadoLabel(order.status)}</Tone>
                    </span>
                    <span className="order-axis">
                      <span className="order-axis-label">Contabilidad</span>
                      <Tone tone={order.adminStatus === "pagada" ? "success" : order.adminStatus === "contabilizada" ? "blue" : "muted"} outline>{estadoLabel(order.adminStatus ?? "pendiente")}</Tone>
                    </span>
                  </div>
                  <a className="button button-secondary" href={`/api/orders/${encodeURIComponent(order.id)}/document`} target="_blank" rel="noreferrer"><FileText aria-hidden="true" size={14} /> Documento</a>
                </div>
                <section className="supplier-info-grid">
                  <div><span>Tipo</span><b>{order.type === "OP" ? "Orden de pago" : "Orden de compra"}</b></div>
                  {/* H2/H3: obra directo de la orden (ya viaja en `OrderRow`) — no depende de que
                      termine de cargar la requisición vinculada. */}
                  <div><span>Obra</span><b>{workName(order.workId)}</b></div>
                  <div><span>Proveedor</span><b>{supplierName(order.supplierId)}</b></div>
                  {/* Revisión (corrección tras QA): `order.requiredDate` viaja directo en la orden
                      (mismo join que resuelve requisitionConsecutive/workId) — ya no depende de cargar
                      la requisición vinculada bajo demanda. */}
                  <div><span>Fecha requerida</span><b>{order.requiredDate ? formatIsoDate(order.requiredDate) : "No registrada"}</b></div>
                  <div>
                    <span>Requisición de origen</span>
                    {requisitionHref
                      ? <b><button type="button" className="text-link" onClick={() => go(requisitionHref)}>{order.requisitionConsecutive ?? "Abrir"} <ArrowRight aria-hidden="true" size={13} /></button></b>
                      : <b>{order.requisitionConsecutive ?? "—"}</b>}
                  </div>
                  {/* Reunión 2026-09: las tres fechas del ciclo administrativo, cada una con su
                      propia etiqueta — nunca fusionadas en una sola "fecha de la orden". */}
                  <div><span>Generada</span><b>{order.generatedAt ? formatIsoDate(order.generatedAt) : "—"}</b></div>
                  <div><span>Contabilizada</span><b>{order.accountedAt ? formatIsoDate(order.accountedAt) : "—"}</b></div>
                  <div><span>Pagada</span><b>{order.paidAt ? formatIsoDate(order.paidAt) : "—"}</b></div>
                </section>
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    <div><h3>Ítems de la orden</h3><p>{orderItems.length} ítem{orderItems.length === 1 ? "" : "s"} de esta orden.</p></div>
                    <Truck aria-hidden="true" size={17} />
                  </div>
                  {orderItems.length ? (
                    <>
                      <div className="supplier-order-total"><span>Total de la orden</span><b>{money.format(total)}</b></div>
                      <div className="table-wrap supplier-orders-table">
                        <table>
                          <thead><tr><th>Descripción</th><th className="align-right">Cantidad</th><th>Unidad</th><th className="align-right">Valor</th></tr></thead>
                          <tbody>
                            {orderItems.map((it) => (
                              <tr key={it.id}>
                                <td>{it.description || "—"}</td>
                                <td className="align-right money">{it.quantity}</td>
                                <td>{it.unit}</td>
                                <td className="align-right money">{money.format(calculateLineTotal(it))}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : <p className="supplier-muted">No fue posible cargar los ítems de esta orden. Ábrela desde su requisición de origen para el detalle completo.</p>}
                </section>
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    {/* GRAVE 2: "Entrega" en vez de "Cumplimiento" — mismo nombre que la columna
                        de la lista y la etiqueta del badge de arriba. */}
                    <div><h3>Entrega</h3><p>La trazabilidad completa vive en la requisición de origen.</p></div>
                    <CheckCircle2 aria-hidden="true" size={17} />
                  </div>
                  {canUpdate && order.status === "generada" ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "cumplida", order.consecutive)}>Marcar cumplida</button>
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "no_cumplida", order.consecutive)}>No cumplida</button>
                      <button className="button button-secondary" type="button" onClick={() => void setStatus(order.id, "no_necesario", order.consecutive)}>No necesaria</button>
                    </div>
                  ) : (
                    <p className="supplier-muted">{order.status === "generada" ? sinPermiso("puede cambiar el estado de entrega de la orden") : `Esta orden ya está marcada como "${estadoLabel(order.status)}". El estado de entrega es definitivo.`}</p>
                  )}
                </section>
                {/* GRAVE 2 (QA 2026-08-31): "eje administrativo" es vocabulario del equipo de
                    desarrollo — el título y los textos ahora dicen "Contabilidad", que es el
                    lenguaje del cliente. Independiente de la entrega de arriba: el contador
                    martes y viernes marca "contabilizada"; Daniel marca "pagada" para que el
                    contador sepa que puede sacar de caja. */}
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    <div><h3>Contabilidad</h3><p>Independiente de la entrega: pendiente → contabilizada → pagada.</p></div>
                  </div>
                  {order.status === "no_necesario" ? (
                    <p className="supplier-muted">Una orden marcada &ldquo;no necesaria&rdquo; no se contabiliza ni se paga.</p>
                  ) : (order.adminStatus ?? "pendiente") === "pendiente" && canAccount ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setAdminStatus(order.id, "contabilizada", order.consecutive)}>Marcar contabilizada</button>
                    </div>
                  ) : order.adminStatus === "contabilizada" && canPay ? (
                    <div className="order-status-actions">
                      <button className="button button-secondary" type="button" onClick={() => void setAdminStatus(order.id, "pagada", order.consecutive)}>Marcar pagada</button>
                    </div>
                  ) : (
                    <p className="supplier-muted">
                      {order.adminStatus === "pagada"
                        ? "Esta orden ya está pagada. El estado de contabilidad es definitivo."
                        : sinPermiso(`puede avanzar la contabilidad desde "${estadoLabel(order.adminStatus ?? "pendiente")}"`)}
                    </p>
                  )}
                </section>
                {/* Bandeja del contador: descarga la orden (arriba) y el expediente del
                    proveedor sin buscarlo por otro lado. */}
                {order.supplierId && (
                  <section className="supplier-section">
                    <div className="supplier-section-head">
                      <div><h3>Expediente del proveedor</h3><p>RUT, cámara de comercio y demás documentos cargados.</p></div>
                    </div>
                    {dossierLoading === order.supplierId ? (
                      <p className="supplier-muted">Cargando expediente…</p>
                    ) : (supplierDocuments[order.supplierId] ?? []).length ? (
                      <div className="attachment-list">
                        {(supplierDocuments[order.supplierId] ?? []).map((document) => (
                          <a
                            key={document.id}
                            className="attachment-link"
                            href={`/api/suppliers/${encodeURIComponent(order.supplierId as string)}/documents/${encodeURIComponent(document.id)}/download`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {document.name}
                          </a>
                        ))}
                      </div>
                    ) : (
                      <p className="supplier-muted">Sin documentos cargados para este proveedor.</p>
                    )}
                  </section>
                )}
              </div>
            </aside>
          </div>
        );
      })()}
      {confirmDialog}
    </>
  );
}

