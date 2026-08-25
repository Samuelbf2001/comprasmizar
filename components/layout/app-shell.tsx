"use client";

import {
  ArrowRight,
  BarChart3,
  Bell,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Database,
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
import { DemoNotice } from "../ui/demo-notice";
import { navigation, type Role } from "../../lib/demo-data";
import { logout } from "../../app/auth-actions";

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
export const roleAllowed: Record<Role, string[]> = {
  Solicitante: [
    "/",
    "/requisiciones/nueva",
    "/requisiciones/mis",
    "/mensajes",
    "/ayuda",
  ],
  Revisor: navigation.map((item) => item.href),
  Aprobador: ["/", "/aprobaciones", "/mensajes", "/ayuda"],
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
    "/catalogos",
    "/proveedores",
    "/reportes",
    "/mensajes",
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
  setRole: (role: Role) => void;
  demoMode: boolean;
  actorName?: string;
}) {
  const allowed = roleAllowed[role];
  const isAllowed = (href: string) => allowed.includes(href);
  const identity = demoMode
    ? roleNames[role]
    : actorName || "Usuario autenticado";
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
            <PanelLeftClose size={17} />
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
            <ChevronDown size={14} />
          </label>
        ) : (
          <div className="role-switch role-production">
            <span className="avatar">{roleInitials[role]}</span>
            <span>
              <small>Sesión autenticada</small>
              <b>{identity}</b>
            </span>
          </div>
        )}
        <nav className="nav-main" aria-label="Navegación principal">
          {navigation
            .filter((item) => isAllowed(item.href))
            .map((item) => {
              const Icon = navIcons[item.icon] || LayoutDashboard;
              return (
                <button
                  key={item.href}
                  className={currentHref === item.href ? "is-active" : ""}
                  onClick={() => onNavigate(item.href)}
                  type="button"
                >
                  <Icon size={17} />
                  <span>{item.label}</span>
                  {item.badge && <i className="nav-badge">{item.badge}</i>}
                </button>
              );
            })}
        </nav>
        <div className="nav-divider" />
        <nav className="nav-secondary">
          {role === "Administrador Sixteam" && (
            <button
              className={
                pathname.startsWith("/configuracion") ? "is-active" : ""
              }
              onClick={() => onNavigate("/configuracion")}
              type="button"
            >
              <Settings size={17} />
              <span>Configuración</span>
            </button>
          )}
          <button
            className={pathname.startsWith("/ayuda") ? "is-active" : ""}
            onClick={() => onNavigate("/ayuda")}
            type="button"
          >
            <HelpCircle size={17} />
            <span>Ayuda</span>
          </button>
        </nav>
        <div className="sidebar-foot">
          <div className="secure-label">
            <ShieldCheck size={14} />
            <span>
              {demoMode ? "Modo demo · sin persistencia" : "Sesión protegida"}
            </span>
          </div>
          <form action={logout}>
            <button className="logout-button" type="submit">
              <LogOut size={15} /> Cerrar sesión
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
      />
      <main className="main-area">
        <header className="topbar">
          <button
            className="mobile-menu icon-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Abrir menú"
            type="button"
          >
            <Menu size={20} />
          </button>
          <div className="breadcrumbs">
            <span>Plataforma</span>
            <ArrowRight size={13} />
            <b>{currentLabel}</b>
          </div>
          <div className="topbar-actions">
            {demoMode && <DemoNotice compact />}
            <button
              className="icon-button notification"
              aria-label="Ver notificaciones"
              type="button"
            >
              <Bell size={18} />
              <i />
            </button>
            <button
              className="profile-button"
              type="button"
              aria-label={`Perfil de ${identity}`}
            >
              <span className="avatar">{roleInitials[role]}</span>
              <span>{identity}</span>
              <ChevronDown size={14} />
            </button>
          </div>
        </header>
        <div className="content-wrap">{children}</div>
      </main>
    </div>
  );
}
