"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedOrders, partido de
// components/screens/connected.tsx. Misma lógica, mismos nombres.
import { Fragment, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Inbox,
  SearchX,
  Truck,
  Wallet,
  X,
} from "lucide-react";
import type { Role } from "../../../lib/demo-data";
import type { PaymentMethod, PaymentStatus } from "../../../lib/domain";
// BLOQUEANTE 1 (QA 2026-08-31): misma fuente de verdad que la ficha y el PDF — ver el
// comentario original en components/screens/connected.tsx (import de lib/domain/rules).
import { calculateLineTotal, sumLines } from "../../../lib/domain/rules";
import { apiRequest } from "../../../lib/http/friendly-error";
import { AttachmentPicker, uploadSignedAttachment } from "../attachment-upload";
import { SectionTitle, Tone, useConfirmDialog } from "../screen-primitives";
import {
  emptyCatalogs,
  estadoLabel,
  formatIsoDate,
  localTodayISO,
  money,
  resolveUserName,
  type OrderPaymentRow,
  type OrderRow,
  type OrdersBundle,
} from "./shared";
import { mutate } from "./data";
import { MEDIO_PAGO_OPTIONS, medioPagoLabel, PAYMENT_STATUS_LABELS, PaymentStatusBadge } from "./payment-labels";

type PaymentInput = { date: string; amount: number; method: PaymentMethod; externalReference?: string; note?: string };
type PaymentDialogState =
  | { step: "form"; orderId: string; mode: "registrar" | "saldo" }
  | { step: "comprobante"; orderId: string; paymentId: string; amount: number };

