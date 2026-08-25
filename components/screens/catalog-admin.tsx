"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  Database,
  Edit3,
  Plus,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
  X,
} from "lucide-react";
import type { Role } from "../../lib/demo-data";
import { SectionTitle } from "./screen-primitives";

type CatalogKind =
  | "works"
  | "tags"
  | "items"
  | "suppliers"
  | "societies"
  | "users";
type CatalogRecord = {
  id: string;
  name: string;
  active?: boolean;
  status?: string;
  societyId?: string;
  unit?: string;
  approverId?: string;
  specification?: string;
  category?: string;
  nit?: string;
  phone?: string;
  email?: string;
  address?: string;
  societyName?: string;
  approverName?: string;
  // RF-004: roles asignados a un usuario del catálogo (no confundir con el rol de sesión `role: Role`).
  roles?: string[];
};
type CatalogData = {
  works: CatalogRecord[];
  tags: CatalogRecord[];
  suppliers: CatalogRecord[];
  items: CatalogRecord[];
  features: Record<string, boolean>;
  societies?: Array<{ id: string; name: string }>;
  approvers?: Array<{ id: string; name: string }>;
  access?: Partial<Record<CatalogKind, boolean>>;
  // RF-002/RF-004: listados completos (incluyen inactivos) que sirve /api/catalogs/manage para las
  // pestañas de administración; distintos de `societies` (activas, para el selector de obras).
  societyRecords?: CatalogRecord[];
  userRecords?: CatalogRecord[];
  // RF-004: admin_mizar puede leer usuarios aunque `access.users` sea false (solo escribe admin_sixteam).
  canReadUsers?: boolean;
};
type FormValues = Record<string, string | boolean | string[]>;

const labels: Record<CatalogKind, string> = {
  works: "Obras",
  tags: "Etiquetas",
  items: "Ítems",
  suppliers: "Proveedores",
  societies: "Sociedades",
  users: "Usuarios",
};
// El título "Nuevo X" por defecto solo quita la "s" final de labels[kind] (falla en géneros y en
// plurales irregulares como "Sociedades"); para las dos pestañas nuevas se declara explícito en vez
// de heredar ese atajo.
const NEW_RECORD_LABEL: Partial<Record<CatalogKind, string>> = {
  societies: "Nueva sociedad",
  users: "Nuevo usuario",
};
// RF-004: debe coincidir exactamente con el tipo Role de lib/domain (lib/domain/model.ts) y con
// `roleLiteral` en app/api/catalogs/route.ts.
const ROLE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "solicitante", label: "Solicitante" },
  { value: "revisor", label: "Revisor" },
  { value: "aprobador", label: "Aprobador" },
  { value: "contabilidad", label: "Contabilidad" },
  { value: "admin_mizar", label: "Administrador Mizar" },
  { value: "admin_sixteam", label: "Administrador Sixteam" },
];
const emptyForm: FormValues = {
  name: "",
  societyId: "",
  approverId: "",
  unit: "",
  specification: "",
  category: "",
  nit: "",
  phone: "",
  email: "",
  address: "",
  id: "",
  roles: [],
};
function rolesFromForm(values: FormValues): string[] {
  return Array.isArray(values.roles) ? values.roles : [];
}

