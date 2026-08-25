"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ArrowRight, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import type { Role } from "../../lib/demo-data";
import { SectionTitle, Tone } from "./screen-primitives";
import { ConnectedCatalogAdmin } from "./catalog-admin";
import {
  AttachmentPicker,
  IMAGE_MIME_TYPES,
  uploadSignedAttachment,
  type AttachmentMetadata,
} from "./attachment-upload";

type LoadState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: unknown };
type ConnectedProps = {
  pathname: string;
  role: Role;
  go: (path: string) => void;
};
type NamedOption = { id: string; name: string };
type CatalogData = {
  works: NamedOption[];
  tags: NamedOption[];
  suppliers: NamedOption[];
  items: Array<NamedOption & { unit: string; status: string }>;
  features: Record<string, boolean>;
  societies?: NamedOption[];
  approvers?: NamedOption[];
  access?: Record<string, boolean>;
};
type RequisitionItem = {
  id: string;
  itemId?: string;
  description?: string;
  quantity: number;
  unit: string;
  possibleSupplier?: string;
  productLink?: string;
  finalSupplierId?: string;
  unitBase?: number;
  unitIva?: number;
};
type RequisitionRow = {
  id: string;
  consecutive: string;
  type: "compra" | "pago";
  workId: string;
  requesterId?: string;
  externalRequester?: { name: string; phone?: string };
  channel: string;
  requiredDate: string;
  destination?: string;
  observations?: string;
  tagId?: string;
  approverId?: string;
  status: string;
  returnReason?: string;
  declineReason?: string;
  items: RequisitionItem[];
};
type OrderRow = {
  id: string;
  consecutive: string;
  type: "OC" | "OP";
  requisitionId: string;
  supplierId?: string;
  status: string;
};
type ExpenseRow = {
  id: string;
  workId: string;
  origin: string;
  referenceId: string;
  tagId?: string;
  date: string;
  total: number;
  period: string;
};
type AttachmentRow = {
  id: string;
  entity: "requisicion" | "requisicion_item" | "caja_menor";
  entityId: string;
  type: "soporte" | "cotizacion" | "foto";
  name: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt?: string;
};
type PettyRow = {
  id: string;
  workId: string;
  date: string;
  concept: string;
  tagId: string;
  amount: number;
};
type AuditRow = { event: string; at: string; data?: Record<string, unknown> };
type DetailBundle = {
  requisition: RequisitionRow;
  catalogs: CatalogData;
  orders: OrderRow[];
  expenses: ExpenseRow[];
  history: AuditRow[];
  attachments: AttachmentRow[];
};
type ExpenseBundle = {
  expenses: ExpenseRow[];
  catalogs: CatalogData;
  pettyCash: PettyRow[];
  pettyAttachments: Record<string, AttachmentRow[]>;
};

const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});
const emptyCatalogs: CatalogData = {
  works: [],
  tags: [],
  suppliers: [],
  items: [],
  features: {},
};

function routeKind(
  pathname: string,
):
  | "dashboard"
  | "new"
  | "detail"
  | "requisitions"
  | "orders"
  | "expenses"
  | "catalogs"
  | undefined {
  if (pathname === "/" || pathname === "/inicio") return "dashboard";
  if (pathname === "/requisiciones/nueva") return "new";
  if (pathname.startsWith("/aprobaciones/") && pathname !== "/aprobaciones/")
    return "detail";
  if (pathname.startsWith("/requisiciones/") && !pathname.endsWith("/mis"))
    return "detail";
  if (
    pathname.startsWith("/revision") ||
    pathname.startsWith("/aprobaciones") ||
    pathname.startsWith("/requisiciones/mis")
  )
    return "requisitions";
  if (pathname.startsWith("/ordenes")) return "orders";
  if (pathname.startsWith("/gastos") || pathname.startsWith("/reportes"))
    return "expenses";
  if (pathname.startsWith("/catalogos") || pathname.startsWith("/proveedores"))
    return "catalogs";
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  const value = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "Tu rol no tiene permiso para consultar estos datos."
        : response.status === 401
          ? "La sesión expiró. Vuelve a iniciar sesión."
          : value?.message || "No fue posible consultar el servicio.",
    );
  return value;
}