// RF-509: estado de pago, medio y fecha de pago salen de `pagos_orden`, no de la fila que ya tiene el
// cliente, así que estos filtros los resuelve el servidor (`parseListQuery` en lib/http/api.ts, mismos
// nombres de query). `loadRoute` (data.ts) sigue pidiendo `/api/orders` sin parámetros; esta pantalla
// pide la versión filtrada solo mientras alguno de estos tenga valor, y los filtros de siempre (obra,
// entrega, contabilidad, proveedor, fecha requerida) se aplican encima, en cliente, como hasta hoy.
type PaymentFilters = { paymentMethod: string; paymentStatus: string; costCenterId: string; billedCompanyId: string; paidFrom: string; paidTo: string };
const EMPTY_PAYMENT_FILTERS: PaymentFilters = { paymentMethod: "", paymentStatus: "", costCenterId: "", billedCompanyId: "", paidFrom: "", paidTo: "" };
function paymentFiltersQuery(filters: PaymentFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params.toString();
}
const PAYMENT_STATUS_OPTIONS = Object.entries(PAYMENT_STATUS_LABELS) as Array<[PaymentStatus, string]>;

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
  const baseRows: OrderRow[] = Array.isArray(data?.rows) ? data.rows : [],
    catalogs = data?.catalogs ?? emptyCatalogs,
    [feedback, setFeedback] = useState(""),
    [success, setSuccess] = useState(""),
    [openOrderId, setOpenOrderId] = useState<string | null>(null),
    canUpdate = role === "Revisor" || role === "Administrador Sixteam",
    // Reunión 2026-08-31: eje administrativo/contable, independiente del cumplimiento de arriba.
    // "contabilizada" es de contabilidad (order:account); "pagada" es del revisor (order:pay).
    canAccount = role === "Contabilidad" || role === "Administrador Sixteam",
    canPay = role === "Revisor" || role === "Administrador Sixteam",
    // DECISIÓN DE ERNESTO (2026-09-17): `payment:register` pasó a ser de revisor/admin_sixteam —
    // contabilidad SALE. Esta pantalla decide por el rol principal del visor, no por su lista
    // efectiva de permisos, así que refleja el DEFAULT de lib/domain/rules.ts: si un administrador
    // le devuelve el permiso a contabilidad desde Configuración, el servidor lo aceptará pero este
    // botón seguirá oculto hasta que el payload de órdenes traiga los permisos del visor.
    canRegisterPayment = canPay;
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
  // Centros de costo (2026-09-12): centro EFECTIVO de la requisición dueña de la orden (ver
  // Order.costCenterId en lib/domain/model.ts) — "—" cuando no hay uno asignado, nunca el UUID crudo.
  const costCenterName = (id?: string) => (id ? ((catalogs.costCenters ?? []).find((c) => c.id === id)?.name ?? "—") : "—");
  const societyName = (id?: string) => (id ? ((catalogs.societies ?? []).find((s) => s.id === id)?.name ?? "—") : "—");
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
  const [paymentFilters, setPaymentFilters] = useState<PaymentFilters>(EMPTY_PAYMENT_FILTERS);
  // `query` es la petición vigente: cambiar dos filtros seguidos puede devolver las respuestas en
  // desorden, y una que llegue para otra query se descarta en el updater (compara contra el estado
  // más reciente, sin refs — la regla react-hooks/refs no deja leer un ref desde funciones que
  // acaban pasadas por props).
  const [serverList, setServerList] = useState<{ query: string; rows: OrderRow[] | null; loading: boolean }>({ query: "", rows: null, loading: false });
  const loadServerRows = async (filters: PaymentFilters) => {
    const query = paymentFiltersQuery(filters);
    if (!query) {
      setServerList({ query: "", rows: null, loading: false });
      return;
    }
    setServerList((current) => ({ query, rows: current.rows, loading: true }));
    try {
      const result = (await apiRequest(`/api/orders?${query}`)) as OrderRow[];
      setServerList((current) => (current.query === query ? { query, rows: Array.isArray(result) ? result : [], loading: false } : current));
    } catch (error) {
      setServerList((current) => (current.query === query ? { ...current, loading: false } : current));
      setFeedback(error instanceof Error ? error.message : "No fue posible aplicar los filtros de pago.");
    }
  };
  const setPaymentFilter = (key: keyof PaymentFilters, value: string) => {
    const next = { ...paymentFilters, [key]: value };
    setPaymentFilters(next);
    void loadServerRows(next);
  };
  const hasPaymentFilters = paymentFiltersQuery(paymentFilters) !== "";
  // Tras cualquier escritura, la lista filtrada por el servidor se vuelve a pedir junto con la ruta:
  // `refresh()` solo recarga `/api/orders` sin parámetros.
  const reloadList = async () => {
    await Promise.all([refresh(), hasPaymentFilters ? loadServerRows(paymentFilters) : Promise.resolve()]);
  };
  const rows = serverList.rows ?? baseRows;
  const statusOptions = Array.from(
    new Set(baseRows.map((row) => row.status)),
  ).sort();
  const adminStatusOptions = Array.from(
    new Set(baseRows.map((row) => row.adminStatus ?? "pendiente")),
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
    setPaymentFilters(EMPTY_PAYMENT_FILTERS);
    setServerList({ query: "", rows: null, loading: false });
  };
  const setStatus = async (id: string, status: string, consecutive?: string) => {
    const ref = consecutive ?? id;
    // Cambio irreversible y sin deshacer: se confirma explícitamente antes de aplicar.
    const { ok } = await confirm({
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
      void reloadList();
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
  // Adenda de pagos (A3): "pagada" ya no inventa ningún pago — el servidor exige saldo cero
  // (SALDO_PENDIENTE), así que este camino solo se ofrece cuando el saldo ya es cero; con saldo, el botón
  // es "Pagar saldo" (abre el diálogo de pago) y el cierre se encadena al registrar ese pago.
  const setAdminStatus = async (id: string, adminStatus: "contabilizada" | "pagada", consecutive?: string) => {
    const ref = consecutive ?? id;
    const description = adminStatus === "pagada"
      ? `La orden ${ref} quedará marcada como "Pagada" en contabilidad. Solo anular un pago la devolvería a "Contabilizada".`
      : `La orden ${ref} quedará marcada como "${estadoLabel(adminStatus)}" en contabilidad. Esta acción es irreversible.`;
    const { ok } = await confirm({
      title: `Marcar la orden como "${estadoLabel(adminStatus)}"`,
      description,
      confirmLabel: "Confirmar",
    });
    if (!ok) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { adminStatus });
      setSuccess(`La orden ${ref} quedó como "${estadoLabel(adminStatus)}" en contabilidad.`);
      void reloadList();
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
  // Reunión agosto 2026: historial de pagos de la orden — mismo patrón perezoso que
  // loadSupplierDossier (se pide una vez, solo al abrir la ficha; GET /api/orders/:id/payments).
  const [paymentsByOrder, setPaymentsByOrder] = useState<Record<string, OrderPaymentRow[]>>({});
  const [paymentsLoading, setPaymentsLoading] = useState<string | null>(null);
  const loadPayments = async (orderId: string, force = false) => {
    if ((!force && paymentsByOrder[orderId]) || paymentsLoading === orderId) return;
    setPaymentsLoading(orderId);
    try {
      const result = (await apiRequest(`/api/orders/${orderId}/payments`)) as OrderPaymentRow[];
      setPaymentsByOrder((current) => ({ ...current, [orderId]: result }));
    } catch {
      // Silencioso, igual que loadSupplierDossier: el historial es un plus de la ficha.
    } finally {
      setPaymentsLoading((current) => (current === orderId ? null : current));
    }
  };
  // Diálogo de pago (A3/RF-507): fecha, valor, medio, referencia y nota; tras guardar, un paso opcional
  // para adjuntar el comprobante contra el id del pago recién creado (el adjunto exige que su padre
  // exista, ver ESTADO.md de la ola 1). "Pagar saldo" abre el mismo diálogo prellenado con el saldo.
  const [paymentDialog, setPaymentDialog] = useState<PaymentDialogState | null>(null);
  const openPaymentDialog = (state: PaymentDialogState) => {
    setFeedback("");
    setSuccess("");
    setPaymentDialog(state);
  };
  const registerPayment = async (order: OrderRow, input: PaymentInput): Promise<OrderPaymentRow> => {
    const result = (await mutate(`/api/orders/${order.id}/payments`, "POST", {
      date: input.date,
      amount: input.amount,
      method: input.method,
      ...(input.externalReference ? { externalReference: input.externalReference } : {}),
      ...(input.note ? { note: input.note } : {}),
    })) as { payment: OrderPaymentRow; order?: OrderRow };
    let message = `Se registró un pago de ${money.format(result.payment.amount)} para la orden ${order.consecutive}.`;
    // Atajo conservado de "Marcar pagada": si este pago deja el saldo en cero y la orden ya estaba
    // contabilizada, se cierra el eje contable en el mismo gesto. Solo quien tiene order:pay (canPay):
    // contabilidad puede registrar el pago, pero el PATCH le daría 403.
    const paidAfter = result.order?.paidAmount ?? (order.paidAmount ?? 0) + input.amount;
    const settled = result.order?.paymentStatus ? result.order.paymentStatus === "pagada" : paidAfter >= sumLines(order.lines ?? []);
    if (settled && canPay && order.adminStatus === "contabilizada") {
      try {
        await mutate(`/api/orders/${order.id}/status`, "PATCH", { adminStatus: "pagada" });
        message += ` La orden quedó como "Pagada" en contabilidad.`;
      } catch (error) {
        setFeedback(`El pago quedó registrado, pero no fue posible marcar la orden como pagada: ${error instanceof Error ? error.message : "inténtalo desde la ficha."}`);
      }
    }
    setSuccess(message);
    await Promise.all([loadPayments(order.id, true), reloadList()]);
    return result.payment;
  };
  // RF-510: un pago se anula con motivo, nunca se borra — el motivo vive dentro del diálogo de
  // confirmación (mismo `reason` de declinar/devolver) y el registro queda tachado en el historial.
  const annulPayment = async (order: OrderRow, payment: OrderPaymentRow) => {
    const { ok, reason } = await confirm({
      title: `Anular el pago de ${money.format(payment.amount)}`,
      description: `El pago del ${formatIsoDate(payment.date)} (${medioPagoLabel(payment.method)}) de la orden ${order.consecutive} quedará anulado y su valor volverá al saldo pendiente; el registro se conserva tachado en el historial.${order.adminStatus === "pagada" ? ' Como la orden ya estaba marcada como pagada, volverá a "Contabilizada".' : ""}`,
      confirmLabel: "Anular pago",
      danger: true,
      reason: { label: "Motivo de la anulación", required: true },
    });
    if (!ok || !reason) return;
    setFeedback("");
    setSuccess("");
    try {
      await mutate(`/api/orders/${order.id}/payments/${payment.id}`, "PATCH", { action: "annul", reason });
      setSuccess(`Se anuló el pago de ${money.format(payment.amount)} de la orden ${order.consecutive}.`);
      await Promise.all([loadPayments(order.id, true), reloadList()]);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "No fue posible anular el pago.");
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Órdenes"
        description="OC y OP visibles según el rol autenticado; cada estado pertenece a su propia orden."
      />
      {baseRows.length > 0 && (
        <>
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
        {/* Segunda barra (no cabe en la primera sin desbordar en escritorio): filtros de pago,
            resueltos por el servidor — ver `loadServerRows`. */}
        <div className="filter-bar">
          <label className="field">
            <span>Medio de pago</span>
            <select value={paymentFilters.paymentMethod} onChange={(event) => setPaymentFilter("paymentMethod", event.target.value)}>
              <option value="">Todos</option>
              {MEDIO_PAGO_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Estado de pago</span>
            <select value={paymentFilters.paymentStatus} onChange={(event) => setPaymentFilter("paymentStatus", event.target.value)}>
              <option value="">Todos</option>
              {PAYMENT_STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Centro de costo</span>
            <select value={paymentFilters.costCenterId} onChange={(event) => setPaymentFilter("costCenterId", event.target.value)}>
              <option value="">Todos</option>
              {(catalogs.costCenters ?? []).map((costCenter) => (
                <option key={costCenter.id} value={costCenter.id}>{costCenter.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Empresa facturada</span>
            <select value={paymentFilters.billedCompanyId} onChange={(event) => setPaymentFilter("billedCompanyId", event.target.value)}>
              <option value="">Todas</option>
              {(catalogs.societies ?? []).map((society) => (
                <option key={society.id} value={society.id}>{society.name}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Pagado desde</span>
            <input type="date" value={paymentFilters.paidFrom} onChange={(event) => setPaymentFilter("paidFrom", event.target.value)} />
          </label>
          <label className="field">
            <span>Pagado hasta</span>
            <input type="date" value={paymentFilters.paidTo} onChange={(event) => setPaymentFilter("paidTo", event.target.value)} />
          </label>
          {serverList.loading && <span className="muted-copy" role="status">Aplicando filtros…</span>}
        </div>
        </>
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
        {baseRows.length === 0 ? (
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
                  <th>Centro de costo</th>
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
                  {/* Reunión agosto 2026: "cuánto se ha pagado de cada orden" — Order.paidAmount ya
                      viaja en el mismo SELECT (ver el comentario en shared.tsx), así que se muestra
                      para TODAS las filas sin una llamada por orden. */}
                  <th className="align-right">Pagado / Total</th>
                  {/* RF-508: tercer eje, derivado (Σ pagos vigentes vs total), con contorno para no
                      confundirse con "Contabilidad", que también puede decir "Pagada". */}
                  <th>Pago</th>
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
                    void loadPayments(row.id);
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
                      <td>
                        {/* Pendiente que dejó otro agente: "OC"/"OP" crudo no se leía como
                            Compra/Pago — mismo lenguaje visual de chip que el resto de la tabla. */}
                        <Tone tone={row.type === "OP" ? "blue" : "muted"}>
                          {row.type === "OP" ? "Pago" : "Compra"}
                        </Tone>
                      </td>
                      <td>{workName(row.workId)}</td>
                      <td>{costCenterName(row.costCenterId)}</td>
                      <td>{row.requisitionConsecutive ?? "—"}</td>
                      <td>{row.requiredDate ? formatIsoDate(row.requiredDate) : "—"}</td>
                      <td>{supplierName(row.supplierId)}</td>
                      <td className="align-right money">{money.format(sumLines(row.lines ?? []))}</td>
                      <td className="align-right money">
                        {money.format(row.paidAmount ?? 0)} / {money.format(sumLines(row.lines ?? []))}
                      </td>
                      <td>{row.paymentStatus ? <PaymentStatusBadge status={row.paymentStatus} /> : "—"}</td>
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
        // Reunión agosto 2026: saldo pendiente de la orden (para "Pagar saldo" y el encabezado del panel
        // "Pagos"). `order.paidAmount` puede faltar (ver el comentario del campo en shared.tsx) en algún
        // camino que no haga el join — se trata como 0, nunca como "ya pagada", que sería el error más
        // caro de los dos.
        const paidTotal = order.paidAmount ?? 0;
        const pendingBalance = Math.max(0, total - paidTotal);
        const requisitionHref = order.requisitionId ? `/requisiciones/${order.requisitionId}` : null;
        const payments = paymentsByOrder[order.id] ?? [];
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
                      contorno — para que no se lean como pasos del mismo camino. RF-508 añade el
                      tercero, "Pago" (derivado de los pagos vigentes). */}
                  <div className="title-actions order-axis-group">
                    <span className="order-axis">
                      <span className="order-axis-label">Entrega</span>
                      <Tone tone={order.status === "cumplida" ? "success" : order.status === "no_cumplida" ? "danger" : order.status === "no_necesario" ? "muted" : "warning"} dot>{estadoLabel(order.status)}</Tone>
                    </span>
                    <span className="order-axis">
                      <span className="order-axis-label">Contabilidad</span>
                      <Tone tone={order.adminStatus === "pagada" ? "success" : order.adminStatus === "contabilizada" ? "blue" : "muted"} outline>{estadoLabel(order.adminStatus ?? "pendiente")}</Tone>
                    </span>
                    {order.paymentStatus && (
                      <span className="order-axis">
                        <span className="order-axis-label">Pago</span>
                        <PaymentStatusBadge status={order.paymentStatus} />
                      </span>
                    )}
                  </div>
                  <a className="button button-secondary" href={`/api/orders/${encodeURIComponent(order.id)}/document`} target="_blank" rel="noreferrer"><FileText aria-hidden="true" size={14} /> Documento</a>
                </div>
                <section className="supplier-info-grid">
                  <div><span>Tipo</span><b>{order.type === "OP" ? "Orden de pago" : "Orden de compra"}</b></div>
                  {/* H2/H3: obra directo de la orden (ya viaja en `OrderRow`) — no depende de que
                      termine de cargar la requisición vinculada. */}
                  <div><span>Obra</span><b>{workName(order.workId)}</b></div>
                  <div><span>Centro de costo</span><b>{costCenterName(order.costCenterId)}</b></div>
                  <div><span>Empresa facturada</span><b>{societyName(order.billedCompanyId)}</b></div>
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
                  <div><span>Último pago</span><b>{order.lastPaymentAt ? formatIsoDate(order.lastPaymentAt) : "—"}</b></div>
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
                      {pendingBalance > 0 ? (
                        <>
                          <button className="button button-secondary" type="button" onClick={() => openPaymentDialog({ step: "form", orderId: order.id, mode: "saldo" })}>Pagar saldo</button>
                          <p className="supplier-muted">Quedan {money.format(pendingBalance)} por pagar. Al registrar ese pago, la orden pasará a &ldquo;Pagada&rdquo; en contabilidad.</p>
                        </>
                      ) : (
                        <>
                          <button className="button button-secondary" type="button" onClick={() => void setAdminStatus(order.id, "pagada", order.consecutive)}>Marcar pagada</button>
                          <p className="supplier-muted">Ya está cubierto el total con los pagos registrados; esto solo cierra el estado.</p>
                        </>
                      )}
                    </div>
                  ) : (
                    <p className="supplier-muted">
                      {order.adminStatus === "pagada"
                        ? "Esta orden ya está pagada. El estado de contabilidad es definitivo."
                        : sinPermiso(`puede avanzar la contabilidad desde "${estadoLabel(order.adminStatus ?? "pendiente")}"`)}
                    </p>
                  )}
                </section>
                {/*
                  Reunión agosto 2026 (pedido del cliente): "saber cuánto se ha pagado de cada orden"
                  con pagos parciales. Adenda de pagos: el formulario inline pasó a un diálogo (mismo
                  patrón de capas que `useConfirmDialog`: `.quick-supplier-overlay` va por encima de
                  `.supplier-overlay`, ver app/globals.css) porque ahora tiene un segundo paso (el
                  comprobante) y lo abre también "Pagar saldo" desde la sección de arriba.
                */}
                <section className="supplier-section">
                  <div className="supplier-section-head">
                    <div><h3>Pagos</h3><p>Pagos registrados para esta orden; los anulados se conservan tachados.</p></div>
                    <Wallet aria-hidden="true" size={17} />
                  </div>
                  {order.status === "no_necesario" ? (
                    <p className="supplier-muted">Una orden marcada &ldquo;no necesaria&rdquo; no tiene gasto asociado: no admite pagos.</p>
                  ) : (
                    <>
                      <div className="supplier-order-total">
                        <span>Pagado / Total</span>
                        <b>{money.format(paidTotal)} / {money.format(total)}</b>
                      </div>
                      {paymentsLoading === order.id ? (
                        <p className="supplier-muted">Cargando pagos…</p>
                      ) : payments.length ? (
                        <div className="table-wrap supplier-orders-table">
                          <table>
                            <thead>
                              <tr>
                                <th>Fecha</th>
                                <th>Medio</th>
                                <th className="align-right">Valor</th>
                                <th>Referencia</th>
                                <th>Comprobante</th>
                                <th />
                              </tr>
                            </thead>
                            <tbody>
                              {payments.map((payment) => {
                                const annulled = Boolean(payment.annulled);
                                // <del> y no una clase: el tachado es semántico ("este registro ya no
                                // vale") y así llega igual a un lector de pantalla y sin CSS nuevo.
                                const cell = (content: string) => (annulled ? <del>{content}</del> : content);
                                const receiptHref = payment.attachmentId
                                  ? `/api/attachments/pago_orden/${encodeURIComponent(payment.id)}/${encodeURIComponent(payment.attachmentId)}/download`
                                  : null;
                                return (
                                  <Fragment key={payment.id}>
                                    <tr>
                                      <td>{cell(formatIsoDate(payment.date))}</td>
                                      <td>{cell(medioPagoLabel(payment.method))}</td>
                                      <td className="align-right money">{cell(money.format(payment.amount))}</td>
                                      <td>{cell(payment.externalReference ?? "—")}</td>
                                      <td>
                                        {receiptHref
                                          ? <a className="attachment-link" href={receiptHref} target="_blank" rel="noreferrer">Descargar</a>
                                          : !annulled && canRegisterPayment
                                            ? <button type="button" className="text-link" onClick={() => openPaymentDialog({ step: "comprobante", orderId: order.id, paymentId: payment.id, amount: payment.amount })}>Adjuntar</button>
                                            : "—"}
                                      </td>
                                      <td className="align-right">
                                        {annulled
                                          ? <Tone tone="danger" outline>Anulado</Tone>
                                          : canRegisterPayment
                                            ? <button type="button" className="text-link" onClick={() => void annulPayment(order, payment)}>Anular</button>
                                            : null}
                                      </td>
                                    </tr>
                                    {(annulled || payment.note) && (
                                      <tr>
                                        <td colSpan={6} className="muted-copy">
                                          {annulled && `Anulado${payment.annulledAt ? ` el ${formatIsoDate(payment.annulledAt)}` : ""} por ${resolveUserName(catalogs, payment.annulledBy, "—")}: ${payment.annulmentReason ?? "sin motivo registrado"}`}
                                          {annulled && payment.note ? " · " : ""}
                                          {payment.note && `Nota: ${payment.note}`}
                                        </td>
                                      </tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="supplier-muted">Sin pagos registrados todavía.</p>
                      )}
                      {order.adminStatus === "pagada" ? (
                        <p className="supplier-muted">Esta orden ya está pagada; no admite más pagos.</p>
                      ) : canRegisterPayment ? (
                        <div className="order-status-actions">
                          <button
                            className="button button-secondary"
                            type="button"
                            disabled={pendingBalance <= 0}
                            aria-disabled={pendingBalance <= 0}
                            title={pendingBalance <= 0 ? "No queda saldo por pagar." : undefined}
                            onClick={() => openPaymentDialog({ step: "form", orderId: order.id, mode: "registrar" })}
                          >
                            Registrar pago
                          </button>
                        </div>
                      ) : (
                        <p className="supplier-muted">{sinPermiso("puede registrar pagos de esta orden")}</p>
                      )}
                    </>
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
      {paymentDialog && (() => {
        const order = rows.find((r) => r.id === paymentDialog.orderId);
        if (!order) return null;
        return (
          <OrderPaymentDialog
            key={paymentDialog.step === "form" ? `${order.id}:form:${paymentDialog.mode}` : `${order.id}:comprobante:${paymentDialog.paymentId}`}
            order={order}
            total={sumLines(order.lines ?? [])}
            paid={order.paidAmount ?? 0}
            initial={paymentDialog}
            willClosePaid={canPay && order.adminStatus === "contabilizada"}
            onSubmit={(input) => registerPayment(order, input)}
            onUploaded={async () => {
              setSuccess(`Comprobante adjuntado a la orden ${order.consecutive}.`);
              await loadPayments(order.id, true);
            }}
            onClose={() => setPaymentDialog(null)}
          />
        );
      })()}
      {confirmDialog}
    </>
  );
}

function OrderPaymentDialog({
  order,
  total,
  paid,
  initial,
  willClosePaid,
  onSubmit,
  onUploaded,
  onClose,
}: {
  order: { consecutive: string };
  total: number;
  paid: number;
  initial: PaymentDialogState;
  /** Cubrir el saldo también cerrará el eje contable (quien mira tiene order:pay y la orden ya está contabilizada). */
  willClosePaid: boolean;
  onSubmit: (input: PaymentInput) => Promise<OrderPaymentRow>;
  onUploaded: () => Promise<void> | void;
  onClose: () => void;
}) {
  const balance = Math.max(0, total - paid);
  const [step, setStep] = useState<"form" | "comprobante">(initial.step);
  const [paymentId, setPaymentId] = useState(initial.step === "comprobante" ? initial.paymentId : "");
  const [registeredAmount, setRegisteredAmount] = useState(initial.step === "comprobante" ? initial.amount : 0);
  const [date, setDate] = useState(localTodayISO());
  const [amount, setAmount] = useState(initial.step === "form" && initial.mode === "saldo" ? String(balance) : "");
  const [method, setMethod] = useState<PaymentMethod | "">("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<"preparing" | "uploading" | "completing" | null>(null);
  const [error, setError] = useState("");
  const [invalid, setInvalid] = useState<"date" | "amount" | "method" | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const trigger = (document.activeElement as HTMLElement | null) ?? null;
    return () => queueMicrotask(() => trigger?.focus());
  }, []);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [step]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'),
      );
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);
  const amountNumber = Math.round(Number(amount));
  const submit = async () => {
    if (!date) {
      setInvalid("date");
      setError("Indica la fecha del pago.");
      return;
    }
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setInvalid("amount");
      setError("Indica un valor mayor a cero.");
      return;
    }
    if (amountNumber > balance) {
      setInvalid("amount");
      setError(`El valor supera el saldo pendiente (${money.format(balance)}).`);
      return;
    }
    if (!method) {
      setInvalid("method");
      setError("Elige el medio de pago.");
      return;
    }
    setInvalid(null);
    setError("");
    setBusy(true);
    try {
      const payment = await onSubmit({
        date,
        amount: amountNumber,
        method,
        ...(reference.trim() ? { externalReference: reference.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setPaymentId(payment.id);
      setRegisteredAmount(payment.amount);
      setStep("comprobante");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "No fue posible registrar el pago.");
    } finally {
      setBusy(false);
    }
  };
  const upload = async () => {
    if (!file || !paymentId) return;
    setError("");
    setBusy(true);
    try {
      await uploadSignedAttachment({
        prepareUrl: `/api/attachments/pago_orden/${encodeURIComponent(paymentId)}`,
        completeUrl: (attachmentId) => `/api/attachments/pago_orden/${encodeURIComponent(paymentId)}/${encodeURIComponent(attachmentId)}/complete`,
        file,
        metadata: { type: "soporte", name: file.name, mimeType: file.type, sizeBytes: file.size },
        onProgress: setStage,
      });
      await onUploaded();
      onClose();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "No fue posible adjuntar el comprobante.");
    } finally {
      setStage(null);
      setBusy(false);
    }
  };
  const errorId = "order-payment-error";
  return (
    <div className="quick-supplier-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div ref={dialogRef} className="panel quick-supplier-dialog" role="dialog" aria-modal="true" aria-labelledby="order-payment-title" aria-describedby="order-payment-desc">
        <div className="panel-head">
          <div>
            <div className="eyebrow">Orden {order.consecutive}</div>
            <h2 id="order-payment-title">{step === "form" ? (initial.step === "form" && initial.mode === "saldo" ? "Pagar saldo" : "Registrar pago") : "Adjuntar comprobante"}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="Cerrar" onClick={onClose} disabled={busy}><X aria-hidden="true" size={16} /></button>
        </div>
        {step === "form" ? (
          <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <div className="quick-supplier-body">
              <p id="order-payment-desc" className="muted-copy">Saldo pendiente: <b>{money.format(balance)}</b> de {money.format(total)}.</p>
              {error && <p className="field-error" role="alert" id={errorId}>{error}</p>}
              <div className="field-grid">
                <label className="field">
                  <span>Fecha</span>
                  <input type="date" value={date} onChange={(event) => setDate(event.target.value)} required aria-invalid={invalid === "date" || undefined} aria-describedby={invalid === "date" ? errorId : undefined} disabled={busy} />
                </label>
                <label className="field">
                  <span>Valor</span>
                  <input type="number" min={1} step={1} value={amount} onChange={(event) => setAmount(event.target.value)} required aria-invalid={invalid === "amount" || undefined} aria-describedby={invalid === "amount" ? errorId : undefined} disabled={busy} data-autofocus={initial.step === "form" && initial.mode === "registrar" ? true : undefined} />
                </label>
                <label className="field">
                  <span>Medio</span>
                  <select value={method} onChange={(event) => setMethod(event.target.value as PaymentMethod | "")} required aria-invalid={invalid === "method" || undefined} aria-describedby={invalid === "method" ? errorId : undefined} disabled={busy} data-autofocus={initial.step === "form" && initial.mode === "saldo" ? true : undefined}>
                    <option value="">Elige un medio</option>
                    {MEDIO_PAGO_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Referencia (opcional)</span>
                  <input type="text" value={reference} onChange={(event) => setReference(event.target.value)} maxLength={240} disabled={busy} />
                </label>
                <label className="field field-wide">
                  <span>Nota (opcional)</span>
                  <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} disabled={busy} />
                </label>
              </div>
              {willClosePaid && balance > 0 && amountNumber >= balance && (
                <p className="muted-copy">Con este pago la orden queda saldada y pasará a &ldquo;Pagada&rdquo; en contabilidad.</p>
              )}
            </div>
            <div className="form-footer">
              <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>Cancelar</button>
              <button className="button button-dark" type="submit" disabled={busy}>{busy ? "Registrando…" : "Guardar pago"}</button>
            </div>
          </form>
        ) : (
          <>
            <div className="quick-supplier-body">
              <p id="order-payment-desc">Pago de {money.format(registeredAmount)} registrado. Si tienes el comprobante (transferencia, recibo de caja), adjúntalo ahora; también puedes hacerlo después desde el historial de pagos.</p>
              {error && <p className="field-error" role="alert">{error}</p>}
              <AttachmentPicker
                id="order-payment-receipt"
                label="Comprobante del pago"
                help="PDF, JPG, PNG o WebP · máximo 10 MB"
                file={file}
                onFile={setFile}
                onError={setError}
                disabled={busy}
              />
              {stage && (
                <p className="muted-copy" role="status">
                  {stage === "preparing" ? "Preparando la carga…" : stage === "uploading" ? "Subiendo el comprobante…" : "Confirmando…"}
                </p>
              )}
            </div>
            <div className="form-footer">
              <button className="button button-secondary" type="button" onClick={onClose} disabled={busy} data-autofocus>Omitir</button>
              <button className="button button-dark" type="button" onClick={() => void upload()} disabled={busy || !file}>{busy ? "Adjuntando…" : "Adjuntar comprobante"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
