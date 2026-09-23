"use client";

import {
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Database,
  Eye,
  FileCheck2,
  HelpCircle,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  PanelLeftClose,
  PlusCircle,
  Receipt,
  Settings,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DemoNotice } from "../ui/demo-notice";
import { navigation, type Role } from "../../lib/demo-data";
import { logout } from "../../app/auth-actions";
// Cerrar sesión vacía las cachés de cliente ANTES de salir: la siguiente cuenta que entre en esta
// pestaña no hereda permisos ni datos (ver `vincularCachesAlVisor` en connected/data.ts).
import { olvidarCachesDelVisor } from "../screens/connected/data";

const roleNames: Record<Role, string> = {
  Solicitante: "Juliana Rojas",
  Revisor: "Daniel Hernández",
  Aprobador: "Nelson Rincón",
  Contabilidad: "Equipo contable",
  "Administrador Mizar": "Claudia · Mizar",
  "Administrador Sixteam": "Samuel · Sixteam",
};
const roleInitials: Record<Role, string> = {
  Solicitante: "JR",
  Revisor: "DH",
  Aprobador: "NR",
  Contabilidad: "EC",
  "Administrador Mizar": "CM",
  "Administrador Sixteam": "SS",
};
// roleAllowed se construye con TODOS los hrefs de `navigation`, incluidos los que llevaran
// `hidden`: ocultar una entrada del menú no debe quitarle la ruta a ningún rol.
// "/gastos" es "Cierre de caja" (adenda A10): la ven los roles con "expense:read" en el servidor
// (lib/domain/rules.ts) — Revisor, Contabilidad, Administrador Mizar y Administrador Sixteam. El
// Aprobador ve Reportes pero NO el cierre: no tiene ese permiso y la pantalla le respondería 403.
export const roleAllowed: Record<Role, string[]> = {
  Solicitante: [
    "/",
    "/requisiciones/nueva",
    "/requisiciones/mis",
    "/mensajes",
    "/ayuda",
  ],
  Revisor: navigation.map((item) => item.href),
  // RF-1301 (reunión 2026-09-11): Juliana (aprobadora) pidió ver "todo lo que aprobé este mes" desde
  // Reportes — hasta hoy el rol no tenía la ruta. El servidor sigue acotando qué ve dentro de ella
  // (visibilidad por `public.es_aprobador_de`, ver lib/services/report-service.ts): esto solo abre la
  // puerta del menú, no el alcance de datos.
  Aprobador: ["/", "/aprobaciones", "/reportes", "/mensajes", "/ayuda"],
  Contabilidad: [
    "/",
    "/ordenes",
    "/gastos",
    "/proveedores",
    "/reportes",
    "/mensajes",
    "/ayuda",
  ],
  "Administrador Mizar": [
    "/",
    "/gastos",
    "/catalogos",
    "/proveedores",
    "/reportes",
    "/mensajes",
    // RF-1401: Configuración no vive en `navigation` (es un ítem aparte, ver nav-secondary más
    // abajo) — sin este href explícito, mizar-app.tsx negaría el acceso a este rol aunque el botón
    // ya se muestre para él.
    "/configuracion",
    "/ayuda",
  ],
  "Administrador Sixteam": navigation.map((item) => item.href),
};
const navIcons = {
  LayoutDashboard,
  PlusCircle,
  ClipboardList,
  Inbox,
  CheckCircle2,
  FileCheck2,
  Receipt,
  Database,
  Truck,
  MessageSquare,
  BarChart3,
} as Record<string, typeof LayoutDashboard>;

