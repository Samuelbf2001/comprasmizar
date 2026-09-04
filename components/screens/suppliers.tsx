"use client";

import {
  Building2,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  Upload,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { suppliers as demoSuppliers, type Role } from "../../lib/demo-data";
import { SectionTitle, Tone } from "./screen-primitives";
import { apiRequest, describeApiError, friendlyErrorText, FriendlyApiError } from "../../lib/http/friendly-error";

type Contact = {
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
};

type BankDetails = {
  bankName?: string;
  accountType?: "ahorros" | "corriente";
  accountNumber?: string;
  accountHolder?: string;
  accountHolderNit?: string;
};

export type Supplier = {
  id: string;
  name: string;
  nit?: string | null;
  contact: Contact;
  active: boolean;
};

type SupplierAccess = {
  canManage: boolean;
  canReadBank: boolean;
};

type SupplierOrder = {
  id: string;
  consecutive: string;
  type: "OC" | "OP";
  status: "generada" | "cumplida" | "no_cumplida" | "no_necesario" | string;
  generatedAt: string;
  total: number;
};

type SupplierDocument = {
  id: string;
  type: "rut" | "camara_comercio" | "certificacion_bancaria" | "certificado_calidad";
  name: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png" | string;
  sizeBytes: number;
  uploadedAt: string;
};

type SupplierDetail = {
  supplier: Supplier & { bankDetails?: BankDetails };
  orders: SupplierOrder[];
  documents: SupplierDocument[];
  access?: SupplierAccess;
};

// Un documento elegido en el formulario de alta, antes de que exista el id del proveedor
// al que subirlo; se sube en lote justo después de crear el registro (ver submitSupplier).
type PendingDocument = { localId: string; type: SupplierDocument["type"]; file: File };

type FormState = {
  name: string;
  nit: string;
  contactName: string;
  phone: string;
  email: string;
  address: string;
  bankName: string;
  accountType: "" | "ahorros" | "corriente";
  accountNumber: string;
  accountHolder: string;
  accountHolderNit: string;
  active: boolean;
};

const DOCUMENT_LABELS: Record<SupplierDocument["type"], string> = {
  rut: "RUT",
  camara_comercio: "Cámara de Comercio",
  certificacion_bancaria: "Certificación bancaria",
  certificado_calidad: "Certificado de calidad",
};

const emptyForm: FormState = {
  name: "",
  nit: "",
  contactName: "",
  phone: "",
  email: "",
  address: "",
  bankName: "",
  accountType: "",
  accountNumber: "",
  accountHolder: "",
  accountHolderNit: "",
  active: true,
};

const demoIds = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
];

const demoRows: Supplier[] = demoSuppliers.map((supplier, index) => ({
  id: demoIds[index] ?? `10000000-0000-4000-8000-00000000000${index + 1}`,
  name: supplier.name,
  nit: supplier.nit,
  contact: { name: supplier.contact, phone: supplier.phone },
  active: supplier.state === "Activo",
}));

const demoDetail = (supplier: Supplier): SupplierDetail => ({
  supplier: {
    ...supplier,
    bankDetails: {
      bankName: "Bancolombia",
      accountType: "corriente",
      accountNumber: "•••• 4812",
      accountHolder: supplier.name,
    },
  },
  orders: [
    {
      id: `${supplier.id}-order`,
      consecutive: supplier.name.includes("Arenera") ? "OC-2026-0097" : "OC-2026-0098",
      type: "OC",
      status: supplier.active ? "cumplida" : "no_cumplida",
      generatedAt: "2026-08-23T14:00:00.000Z",
      total: supplier.name.includes("Cementos") ? 3200000 : 960000,
    },
  ],
  documents: supplier.active
    ? [
        {
          id: `${supplier.id}-rut`,
          type: "rut",
          name: "rut-proveedor.pdf",
          mimeType: "application/pdf",
          sizeBytes: 248000,
          uploadedAt: "2026-08-21T10:00:00.000Z",
        },
      ]
    : [],
});

const money = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0,
});

function compactDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat("es-CO", { dateStyle: "medium" }).format(date);
}

function humanDocumentType(type: SupplierDocument["type"]) {
  return DOCUMENT_LABELS[type] ?? type.replaceAll("_", " ");
}

