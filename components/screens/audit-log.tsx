"use client";

// HISTORIAL DE CAMBIOS (ADM-08 del plan de pruebas, RF-1003 del PRD, 25-sep-2026): quién cambió qué y
// cuándo, en lenguaje de negocio. Solo lectura. Todo lo que se pinta llega YA TRADUCIDO desde
// GET /api/audit (lib/services/audit-log-service.ts): nombres en vez de ids, consecutivos en vez de
// UUID, y una lista blanca de campos que deja fuera cédulas/NIT, datos bancarios, correos, teléfonos,
// contraseñas y hashes. Esta pantalla no interpreta eventos: si algo no debe verse, no llega.
//
// Estados como el resto de pantallas conectadas: esqueleto con la cabecera real de la tabla mientras
// carga, panel de error con «Reintentar», estado vacío que ofrece limpiar filtros, y «Cargar más» con
// cursor. Los filtros se aplican al cambiar (sin botón «Buscar»): son selects y fechas, no texto libre.
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, History, RefreshCw, TriangleAlert } from "lucide-react";
import { SectionTitle, Tone } from "./screen-primitives";
import { LoadingStatus, TableSkeleton } from "./skeletons";
import { apiRequest, describeNetworkError, isFriendlyApiError, type FriendlyError } from "../../lib/http/friendly-error";
import { loadCatalogsBootstrap } from "./connected/data";
import { AUDIT_ENTITY_OPTIONS, AUDIT_EVENT_OPTIONS, AUDIT_ORIGIN_OPTIONS } from "../../lib/services/audit-log-options";

type AuditDetail = { label: string; before?: string; after?: string; value?: string };
type AuditEntry = {
  key: string;
  at: string;
  actor: string;
  action: string;
  subject: string | null;
  entityLabel: string;
  origin: string;
  originLabel: string;
  details: AuditDetail[];
};
type AuditPage = { rows: AuditEntry[]; nextCursor: string | null };
type Filters = { from: string; to: string; actor: string; entity: string; event: string; origin: string };
const EMPTY_FILTERS: Filters = { from: "", to: "", actor: "", entity: "", event: "", origin: "" };
const HEADERS = ["Fecha y hora", "Quién", "Qué pasó", "Sobre qué", "Origen", ""];
const PAGE_SIZE = 50;

const ORIGIN_TONE: Record<string, string> = { web: "blue", publico: "warning", whatsapp: "success", mcp: "muted", sistema: "muted" };

// Hora de Colombia fija (UTC-5), no la del navegador: la misma para todos los que miran el historial.
const dateFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", day: "2-digit", month: "short", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit" });
function formatWhen(iso: string): { date: string; time: string } {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return { date: "—", time: "" };
  return { date: dateFormat.format(value), time: timeFormat.format(value) };
}

function auditUrl(filters: Filters, cursor?: string): string {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return `/api/audit?${params.toString()}`;
}
function friendlyOf(error: unknown): FriendlyError {
  return isFriendlyApiError(error) ? error.friendly : describeNetworkError();
}

type LoadState =
  | { state: "loading" }
  | { state: "error"; friendly: FriendlyError }
  | { state: "ready"; rows: AuditEntry[]; nextCursor: string | null };

