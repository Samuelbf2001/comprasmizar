"use client";

// RF-1401 (reunión 21-ago / 11-sep-2026: "en Configuración todavía no lo tenemos listo"). Hasta
// ahora `/configuracion` era un `Placeholder` fijo (ver components/mizar-app.tsx) — esta pantalla
// reemplaza esa vitrina vacía por accesos reales para admin_sixteam/admin_mizar, reutilizando
// endpoints y reglas que YA EXISTEN en vez de duplicarlos:
//   - Acceso público: mismo GET/PATCH /api/public-access que ya usaba el panel "Acceso público" de
//     Catálogos (components/screens/catalog-admin.tsx, fuera de alcance para este cambio) — ese
//     panel sigue ahí (tocarlo no es parte de este encargo); esta pantalla EMBEBE el mismo endpoint
//     en vez de moverlo, para no editar un archivo de otro agente.
//   - Usuarios y roles: la única fuente de verdad para roles/estado es GET /api/catalogs/manage
//     (userRecords + access.users), y las mutaciones son las que ya existían: PATCH /api/catalogs
//     (kind "users") para teléfono/activo, y POST /api/usuarios/:id/clave para la contraseña
//     temporal. Nada de esto es lógica nueva — es la MISMA que ya ejercía la pestaña "Usuarios" de
//     Catálogos, con una tabla más liviana (sin alta ni edición de roles: para eso, el enlace "Ver
//     en Catálogos" lleva a la pantalla completa).
//   - WhatsApp: /api/health ya informa `kapso` y `whatsapp_fallidos_24h`; los ids de Flow son
//     secretos de servidor (WHATSAPP_FLOW_ID / WHATSAPP_APPROVAL_FLOW_ID, ver .env.example) y NUNCA
//     se exponen como NEXT_PUBLIC_*, así que aquí solo se leen si algún día existiera su variante
//     pública — hoy siempre se muestra "gestionado por variable de servidor".
//   - Catálogos: cinco accesos directos a pestañas que ya existen; ningún dato propio.
//
// `.settings-layout`/`.settings-nav`/`.settings-section` (app/globals.css) ya existían sin usarse
// en ningún componente — se adoptan tal cual para no inventar paleta nueva.
import { Fragment, useEffect, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Boxes,
  Check,
  Copy,
  Hammer,
  KeyRound,
  Landmark,
  Lock,
  MessageSquare,
  Pencil,
  ShieldAlert,
  Tag,
  ToggleLeft,
  ToggleRight,
  Truck,
  Users as UsersIcon,
} from "lucide-react";
import type { Role } from "../../lib/demo-data";
import { normalizeCoPhone } from "../../lib/infrastructure/phone";
import { SectionTitle, Tone } from "./screen-primitives";
import { apiRequest, friendlyErrorText } from "../../lib/http/friendly-error";
import { invalidateCatalogs } from "./connected/data";

// Únicos roles con esta ruta habilitada (ver roleAllowed en components/layout/app-shell.tsx y el
// gate de mizar-app.tsx). Se repite aquí a propósito: esta pantalla debe negarse a sí misma aunque
// algún día alguien la monte fuera de esa ruta.
const ALLOWED_ROLES: Role[] = ["Administrador Sixteam", "Administrador Mizar"];

type SectionId = "acceso-publico" | "usuarios" | "permisos" | "whatsapp" | "catalogos";
// «Permisos por rol» (decisión de Ernesto, 2026-09-17) es SOLO de Administrador Sixteam: no aparece
// siquiera en el índice para Administrador Mizar, que sí ve el resto de la pantalla.
const SECTIONS: Array<{ id: SectionId; label: string; onlySixteam?: boolean }> = [
  { id: "acceso-publico", label: "Acceso público" },
  { id: "usuarios", label: "Usuarios y roles" },
  { id: "permisos", label: "Permisos por rol", onlySixteam: true },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "catalogos", label: "Catálogos" },
];