function formFromSupplier(supplier: Supplier & { bankDetails?: BankDetails }): FormState {
  return {
    name: supplier.name,
    nit: supplier.nit ?? "",
    contactName: supplier.contact?.name ?? "",
    phone: supplier.contact?.phone ?? "",
    email: supplier.contact?.email ?? "",
    address: supplier.contact?.address ?? "",
    bankName: supplier.bankDetails?.bankName ?? "",
    accountType: supplier.bankDetails?.accountType ?? "",
    accountNumber: supplier.bankDetails?.accountNumber ?? "",
    accountHolder: supplier.bankDetails?.accountHolder ?? "",
    accountHolderNit: supplier.bankDetails?.accountHolderNit ?? "",
    active: supplier.active,
  };
}

function optional(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toPayload(form: FormState, patch = false) {
  const contact: Contact = {};
  const bankDetails: BankDetails = {};
  if (optional(form.contactName)) contact.name = form.contactName.trim();
  if (optional(form.phone)) contact.phone = form.phone.trim();
  if (optional(form.email)) contact.email = form.email.trim();
  if (optional(form.address)) contact.address = form.address.trim();
  if (optional(form.bankName)) bankDetails.bankName = form.bankName.trim();
  if (form.accountType) bankDetails.accountType = form.accountType;
  if (optional(form.accountNumber)) bankDetails.accountNumber = form.accountNumber.trim();
  if (optional(form.accountHolder)) bankDetails.accountHolder = form.accountHolder.trim();
  if (optional(form.accountHolderNit)) bankDetails.accountHolderNit = form.accountHolderNit.trim();
  return {
    name: form.name.trim(),
    // PATCH intentionally sends null/{} for cleared optional values. The
    // service treats nested objects as replacement values, so omitting them
    // would leave stale contact or bank data behind.
    nit: optional(form.nit) ?? (patch ? null : undefined),
    contact: Object.keys(contact).length ? contact : (patch ? {} : undefined),
    bankDetails: Object.keys(bankDetails).length ? bankDetails : (patch ? {} : undefined),
    active: form.active,
  };
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function validateDocumentFile(file: File): string {
  if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type)) {
    return "El archivo debe ser PDF, JPG o PNG.";
  }
  if (file.size < 1 || file.size > 10 * 1024 * 1024) {
    return "El archivo debe pesar como máximo 10 MB.";
  }
  return "";
}

type DocumentMetadata = { type: SupplierDocument["type"]; name: string; mimeType: string; sizeBytes: number };

// Único punto que habla con /api/suppliers/:id/documents: lo usa tanto el adjunto inmediato
// (ficha ya guardada) como el lote posterior a crear un proveedor nuevo (submitSupplier).
async function uploadOneDocument(supplierId: string, file: File, metadata: DocumentMetadata) {
  const prepare = await fetch(`/api/suppliers/${encodeURIComponent(supplierId)}/documents`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) });
  const preparedValue = await prepare.json().catch(() => null) as ({ document?: SupplierDocument; upload?: { url: string; method: "PUT"; multipart: { cacheControl: string; fileField: string } } } & { message?: string }) | null;
  if (!prepare.ok) throw new FriendlyApiError(describeApiError(prepare.status, preparedValue));
  if (!preparedValue?.document || !preparedValue.upload?.multipart) throw new Error("No fue posible preparar la carga del documento. Intenta de nuevo.");
  const uploadBody = new FormData();
  uploadBody.append("cacheControl", preparedValue.upload.multipart.cacheControl);
  uploadBody.append(preparedValue.upload.multipart.fileField, file);
  const upload = await fetch(preparedValue.upload.url, { method: preparedValue.upload.method, body: uploadBody });
  if (!upload.ok) throw new Error("La carga al almacenamiento privado falló. Verifica tu conexión e intenta nuevamente.");
  const complete = await fetch(`/api/suppliers/${encodeURIComponent(supplierId)}/documents/${encodeURIComponent(preparedValue.document.id)}/complete`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata) });
  const completeValue = await complete.json().catch(() => null);
  if (!complete.ok) throw new FriendlyApiError(describeApiError(complete.status, completeValue));
}

