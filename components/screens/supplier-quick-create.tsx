"use client";

// Alta rápida de proveedor/beneficiario (RF-601/RF-606, adenda de pagos): un solo diálogo para la
// captura interna (new-requisition.tsx), la revisión (detail.tsx) y el directorio (suppliers.tsx),
// que antes lo repetían inline con formularios distintos. Habla con el mismo endpoint que todos
// usaban (POST /api/suppliers) y deja la ficha marcada "pendiente de completar" por defecto: una
// alta con nombre + identificación no trae datos bancarios ni documentos, y alguien tiene que
// terminarla en Proveedores.
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { X } from "lucide-react";
import type { SupplierIdentificationType } from "../../lib/domain/model";
import { normalizeIdentification } from "../../lib/domain/normalization";
import { apiRequest, friendlyErrorText } from "../../lib/http/friendly-error";
import { mutate } from "./connected/data";

export const SUPPLIER_IDENTIFICATION_TYPE_OPTIONS: ReadonlyArray<{
  value: SupplierIdentificationType;
  label: string;
}> = [
  { value: "NIT", label: "NIT" },
  { value: "CC", label: "Cédula de ciudadanía" },
  { value: "CE", label: "Cédula de extranjería" },
  { value: "PAS", label: "Pasaporte" },
];

export type SupplierIdentity = {
  nit?: string | null;
  identificationType?: SupplierIdentificationType | string;
  identification?: string | null;
  pendingNormalization?: boolean;
};

export type QuickSupplier = SupplierIdentity & {
  id: string;
  name: string;
  contact?: { name?: string; phone?: string; email?: string; address?: string };
  active?: boolean;
};

export type QuickSupplierDraft = {
  name: string;
  identificationType: SupplierIdentificationType;
  identification: string;
  phone: string;
  email: string;
  pendingNormalization: boolean;
};

const PHONE_RE = /^\+?[0-9 ()-]{7,20}$/;
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** "NIT 900123456-1" / "CC 1234567" / "" cuando no hay identificación (cae al `nit` legado). */
export function identificationLabel(supplier: SupplierIdentity): string {
  const value = supplier.identification ?? supplier.nit;
  if (!value) return "";
  return `${supplier.identificationType ?? "NIT"} ${value}`;
}

export function matchesIdentification(
  supplier: SupplierIdentity,
  type: SupplierIdentificationType,
  identification: string,
): boolean {
  const wanted = normalizeIdentification(identification);
  const own = supplier.identification ?? supplier.nit;
  if (!wanted || !own) return false;
  return (supplier.identificationType ?? "NIT") === type && normalizeIdentification(own) === wanted;
}

export function findSupplierByIdentification<T extends SupplierIdentity>(
  suppliers: readonly T[],
  type: SupplierIdentificationType,
  identification: string,
): T | undefined {
  return suppliers.find((supplier) => matchesIdentification(supplier, type, identification));
}

/** La ola 1 dejó `findByIdentification` en el servicio pero sin ruta HTTP: se lee el directorio
 *  completo y se filtra aquí con la misma normalización que la base (normalizeIdentification). */
export async function lookupSupplierByIdentification(
  type: SupplierIdentificationType,
  identification: string,
): Promise<QuickSupplier | null> {
  const value = await apiRequest<{ suppliers?: QuickSupplier[] }>("/api/suppliers", { cache: "no-store" });
  return findSupplierByIdentification(value?.suppliers ?? [], type, identification) ?? null;
}