export function AuditLogScreen() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [users, setUsers] = useState<Array<{ id: string; name: string }>>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [moreError, setMoreError] = useState("");
  // Cada consulta lleva un número: si el usuario cambia un filtro antes de que llegue la respuesta
  // anterior, esa respuesta vieja se descarta y no pisa la tabla con resultados de otro filtro.
  const requestId = useRef(0);

  // Solo pide; el estado «cargando» lo pone quien dispara la consulta (cambio de filtro o reintento),
  // así el efecto no escribe estado de forma síncrona.
  const fetchFirstPage = useCallback((current: Filters) => {
    const id = ++requestId.current;
    apiRequest<AuditPage>(auditUrl(current))
      .then((page) => { if (id === requestId.current) setLoad({ state: "ready", rows: page.rows, nextCursor: page.nextCursor }); })
      .catch((error: unknown) => { if (id === requestId.current) setLoad({ state: "error", friendly: friendlyOf(error) }); });
  }, []);

  useEffect(() => {
    fetchFirstPage(filters);
  }, [filters, fetchFirstPage]);

  const resetView = () => {
    setLoad({ state: "loading" });
    setExpanded(null);
    setMoreError("");
  };
  const applyFilters = (next: Filters) => {
    resetView();
    setFilters(next);
  };
  const retry = () => {
    resetView();
    fetchFirstPage(filters);
  };

  // Lista de personas para el filtro «Quién»: la misma lista mínima (id + nombre) que ya usa toda la
  // plataforma para mostrar nombres, del bootstrap de catálogos (con su caché de sesión).
  useEffect(() => {
    let active = true;
    loadCatalogsBootstrap()
      .then((payload) => {
        const list = (payload as { users?: Array<{ id: string; name: string }> } | undefined)?.users;
        if (active && Array.isArray(list)) setUsers(list);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const change = (key: keyof Filters, value: string) => applyFilters({ ...filters, [key]: value });
  const hasFilters = Object.values(filters).some(Boolean);

  const loadMore = async () => {
    if (load.state !== "ready" || !load.nextCursor) return;
    const id = requestId.current;
    setMoreBusy(true);
    setMoreError("");
    try {
      const page = await apiRequest<AuditPage>(auditUrl(filters, load.nextCursor));
      if (id !== requestId.current) return;
      setLoad({ state: "ready", rows: [...load.rows, ...page.rows], nextCursor: page.nextCursor });
    } catch (error) {
      if (id === requestId.current) setMoreError(friendlyOf(error).message);
    } finally {
      setMoreBusy(false);
    }
  };

  return (
    <>
      <SectionTitle
        eyebrow="Administración"
        title="Historial de cambios"
        description="Quién cambió qué y cuándo. Es un registro de solo lectura: lo que queda aquí no se puede editar ni borrar."
      />
      <div className="filter-bar audit-filters" role="group" aria-label="Filtros del historial">
        <label className="field">
          <span>Desde</span>
          <input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => change("from", event.target.value)} />
        </label>
        <label className="field">
          <span>Hasta</span>
          <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => change("to", event.target.value)} />
        </label>
        <label className="field">
          <span>Quién</span>
          <select value={filters.actor} onChange={(event) => change("actor", event.target.value)}>
            <option value="">Todas las personas</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sobre qué</span>
          <select value={filters.entity} onChange={(event) => change("entity", event.target.value)}>
            <option value="">Todos los cambios</option>
            {AUDIT_ENTITY_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Qué pasó</span>
          <select value={filters.event} onChange={(event) => change("event", event.target.value)}>
            <option value="">Cualquier acción</option>
            {AUDIT_EVENT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Origen</span>
          <select value={filters.origin} onChange={(event) => change("origin", event.target.value)}>
            <option value="">Todos</option>
            {AUDIT_ORIGIN_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <button className="button button-secondary audit-clear" type="button" onClick={() => applyFilters(EMPTY_FILTERS)}>
            Limpiar filtros
          </button>
        )}
      </div>
      {load.state === "error" ? (
        <div className="panel state-panel" role="alert">
          <span className="empty-icon"><TriangleAlert aria-hidden="true" size={21} /></span>
          <h3>{load.friendly.title}</h3>
          <p>{load.friendly.message}</p>
          {load.friendly.solution && <p className="state-panel-hint">{load.friendly.solution}</p>}
          <div className="button-row">
            <button className="button button-dark" type="button" onClick={retry}>
              <RefreshCw aria-hidden="true" size={15} /> Reintentar
            </button>
          </div>
        </div>
      ) : load.state === "loading" ? (
        <section className="panel" aria-busy="true" data-testid="audit-skeleton">
          <TableSkeleton headers={HEADERS} />
          <LoadingStatus label="Cargando el historial de cambios…" />
        </section>
      ) : load.rows.length === 0 ? (
        <section className="panel">
          <div className="empty-state">
            <span className="empty-icon"><History aria-hidden="true" size={21} /></span>
            <h3>{hasFilters ? "No hay cambios con estos filtros" : "Todavía no hay cambios registrados"}</h3>
            <p>{hasFilters ? "Prueba con otro rango de fechas o quita algún filtro." : "Cada cambio que se haga en la plataforma aparecerá aquí."}</p>
            {hasFilters && (
              <button className="button button-secondary" type="button" onClick={() => applyFilters(EMPTY_FILTERS)}>
                Limpiar filtros
              </button>
            )}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="table-wrap">
            <table className="audit-table">
              <caption className="sr-only">Historial de cambios, del más reciente al más antiguo</caption>
              <thead>
                <tr>
                  {HEADERS.map((header, index) => (
                    <th key={header || `col-${index}`} scope="col">
                      {header || <span className="sr-only">Detalle</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {load.rows.map((row) => {
                  const when = formatWhen(row.at);
                  const open = expanded === row.key;
                  const detailId = `audit-detail-${row.key}`;
                  return (
                    <Fragment key={row.key}>
                      <tr className={open ? "is-expanded" : undefined}>
                        <td className="audit-when">
                          <b>{when.date}</b>
                          <span className="table-sub">{when.time}</span>
                        </td>
                        <td>{row.actor}</td>
                        <td className="audit-action">{row.action}</td>
                        <td>
                          {row.subject ? <b>{row.subject}</b> : null}
                          <span className="table-sub">{row.entityLabel}</span>
                        </td>
                        <td>
                          <Tone tone={ORIGIN_TONE[row.origin] ?? "muted"}>{row.originLabel}</Tone>
                        </td>
                        <td className="align-right">
                          {row.details.length > 0 && (
                            <button
                              className="button button-secondary audit-toggle"
                              type="button"
                              aria-expanded={open}
                              aria-controls={detailId}
                              onClick={() => setExpanded(open ? null : row.key)}
                            >
                              {open ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
                              {open ? "Ocultar" : "Ver detalle"}
                            </button>
                          )}
                        </td>
                      </tr>
                      {open && (
                        <tr className="audit-detail-row" id={detailId}>
                          <td colSpan={HEADERS.length}>
                            <dl className="audit-detail">
                              {row.details.map((detail, index) => (
                                <div key={`${detail.label}-${index}`} className="audit-detail-item">
                                  <dt>{detail.label}</dt>
                                  <dd>
                                    {detail.value !== undefined ? (
                                      detail.value
                                    ) : (
                                      <>
                                        <span className="audit-before">{detail.before ?? "—"}</span>
                                        <span aria-hidden="true" className="audit-arrow">→</span>
                                        <span className="sr-only"> cambió a </span>
                                        <b>{detail.after ?? "—"}</b>
                                      </>
                                    )}
                                  </dd>
                                </div>
                              ))}
                            </dl>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {(load.nextCursor || moreError) && (
            <div className="audit-more">
              {moreError && <p className="field-error connected-feedback" role="alert">{moreError}</p>}
              {load.nextCursor && (
                <button className="button button-secondary" type="button" disabled={moreBusy} onClick={() => void loadMore()}>
                  {moreBusy ? "Cargando…" : "Cargar más"}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