function directorySupplier(value: Supplier & { bankDetails?: unknown }): Supplier {
  const safe = { ...value } as Supplier & { bankDetails?: unknown };
  delete safe.bankDetails;
  return safe;
}

function ErrorMessage({ children }: { children: React.ReactNode }) {
  return <p className="field-error supplier-feedback" role="alert">{children}</p>;
}

export function SuppliersScreen({ role: _role, demoMode }: { role: Role; demoMode: boolean }) {
  // Production capabilities come from the API. Demo provides an equivalent
  // fixture so its role switch still demonstrates read-only and gated states.
  const demoAccess: SupplierAccess = demoMode
    ? { canManage: _role !== "Contabilidad" && _role !== "Administrador Mizar", canReadBank: _role !== "Administrador Mizar" }
    : { canManage: false, canReadBank: false };
  const [access, setAccess] = useState<SupplierAccess>(
    demoAccess,
  );
  const capabilities = demoMode ? demoAccess : access;
  const canWrite = capabilities.canManage;
  const [rows, setRows] = useState<Supplier[]>(demoMode ? demoRows : []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupplierDetail | null>(null);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const [loading, setLoading] = useState(!demoMode);
  const [detailLoading, setDetailLoading] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [editor, setEditor] = useState<"create" | "edit" | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [documentType, setDocumentType] = useState<SupplierDocument["type"]>("rut");
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([]);
  const editorRef = useRef<HTMLFormElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const detailRef = useRef<HTMLElement>(null);
  const previousDetailFocus = useRef<HTMLElement | null>(null);

  const closeEditor = () => {
    setEditor(null);
    setPendingDocuments([]);
  };

  const loadRows = async () => {
    if (demoMode) {
      setRows(demoRows);
      setAccess(demoAccess);
      return;
    }
    setLoading(true);
    setFeedback("");
    setStatusMessage("");
    try {
      const value = await apiRequest<{ suppliers?: unknown; access?: unknown }>("/api/suppliers", { cache: "no-store" });
      const next = value && typeof value === "object" && Array.isArray(value.suppliers) ? value.suppliers : [];
      const capabilities = value && typeof value === "object" && value.access && typeof value.access === "object" ? value.access as Partial<SupplierAccess> : undefined;
      if (capabilities) setAccess({ canManage: capabilities.canManage === true, canReadBank: capabilities.canReadBank === true });
      setRows((next as Supplier[]).map(directorySupplier));
      setStatusMessage("Directorio actualizado.");
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible cargar los proveedores."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (demoMode) return;
    let active = true;
    void apiRequest<{ suppliers?: unknown; access?: unknown }>("/api/suppliers", { cache: "no-store" })
      .then((value) => {
        if (!active) return;
        const next = value && typeof value === "object" && Array.isArray(value.suppliers) ? value.suppliers : [];
        const capabilities = value && typeof value === "object" && value.access && typeof value.access === "object" ? value.access as Partial<SupplierAccess> : undefined;
        if (capabilities) setAccess({ canManage: capabilities.canManage === true, canReadBank: capabilities.canReadBank === true });
        setRows((next as Supplier[]).map(directorySupplier));
      })
      .catch((error) => {
        if (active) setFeedback(friendlyErrorText(error, "No fue posible cargar los proveedores."));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [demoMode]);

  useEffect(() => {
    if (!editor) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstControl = editorRef.current?.querySelector<HTMLElement>("input, select, button, textarea");
    firstControl?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeEditor();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
      previousFocus.current = null;
    };
  }, [editor]);

  useEffect(() => {
    if (!selectedId || editor) return;
    previousDetailFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const firstControl = detailRef.current?.querySelector<HTMLElement>("button, a, input, select");
    firstControl?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousDetailFocus.current?.focus();
      previousDetailFocus.current = null;
    };
  }, [editor, selectedId]);

  const filteredRows = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("es");
    return rows.filter((row) => {
      const matchesQuery = !normalized || row.name.toLocaleLowerCase("es").includes(normalized) || (row.nit ?? "").toLocaleLowerCase("es").includes(normalized) || (row.contact?.name ?? "").toLocaleLowerCase("es").includes(normalized);
      const matchesStatus = activeFilter === "all" || (activeFilter === "active" ? row.active : !row.active);
      return matchesQuery && matchesStatus;
    });
  }, [activeFilter, query, rows]);

  const activeCount = rows.filter((row) => row.active).length;
  const inactiveCount = rows.length - activeCount;

  const openDetail = async (id: string) => {
    setSelectedId(id);
    setFeedback("");
    setStatusMessage("");
    if (demoMode) {
      const supplier = rows.find((row) => row.id === id);
      setDetail(supplier ? demoDetail(supplier) : null);
      return;
    }
    setDetailLoading(true);
    setDetail(null);
    try {
      const value = await apiRequest<Record<string, unknown>>(`/api/suppliers/${encodeURIComponent(id)}`, { cache: "no-store" });
      setDetail(value as SupplierDetail);
      const capabilities = value && typeof value === "object" && value.access && typeof value.access === "object" ? value.access as Partial<SupplierAccess> : undefined;
      if (capabilities) setAccess({ canManage: capabilities.canManage === true, canReadBank: capabilities.canReadBank === true });
      setStatusMessage("Ficha cargada.");
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible cargar la ficha del proveedor."));
    } finally {
      setDetailLoading(false);
    }
  };

  const openCreate = () => {
    setFeedback("");
    setForm(emptyForm);
    setPendingDocuments([]);
    setEditor("create");
  };

  const openEdit = () => {
    if (!detail) return;
    setFeedback("");
    setForm(formFromSupplier(detail.supplier));
    setPendingDocuments([]);
    setEditor("edit");
  };

  const submitSupplier = async (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setFeedback("La razón social es obligatoria.");
      return;
    }
    setSaving(true);
    setFeedback("");
    const editing = editor === "edit" && detail;
    // Los documentos elegidos en el formulario solo pueden subirse una vez exista el id del
    // proveedor, así que en edición no aplica: esa ficha ya tiene su propio adjunto inmediato.
    const documentsToUpload = editing ? [] : pendingDocuments;
    try {
      const failedDocuments: string[] = [];
      if (demoMode) {
        const next = {
          id: editing ? detail.supplier.id : crypto.randomUUID(),
          name: form.name.trim(),
          nit: optional(form.nit),
          contact: toPayload(form).contact ?? {},
          active: form.active,
        } satisfies Supplier;
        setRows((current) => editing ? current.map((row) => row.id === next.id ? next : row) : [next, ...current]);
        if (editing) {
          setDetail((current) => current ? { ...current, supplier: { ...next, bankDetails: toPayload(form).bankDetails } } : current);
        } else if (documentsToUpload.length) {
          const documents: SupplierDocument[] = documentsToUpload.map((pending) => ({
            id: crypto.randomUUID(),
            type: pending.type,
            name: pending.file.name,
            mimeType: pending.file.type,
            sizeBytes: pending.file.size,
            uploadedAt: new Date().toISOString(),
          }));
          setDetail({ ...demoDetail(next), documents });
          setSelectedId(next.id);
        }
      } else {
        const url = editing ? `/api/suppliers/${encodeURIComponent(detail.supplier.id)}` : "/api/suppliers";
        const value = await apiRequest(url, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(toPayload(form, Boolean(editing))) });
        const saved = directorySupplier(value as Supplier & { bankDetails?: unknown });
        setRows((current) => editing ? current.map((row) => row.id === saved.id ? saved : row) : [saved, ...current]);
        if (editing) {
          await openDetail(saved.id);
        } else if (documentsToUpload.length) {
          for (const pending of documentsToUpload) {
            const metadata = { type: pending.type, name: pending.file.name, mimeType: pending.file.type, sizeBytes: pending.file.size };
            try {
              await uploadOneDocument(saved.id, pending.file, metadata);
            } catch {
              failedDocuments.push(pending.file.name);
            }
          }
          await openDetail(saved.id);
        }
      }
      setEditor(null);
      setPendingDocuments([]);
      setStatusMessage(editor === "create" ? "Proveedor creado correctamente." : "Proveedor actualizado correctamente.");
      if (failedDocuments.length) {
        setFeedback(`El proveedor se guardó, pero no fue posible adjuntar: ${failedDocuments.join(", ")}. Ábrelo desde el listado para reintentar.`);
      }
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible guardar el proveedor."));
    } finally {
      setSaving(false);
    }
  };

  const uploadDocument = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !detail || !canWrite) return;
    const validationError = validateDocumentFile(file);
    if (validationError) {
      setFeedback(validationError);
      return;
    }
    const metadata = { type: documentType, name: file.name, mimeType: file.type, sizeBytes: file.size };
    setUploading(true);
    setFeedback("");
    try {
      if (demoMode) {
        const document: SupplierDocument = { id: crypto.randomUUID(), ...metadata, uploadedAt: new Date().toISOString() };
        setDetail((current) => current ? { ...current, documents: [document, ...current.documents] } : current);
      } else {
        await uploadOneDocument(detail.supplier.id, file, metadata);
        await openDetail(detail.supplier.id);
        setStatusMessage("Documento adjuntado correctamente.");
      }
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible cargar el documento."));
    } finally {
      setUploading(false);
    }
  };

  // Adjunta al formulario de alta (aún sin id de proveedor): valida y guarda el archivo en
  // memoria; la subida real ocurre en submitSupplier una vez creado el registro.
  const stagePendingDocument = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const validationError = validateDocumentFile(file);
    if (validationError) {
      setFeedback(validationError);
      return;
    }
    setFeedback("");
    setPendingDocuments((current) => [...current, { localId: crypto.randomUUID(), type: documentType, file }]);
  };

  const removePendingDocument = (localId: string) => {
    setPendingDocuments((current) => current.filter((pending) => pending.localId !== localId));
  };

  // Compartida entre la ficha de detalle y el formulario de edición (ver editor === "edit"
  // más abajo): misma lista, mismo control de carga inmediata contra un proveedor ya guardado.
  const documentsSection = (activeDetail: SupplierDetail) => (
    <section className="supplier-section">
      <div className="supplier-section-head">
        <div>
          <h3>Documentos</h3>
          <p>{activeDetail.documents.length} soporte{activeDetail.documents.length === 1 ? "" : "s"} disponible{activeDetail.documents.length === 1 ? "" : "s"} en almacenamiento privado.</p>
        </div>
        <FileText aria-hidden="true" size={17} />
      </div>
      {activeDetail.documents.length ? (
        <ul className="supplier-documents">
          {activeDetail.documents.map((doc) => (
            <li key={doc.id}>
              <span className="supplier-file-icon"><FileText aria-hidden="true" size={16} /></span>
              <span><b>{humanDocumentType(doc.type)}</b><small>{doc.name} · {formatBytes(doc.sizeBytes)} · {compactDate(doc.uploadedAt)}</small></span>
              <a className="text-link" href={`/api/suppliers/${encodeURIComponent(activeDetail.supplier.id)}/documents/${encodeURIComponent(doc.id)}/download`} target="_blank" rel="noreferrer">Descargar</a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="supplier-muted">Aún no hay documentos adjuntos.</p>
      )}
      {canWrite && (
        <div className="supplier-upload">
          <label className="field">
            <span>Tipo de documento</span>
            <select value={documentType} onChange={(event) => setDocumentType(event.target.value as SupplierDocument["type"])}>
              <option value="rut">RUT</option>
              <option value="camara_comercio">Cámara de Comercio</option>
              <option value="certificacion_bancaria">Certificación bancaria</option>
              <option value="certificado_calidad">Certificado de calidad</option>
            </select>
          </label>
          <label className={`button button-secondary supplier-upload-button ${uploading ? "is-busy" : ""}`}>
            <Upload aria-hidden="true" size={15} /> {uploading ? "Cargando…" : "Adjuntar soporte"}
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(event) => void uploadDocument(event)} disabled={uploading} />
          </label>
        </div>
      )}
    </section>
  );

  // Mismo layout que documentsSection, pero sobre pendingDocuments: nada se sube todavía
  // (no hay id de proveedor), así que "Descargar" se reemplaza por "Quitar".
  const pendingDocumentsSection = (
    <section className="supplier-section">
      <div className="supplier-section-head">
        <div>
          <h3>Documentos</h3>
          <p>Se cargan al guardar el proveedor.</p>
        </div>
        <FileText aria-hidden="true" size={17} />
      </div>
      {pendingDocuments.length ? (
        <ul className="supplier-documents">
          {pendingDocuments.map((pending) => (
            <li key={pending.localId}>
              <span className="supplier-file-icon"><FileText aria-hidden="true" size={16} /></span>
              <span><b>{humanDocumentType(pending.type)}</b><small>{pending.file.name} · {formatBytes(pending.file.size)}</small></span>
              <button className="attachment-remove" type="button" onClick={() => removePendingDocument(pending.localId)}><X aria-hidden="true" size={13} /> Quitar</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="supplier-muted">Aún no hay documentos para adjuntar.</p>
      )}
      <div className="supplier-upload">
        <label className="field">
          <span>Tipo de documento</span>
          <select value={documentType} onChange={(event) => setDocumentType(event.target.value as SupplierDocument["type"])}>
            <option value="rut">RUT</option>
            <option value="camara_comercio">Cámara de Comercio</option>
            <option value="certificacion_bancaria">Certificación bancaria</option>
            <option value="certificado_calidad">Certificado de calidad</option>
          </select>
        </label>
        <label className="button button-secondary supplier-upload-button">
          <Upload aria-hidden="true" size={15} /> Adjuntar documento
          <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={stagePendingDocument} />
        </label>
      </div>
    </section>
  );

  return (
    <>
      <SectionTitle
        eyebrow="Catálogo de compras"
        title="Proveedores"
        description="Una ficha confiable para compras, documentos y contabilidad."
        action={
          <div className="title-actions">
            <button className="button button-secondary" type="button" onClick={() => void loadRows()} disabled={loading}>
              <RefreshCw aria-hidden="true" size={15} /> Actualizar
            </button>
            {canWrite && <button className="button button-dark" type="button" onClick={openCreate}><Plus aria-hidden="true" size={15} /> Nuevo proveedor</button>}
          </div>
        }
      />
      <div className="supplier-stats" aria-label="Resumen de proveedores">
        <div><span>Total</span><strong>{rows.length}</strong><small>registros visibles</small></div>
        <div><span>Activos</span><strong>{activeCount}</strong><small>disponibles para compras</small></div>
        <div><span>Inactivos</span><strong>{inactiveCount}</strong><small>conservados para historial</small></div>
      </div>
      {feedback && !selectedId && <ErrorMessage>{feedback}</ErrorMessage>}
      {statusMessage && !selectedId && <p className="supplier-success" role="status">{statusMessage}</p>}
      <section className="panel supplier-list-panel">
        <div className="panel-head supplier-toolbar">
          <div><h2>Directorio</h2><p className="panel-sub">El listado nunca expone datos bancarios.</p></div>
          <div className="supplier-filters">
            <label className="supplier-search"><Search aria-hidden="true" size={15} /><span className="sr-only">Buscar proveedores</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, NIT o contacto" /></label>
            <label className="sr-only" htmlFor="supplier-status">Filtrar proveedores</label>
            <select id="supplier-status" value={activeFilter} onChange={(event) => setActiveFilter(event.target.value as typeof activeFilter)}>
              <option value="all">Todos los estados</option><option value="active">Activos</option><option value="inactive">Inactivos</option>
            </select>
          </div>
        </div>
        {loading ? <div className="state-panel" role="status"><Loader2 aria-hidden="true" className="state-spinner" size={26} /><h3>Cargando proveedores</h3><p>Consultando el catálogo según tu rol.</p></div> : filteredRows.length ? (
          <div className="table-wrap supplier-table-wrap"><table><caption className="sr-only">Listado de proveedores</caption><thead><tr><th>Proveedor</th><th>NIT</th><th>Contacto</th><th>Estado</th><th className="align-right">Ficha</th></tr></thead><tbody>{filteredRows.map((row) => <tr key={row.id}><td><div className="supplier-name"><span className="supplier-avatar"><Building2 aria-hidden="true" size={16} /></span><span><b>{row.name}</b><small>{row.contact?.email || row.contact?.phone || "Sin contacto adicional"}</small></span></div></td><td>{row.nit || "—"}</td><td>{row.contact?.name || "Sin registrar"}</td><td><Tone tone={row.active ? "success" : "muted"} dot>{row.active ? "Activo" : "Inactivo"}</Tone></td><td className="align-right"><button className="icon-button supplier-open" type="button" aria-label={`Abrir ficha de ${row.name}`} onClick={() => void openDetail(row.id)}><ChevronRight aria-hidden="true" size={16} /></button></td></tr>)}</tbody></table></div>
        ) : <div className="empty-state supplier-empty"><span className="empty-icon"><Building2 aria-hidden="true" size={20} /></span><h3>No hay proveedores para este filtro</h3><p>Prueba con otro nombre o estado.</p></div>}
      </section>

      {selectedId && !editor && <div className="supplier-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedId(null); }}><aside ref={detailRef} className="supplier-drawer" role="dialog" aria-modal="true" aria-labelledby="supplier-detail-title"><div className="supplier-drawer-head"><div><div className="eyebrow">Ficha de proveedor</div><h2 id="supplier-detail-title">{detail?.supplier.name || "Cargando ficha"}</h2></div><button className="icon-button" type="button" aria-label="Cerrar ficha" onClick={() => setSelectedId(null)}><X aria-hidden="true" size={18} /></button></div>{detailLoading ? <div className="state-panel" role="status"><Loader2 aria-hidden="true" className="state-spinner" size={26} /><h3>Cargando ficha</h3><p>Consultando órdenes y documentos.</p></div> : detail ? <div className="supplier-drawer-body">{feedback && <ErrorMessage>{feedback}</ErrorMessage>}{statusMessage && <p className="supplier-success" role="status">{statusMessage}</p>}<div className="supplier-detail-actions">{detail.supplier.active ? <Tone tone="success" dot>Activo</Tone> : <Tone tone="muted" dot>Inactivo</Tone>}{canWrite && <button className="button button-secondary" type="button" onClick={openEdit}><Pencil aria-hidden="true" size={14} /> Editar</button>}</div><section className="supplier-info-grid"><div><span>Razón social</span><b>{detail.supplier.name}</b></div><div><span>NIT</span><b>{detail.supplier.nit || "No registrado"}</b></div><div><span>Contacto</span><b>{detail.supplier.contact?.name || "No registrado"}</b></div><div><span>Teléfono</span><b>{detail.supplier.contact?.phone || "No registrado"}</b></div><div><span>Correo</span><b>{detail.supplier.contact?.email || "No registrado"}</b></div><div><span>Dirección</span><b>{detail.supplier.contact?.address || "No registrada"}</b></div></section><section className="supplier-section"><div className="supplier-section-head"><div><h3>Datos bancarios</h3><p>Visible solo para roles autorizados; nunca aparece en el directorio.</p></div><ShieldCheck aria-hidden="true" size={17} /></div>{capabilities.canReadBank && detail.supplier.bankDetails && Object.values(detail.supplier.bankDetails).some(Boolean) ? <dl className="supplier-bank-grid">{detail.supplier.bankDetails.bankName && <div><dt>Banco</dt><dd>{detail.supplier.bankDetails.bankName}</dd></div>}{detail.supplier.bankDetails.accountType && <div><dt>Tipo de cuenta</dt><dd>{detail.supplier.bankDetails.accountType}</dd></div>}{detail.supplier.bankDetails.accountNumber && <div><dt>Número de cuenta</dt><dd>{detail.supplier.bankDetails.accountNumber}</dd></div>}{detail.supplier.bankDetails.accountHolder && <div><dt>Titular</dt><dd>{detail.supplier.bankDetails.accountHolder}</dd></div>}{detail.supplier.bankDetails.accountHolderNit && <div><dt>NIT titular</dt><dd>{detail.supplier.bankDetails.accountHolderNit}</dd></div>}</dl> : <p className="supplier-muted">Datos bancarios no disponibles para tu alcance.</p>}</section>{documentsSection(detail)}<section className="supplier-section"><div className="supplier-section-head"><div><h3>Historial de órdenes</h3><p>Órdenes generadas para este proveedor.</p></div><Check aria-hidden="true" size={17} /></div>{detail.orders.length ? <><div className="supplier-order-total"><span>Total comprado</span><b>{money.format(detail.orders.reduce((sum, order) => sum + order.total, 0))}</b></div><div className="table-wrap supplier-orders-table"><table><thead><tr><th>Orden</th><th>Fecha</th><th>Estado</th><th className="align-right">Total</th></tr></thead><tbody>{detail.orders.map((order) => <tr key={order.id}><td><b>{order.consecutive}</b><small>{order.type}</small></td><td>{compactDate(order.generatedAt)}</td><td><Tone tone={order.status === "cumplida" ? "success" : order.status === "no_cumplida" ? "danger" : "warning"}>{order.status.replaceAll("_", " ")}</Tone></td><td className="align-right money">{money.format(order.total)}</td></tr>)}</tbody></table></div></> : <p className="supplier-muted">No hay órdenes asociadas.</p>}</section></div> : <div className="empty-state"><span className="empty-icon"><TriangleAlert aria-hidden="true" size={21} /></span><h3>No fue posible cargar la ficha</h3><p>{feedback || "Cierra esta vista e inténtalo de nuevo."}</p></div>}</aside></div>}

      {editor && <div className="supplier-overlay" role="presentation"><form ref={editorRef} className="supplier-editor" role="dialog" aria-modal="true" aria-labelledby="supplier-editor-title" onSubmit={submitSupplier}><div className="supplier-drawer-head"><div><div className="eyebrow">{editor === "create" ? "Alta de catálogo" : "Edición de catálogo"}</div><h2 id="supplier-editor-title">{editor === "create" ? "Nuevo proveedor" : "Editar proveedor"}</h2></div><button className="icon-button" type="button" aria-label="Cerrar formulario" onClick={closeEditor}><X aria-hidden="true" size={18} /></button></div><div className="supplier-editor-body"><div className="field-grid"><label className="field field-wide"><span>Razón social *</span><input required maxLength={160} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label><label className="field"><span>NIT</span><input maxLength={32} value={form.nit} onChange={(event) => setForm({ ...form, nit: event.target.value })} /></label><label className="field"><span>Nombre de contacto</span><input maxLength={160} value={form.contactName} onChange={(event) => setForm({ ...form, contactName: event.target.value })} /></label><label className="field"><span>Teléfono</span><input type="tel" maxLength={20} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label><label className="field"><span>Correo</span><input type="email" maxLength={254} value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label><label className="field field-wide"><span>Dirección</span><input maxLength={300} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></label></div><fieldset className="supplier-bank-form"><legend>Datos bancarios <small>Opcional</small></legend><div className="field-grid"><label className="field"><span>Banco</span><input maxLength={120} value={form.bankName} onChange={(event) => setForm({ ...form, bankName: event.target.value })} /></label><label className="field"><span>Tipo de cuenta</span><select value={form.accountType} onChange={(event) => setForm({ ...form, accountType: event.target.value as FormState["accountType"] })}><option value="">Selecciona…</option><option value="ahorros">Ahorros</option><option value="corriente">Corriente</option></select></label><label className="field"><span>Número de cuenta</span><input inputMode="numeric" maxLength={40} value={form.accountNumber} onChange={(event) => setForm({ ...form, accountNumber: event.target.value })} /></label><label className="field"><span>Titular</span><input maxLength={160} value={form.accountHolder} onChange={(event) => setForm({ ...form, accountHolder: event.target.value })} /></label><label className="field"><span>NIT del titular</span><input maxLength={32} value={form.accountHolderNit} onChange={(event) => setForm({ ...form, accountHolderNit: event.target.value })} /></label></div></fieldset>{editor === "edit" && detail ? documentsSection(detail) : pendingDocumentsSection}<label className="check-line"><input type="checkbox" checked={form.active} onChange={(event) => setForm({ ...form, active: event.target.checked })} />Proveedor activo para nuevas órdenes</label>{feedback && <ErrorMessage>{feedback}</ErrorMessage>}</div><div className="form-footer"><button className="button button-secondary" type="button" onClick={closeEditor}>Cancelar</button><button className="button button-dark" type="submit" disabled={saving}>{saving ? "Guardando…" : editor === "create" ? "Crear proveedor" : "Guardar cambios"}</button></div></form></div>}
    </>
  );
}