// RF-002/RF-004: la clave de estado real difiere del `kind` para sociedades/usuarios (ver CatalogData);
// rowsFor y las actualizaciones optimistas de save/toggle comparten este único mapeo para no divergir.
function fieldFor(kind: CatalogKind): "societyRecords" | "userRecords" | Exclude<CatalogKind, "societies" | "users"> {
  if (kind === "societies") return "societyRecords";
  if (kind === "users") return "userRecords";
  return kind;
}
function rowsFor(data: CatalogData, kind: CatalogKind) {
  const rows = data[fieldFor(kind)];
  return Array.isArray(rows) ? rows : [];
}
function isActive(row: CatalogRecord) {
  return (
    row.active !== false &&
    row.status !== "inactivo" &&
    row.status !== "pendiente_normalizacion"
  );
}
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function statusLabel(row: CatalogRecord) {
  if (row.status === "pendiente_normalizacion")
    return "Pendiente de normalización";
  return isActive(row) ? "Activo" : "Inactivo";
}
function actionLabel(row: CatalogRecord) {
  if (row.status === "pendiente_normalizacion") return "Normalizar";
  return isActive(row) ? "Desactivar" : "Reactivar";
}
function dataFeatureEnabled(data: CatalogData) {
  return data.features?.catalogos_admin_mizar === true;
}
function canManageKind(
  kind: CatalogKind,
  role: Role,
  data: CatalogData,
  featureEnabled = dataFeatureEnabled(data),
) {
  const roleAllowed =
    kind === "items"
      ? role === "Administrador Sixteam" || role === "Revisor"
      : kind === "suppliers"
        ? role === "Administrador Sixteam" ||
          role === "Revisor" ||
          (role === "Administrador Mizar" && featureEnabled)
        : // RF-004: administrar usuarios es exclusivo de Administrador Sixteam, sin depender del
          // autoservicio de catálogos (igual que sociedades, ver más abajo).
          kind === "users"
          ? role === "Administrador Sixteam"
          : // RF-002: sociedades se comparte entre Sixteam y Mizar de forma incondicional.
            kind === "societies"
            ? role === "Administrador Sixteam" || role === "Administrador Mizar"
            : role === "Administrador Sixteam" ||
              (role === "Administrador Mizar" && featureEnabled);
  return data.access && kind in data.access
    ? data.access[kind] === true
    : roleAllowed;
}
/**
 * RF-004: a diferencia de los demás catálogos, "users" tiene un nivel de acceso intermedio:
 * Administrador Mizar puede CONSULTAR (nunca escribir) mientras que canManageKind sigue siendo la
 * única puerta para crear/editar/activar. `data.canReadUsers` es la señal autoritativa que calcula el
 * backend (app/api/catalogs/manage/route.ts, `access.users || actor.roles.includes("admin_mizar")`);
 * deliberadamente NO se adivina un valor por rol cuando falta (p. ej. el estado de error inicial de
 * ConnectedScreen con `emptyCatalogs`, o un doble de prueba incompleto): cierra en falso, igual que el
 * resto de la autorización de esta plataforma.
 */
function canViewKind(
  kind: CatalogKind,
  role: Role,
  data: CatalogData,
  featureEnabled = dataFeatureEnabled(data),
) {
  if (kind === "users")
    return (
      canManageKind(kind, role, data, featureEnabled) ||
      data.canReadUsers === true
    );
  return canManageKind(kind, role, data, featureEnabled);
}
function readError(value: unknown, fallback: string) {
  return value &&
    typeof value === "object" &&
    "message" in value &&
    typeof value.message === "string"
    ? value.message
    : fallback;
}