export function quickSupplierPayload(draft: QuickSupplierDraft): Record<string, unknown> {
  const identification = draft.identification.trim();
  const phone = draft.phone.trim();
  const email = draft.email.trim();
  const contact = { ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
  return {
    name: draft.name.trim(),
    ...(identification ? { identificationType: draft.identificationType, identification } : {}),
    pendingNormalization: draft.pendingNormalization,
    ...(Object.keys(contact).length ? { contact } : {}),
  };
}

export function validateQuickSupplierDraft(draft: QuickSupplierDraft): string {
  if (draft.name.trim().length < 2) return "Escribe la razón social o el nombre del beneficiario.";
  const identification = draft.identification.trim();
  if (identification && (identification.length < 3 || identification.length > 32 || !normalizeIdentification(identification)))
    return "La identificación debe tener entre 3 y 32 caracteres, con al menos un dígito o letra.";
  if (draft.phone.trim() && !PHONE_RE.test(draft.phone.trim())) return "El teléfono debe tener entre 7 y 20 caracteres válidos.";
  if (draft.email.trim() && !EMAIL_RE.test(draft.email.trim())) return "Ingresa un correo válido o deja el campo vacío.";
  return "";
}

export async function createQuickSupplier(draft: QuickSupplierDraft): Promise<QuickSupplier> {
  const created = (await mutate("/api/suppliers", "POST", quickSupplierPayload(draft))) as Partial<QuickSupplier> | null;
  if (!created?.id || !created.name) throw new Error("El servicio no devolvió el proveedor creado.");
  return created as QuickSupplier;
}

function emptyDraft(
  identificationType: SupplierIdentificationType,
  identification: string,
): QuickSupplierDraft {
  return { name: "", identificationType, identification, phone: "", email: "", pendingNormalization: true };
}

type QuickCreateFormProps = {
  onClose: () => void;
  onCreated: (supplier: QuickSupplier) => void;
  /** Quien crea de verdad. Por defecto POST /api/suppliers; el modo demo del directorio inyecta uno local. */
  create?: (draft: QuickSupplierDraft) => Promise<QuickSupplier>;
  description?: string;
  submitLabel?: string;
  initialIdentificationType?: SupplierIdentificationType;
  initialIdentification?: string;
};

/** El formulario se monta solo mientras está abierto: cada apertura arranca limpio con los valores
 *  iniciales de ese momento, sin efectos de reinicio. */
export function SupplierQuickCreate({ open, ...props }: QuickCreateFormProps & { open: boolean }) {
  return open ? <QuickCreateForm {...props} /> : null;
}

function QuickCreateForm({
  onClose,
  onCreated,
  create = createQuickSupplier,
  description,
  submitLabel = "Crear proveedor",
  initialIdentificationType = "NIT",
  initialIdentification = "",
}: QuickCreateFormProps) {
  const [draft, setDraft] = useState<QuickSupplierDraft>(() => emptyDraft(initialIdentificationType, initialIdentification));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement | null>(null);
  const submittingRef = useRef(false);
  const latestRef = useRef({ onClose, busy });
  useEffect(() => {
    latestRef.current = { onClose, busy };
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    nameRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const latest = latestRef.current;
      if (event.key === "Escape" && !latest.busy) latest.onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previous && previous !== document.body) queueMicrotask(() => previous.focus());
    };
  }, []);

  const update = (patch: Partial<QuickSupplierDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const trapFocus = (event: ReactKeyboardEvent<HTMLFormElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submittingRef.current) return;
    const validation = validateQuickSupplierDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    submittingRef.current = true;
    setBusy(true);
    setError("");
    try {
      onCreated(await create(draft));
    } catch (caught) {
      setError(friendlyErrorText(caught, "No fue posible crear el proveedor."));
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      className="quick-supplier-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="panel quick-supplier-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-supplier-title"
        onKeyDown={trapFocus}
        onSubmit={submit}
        noValidate
      >
        <div className="panel-head">
          <div>
            <div className="eyebrow">Alta rápida</div>
            <h2 id="quick-supplier-title">Nuevo proveedor</h2>
            {description && <p className="panel-sub">{description}</p>}
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Cerrar alta de proveedor"
            onClick={onClose}
            disabled={busy}
          >
            <X aria-hidden="true" size={16} />
          </button>
        </div>
        <div className="quick-supplier-body">
          <label className="field">
            <span>Razón social *</span>
            <input
              ref={nameRef}
              required
              maxLength={160}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Tipo de identificación</span>
            <select
              value={draft.identificationType}
              onChange={(event) => update({ identificationType: event.target.value as SupplierIdentificationType })}
            >
              {SUPPLIER_IDENTIFICATION_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Identificación (opcional)</span>
            <input
              maxLength={32}
              placeholder="Ej. 900123456-7"
              value={draft.identification}
              onChange={(event) => update({ identification: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Teléfono (opcional)</span>
            <input
              type="tel"
              maxLength={20}
              value={draft.phone}
              onChange={(event) => update({ phone: event.target.value })}
            />
          </label>
          <label className="field">
            <span>Correo (opcional)</span>
            <input
              type="email"
              maxLength={254}
              value={draft.email}
              onChange={(event) => update({ email: event.target.value })}
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={draft.pendingNormalization}
              onChange={(event) => update({ pendingNormalization: event.target.checked })}
            />
            Ficha pendiente de completar en Proveedores
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="form-footer">
          <button className="button button-secondary" type="button" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button className="button button-dark" type="submit" disabled={busy || !draft.name.trim()}>
            {busy ? "Creando…" : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