export function AppShell({
  children,
  currentHref,
  currentLabel,
  pathname,
  onNavigate,
  sidebarOpen,
  setSidebarOpen,
  role,
  realRole,
  setRole,
  demoMode,
  actorName,
}: {
  children: React.ReactNode;
  currentHref: string;
  currentLabel: string;
  pathname: string;
  onNavigate: (href: string) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  role: Role;
  realRole: Role;
  setRole: (role: Role) => void;
  demoMode: boolean;
  actorName?: string;
}) {
  const allowed = roleAllowed[role];
  const isAllowed = (href: string) => allowed.includes(href);
  const identity = demoMode
    ? roleNames[role]
    : actorName || "Usuario autenticado";
  // "Ver como" es una LENTE DE PRESENTACIÓN, no un cambio de permisos: solo altera qué pinta
  // este cliente. La autorización real vive en el servidor (lib/domain/rules.ts le da "*" a
  // admin_sixteam y requireServerActor() resuelve el rol desde la sesión, no desde aquí), así
  // que mirar como "Contabilidad" no recorta lo que el servidor deja hacer ni al revés.
  // La visibilidad del control se decide con el rol REAL: si se decidiera con `role`, al mirar
  // como otro rol el selector desaparecería y el usuario quedaría atrapado sin poder volver.
  const canViewAs = !demoMode && realRole === "Administrador Sixteam";
  const viewingAs = canViewAs && role !== realRole;
  // El avatar representa siempre la sesión real, no el rol que se está mirando.
  const avatarRole = demoMode ? role : realRole;

  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  // Cierra el menú de perfil con click afuera y con Escape (devolviendo el foco al botón).
  useEffect(() => {
    if (!profileMenuOpen) return;
    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        profileMenuRef.current?.contains(target) ||
        profileButtonRef.current?.contains(target)
      ) {
        return;
      }
      setProfileMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileMenuOpen(false);
        profileButtonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [profileMenuOpen]);

  // Cierra el sidebar móvil con Escape mientras está abierto (además del scrim).
  useEffect(() => {
    if (!sidebarOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSidebarOpen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [sidebarOpen, setSidebarOpen]);

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <div className="brand">
          <span className="brand-mark">M</span>
          <span>
            <b>MIZAR</b>
            <small>Control de obra</small>
          </span>
          <button
            className="sidebar-close icon-button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Cerrar menú"
            type="button"
          >
            <PanelLeftClose aria-hidden="true" size={17} />
          </button>
        </div>
        {demoMode ? (
          <label className="role-switch">
            <span className="avatar">{roleInitials[role]}</span>
            <span>
              <small>Rol demo</small>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
                aria-label="Cambiar rol demo"
              >
                {Object.keys(roleNames).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
              <b>{identity}</b>
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </label>
        ) : canViewAs ? (
          <label
            className={`role-switch role-view-as ${viewingAs ? "is-lens" : ""}`}
          >
            <span className="avatar">{roleInitials[avatarRole]}</span>
            <span>
              <small>
                <Eye aria-hidden="true" size={11} /> Ver como
              </small>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
                aria-label="Ver la plataforma como otro rol"
              >
                {Object.keys(roleNames).map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
              <b>{identity}</b>
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </label>
        ) : (
          <div className="role-switch role-production">
            <span className="avatar">{roleInitials[avatarRole]}</span>
            <span>
              <small>Sesión autenticada</small>
              <b>{identity}</b>
            </span>
          </div>
        )}
        {viewingAs && (
          <p className="view-as-flag">
            <span role="status">
              Viendo como <b>{role}</b> · tu sesión sigue siendo {realRole}
            </span>
            <button type="button" onClick={() => setRole(realRole)}>
              Volver a mi rol
            </button>
          </p>
        )}
        <nav className="nav-main" aria-label="Navegación principal">
          {navigation
            .filter((item) => !item.hidden && isAllowed(item.href))
            .map((item) => {
              const Icon = navIcons[item.icon] || LayoutDashboard;
              const label = demoMode
                ? item.label
                : item.genericLabel ?? item.label;
              return (
                <button
                  key={item.href}
                  className={currentHref === item.href ? "is-active" : ""}
                  onClick={() => onNavigate(item.href)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={17} />
                  <span>{label}</span>
                  {demoMode && item.badge && (
                    <i className="nav-badge">{item.badge}</i>
                  )}
                </button>
              );
            })}
        </nav>
        <div className="nav-divider" />
        <nav className="nav-secondary">
          {(role === "Administrador Sixteam" || role === "Administrador Mizar") && (
            <button
              className={
                pathname.startsWith("/configuracion") ? "is-active" : ""
              }
              onClick={() => onNavigate("/configuracion")}
              type="button"
            >
              <Settings aria-hidden="true" size={17} />
              <span>Configuración</span>
            </button>
          )}
          <button
            className={pathname.startsWith("/ayuda") ? "is-active" : ""}
            onClick={() => onNavigate("/ayuda")}
            type="button"
          >
            <HelpCircle aria-hidden="true" size={17} />
            <span>Ayuda</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <div className="secure-label">
            <ShieldCheck aria-hidden="true" size={14} />
            <span>
              {demoMode ? "Modo demo · sin persistencia" : "Sesión protegida"}
            </span>
          </div>
          <form action={logout} onSubmit={olvidarCachesDelVisor}>
            <button className="logout-button" type="submit">
              <LogOut aria-hidden="true" size={15} /> Cerrar sesión
            </button>
          </form>
          <small>
            {demoMode ? "v0.8 · Fase de validación" : "Sesión autenticada"}
          </small>
        </div>
      </aside>
      <div
        className={`sidebar-scrim ${sidebarOpen ? "is-visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setSidebarOpen(false);
          }
        }}
        role="button"
        aria-label="Cerrar menú"
        tabIndex={sidebarOpen ? 0 : -1}
      />
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Abrir menú"
            type="button"
          >
            <Menu aria-hidden="true" size={20} />
          </button>
          <div className="breadcrumbs">
            <button
              type="button"
              className="breadcrumb-root"
              onClick={() => onNavigate("/")}
              title="Ir al inicio"
            >
              <span>Plataforma</span>
            </button>
            <ArrowRight aria-hidden="true" size={13} />
            <b>{currentLabel}</b>
          </div>
          <div className="topbar-actions">
            {demoMode && <DemoNotice compact />}
            <button
              className="icon-button notification"
              aria-label="Notificaciones"
              aria-disabled="true"
              title="Notificaciones · próximamente"
              type="button"
            >
              <Bell aria-hidden="true" size={18} />
              {demoMode && <i />}
            </button>
            <div className="profile-menu-wrap">
              <button
                ref={profileButtonRef}
                className="profile-button"
                type="button"
                aria-haspopup="menu"
                aria-expanded={profileMenuOpen}
                aria-label={`Perfil de ${identity}`}
                onClick={() => setProfileMenuOpen((value) => !value)}
              >
                <span className="avatar">{roleInitials[avatarRole]}</span>
                <span>{identity}</span>
                <ChevronDown aria-hidden="true" size={14} />
              </button>
              {profileMenuOpen && (
                <div
                  ref={profileMenuRef}
                  role="menu"
                  aria-label="Menú de perfil"
                  className="profile-menu"
                >
                  <button
                    type="button"
                    role="menuitem"
                    disabled
                    title="Próximamente"
                    className="profile-menu-item"
                  >
                    <span>Mi perfil</span>
                  </button>
                  <form action={logout} onSubmit={olvidarCachesDelVisor} role="none">
                    <button
                      type="submit"
                      role="menuitem"
                      className="profile-menu-item"
                    >
                      <LogOut aria-hidden="true" size={15} />
                      <span>Cerrar sesión</span>
                    </button>
                  </form>
                </div>
              )}
            </div>
          </div>
        </header>
        <div className="content-wrap">{children}</div>
      </main>
    </div>
  );
}