export function SettingsScreen({
  role,
  go,
}: {
  role: Role;
  go: (path: string) => void;
}) {
  const [activeSection, setActiveSection] = useState<SectionId>("acceso-publico");
  if (!ALLOWED_ROLES.includes(role)) {
    return (
      <div className="state-panel panel access-denied" role="alert">
        <span className="empty-icon">
          <ShieldAlert aria-hidden="true" size={21} />
        </span>
        <h3>Sin acceso con este rol</h3>
        <p>
          Configuración está disponible solo para <b>Administrador Sixteam</b> y{" "}
          <b>Administrador Mizar</b>.
        </p>
      </div>
    );
  }
  const jump = (id: SectionId) => {
    setActiveSection(id);
    document.getElementById(`settings-${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  return (
    <>
      <SectionTitle
        eyebrow="Administración"
        title="Configuración"
        description="Acceso público, usuarios, WhatsApp y catálogos en un solo lugar."
      />
      <div className="panel settings-layout">
        <nav className="settings-nav" aria-label="Secciones de configuración">
          {SECTIONS.filter((section) => !section.onlySixteam || role === "Administrador Sixteam").map((section) => (
            <button
              key={section.id}
              type="button"
              className={activeSection === section.id ? "is-active" : ""}
              onClick={() => jump(section.id)}
            >
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-content">
          <PublicAccessSection />
          {(role === "Administrador Sixteam" || role === "Administrador Mizar") && (
            <UsersSection go={go} />
          )}
          {role === "Administrador Sixteam" && <PermissionsSection />}
          <WhatsAppSection go={go} />
          <CatalogsSection go={go} />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// 0. Permisos por rol (decisión de Ernesto, 2026-09-17)
// ---------------------------------------------------------------------------------------------

/** Lo que devuelve GET/PUT /api/config/permissions (ver lib/services/role-permissions-service.ts).
 *  La pantalla no conoce NINGUNA regla: los nombres de negocio, los defaults y el permiso bloqueado
 *  vienen del servidor, que es quien tiene el catálogo. */
type PermissionsSettings = {
  roles: Array<{ key: string; label: string }>;
  permissions: Array<{ key: string; label: string; group: string }>;
  defaults: Record<string, string[]>;
  effective: Record<string, string[]>;
  overridden: string[];
  lockedPermission: string;
};

const WILDCARD = "*";
/** `admin_sixteam` guarda `["*"]` (todo, también lo que se invente mañana). En la matriz eso es
 *  "todas marcadas"; al desmarcar una, el comodín se expande a la lista explícita para poder quitarla. */
const marca = (lista: string[], permiso: string) => lista.includes(WILDCARD) || lista.includes(permiso);
const mismos = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|");

function PermissionsSection() {
  const [data, setData] = useState<PermissionsSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [success, setSuccess] = useState("");

  const adopt = (value: PermissionsSettings) => {
    setData(value);
    setDraft(Object.fromEntries(Object.entries(value.effective).map(([role, list]) => [role, [...list]])));
  };

  useEffect(() => {
    let active = true;
    apiRequest<PermissionsSettings>("/api/config/permissions")
      .then((value) => { if (active) adopt(value); })
      .catch((error: unknown) => { if (active) setLoadError(friendlyErrorText(error, "No fue posible consultar los permisos por rol.")); });
    return () => { active = false; };
  }, []);

  if (loadError) {
    return (
      <section id="settings-permisos" className="settings-section">
        <div><h2>Permisos por rol</h2><p>Qué puede hacer cada rol dentro de la plataforma.</p></div>
        <p className="field-error catalog-feedback" role="alert">{loadError}</p>
      </section>
    );
  }
  if (!data) {
    return (
      <section id="settings-permisos" className="settings-section">
        <div><h2>Permisos por rol</h2><p>Qué puede hacer cada rol dentro de la plataforma.</p></div>
        <p className="public-access-status">Consultando permisos…</p>
      </section>
    );
  }

  const toggle = (role: string, permiso: string) => {
    setSuccess("");
    setFeedback("");
    setDraft((previous) => {
      const actual = previous[role] ?? [];
      const explicita = actual.includes(WILDCARD) ? data.permissions.map((entry) => entry.key) : actual;
      const siguiente = explicita.includes(permiso) ? explicita.filter((entry) => entry !== permiso) : [...explicita, permiso];
      return { ...previous, [role]: siguiente };
    });
  };
  const restore = (role: string) => {
    setSuccess("");
    setFeedback("");
    setDraft((previous) => ({ ...previous, [role]: [...data.defaults[role]] }));
  };
  // Solo viajan los roles que DIFIEREN del default: un rol igual al default no deja override, y así
  // «Restaurar valores por defecto» le devuelve también los cambios futuros de rules.ts.
  const overrides = Object.fromEntries(Object.entries(draft).filter(([role, lista]) => !mismos(lista, data.defaults[role])));
  const cambiado = !mismos(Object.keys(overrides).sort(), [...data.overridden].sort())
    || Object.entries(overrides).some(([role, lista]) => !mismos(lista, data.effective[role]));

  const save = async () => {
    setFeedback("");
    setSuccess("");
    setSaving(true);
    try {
      adopt(await apiRequest<PermissionsSettings>("/api/config/permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ overrides }),
      }));
      setSuccess("Permisos guardados. Cada usuario los verá en su próxima acción.");
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible guardar los permisos."));
    } finally {
      setSaving(false);
    }
  };

  const grupos = [...new Set(data.permissions.map((permiso) => permiso.group))];
  return (
    <section id="settings-permisos" className="settings-section">
      <div>
        <h2>Permisos por rol</h2>
        <p>
          Qué puede hacer cada rol. Lo que marques aquí manda sobre los valores con los que viene la
          plataforma; lo que quede igual al valor por defecto no se guarda como excepción.
        </p>
      </div>
      <div className="table-wrap">
        <table className="permission-matrix">
          <caption className="sr-only">Permisos por rol: marca qué puede hacer cada rol</caption>
          <thead>
            <tr>
              <th scope="col">Permiso</th>
              {data.roles.map((role) => (
                <th key={role.key} scope="col" className="align-center">
                  <span>{role.label}</span>
                  {!mismos(draft[role.key] ?? [], data.defaults[role.key]) && (
                    <span className="badge badge-blue permission-role-flag">Modificado</span>
                  )}
                  <button
                    className="permission-restore"
                    type="button"
                    disabled={saving || mismos(draft[role.key] ?? [], data.defaults[role.key])}
                    onClick={() => restore(role.key)}
                  >
                    Restaurar valores por defecto
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grupos.map((grupo) => (
              <Fragment key={grupo}>
                <tr className="permission-group">
                  <th scope="colgroup" colSpan={data.roles.length + 1}>{grupo}</th>
                </tr>
                {data.permissions.filter((permiso) => permiso.group === grupo).map((permiso) => (
                  <tr key={permiso.key}>
                    <th scope="row">{permiso.label}</th>
                    {data.roles.map((role) => {
                      const activo = marca(draft[role.key] ?? [], permiso.key);
                      // El candado anti-pie, también en pantalla: Administrador Sixteam no puede
                      // quedarse sin «Configurar la plataforma» porque nadie podría volver a entrar
                      // aquí. El servidor lo rechaza igual; esto solo evita ofrecer el disparo.
                      const bloqueado = role.key === "admin_sixteam" && permiso.key === data.lockedPermission;
                      return (
                        <td key={role.key} className={`align-center${activo !== marca(data.defaults[role.key], permiso.key) ? " permission-differs" : ""}`}>
                          <input
                            type="checkbox"
                            checked={activo}
                            disabled={saving || bloqueado}
                            aria-label={`${permiso.label} — ${role.label}`}
                            title={bloqueado ? "Administrador Sixteam siempre conserva este permiso" : undefined}
                            onChange={() => toggle(role.key, permiso.key)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="permission-legend">
        <span className="permission-legend-swatch" aria-hidden="true" /> Celda resaltada: distinta del
        valor por defecto de la plataforma.
      </p>
      {feedback && <p className="field-error catalog-feedback" role="alert">{feedback}</p>}
      {success && <p className="catalog-success" role="status">{success}</p>}
      <div className="settings-inline-edit">
        <button className="button button-dark" type="button" disabled={saving || !cambiado} onClick={() => void save()}>
          {saving ? "Guardando…" : "Guardar permisos"}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 1. Acceso público
// ---------------------------------------------------------------------------------------------

type PublicAccessStatus = { configured: boolean; updatedAt: string | null };

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}

function PublicAccessSection() {
  const [status, setStatus] = useState<PublicAccessStatus | null>(null);
  const [loadError, setLoadError] = useState("");
  const [code, setCode] = useState("");
  const [confirmCode, setConfirmCode] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [success, setSuccess] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest<PublicAccessStatus>("/api/public-access")
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(friendlyErrorText(error, "No fue posible consultar el estado del acceso público."));
      });
    return () => {
      active = false;
    };
  }, []);

  const portalUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/requisiciones/publica`
      : "/requisiciones/publica";

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(portalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setFeedback("No se pudo copiar el enlace; selecciónalo y cópialo manualmente.");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFeedback("");
    setSuccess("");
    if (code.length < 8) {
      setFieldError("La contraseña debe tener al menos 8 caracteres.");
      return;
    }
    if (code !== confirmCode) {
      setFieldError("Las dos contraseñas no coinciden.");
      return;
    }
    setFieldError("");
    setSaving(true);
    try {
      const next = await apiRequest<PublicAccessStatus>("/api/public-access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      setStatus(next);
      setCode("");
      setConfirmCode("");
      setSuccess("Contraseña del portal actualizada.");
    } catch (error) {
      setFeedback(friendlyErrorText(error, "No fue posible actualizar la contraseña."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section id="settings-acceso-publico" className="settings-section">
      <div>
        <h2>Acceso público</h2>
        <p>
          Una sola contraseña para todo el portal de requisiciones; el enlace es el mismo para
          todas las obras que lo tengan habilitado.
        </p>
      </div>
      <div className="field">
        <span>Enlace del portal</span>
        <div className="settings-copy-row">
          <input type="text" readOnly value={portalUrl} aria-label="Enlace del portal público" />
          <button className="button button-secondary" type="button" onClick={() => void copyLink()}>
            {copied ? (
              <>
                <Check aria-hidden="true" size={15} /> Copiado
              </>
            ) : (
              <>
                <Copy aria-hidden="true" size={15} /> Copiar
              </>
            )}
          </button>
        </div>
      </div>
      {loadError ? (
        <p className="field-error catalog-feedback" role="alert">
          {loadError}
        </p>
      ) : status === null ? (
        <p className="public-access-status">Consultando estado…</p>
      ) : status.configured ? (
        <p className="public-access-status">
          {`Contraseña configurada. Último cambio: ${status.updatedAt ? formatDate(status.updatedAt) : "fecha no disponible"}.`}
        </p>
      ) : (
        <p className="public-access-closed-alert" role="alert">
          <ShieldAlert aria-hidden="true" size={18} />
          <span>
            El portal de requisiciones está <b>cerrado</b>: no hay contraseña configurada. Nadie
            puede radicar por el enlace hasta que la fijes.
          </span>
        </p>
      )}
      <form onSubmit={submit} noValidate>
        <div className="field-grid">
          <label className="field">
            <span>
              Nueva contraseña <em>*</em>
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              minLength={8}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? "settings-public-access-error" : undefined}
            />
          </label>
          <label className="field">
            <span>
              Confirmar contraseña <em>*</em>
            </span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmCode}
              onChange={(event) => setConfirmCode(event.target.value)}
              minLength={8}
              aria-invalid={Boolean(fieldError)}
              aria-describedby={fieldError ? "settings-public-access-error" : undefined}
            />
          </label>
        </div>
        {fieldError && (
          <small className="field-error" id="settings-public-access-error">
            {fieldError}
          </small>
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
        <div className="form-footer">
          <span>Se audita quién y cuándo la cambia; nunca queda en claro en el registro.</span>
          <button className="button button-dark" type="submit" disabled={saving}>
            {saving ? "Guardando…" : "Fijar contraseña"}
          </button>
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 2. Usuarios y roles
// ---------------------------------------------------------------------------------------------

type UserRow = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  active: boolean;
  roles: string[];
};
type ManageResponse = {
  userRecords?: UserRow[];
  canReadUsers?: boolean;
  access?: { users?: boolean };
};

const ROLE_LABELS: Record<string, string> = {
  solicitante: "Solicitante",
  revisor: "Revisor",
  aprobador: "Aprobador",
  contabilidad: "Contabilidad",
  admin_mizar: "Administrador Mizar",
  admin_sixteam: "Administrador Sixteam",
};

function UsersSection({ go }: { go: (path: string) => void }) {
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [rowSuccess, setRowSuccess] = useState<Record<string, string>>({});
  const [editingPhoneId, setEditingPhoneId] = useState<string | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [resetId, setResetId] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState("");

  const load = () => {
    apiRequest<ManageResponse>("/api/catalogs/manage")
      .then((data) => {
        setRows(Array.isArray(data.userRecords) ? data.userRecords : []);
        setCanManage(data.access?.users === true);
      })
      .catch((error: unknown) => {
        setLoadError(friendlyErrorText(error, "No fue posible consultar los usuarios."));
      });
  };
  useEffect(load, []);

  const setRowFeedback = (id: string, kind: "error" | "success", message: string) => {
    if (kind === "error") setRowError((current) => ({ ...current, [id]: message }));
    else setRowSuccess((current) => ({ ...current, [id]: message }));
  };
  const withoutId = (current: Record<string, string>, id: string): Record<string, string> =>
    Object.fromEntries(Object.entries(current).filter(([key]) => key !== id));
  const clearRowFeedback = (id: string) => {
    setRowError((current) => withoutId(current, id));
    setRowSuccess((current) => withoutId(current, id));
  };

  const toggleActive = async (row: UserRow) => {
    clearRowFeedback(row.id);
    setBusyId(row.id);
    try {
      await apiRequest("/api/catalogs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "users", id: row.id, data: { active: !row.active } }),
      });
      invalidateCatalogs();
      setRows((current) =>
        current
          ? current.map((item) => (item.id === row.id ? { ...item, active: !item.active } : item))
          : current,
      );
    } catch (error) {
      setRowFeedback(row.id, "error", friendlyErrorText(error, "No fue posible cambiar el estado."));
    } finally {
      setBusyId(null);
    }
  };

  const savePhone = async (row: UserRow) => {
    clearRowFeedback(row.id);
    setBusyId(row.id);
    try {
      await apiRequest("/api/catalogs", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "users",
          id: row.id,
          data: { phone: phoneDraft.trim() || null },
        }),
      });
      invalidateCatalogs();
      setRows((current) =>
        current
          ? current.map((item) =>
              item.id === row.id ? { ...item, phone: phoneDraft.trim() || null } : item,
            )
          : current,
      );
      setEditingPhoneId(null);
    } catch (error) {
      setRowFeedback(row.id, "error", friendlyErrorText(error, "No fue posible guardar el teléfono."));
    } finally {
      setBusyId(null);
    }
  };

  const submitTempPassword = async (row: UserRow, event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    clearRowFeedback(row.id);
    if (tempPassword.length < 8) {
      setRowFeedback(row.id, "error", "La contraseña temporal debe tener al menos 8 caracteres.");
      return;
    }
    setBusyId(row.id);
    try {
      await apiRequest(`/api/usuarios/${row.id}/clave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: tempPassword }),
      });
      setRowFeedback(row.id, "success", "Contraseña temporal asignada; se cerraron sus sesiones abiertas.");
      setTempPassword("");
      setResetId(null);
    } catch (error) {
      setRowFeedback(row.id, "error", friendlyErrorText(error, "No fue posible asignar la contraseña."));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section id="settings-usuarios" className="settings-section">
      <div>
        <h2>Usuarios y roles</h2>
        <p>
          Quién tiene acceso a la plataforma, con qué rol y qué tan reciente está su teléfono.
          {!canManage && " Consulta de solo lectura para este rol."}
        </p>
      </div>
      {loadError ? (
        <p className="field-error catalog-feedback" role="alert">
          {loadError}
        </p>
      ) : rows === null ? (
        <p className="public-access-status">Consultando usuarios…</p>
      ) : rows.length === 0 ? (
        <p className="public-access-status">No hay usuarios para mostrar.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Roles</th>
                <th>Teléfono</th>
                <th>Estado</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <tr>
                    <td>
                      <b>{row.name}</b>
                      <span className="table-sub">{row.email}</span>
                    </td>
                    <td>{row.roles.map((code) => ROLE_LABELS[code] ?? code).join(", ") || "—"}</td>
                    <td>
                      {editingPhoneId === row.id ? (
                        <div className="settings-inline-edit">
                          <input
                            type="tel"
                            aria-label={`Teléfono de ${row.name}`}
                            value={phoneDraft}
                            onChange={(event) => setPhoneDraft(event.target.value)}
                          />
                          <button
                            className="button button-dark"
                            type="button"
                            disabled={busyId === row.id}
                            onClick={() => void savePhone(row)}
                          >
                            Guardar
                          </button>
                          <button
                            className="button button-secondary"
                            type="button"
                            onClick={() => setEditingPhoneId(null)}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : row.phone ? (
                        <>
                          {row.phone}
                          <span className="table-sub">Normalizado: {normalizeCoPhone(row.phone)}</span>
                        </>
                      ) : (
                        <span className="table-sub">Sin teléfono</span>
                      )}
                    </td>
                    <td>
                      <Tone tone={row.active ? "success" : "muted"} dot>
                        {row.active ? "Activo" : "Inactivo"}
                      </Tone>
                    </td>
                    {canManage && (
                      <td>
                        {editingPhoneId !== row.id && (
                          <div className="button-row">
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`Editar teléfono de ${row.name}`}
                              disabled={busyId === row.id}
                              onClick={() => {
                                setEditingPhoneId(row.id);
                                setPhoneDraft(row.phone ?? "");
                              }}
                            >
                              <Pencil aria-hidden="true" size={15} />
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`${row.active ? "Desactivar" : "Activar"} a ${row.name}`}
                              disabled={busyId === row.id}
                              onClick={() => void toggleActive(row)}
                            >
                              {row.active ? (
                                <ToggleRight aria-hidden="true" size={17} />
                              ) : (
                                <ToggleLeft aria-hidden="true" size={17} />
                              )}
                            </button>
                            <button
                              className="icon-button"
                              type="button"
                              aria-label={`Asignar contraseña temporal a ${row.name}`}
                              disabled={busyId === row.id}
                              onClick={() => {
                                setResetId(resetId === row.id ? null : row.id);
                                setTempPassword("");
                              }}
                            >
                              <KeyRound aria-hidden="true" size={15} />
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                  {resetId === row.id && (
                    <tr>
                      <td colSpan={canManage ? 5 : 4}>
                        <form
                          className="settings-inline-edit"
                          onSubmit={(event) => void submitTempPassword(row, event)}
                        >
                          <label className="field">
                            <span>
                              Contraseña temporal para {row.name} <em>*</em>
                            </span>
                            <input
                              type="password"
                              autoComplete="new-password"
                              minLength={8}
                              value={tempPassword}
                              onChange={(event) => setTempPassword(event.target.value)}
                            />
                          </label>
                          <button className="button button-dark" type="submit" disabled={busyId === row.id}>
                            <Lock aria-hidden="true" size={14} /> Asignar
                          </button>
                        </form>
                      </td>
                    </tr>
                  )}
                  {(rowError[row.id] || rowSuccess[row.id]) && (
                    <tr>
                      <td colSpan={canManage ? 5 : 4}>
                        {rowError[row.id] && (
                          <p className="field-error catalog-feedback" role="alert">
                            {rowError[row.id]}
                          </p>
                        )}
                        {rowSuccess[row.id] && (
                          <p className="catalog-success" role="status">
                            {rowSuccess[row.id]}
                          </p>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="form-footer">
        <span>Alta de usuarios y edición de roles: pestaña completa en Catálogos.</span>
        <button className="button button-secondary" type="button" onClick={() => go("/catalogos/usuarios")}>
          <UsersIcon aria-hidden="true" size={15} /> Ver en Catálogos
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 3. WhatsApp
// ---------------------------------------------------------------------------------------------

type HealthResponse = {
  components?: { kapso?: boolean };
  whatsapp_fallidos_24h?: number | null;
};

function flowIdOrHidden(publicValue: string | undefined): string {
  return publicValue && publicValue.trim() ? publicValue.trim() : "Gestionado por variable de servidor";
}

function WhatsAppSection({ go }: { go: (path: string) => void }) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    fetch("/api/health", { cache: "no-store" })
      .then((response) => response.json())
      .then((data: HealthResponse) => {
        if (active) setHealth(data);
      })
      .catch(() => {
        if (active) setLoadError("No fue posible consultar el estado de WhatsApp.");
      });
    return () => {
      active = false;
    };
  }, []);

  // Los ids de Flow (WHATSAPP_FLOW_ID / WHATSAPP_APPROVAL_FLOW_ID) son secretos de servidor — nunca
  // viajan como NEXT_PUBLIC_*. Si algún día se decide exponerlos, basta con declarar esa variante
  // pública; hasta entonces esto siempre resuelve al texto "gestionado por variable de servidor".
  const captureFlowId = flowIdOrHidden(process.env.NEXT_PUBLIC_WHATSAPP_FLOW_ID);
  const approvalFlowId = flowIdOrHidden(process.env.NEXT_PUBLIC_WHATSAPP_APPROVAL_FLOW_ID);

  return (
    <section id="settings-whatsapp" className="settings-section">
      <div>
        <h2>WhatsApp</h2>
        <p>Estado de la integración y los Flows vigentes.</p>
      </div>
      {loadError ? (
        <p className="field-error catalog-feedback" role="alert">
          {loadError}
        </p>
      ) : health === null ? (
        <p className="public-access-status">Consultando estado…</p>
      ) : (
        <div className="toggle-row">
          <span>
            <b>Kapso (envío de mensajes)</b>
            <small>Credenciales configuradas en el servidor.</small>
          </span>
          <Tone tone={health.components?.kapso ? "success" : "danger"} dot>
            {health.components?.kapso ? "Configurado" : "No configurado"}
          </Tone>
        </div>
      )}
      {health && (
        <div className="toggle-row">
          <span>
            <b>Avisos fallidos (24 h)</b>
            <small>Mensajes que Meta descartó en el último día.</small>
          </span>
          <Tone tone={!health.whatsapp_fallidos_24h ? "success" : "warning"} dot>
            {health.whatsapp_fallidos_24h ?? "—"}
          </Tone>
        </div>
      )}
      <div className="toggle-row">
        <span>
          <b>Flow de captura</b>
          <small>{captureFlowId}</small>
        </span>
      </div>
      <div className="toggle-row">
        <span>
          <b>Flow de aprobación</b>
          <small>{approvalFlowId}</small>
        </span>
      </div>
      <div className="form-footer">
        <span>Bandeja de conversaciones y estado de entrega detallado.</span>
        <button className="button button-secondary" type="button" onClick={() => go("/mensajes")}>
          <MessageSquare aria-hidden="true" size={15} /> Mensajes de WhatsApp
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// 4. Catálogos
// ---------------------------------------------------------------------------------------------

const CATALOG_LINKS = [
  { label: "Empresas", href: "/catalogos/sociedades", icon: Landmark },
  { label: "Obras", href: "/catalogos/obras", icon: Hammer },
  { label: "Ítems", href: "/catalogos/items", icon: Boxes },
  { label: "Proveedores", href: "/proveedores", icon: Truck },
  { label: "Etiquetas", href: "/catalogos/etiquetas", icon: Tag },
] as const;

function CatalogsSection({ go }: { go: (path: string) => void }) {
  return (
    <section id="settings-catalogos" className="settings-section danger-section">
      <div>
        <h2>Catálogos</h2>
        <p>Accesos directos a la administración de cada catálogo.</p>
      </div>
      <div className="report-cards">
        {CATALOG_LINKS.map(({ label, href, icon: Icon }) => (
          <button key={href} type="button" className="report-card" onClick={() => go(href)}>
            <span className="report-card-icon">
              <Icon aria-hidden="true" size={16} />
            </span>
            <span>
              <b>{label}</b>
              <small>{href}</small>
            </span>
            <ArrowRight aria-hidden="true" size={14} />
          </button>
        ))}
      </div>
    </section>
  );
}