async function writeCatalog(method: "POST" | "PATCH", body: unknown) {
  const response = await fetch("/api/catalogs", {
    method,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "Tu rol no tiene permiso para esta acción."
        : response.status === 409
          ? "Ya existe un registro con ese nombre o NIT."
          : response.status === 422
            ? `La operación no cumple una regla de negocio: ${readError(value, "revisa los datos y el estado del registro.")}`
            : readError(value, "No fue posible guardar el cambio."),
    );
  return value as CatalogRecord;
}

function payloadFor(
  kind: CatalogKind,
  values: FormValues,
  editing: boolean,
  currentActive = true,
) {
  const data: Record<string, unknown> = {
    name: String(values.name || "").trim(),
  };
  if (kind === "works") data.societyId = String(values.societyId || "").trim();
  if (kind === "tags") data.approverId = String(values.approverId || "").trim();
  if (kind === "items") {
    data.unit = String(values.unit || "").trim();
    const specification = String(values.specification || "").trim();
    const category = String(values.category || "").trim();
    if (editing || specification) data.specification = specification || null;
    if (editing || category) data.category = category || null;
  }
  if (kind === "suppliers") {
    const nit = String(values.nit || "").trim();
    if (editing || nit) data.nit = nit || null;
    for (const key of ["phone", "email", "address"])
      if (editing || String(values[key] || "").trim())
        data[key] = String(values[key] || "").trim() || null;
  }
  if (kind === "societies") {
    const nit = String(values.nit || "").trim();
    if (editing || nit) data.nit = nit || null;
  }
  if (kind === "users") {
    // RF-004: id/correo son inmutables tras el alta (el correo vive en Supabase Auth, no en este
    // catálogo); el esquema de PATCH ni siquiera acepta esas claves, así que solo se envían al crear.
    if (!editing) {
      data.id = String(values.id || "").trim();
      data.email = String(values.email || "").trim();
    }
    const phone = String(values.phone || "").trim();
    if (editing || phone) data.phone = phone || null;
    // "roles" en un PATCH es el conjunto final deseado (reemplaza, no incrementa), igual que en el
    // servicio (ver CatalogService.patch / RF-004); por eso siempre se envía el array completo.
    data.roles = rolesFromForm(values);
  }
  if (
    kind === "tags" &&
    editing &&
    !String(values.approverId || "").trim() &&
    !currentActive
  )
    data.approverId = null;
  return data;
}

export function ConnectedCatalogAdmin({
  pathname,
  role,
  initialData,
}: {
  pathname: string;
  role: Role;
  initialData: CatalogData;
}) {
  const requestedKind: CatalogKind | undefined = pathname.startsWith(
    "/proveedores",
  )
    ? "suppliers"
    : pathname.startsWith("/catalogos/obras")
      ? "works"
      : pathname.startsWith("/catalogos/etiquetas")
        ? "tags"
        : pathname.startsWith("/catalogos/items")
          ? "items"
          : pathname.startsWith("/catalogos/sociedades")
            ? "societies"
            : pathname.startsWith("/catalogos/usuarios")
              ? "users"
              : undefined;
  const initialFeatureEnabled = dataFeatureEnabled(initialData);
  const firstAllowed = (Object.keys(labels) as CatalogKind[]).find((option) =>
    canViewKind(option, role, initialData, initialFeatureEnabled),
  );
  const initialKind: CatalogKind =
    (requestedKind &&
      canViewKind(requestedKind, role, initialData, initialFeatureEnabled) &&
      requestedKind) ||
    firstAllowed ||
    requestedKind ||
    "items";
  const [kind, setKind] = useState<CatalogKind>(initialKind);
  const [data, setData] = useState(initialData);
  const [editing, setEditing] = useState<CatalogRecord | null>(null);
  const [form, setForm] = useState<FormValues>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [success, setSuccess] = useState("");

  const featureEnabled = dataFeatureEnabled(data);
  const canView = canViewKind(kind, role, data, featureEnabled);
  const canManage = canManageKind(kind, role, data, featureEnabled);
  const rows = useMemo(() => rowsFor(data, kind), [data, kind]);
  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormOpen(true);
    setFeedback("");
    setSuccess("");
  };
  const openEdit = (row: CatalogRecord) => {
    setEditing(row);
    setForm({
      ...emptyForm,
      ...row,
    });
    setFormOpen(true);
    setFeedback("");
    setSuccess("");
  };
  const closeForm = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormOpen(false);
  };
  const update = (key: string, value: string | boolean | string[]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const validate = () => {
    const name = String(form.name || "").trim();
    if (name.length < 2 || name.length > 160)
      return "El nombre debe tener entre 2 y 160 caracteres.";
    if (
      kind === "works" &&
      (!String(form.societyId || "").trim() ||
        !UUID_RE.test(String(form.societyId)))
    )
      return "Selecciona una sociedad elegible con un UUID válido.";
    if (
      kind === "tags" &&
      (!editing || editing.active !== false) &&
      (!String(form.approverId || "").trim() ||
        !UUID_RE.test(String(form.approverId)))
    )
      return "Selecciona un aprobador elegible con un UUID válido.";
    if (
      kind === "items" &&
      (!String(form.unit || "").trim() || String(form.unit).length > 40)
    )
      return "La unidad es obligatoria y admite hasta 40 caracteres.";
    if (
      kind === "items" &&
      (String(form.specification || "").length > 1000 ||
        String(form.category || "").length > 100)
    )
      return "La especificación admite 1000 caracteres y la categoría 100.";
    if (
      (kind === "suppliers" || kind === "societies") &&
      String(form.nit || "").trim() &&
      (String(form.nit).length < 3 || String(form.nit).length > 32)
    )
      return "El NIT debe tener entre 3 y 32 caracteres.";
    if (
      (kind === "suppliers" || kind === "users") &&
      String(form.phone || "").trim() &&
      !/^\+?[0-9 ()-]{7,20}$/.test(String(form.phone))
    )
      return "El teléfono debe tener entre 7 y 20 caracteres válidos.";
    if (
      kind === "suppliers" &&
      String(form.email || "").trim() &&
      !/^\S+@\S+\.\S+$/.test(String(form.email))
    )
      return "Ingresa un correo válido o deja el campo vacío.";
    if (kind === "users" && !editing) {
      // RF-004: el id debe ser el de una cuenta que ya existe en Supabase Auth; esta plataforma nunca
      // la crea. El servicio vuelve a validarlo (AUTH_ACCOUNT_NOT_FOUND) — esto solo evita un viaje
      // redondo con un valor que ni siquiera tiene forma de UUID.
      if (!UUID_RE.test(String(form.id || "").trim()))
        return "El id de usuario debe ser el UUID de una cuenta existente en Supabase Auth.";
      if (!/^\S+@\S+\.\S+$/.test(String(form.email || "")))
        return "Ingresa un correo válido.";
    }
    if (kind === "users" && rolesFromForm(form).length === 0)
      return "Selecciona al menos un rol.";
    return "";
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setFeedback("");
    setSuccess("");
    const validation = validate();
    if (validation) {
      setFeedback(validation);
      return;
    }
    setSaving(true);
    try {
      const body = payloadFor(
        kind,
        form,
        Boolean(editing),
        editing?.active !== false,
      );
      const result = editing
        ? await writeCatalog("PATCH", { kind, id: editing.id, data: body })
        : await writeCatalog("POST", { kind, data: body });
      const row = {
        ...(editing || {}),
        ...result,
        ...body,
        id: result?.id || editing?.id || `local-${Date.now()}`,
        active: result?.active ?? editing?.active ?? true,
      } as CatalogRecord;
      setData((current) => ({
        ...current,
        [fieldFor(kind)]: editing
          ? rowsFor(current, kind).map((item) =>
              item.id === row.id ? row : item,
            )
          : [...rowsFor(current, kind), row],
      }));
      setSuccess(
        editing
          ? "Registro actualizado correctamente."
          : "Registro creado correctamente.",
      );
      closeForm();
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible guardar el cambio.",
      );
    } finally {
      setSaving(false);
    }
  };
  const toggle = async (row: CatalogRecord) => {
    setFeedback("");
    setSuccess("");
    setSaving(true);
    try {
      const nextActive = !isActive(row);
      const result = await writeCatalog("PATCH", {
        kind,
        id: row.id,
        data: { active: nextActive },
      });
      setData((current) => ({
        ...current,
        [fieldFor(kind)]: rowsFor(current, kind).map((item) =>
          item.id === row.id
            ? {
                ...item,
                ...result,
                active: nextActive,
                status: nextActive ? "activo" : "inactivo",
              }
            : item,
        ),
      }));
      setSuccess(
        nextActive
          ? row.status === "pendiente_normalizacion"
            ? "Propuesta normalizada y activada."
            : "Registro reactivado."
          : "Registro desactivado de forma reversible.",
      );
    } catch (error) {
      setFeedback(
        error instanceof Error
          ? error.message
          : "No fue posible cambiar el estado.",
      );
    } finally {
      setSaving(false);
    }
  };
  const blockedReason =
    kind === "items"
      ? "Los ítems solo pueden administrarse con item:manage (Revisor o Administrador Sixteam)."
      : kind === "users"
        ? "La administración de usuarios es exclusiva de Administrador Sixteam. Administrador Mizar puede consultarla en modo lectura; el resto de roles no tiene acceso."
        : kind === "societies"
          ? "Las sociedades solo pueden administrarse desde Administrador Mizar o Administrador Sixteam."
          : role === "Administrador Mizar" && !featureEnabled
            ? "El autoservicio de Administrador Mizar está bloqueado hasta habilitar el módulo catalogos_admin_mizar."
            : kind === "suppliers"
              ? "Necesitas supplier:manage para administrar proveedores."
              : "Necesitas catalog:manage para administrar este catálogo.";
  return (
    <>
      <SectionTitle
        eyebrow="Administración conectada"
        title="Catálogos"
        description="Altas, edición y desactivación reversible mediante el servicio autenticado."
        action={<span className="badge badge-warning">Sin borrado físico</span>}
      />
      <div
        className="catalog-admin-tabs"
        role="tablist"
        aria-label="Catálogos administrables"
      >
        {(Object.keys(labels) as CatalogKind[]).map((option) => {
          const allowed = canViewKind(option, role, data, featureEnabled);
          return (
            <button
              key={option}
              type="button"
              role="tab"
              id={`catalog-tab-${option}`}
              aria-controls="catalog-admin-panel"
              aria-selected={kind === option}
              className={kind === option ? "is-active" : ""}
              disabled={!allowed}
              onClick={() => {
                setKind(option);
                closeForm();
                setFeedback("");
                setSuccess("");
              }}
            >
              <Database size={15} />
              {labels[option]}
              {!allowed && <span className="catalog-lock">Bloqueado</span>}
            </button>
          );
        })}
      </div>
      {!canView ? (
        <section
          className="panel catalog-access-gate"
          id="catalog-admin-panel"
          role="tabpanel"
          aria-labelledby={`catalog-tab-${kind}`}
        >
          <ShieldCheck size={22} />
          <div role="alert">
            <h2>Gestión bloqueada para este rol</h2>
            <p>{blockedReason}</p>
            <small>
              La API mantiene la autorización; esta vista no habilita acciones
              ni intenta simular persistencia.
            </small>
          </div>
        </section>
      ) : (
        <section
          className="panel catalog-admin-panel"
          id="catalog-admin-panel"
          role="tabpanel"
          aria-label={labels[kind]}
          aria-labelledby={`catalog-tab-${kind}`}
        >
          <div className="panel-head">
            <div>
              <h2>{labels[kind]}</h2>
              <p className="panel-sub">
                {rows.length
                  ? `${rows.length} registros recibidos por API`
                  : "No hay registros en este catálogo."}
              </p>
            </div>
            {canManage && (
              <button
                className="button button-dark"
                type="button"
                onClick={openCreate}
              >
                <Plus size={15} /> Nuevo registro
              </button>
            )}
          </div>
          {!canManage && (
            <p className="catalog-readonly-note" role="note">
              Modo lectura: la administración de usuarios es exclusiva de
              Administrador Sixteam.
            </p>
          )}
          {feedback && (
            <p className="field-error catalog-feedback" role="alert">
              {feedback}
            </p>
          )}
          {success && (
            <p className="catalog-success" role="status">
              {success}
            </p>
          )}
          {formOpen && canManage ? (
            <CatalogForm
              kind={kind}
              values={form}
              editing={Boolean(editing)}
              approverRequired={kind === "tags" && editing?.active !== false}
              saving={saving}
              feedback={feedback}
              update={update}
              onSubmit={save}
              onCancel={closeForm}
              societies={data.societies ?? []}
              approvers={data.approvers ?? []}
            />
          ) : null}
          {rows.length === 0 ? (
            <div className="empty-state">
              <span className="empty-icon">
                <Database size={21} />
              </span>
              <h3>Catálogo vacío</h3>
              <p>Crea el primer registro cuando la operación lo permita.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Nombre</th>
                    {kind === "works" && <th>Sociedad</th>}
                    {kind === "items" && (
                      <>
                        <th>Unidad</th>
                        <th>Categoría</th>
                      </>
                    )}
                    {kind === "tags" && (
                      <>
                        <th>Aprobador</th>
                      </>
                    )}
                    {kind === "suppliers" && (
                      <>
                        <th>NIT</th>
                        <th>Contacto</th>
                      </>
                    )}
                    {kind === "societies" && <th>NIT</th>}
                    {kind === "users" && (
                      <>
                        <th>Correo</th>
                        <th>Roles</th>
                      </>
                    )}
                    <th>Estado</th>
                    <th className="align-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className={!isActive(row) ? "catalog-row-inactive" : ""}
                    >
                      <td>
                        <b>{row.name}</b>
                        {row.specification && (
                          <small className="table-sub">
                            {row.specification}
                          </small>
                        )}
                      </td>
                      {kind === "works" && (
                        <td className="mono-id">
                          {row.societyName ||
                            data.societies?.find(
                              (society) => society.id === row.societyId,
                            )?.name ||
                            "No configurada"}
                        </td>
                      )}
                      {kind === "items" && (
                        <>
                          <td>{row.unit || "—"}</td>
                          <td>{row.category || "—"}</td>
                        </>
                      )}
                      {kind === "tags" && (
                        <>
                          <td>
                            {row.approverName ||
                              data.approvers?.find(
                                (approver) => approver.id === row.approverId,
                              )?.name ||
                              "No configurado"}
                          </td>
                        </>
                      )}
                      {kind === "suppliers" && (
                        <>
                          <td>{row.nit || "—"}</td>
                          <td>{row.email || row.phone || "—"}</td>
                        </>
                      )}
                      {kind === "societies" && <td>{row.nit || "—"}</td>}
                      {kind === "users" && (
                        <>
                          <td>{row.email || "—"}</td>
                          <td>
                            {(row.roles ?? [])
                              .map(
                                (value) =>
                                  ROLE_OPTIONS.find(
                                    (option) => option.value === value,
                                  )?.label ?? value,
                              )
                              .join(", ") || "—"}
                          </td>
                        </>
                      )}
                      <td>
                        <span
                          className={`badge ${isActive(row) ? "badge-success" : "badge-muted"}`}
                        >
                          {statusLabel(row)}
                        </span>
                      </td>
                      <td className="align-right">
                        {canManage ? (
                          <>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`Editar ${row.name}`}
                              disabled={saving}
                              onClick={() => openEdit(row)}
                            >
                              <Edit3 size={15} />
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`${actionLabel(row)} ${row.name}`}
                              disabled={saving}
                              onClick={() => void toggle(row)}
                            >
                              {isActive(row) ? (
                                <ToggleRight size={17} />
                              ) : (
                                <ToggleLeft size={17} />
                              )}
                            </button>
                          </>
                        ) : (
                          <span className="table-sub">Solo lectura</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}

function CatalogForm({
  kind,
  values,
  editing,
  approverRequired,
  saving,
  feedback,
  update,
  onSubmit,
  onCancel,
  societies,
  approvers,
}: {
  kind: CatalogKind;
  values: FormValues;
  editing: boolean;
  approverRequired: boolean;
  saving: boolean;
  feedback: string;
  update: (key: string, value: string | boolean | string[]) => void;
  onSubmit: (event: FormEvent) => void;
  onCancel: () => void;
  societies: Array<{ id: string; name: string }>;
  approvers: Array<{ id: string; name: string }>;
}) {
  const invalidName = Boolean(
    feedback && String(values.name || "").trim().length < 2,
  );
  return (
    <form className="catalog-edit-form" onSubmit={onSubmit} noValidate>
      <div className="panel-head">
        <div>
          <h3>
            {editing
              ? "Editar registro"
              : (NEW_RECORD_LABEL[kind] ??
                `Nuevo ${labels[kind].toLowerCase().slice(0, -1)}`)}
          </h3>
          <p className="panel-sub">
            La API valida duplicados y permisos antes de guardar.
          </p>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="Cerrar formulario"
          onClick={onCancel}
        >
          <X size={16} />
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>
            Nombre <em>*</em>
          </span>
          <input
            value={String(values.name || "")}
            maxLength={160}
            required
            aria-invalid={invalidName}
            aria-describedby={invalidName ? "catalog-name-error" : undefined}
            onChange={(event) => update("name", event.target.value)}
          />
          {invalidName && (
            <small className="field-error" id="catalog-name-error">
              El nombre debe tener al menos 2 caracteres.
            </small>
          )}
        </label>
        {kind === "works" && (
          <label className="field">
            <span>
              Sociedad <em>*</em>
            </span>
            <select
              value={String(values.societyId || "")}
              required
              disabled={!societies.length}
              aria-invalid={Boolean(
                feedback &&
                  (!String(values.societyId || "").trim() ||
                    !UUID_RE.test(String(values.societyId))),
              )}
              aria-describedby={
                feedback &&
                (!String(values.societyId || "").trim() ||
                  !UUID_RE.test(String(values.societyId)))
                  ? "catalog-society-error"
                  : undefined
              }
              onChange={(event) => update("societyId", event.target.value)}
            >
              <option value="">
                {societies.length
                  ? "Selecciona una sociedad elegible"
                  : "No hay sociedades elegibles"}
              </option>
              {societies.map((society) => (
                <option key={society.id} value={society.id}>
                  {society.name}
                </option>
              ))}
            </select>
            {feedback &&
              (!String(values.societyId || "").trim() ||
                !UUID_RE.test(String(values.societyId))) && (
                <small className="field-error" id="catalog-society-error">
                  Selecciona una sociedad elegible.
                </small>
              )}
          </label>
        )}
        {kind === "tags" && (
          <label className="field">
            <span>Aprobador elegible {approverRequired && <em>*</em>}</span>
            <select
              value={String(values.approverId || "")}
              required={approverRequired}
              disabled={!approvers.length}
              aria-invalid={Boolean(
                feedback &&
                  approverRequired &&
                  (!String(values.approverId || "").trim() ||
                    !UUID_RE.test(String(values.approverId))),
              )}
              aria-describedby={
                feedback &&
                approverRequired &&
                (!String(values.approverId || "").trim() ||
                  !UUID_RE.test(String(values.approverId)))
                  ? "catalog-approver-error"
                  : undefined
              }
              onChange={(event) => update("approverId", event.target.value)}
            >
              <option value="">
                {approvers.length
                  ? "Selecciona un aprobador elegible"
                  : "No hay aprobadores elegibles"}
              </option>
              {approvers.map((approver) => (
                <option key={approver.id} value={approver.id}>
                  {approver.name}
                </option>
              ))}
            </select>
            {feedback &&
              approverRequired &&
              (!String(values.approverId || "").trim() ||
                !UUID_RE.test(String(values.approverId))) && (
                <small className="field-error" id="catalog-approver-error">
                  Selecciona un aprobador elegible.
                </small>
              )}
          </label>
        )}
        {kind === "items" && (
          <>
            <label className="field">
              <span>
                Unidad <em>*</em>
              </span>
              <input
                value={String(values.unit || "")}
                maxLength={40}
                required
                aria-invalid={Boolean(
                  feedback && !String(values.unit || "").trim(),
                )}
                onChange={(event) => update("unit", event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>
                Especificación <small>opcional</small>
              </span>
              <textarea
                value={String(values.specification || "")}
                maxLength={1000}
                onChange={(event) =>
                  update("specification", event.target.value)
                }
              />
            </label>
            <label className="field">
              <span>
                Categoría <small>opcional</small>
              </span>
              <input
                value={String(values.category || "")}
                maxLength={100}
                onChange={(event) => update("category", event.target.value)}
              />
            </label>
          </>
        )}
        {kind === "suppliers" && (
          <>
            <label className="field">
              <span>
                NIT <small>opcional</small>
              </span>
              <input
                value={String(values.nit || "")}
                maxLength={32}
                onChange={(event) => update("nit", event.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Teléfono <small>opcional</small>
              </span>
              <input
                value={String(values.phone || "")}
                maxLength={20}
                inputMode="tel"
                onChange={(event) => update("phone", event.target.value)}
              />
            </label>
            <label className="field">
              <span>
                Correo <small>opcional</small>
              </span>
              <input
                type="email"
                value={String(values.email || "")}
                onChange={(event) => update("email", event.target.value)}
              />
            </label>
            <label className="field field-wide">
              <span>
                Dirección <small>opcional</small>
              </span>
              <input
                value={String(values.address || "")}
                maxLength={300}
                onChange={(event) => update("address", event.target.value)}
              />
            </label>
          </>
        )}
        {kind === "societies" && (
          <label className="field">
            <span>
              NIT <small>opcional</small>
            </span>
            <input
              value={String(values.nit || "")}
              maxLength={32}
              onChange={(event) => update("nit", event.target.value)}
            />
          </label>
        )}
        {kind === "users" && (
          <>
            {!editing && (
              <label className="field field-wide">
                <span>
                  Id de usuario (Supabase Auth) <em>*</em>
                </span>
                <input
                  value={String(values.id || "")}
                  maxLength={36}
                  required
                  placeholder="00000000-0000-4000-8000-000000000000"
                  aria-invalid={Boolean(
                    feedback && !UUID_RE.test(String(values.id || "").trim()),
                  )}
                  onChange={(event) => update("id", event.target.value)}
                />
                <small>
                  Debe existir previamente en Supabase Auth; esta plataforma
                  nunca crea la cuenta, solo la vincula.
                </small>
              </label>
            )}
            {!editing && (
              <label className="field">
                <span>
                  Correo <em>*</em>
                </span>
                <input
                  type="email"
                  required
                  value={String(values.email || "")}
                  aria-invalid={Boolean(
                    feedback &&
                      !/^\S+@\S+\.\S+$/.test(String(values.email || "")),
                  )}
                  onChange={(event) => update("email", event.target.value)}
                />
              </label>
            )}
            <label className="field">
              <span>
                Teléfono <small>opcional</small>
              </span>
              <input
                value={String(values.phone || "")}
                maxLength={20}
                inputMode="tel"
                onChange={(event) => update("phone", event.target.value)}
              />
            </label>
            <fieldset className="field field-wide catalog-roles">
              <legend>
                Roles <em>*</em>
              </legend>
              <div className="catalog-roles-grid">
                {ROLE_OPTIONS.map((option) => {
                  const selected = rolesFromForm(values);
                  const checked = selected.includes(option.value);
                  return (
                    <label key={option.value} className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          update(
                            "roles",
                            event.target.checked
                              ? [...selected, option.value]
                              : selected.filter((value) => value !== option.value),
                          )
                        }
                      />
                      {option.label}
                    </label>
                  );
                })}
              </div>
              {feedback && rolesFromForm(values).length === 0 && (
                <small className="field-error">
                  Selecciona al menos un rol.
                </small>
              )}
            </fieldset>
          </>
        )}
      </div>
      <div className="form-footer">
        <span>Los cambios se auditan en el servicio.</span>
        <div className="title-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={onCancel}
          >
            Cancelar
          </button>
          <button
            className="button button-dark"
            type="submit"
            disabled={saving}
          >
            {saving
              ? "Guardando…"
              : editing
                ? "Guardar cambios"
                : "Crear registro"}
          </button>
        </div>
      </div>
    </form>
  );
}