async function loadRoute(pathname: string, role: Role): Promise<unknown> {
  const kind = routeKind(pathname);
  if (kind === "dashboard")
    return readJson(
      `/api/dashboard?period=${new Date().toISOString().slice(0, 7)}`,
    );
  if (kind === "new") return readJson("/api/catalogs");
  if (kind === "detail") {
    const id = encodeURIComponent(pathname.split("/").pop() ?? "");
    const canReadOrders = [
      "Revisor",
      "Aprobador",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const canReadExpenses = [
      "Revisor",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const [requisition, catalogs, orders, expenses, history] =
      await Promise.all([
        readJson(`/api/requisitions/${id}`),
        readJson("/api/catalogs"),
        canReadOrders ? readJson("/api/orders") : Promise.resolve([]),
        canReadExpenses ? readJson("/api/expenses") : Promise.resolve([]),
        readJson(`/api/requisitions/${id}/history`),
      ]);
    const current = requisition as RequisitionRow,
      orderRows = orders as OrderRow[];
    const attachmentPayloads = await Promise.all([
      readJson(`/api/attachments/requisicion/${id}`),
      ...current.items.map((item) =>
        readJson(`/api/attachments/requisicion_item/${encodeURIComponent(item.id)}`),
      ),
    ]);
    const attachments = attachmentPayloads.flatMap((payload, index) => {
      const rows = payload as { attachments?: AttachmentRow[] };
      if (!Array.isArray(rows.attachments)) return [];
      const entity: AttachmentRow["entity"] =
        index === 0 ? "requisicion" : "requisicion_item";
      const entityId = index === 0 ? current.id : current.items[index - 1]?.id;
      return rows.attachments.map((attachment) => ({
        ...attachment,
        entity,
        entityId: entityId ?? "",
      }));
    });
    return {
      requisition: current,
      catalogs: catalogs as CatalogData,
      orders: orderRows.filter((row) => row.requisitionId === current.id),
      expenses: (expenses as ExpenseRow[]).filter(
        (row) =>
          row.referenceId === current.id ||
          orderRows.some(
            (order) =>
              order.requisitionId === current.id &&
              order.id === row.referenceId,
          ),
      ),
      history: history as AuditRow[],
      attachments,
    } satisfies DetailBundle;
  }
  if (kind === "requisitions") return readJson("/api/requisitions");
  if (kind === "orders") return readJson("/api/orders");
  if (kind === "expenses") {
    const canReadPettyCash = [
      "Revisor",
      "Contabilidad",
      "Administrador Sixteam",
    ].includes(role);
    const [expenses, catalogs, pettyCash] = await Promise.all([
      readJson("/api/expenses"),
      readJson("/api/catalogs"),
      canReadPettyCash ? readJson("/api/petty-cash") : Promise.resolve([]),
    ]);
    return {
      expenses: expenses as ExpenseRow[],
      catalogs: catalogs as CatalogData,
      pettyCash: pettyCash as PettyRow[],
      pettyAttachments: Object.fromEntries(
        await Promise.all(
          (pettyCash as PettyRow[]).map(async (row) => {
            const payload = (await readJson(
              `/api/attachments/caja_menor/${encodeURIComponent(row.id)}`,
            )) as { attachments?: AttachmentRow[] };
            return [
              row.id,
              Array.isArray(payload.attachments)
                ? payload.attachments.map((attachment) => ({
                    ...attachment,
                    entity: "caja_menor" as const,
                    entityId: row.id,
                  }))
                : [],
            ];
          }),
        ),
      ),
    } satisfies ExpenseBundle;
  }
  if (kind === "catalogs") return readJson("/api/catalogs/manage");
  throw new Error("Ruta operativa no soportada.");
}

async function mutate(
  url: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
): Promise<unknown> {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = (await response.json().catch(() => null)) as {
    message?: string;
  } | null;
  if (!response.ok)
    throw new Error(
      value?.message ||
        (response.status === 403
          ? "No tienes permiso para esta acción."
          : "La operación no pudo completarse."),
    );
  return value;
}

export function isConnectedReadRoute(pathname: string): boolean {
  return Boolean(routeKind(pathname));
}

export function ConnectedScreen({ pathname, role, go }: ConnectedProps) {
  const kind = useMemo(() => routeKind(pathname), [pathname]);
  const [version, setVersion] = useState(0),
    [load, setLoad] = useState<LoadState>({ state: "loading" });
  const refresh = () => {
    setLoad({ state: "loading" });
    setVersion((value) => value + 1);
  };
  useEffect(() => {
    let active = true;
    void loadRoute(pathname, role)
      .then((data) => {
        if (active) setLoad({ state: "ready", data });
      })
      .catch((error) => {
        if (active)
          setLoad({
            state: "error",
            message:
              error instanceof Error ? error.message : "Fallo de consulta.",
          });
      });
    return () => {
      active = false;
    };
  }, [pathname, role, version]);
  if (!kind) return null;
  if (load.state === "loading")
    return (
      <>
        <SectionTitle
          eyebrow="Sesión autenticada"
          title="Cargando operación"
          description="Consultando datos dentro del alcance de tu rol."
        />
        <div className="panel state-panel" role="status">
          <span className="state-spinner" />
          <h3>Conectando con el servicio</h3>
          <p>No se muestran datos sintéticos mientras esperas.</p>
        </div>
      </>
    );
  if (
    load.state === "error" &&
    kind === "catalogs" &&
    role === "Administrador Mizar"
  )
    return (
      <ConnectedCatalogAdmin
        pathname={pathname}
        role={role}
        initialData={emptyCatalogs}
      />
    );
  if (load.state === "error")
    return (
      <>
        <SectionTitle
          eyebrow="Sesión autenticada"
          title="Datos no disponibles"
          description={`Rol activo: ${role}`}
        />
        <div className="panel state-panel" role="alert">
          <span className="empty-icon">!</span>
          <h3>No pudimos cargar esta vista</h3>
          <p>{load.message}</p>
          <button
            className="button button-dark"
            type="button"
            onClick={refresh}
          >
            <RefreshCw size={15} /> Reintentar
          </button>
        </div>
      </>
    );
  if (kind === "dashboard") return <ConnectedDashboard data={load.data} />;
  if (kind === "new")
    return (
      <ConnectedNewRequisition catalogs={load.data as CatalogData} go={go} />
    );
  if (kind === "detail")
    return (
      <ConnectedRequisitionDetail
        data={load.data as DetailBundle}
        role={role}
        go={go}
        refresh={refresh}
      />
    );
  if (kind === "requisitions")
    return (
      <ConnectedRequisitions
        data={load.data as RequisitionRow[]}
        pathname={pathname}
        go={go}
      />
    );
  if (kind === "orders")
    return (
      <ConnectedOrders
        data={load.data as OrderRow[]}
        role={role}
        refresh={refresh}
      />
    );
  if (kind === "catalogs")
    return (
      <ConnectedCatalogAdmin
        pathname={pathname}
        role={role}
        initialData={load.data as CatalogData}
      />
    );
  return (
    <ConnectedExpenses
      data={load.data as ExpenseBundle}
      pathname={pathname}
      role={role}
      refresh={refresh}
    />
  );
}

function ConnectedDashboard({ data }: { data: unknown }) {
  const metrics = data as {
    byStatus?: Record<string, number>;
    inProcessValue?: number;
    periodExpense?: number;
    pendingOrders?: number;
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Pulso de compras"
        description="Métricas calculadas por el servicio para tu rol y el periodo actual."
      />
      <div className="stats-grid">
        <article className="stat-card">
          <span>En revisión</span>
          <strong>{metrics.byStatus?.en_revision ?? 0}</strong>
          <small>requisiciones visibles</small>
        </article>
        <article className="stat-card">
          <span>En aprobación</span>
          <strong>{metrics.byStatus?.en_aprobacion ?? 0}</strong>
          <small>{money.format(metrics.inProcessValue ?? 0)}</small>
        </article>
        <article className="stat-card">
          <span>Compras pendientes</span>
          <strong>{metrics.pendingOrders ?? 0}</strong>
          <small>generadas o no cumplidas</small>
        </article>
        <article className="stat-card">
          <span>Gasto del periodo</span>
          <strong>{money.format(metrics.periodExpense ?? 0)}</strong>
          <small>según alcance del rol</small>
        </article>
      </div>
      <div className="panel integration-evidence">
        <ShieldCheck size={18} />
        <div>
          <b>Sin cifras de demostración</b>
          <p>
            Esta vista solo renderiza la respuesta autenticada de
            `/api/dashboard`.
          </p>
        </div>
      </div>
    </>
  );
}

type DraftLine = {
  key: string;
  itemId: string;
  description: string;
  quantity: string;
  unit: string;
  possibleSupplier: string;
  productLink: string;
  photo: File | null;
};
const newLine = (): DraftLine => ({
  key: crypto.randomUUID(),
  itemId: "",
  description: "",
  quantity: "1",
  unit: "unidad",
  possibleSupplier: "",
  productLink: "",
  photo: null,
});

type AttachmentProgress = {
  completed: number;
  total: number;
  stage: "preparing" | "uploading" | "completing";
};

async function uploadOperationalAttachment({
  entity,
  entityId,
  type,
  file,
  onProgress,
}: {
  entity: "requisicion" | "requisicion_item" | "caja_menor";
  entityId: string;
  type: "soporte" | "foto";
  file: File;
  onProgress?: (stage: AttachmentProgress["stage"]) => void;
}) {
  const metadata: AttachmentMetadata = {
    type,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
  };
  return uploadSignedAttachment({
    prepareUrl: `/api/attachments/${entity}/${encodeURIComponent(entityId)}`,
    completeUrl: (attachmentId) =>
      `/api/attachments/${entity}/${encodeURIComponent(entityId)}/${encodeURIComponent(attachmentId)}/complete`,
    file,
    metadata,
    onProgress,
  });
}

export function ConnectedNewRequisition({
  catalogs = emptyCatalogs,
  go,
}: {
  catalogs: CatalogData;
  go: (path: string) => void;
}) {
  const [type, setType] = useState<"compra" | "pago">("compra"),
    [workId, setWorkId] = useState(catalogs.works[0]?.id ?? ""),
    [requiredDate, setRequiredDate] = useState(
      new Date().toISOString().slice(0, 10),
    );
  const [destination, setDestination] = useState(""),
    [observations, setObservations] = useState(""),
    [supportFile, setSupportFile] = useState<File | null>(null),
    [lines, setLines] = useState<DraftLine[]>([newLine()]),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [uploadProgress, setUploadProgress] = useState<AttachmentProgress | null>(null),
    [success, setSuccess] = useState(""),
    [createdId, setCreatedId] = useState("");
  const updateLine = (key: string, patch: Partial<DraftLine>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (createdId) {
      setFeedback("La requisición ya fue creada; consulta el detalle para gestionar los soportes pendientes.");
      return;
    }
    const invalidLine = lines.find(
      (line) =>
        (!line.itemId && !line.description.trim()) ||
        !line.unit.trim() ||
        !Number.isFinite(Number(line.quantity)) ||
        Number(line.quantity) <= 0 ||
        (line.productLink.trim() &&
          !/^https:\/\//i.test(line.productLink.trim())),
    );
    if (!workId || !requiredDate || invalidLine) {
      setFeedback(
        !workId || !requiredDate
          ? "Selecciona la obra y la fecha requerida."
          : "Completa cada ítem con descripción o catálogo, cantidad, unidad y un link HTTPS válido.",
      );
      return;
    }
    setBusy(true);
    setFeedback("");
    setSuccess("");
    let createdEntityId = "";
    try {
      const created = (await mutate("/api/requisitions", "POST", {
        type,
        workId,
        requiredDate,
        ...(destination.trim() ? { destination: destination.trim() } : {}),
        ...(observations.trim() ? { observations: observations.trim() } : {}),
        items: lines.map((line) => ({
          ...(line.itemId
            ? { itemId: line.itemId }
            : { description: line.description.trim() }),
          quantity: Number(line.quantity),
          unit: line.unit.trim(),
          ...(line.possibleSupplier.trim()
            ? { possibleSupplier: line.possibleSupplier.trim() }
            : {}),
          ...(line.productLink.trim()
            ? { productLink: line.productLink.trim() }
            : {}),
        })),
      })) as RequisitionRow;
      createdEntityId = created.id;
      setCreatedId(created.id);
      const uploads: Array<{
        entity: "requisicion" | "requisicion_item";
        entityId: string;
        type: "soporte" | "foto";
        file: File;
      }> = [];
      let pendingWithoutItemId = 0;
      if (supportFile) {
        uploads.push({
          entity: "requisicion",
          entityId: created.id,
          type: "soporte",
          file: supportFile,
        });
      }
      lines.forEach((line, index) => {
        const itemId = created.items?.[index]?.id;
        if (line.photo && itemId) {
          uploads.push({
            entity: "requisicion_item",
            entityId: itemId,
            type: "foto",
            file: line.photo,
          });
        } else if (line.photo) {
          pendingWithoutItemId += 1;
        }
      });
      if (!uploads.length) {
        if (pendingWithoutItemId) {
          setFeedback(
            `La requisición fue creada; ${pendingWithoutItemId} foto quedó pendiente porque el servicio no devolvió el ítem.`,
          );
          return;
        }
        setSuccess("Requisición creada correctamente.");
        go(`/requisiciones/${created.id}`);
        return;
      }
      setUploadProgress({ completed: 0, total: uploads.length, stage: "preparing" });
      for (const [index, upload] of uploads.entries()) {
        await uploadOperationalAttachment({
          ...upload,
          onProgress: (stage) =>
            setUploadProgress({ completed: index, total: uploads.length, stage }),
        });
        setUploadProgress({
          completed: index + 1,
          total: uploads.length,
          stage: "completing",
        });
      }
      if (pendingWithoutItemId) {
        setFeedback(
          `La requisición fue creada y ${uploads.length} soporte(s) cargaron; ${pendingWithoutItemId} foto(s) quedaron pendientes porque el servicio no devolvió el ítem.`,
        );
        return;
      }
      setSuccess(
        `Requisición creada y ${uploads.length === 1 ? "archivo cargado" : `${uploads.length} archivos cargados`} correctamente.`,
      );
    } catch (error) {
      setFeedback(
        createdEntityId
          ? `La requisición sí fue creada; el soporte quedó pendiente. ${
              error instanceof Error ? error.message : "No fue posible completar la carga."
            }`
          : error instanceof Error
            ? error.message
            : "No fue posible crear la requisición.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna conectada"
        title="Nueva requisición"
        description="Los datos se validan y guardan en una sola transacción; los ítems nuevos quedan pendientes de normalización."
      />
      <form className="panel connected-form" onSubmit={submit} noValidate>
        <div className="form-section">
          <div className="field-grid">
            <label className="field">
              <span>Tipo</span>
              <select
                value={type}
                onChange={(event) =>
                  setType(event.target.value as "compra" | "pago")
                }
              >
                <option value="compra">Compra</option>
                <option value="pago">Pago</option>
              </select>
            </label>
            <label className="field">
              <span>Obra</span>
              <select
                required
                value={workId}
                aria-invalid={Boolean(feedback && !workId)}
                onChange={(event) => setWorkId(event.target.value)}
              >
                <option value="">Selecciona una obra</option>
                {catalogs.works.map((work) => (
                  <option key={work.id} value={work.id}>
                    {work.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Fecha requerida</span>
              <input
                required
                type="date"
                value={requiredDate}
                onChange={(event) => setRequiredDate(event.target.value)}
              />
            </label>
            <label className="field">
              <span>Frente o actividad</span>
              <input
                maxLength={500}
                value={destination}
                onChange={(event) => setDestination(event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>Observaciones</span>
              <textarea
                maxLength={3000}
                value={observations}
                onChange={(event) => setObservations(event.target.value)}
              />
            </label>
            <AttachmentPicker
              id="requisition-support"
              label="Soporte general (opcional)"
              help="PDF, JPG, PNG o WebP · máximo 10 MB"
              file={supportFile}
              onFile={setSupportFile}
              onError={setFeedback}
              disabled={busy}
            />
          </div>
        </div>
        <div className="form-section">
          <div className="panel-head connected-head">
            <div>
              <h2>Ítems</h2>
              <p className="panel-sub">
                Selecciona catálogo o describe una propuesta nueva.
              </p>
            </div>
            <button
              className="button button-secondary"
              type="button"
              onClick={() => setLines((current) => [...current, newLine()])}
            >
              <Plus size={14} /> Agregar ítem
            </button>
          </div>
          <div className="connected-lines">
            {lines.map((line, index) => (
              <fieldset className="connected-line" key={line.key}>
                <legend>Ítem {index + 1}</legend>
                <label className="field">
                  <span>Catálogo</span>
                  <select
                    value={line.itemId}
                    onChange={(event) => {
                      const selected = catalogs.items.find(
                        (item) => item.id === event.target.value,
                      );
                      updateLine(line.key, {
                        itemId: event.target.value,
                        unit: selected?.unit ?? line.unit,
                        description: "",
                      });
                    }}
                  >
                    <option value="">Proponer nuevo</option>
                    {catalogs.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.status !== "activo" ? " · pendiente" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {!line.itemId && (
                  <label className="field">
                    <span>Descripción nueva</span>
                    <input
                      required
                      maxLength={500}
                      value={line.description}
                      aria-invalid={Boolean(
                        feedback && !line.description.trim(),
                      )}
                      onChange={(event) =>
                        updateLine(line.key, {
                          description: event.target.value,
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span>Cantidad</span>
                  <input
                    required
                    type="number"
                    min="0.001"
                    max="1000000"
                    step="0.001"
                    value={line.quantity}
                    aria-invalid={Boolean(
                      feedback &&
                        (!Number.isFinite(Number(line.quantity)) ||
                          Number(line.quantity) <= 0),
                    )}
                    onChange={(event) =>
                      updateLine(line.key, { quantity: event.target.value })
                    }
                  />
                </label>
                <AttachmentPicker
                  id={`requisition-item-photo-${line.key}`}
                  label="Foto del ítem (opcional)"
                  help="JPG, PNG o WebP · máximo 10 MB"
                  allowedMimeTypes={IMAGE_MIME_TYPES}
                  file={line.photo}
                  onFile={(photo) => updateLine(line.key, { photo })}
                  onError={setFeedback}
                  disabled={busy}
                />
                <label className="field">
                  <span>Unidad</span>
                  <input
                    required
                    maxLength={40}
                    value={line.unit}
                    aria-invalid={Boolean(feedback && !line.unit.trim())}
                    onChange={(event) =>
                      updateLine(line.key, { unit: event.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span>Proveedor sugerido</span>
                  <input
                    maxLength={240}
                    value={line.possibleSupplier}
                    onChange={(event) =>
                      updateLine(line.key, {
                        possibleSupplier: event.target.value,
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>Link HTTPS</span>
                  <input
                    type="url"
                    pattern="https://.*"
                    title="Usa una URL HTTPS o deja el campo vacío."
                    placeholder="https://"
                    value={line.productLink}
                    aria-invalid={Boolean(
                      feedback &&
                        line.productLink.trim() &&
                        !/^https:\/\//i.test(line.productLink.trim()),
                    )}
                    onChange={(event) =>
                      updateLine(line.key, { productLink: event.target.value })
                    }
                  />
                </label>
                <button
                  className="icon-button connected-remove"
                  type="button"
                  aria-label={`Quitar ítem ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() =>
                    setLines((current) =>
                      current.filter((item) => item.key !== line.key),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </fieldset>
            ))}
          </div>
        </div>
        <div className="form-footer">
          {feedback ? (
            <p className="field-error" role="alert">
              {feedback}
            </p>
          ) : success ? (
            <p className="field-success" role="status">
              {success} {uploadProgress && `(${uploadProgress.completed}/${uploadProgress.total})`}
            </p>
          ) : uploadProgress && busy ? (
            <p className="muted-copy" role="status">
              {uploadProgress.stage === "preparing"
                ? "Preparando soporte…"
                : uploadProgress.stage === "uploading"
                  ? "Cargando soporte…"
                  : "Confirmando soporte…"}{" "}
              ({uploadProgress.completed}/{uploadProgress.total})
            </p>
          ) : (
            <span>Los valores cotizados se completan durante la revisión.</span>
          )}
          {createdId && (
            <button
              className="button button-secondary"
              type="button"
              onClick={() => go(`/requisiciones/${createdId}`)}
            >
              Ver requisición <ArrowRight size={14} />
            </button>
          )}
          <button
            className="button button-dark"
            disabled={busy || Boolean(createdId) || !catalogs.works.length}
            type="submit"
          >
            {busy ? "Guardando…" : "Crear requisición"} <ArrowRight size={14} />
          </button>
        </div>
      </form>
    </>
  );
}

export function DemoRequisitionScreen() {
  const [supportFile, setSupportFile] = useState<File | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [feedback, setFeedback] = useState("");
  const save = () =>
    setFeedback(
      supportFile || photoFile
        ? "Borrador demo guardado; los archivos cumplen la validación de carga."
        : "Borrador demo guardado.",
    );
  return (
    <>
      <SectionTitle
        eyebrow="Captura interna"
        title="Nueva requisición"
        description="Adjunta un soporte general y una foto opcional por ítem. Esta pantalla demo no persiste datos."
      />
      <div className="panel connected-form">
        <div className="field-grid">
          <label className="field">
            <span>Obra</span>
            <select defaultValue="Torre Norte"><option>Torre Norte</option><option>Casa 18</option></select>
          </label>
          <label className="field">
            <span>Fecha requerida</span>
            <input type="date" defaultValue={new Date().toISOString().slice(0, 10)} />
          </label>
          <label className="field field-wide">
            <span>Observaciones</span>
            <textarea placeholder="Indica el frente o la necesidad…" />
          </label>
          <AttachmentPicker
            id="demo-requisition-support"
            label="Soporte general (opcional)"
            help="PDF, JPG, PNG o WebP · máximo 10 MB"
            file={supportFile}
            onFile={setSupportFile}
            onError={setFeedback}
          />
        </div>
        <fieldset className="connected-line">
          <legend>Ítem 1</legend>
          <label className="field"><span>Descripción</span><input defaultValue="Material de obra" /></label>
          <label className="field"><span>Cantidad</span><input type="number" min="1" defaultValue="1" /></label>
          <AttachmentPicker
            id="demo-requisition-item-photo"
            label="Foto del ítem (opcional)"
            help="JPG, PNG o WebP · máximo 10 MB"
            allowedMimeTypes={IMAGE_MIME_TYPES}
            file={photoFile}
            onFile={setPhotoFile}
            onError={setFeedback}
          />
        </fieldset>
        {feedback && <p className={feedback.includes("guardado") ? "field-success" : "field-error"} role={feedback.includes("guardado") ? "status" : "alert"}>{feedback}</p>}
        <div className="form-footer"><span className="muted-copy">Demo sin persistencia</span><button className="button button-dark" type="button" onClick={save}>Guardar borrador</button></div>
      </div>
    </>
  );
}

function ConnectedRequisitions({
  data,
  pathname,
  go,
}: {
  data: RequisitionRow[];
  pathname: string;
  go: (path: string) => void;
}) {
  const rows = Array.isArray(data)
    ? data.filter((row) =>
        pathname.startsWith("/revision")
          ? ["enviada", "en_revision", "devuelta"].includes(row.status)
          : pathname.startsWith("/aprobaciones")
            ? row.status === "en_aprobacion"
            : true,
      )
    : [];
  const title = pathname.startsWith("/revision")
    ? "Bandeja de revisión"
    : pathname.startsWith("/aprobaciones")
      ? "Mis aprobaciones"
      : "Mis requisiciones";
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title={title}
        description="La API aplica alcance por actor antes de devolver cada fila."
      />
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>{rows.length} visibles</h2>
            <p className="panel-sub">
              Sin datos sintéticos ni mezcla entre roles.
            </p>
          </div>
          <Tone tone="muted">Orden cronológico</Tone>
        </div>
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Requisición</th>
                  <th>Tipo</th>
                  <th>Canal</th>
                  <th>Fecha requerida</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-testid={
                      pathname.startsWith("/revision")
                        ? "active-requisition"
                        : undefined
                    }
                  >
                    <td>
                      <b>{row.consecutive}</b>
                    </td>
                    <td>{row.type}</td>
                    <td>{row.channel}</td>
                    <td>{row.requiredDate || "—"}</td>
                    <td>{row.status.replaceAll("_", " ")}</td>
                    <td>
                      <button
                        className="text-link"
                        type="button"
                        onClick={() => go(`/requisiciones/${row.id}`)}
                      >
                        Abrir <ArrowRight size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">—</span>
            <h3>Sin requisiciones en esta vista</h3>
            <p>El resultado proviene del backend autenticado.</p>
          </div>
        )}
      </section>
    </>
  );
}

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
    [lines, setLines] = useState<RequisitionItem[]>(requisition?.items ?? []),
    [supplierOptions, setSupplierOptions] = useState<NamedOption[]>(
      catalogs.suppliers,
    ),
    [comment, setComment] = useState(""),
    [multiSupplier, setMultiSupplier] = useState(false),
    [busy, setBusy] = useState(false),
    [feedback, setFeedback] = useState(""),
    [supplierStatus, setSupplierStatus] = useState(""),
    [quickSupplierItemId, setQuickSupplierItemId] = useState<string | null>(
      null,
    ),
    [quickSupplierName, setQuickSupplierName] = useState(""),
    [quickSupplierNit, setQuickSupplierNit] = useState(""),
    [quickSupplierError, setQuickSupplierError] = useState(""),
    [quickSupplierBusy, setQuickSupplierBusy] = useState(false);
  const quickSupplierNameRef = useRef<HTMLInputElement | null>(null),
    quickSupplierDialogRef = useRef<HTMLFormElement | null>(null),
    quickSupplierTriggerRef = useRef<HTMLButtonElement | null>(null),
    quickSupplierWasOpen = useRef(false),
    quickSupplierSubmitting = useRef(false);
  const run = async (body: Record<string, unknown>) => {
    setBusy(true);
    setFeedback("");
    try {
      await mutate(`/api/requisitions/${requisition.id}/actions`, "POST", body);
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
  const supplierGroups = [
      ...new Set(
        lines
          .map((item) => item.finalSupplierId)
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    multiSupplierEnabled = catalogs.features.ordenes_multi_proveedor === true;
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
                {catalogs.works.find((work) => work.id === requisition.workId)
                  ?.name ?? requisition.workId}
              </p>
            </div>
            <Tone tone="muted">
              <span data-testid="requisition-status">
                {requisition.status.replaceAll("_", " ")}
              </span>
            </Tone>
          </div>
          {isReviewer &&
          ["en_revision", "devuelta"].includes(requisition.status) ? (
            <div className="connected-review">
              <label className="field">
                <span>Etiqueta y ruta de aprobación</span>
                <select
                  required
                  value={tagId}
                  onChange={(event) => setTagId(event.target.value)}
                >
                  <option value="">Selecciona una etiqueta</option>
                  {catalogs.tags.map((tag) => (
                    <option key={tag.id} value={tag.id}>
                      {tag.name}
                    </option>
                  ))}
                </select>
              </label>
              {lines.map((line) => (
                <fieldset className="review-line" key={line.id}>
                  <legend>
                    {line.description ||
                      catalogs.items.find((item) => item.id === line.itemId)
                        ?.name ||
                      "Ítem"}
                  </legend>
                  <label className="field">
                    <span>Cantidad</span>
                    <input
                      type="number"
                      step="0.001"
                      min="0.001"
                      value={line.quantity}
                      onChange={(event) =>
                        updateLine(line.id, {
                          quantity: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Unidad</span>
                    <input
                      value={line.unit}
                      onChange={(event) =>
                        updateLine(line.id, { unit: event.target.value })
                      }
                    />
                  </label>
                  <div className="field supplier-assignment-field">
                    <label className="field-label" htmlFor={`supplier-${line.id}`}>
                      Proveedor final
                    </label>
                    <select
                      id={`supplier-${line.id}`}
                      value={line.finalSupplierId ?? ""}
                      onChange={(event) =>
                        updateLine(line.id, {
                          finalSupplierId: event.target.value || undefined,
                        })
                      }
                    >
                      <option value="">Por definir</option>
                      {supplierOptions.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button button-secondary quick-supplier-trigger"
                      type="button"
                      disabled={busy}
                      onClick={(event) =>
                        openQuickSupplier(line.id, event.currentTarget)
                      }
                      aria-label={`Crear proveedor para ${line.description || "este ítem"}`}
                    >
                      + Crear proveedor
                    </button>
                  </div>
                  <label className="field">
                    <span>Base unitaria COP</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={line.unitBase ?? 0}
                      onChange={(event) =>
                        updateLine(line.id, {
                          unitBase: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    <span>IVA unitario COP</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={line.unitIva ?? 0}
                      onChange={(event) =>
                        updateLine(line.id, {
                          unitIva: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <strong>
                    {money.format(
                      line.quantity *
                        ((line.unitBase ?? 0) + (line.unitIva ?? 0)),
                    )}
                  </strong>
                </fieldset>
              ))}
              {supplierStatus && (
                <p className="field-success" role="status">
                  {supplierStatus}
                </p>
              )}
              <div className="connected-actions">
                <button
                  className="button button-secondary"
                  disabled={busy || !tagId}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "review",
                      tagId,
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
                          unitIva,
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
                          unitIva: Math.round(unitIva ?? 0),
                        }),
                      ),
                    })
                  }
                >
                  Guardar revisión
                </button>
                <button
                  className="button button-dark"
                  disabled={busy || requisition.status === "devuelta" || !tagId}
                  type="button"
                  onClick={() => void run({ action: "send_for_approval" })}
                >
                  Enviar a aprobación
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
                    <th>IVA unit.</th>
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
                      <td>{money.format(item.unitIva ?? 0)}</td>
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
                <dd>{requisition.status.replaceAll("_", " ")}</dd>
              </div>
              <div>
                <dt>Destino</dt>
                <dd>{requisition.destination || "—"}</dd>
              </div>
              <div>
                <dt>Observaciones</dt>
                <dd>{requisition.observations || "—"}</dd>
              </div>
            </dl>
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
                  <button
                    className="button button-danger"
                    disabled={busy || !comment.trim()}
                    type="button"
                    onClick={() =>
                      void run({ action: "decline", reason: comment })
                    }
                  >
                    Declinar
                  </button>
                </>
              )}
            {isApprover && requisition.status === "en_aprobacion" && (
              <>
                {multiSupplierEnabled && (
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={multiSupplier}
                      onChange={(event) =>
                        setMultiSupplier(event.target.checked)
                      }
                    />{" "}
                    Dividir OC por proveedor (Completo)
                  </label>
                )}
                <button
                  className="button button-dark"
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run({
                      action: "approve",
                      multiSupplier: multiSupplierEnabled && multiSupplier,
                    })
                  }
                >
                  Aprobar y generar orden
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
                  Devolver a revisión
                </button>
              </>
            )}
            {feedback && (
              <p className="field-error" role="alert">
                {feedback}
              </p>
            )}
          </section>
          {supplierGroups.length > 0 && (
            <section className="panel connected-summary">
              <h3>Asignación por proveedor</h3>
              {supplierGroups.map((supplierId) => (
                <p key={supplierId} data-testid="supplier-allocation">
                  {supplierOptions.find(
                    (supplier) => supplier.id === supplierId,
                  )?.name ?? supplierId}
                </p>
              ))}
            </section>
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
          <section className="panel connected-summary">
            <h3>Soportes y fotos</h3>
            {attachments.length ? (
              <div className="attachment-list">
                {attachments.map((attachment) => (
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
            <h3>Historial de trazabilidad</h3>
            {history.length ? (
              history.map((entry, index) => (
                <p key={`${entry.at}-${index}`} data-testid="audit-event">
                  <b>{entry.event.replaceAll("_", " ")}</b> ·{" "}
                  {new Date(entry.at).toLocaleString("es-CO")}
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
                ×
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
    </>
  );
}

function ConnectedOrders({
  data,
  role,
  refresh,
}: {
  data: OrderRow[];
  role: Role;
  refresh: () => void;
}) {
  const rows = Array.isArray(data) ? data : [],
    [feedback, setFeedback] = useState(""),
    canUpdate = role === "Revisor" || role === "Administrador Sixteam";
  const setStatus = async (id: string, status: string) => {
    setFeedback("");
    try {
      await mutate(`/api/orders/${id}/status`, "PATCH", { status });
      refresh();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible actualizar la orden.",
      );
    }
  };
  return (
    <>
      <SectionTitle
        eyebrow="Datos conectados"
        title="Órdenes"
        description="OC y OP visibles según el rol autenticado; cada estado pertenece a su propia orden."
      />
      <section className="panel">
        {feedback && (
          <p className="field-error connected-feedback" role="alert">
            {feedback}
          </p>
        )}
        {rows.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Orden</th>
                  <th>Tipo</th>
                  <th>Requisición</th>
                  <th>Proveedor</th>
                  <th>Estado</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <b>{row.consecutive}</b>
                    </td>
                    <td>{row.type}</td>
                    <td>{row.requisitionId}</td>
                    <td>{row.supplierId || "Por definir"}</td>
                    <td>{row.status.replaceAll("_", " ")}</td>
                    <td>
                      {canUpdate && row.status === "generada" ? (
                        <select
                          aria-label={`Cumplimiento de ${row.consecutive}`}
                          defaultValue=""
                          onChange={(event) =>
                            event.target.value &&
                            void setStatus(row.id, event.target.value)
                          }
                        >
                          <option value="">Actualizar…</option>
                          <option value="cumplida">Cumplida</option>
                          <option value="no_cumplida">No cumplida</option>
                          <option value="no_necesario">No necesaria</option>
                        </select>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">
            <span className="empty-icon">—</span>
            <h3>Sin órdenes visibles</h3>
            <p>El servicio no devolvió órdenes para tu alcance.</p>
          </div>
        )}
      </section>
    </>
  );
}

export function ConnectedExpenses({
  data,
  pathname,
  role,
  refresh,
}: {
  data: ExpenseBundle;
  pathname: string;
  role: Role;
  refresh: () => void;
}) {
  const rows = Array.isArray(data.expenses) ? data.expenses : [],
    sourcePettyRows = Array.isArray(data.pettyCash) ? data.pettyCash : [],
    pettyAttachments = data.pettyAttachments ?? {},
    total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0),
    canCreate = role === "Revisor" || role === "Administrador Sixteam",
    canReadPettyCash = canCreate || role === "Contabilidad";
  const [workId, setWorkId] = useState(data.catalogs.works[0]?.id ?? ""),
    [tagId, setTagId] = useState(data.catalogs.tags[0]?.id ?? ""),
    [date, setDate] = useState(new Date().toISOString().slice(0, 10)),
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
  const pettyTotal = pettyRows.reduce(
    (sum, row) => sum + Number(row.amount || 0),
    0,
  );
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
        title={
          pathname.startsWith("/reportes")
            ? "Reporte operativo"
            : "Gastos por obra"
        }
        description="Lectura autorizada del libro común de gastos, incluidas las entradas de caja menor."
        action={
          pathname.startsWith("/reportes") &&
          [
            "Contabilidad",
            "Administrador Mizar",
            "Administrador Sixteam",
          ].includes(role) ? (
            <a
              className="button button-dark"
              href={`/api/reports/expenses?period=${new Date().toISOString().slice(0, 7)}`}
            >
              Descargar XLSX provisional
            </a>
          ) : undefined
        }
      />
      <div className="connected-detail-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>{money.format(total)}</h2>
              <p className="panel-sub">
                Total de las filas visibles para tu rol.
              </p>
            </div>
            <Tone tone="muted">{rows.length} movimientos</Tone>
          </div>
          {rows.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Obra</th>
                    <th>Origen</th>
                    <th>Periodo</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.date}</td>
                      <td>
                        {data.catalogs.works.find(
                          (work) => work.id === row.workId,
                        )?.name ?? row.workId}
                      </td>
                      <td>{row.origin.replaceAll("_", " ")}</td>
                      <td>{row.period}</td>
                      <td>{money.format(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty-state">
              <span className="empty-icon">—</span>
              <h3>Sin gastos visibles</h3>
              <p>El servicio no devolvió movimientos para tu alcance.</p>
            </div>
          )}
        </section>
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
            {pettyRows.length ? (
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
                    {pettyRows.map((row) => (
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
            ) : (
              <div className="empty-state">
                <span className="empty-icon">—</span>
                <h3>Sin movimientos de caja menor</h3>
                <p>
                  Los registros aparecerán aquí después de una captura
                  autorizada.
                </p>
              </div>
            )}
          </section>
        )}
        {canCreate && !pathname.startsWith("/reportes") && (
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
              <div className="attachment-error" role="alert">
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
