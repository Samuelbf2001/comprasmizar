"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Inbox, TriangleAlert } from "lucide-react";
import { navigation, type Role } from "../lib/demo-data";
import { AppShell, roleAllowed } from "./layout/app-shell";
import { PublicRequestScreen } from "./screens/public-request";
import { MobilePublicRequestScreen } from "./screens/public-request-mobile";
import { DashboardScreen } from "./screens/dashboard";
import {
  ReviewScreen,
  ApprovalsScreen,
  RequestDetailScreen,
} from "./screens/workflow";
import { OrdersScreen, ExpensesScreen } from "./screens/operations";
import { ReportsScreen, AdminScreen } from "./screens/reports-admin";
import { MessagesScreen } from "./screens/messages";
import { SectionTitle } from "./screens/screen-primitives";
import {
  ConnectedScreen,
  DemoRequisitionScreen,
  isConnectedReadRoute,
} from "./screens/connected";
import { SuppliersScreen } from "./screens/suppliers";

function AccessDenied({
  go,
  role,
  demoMode,
}: {
  go: (path: string) => void;
  role: Role;
  demoMode: boolean;
}) {
  return (
    <div className="state-panel panel access-denied" role="alert">
      <span className="empty-icon">
        <TriangleAlert aria-hidden="true" size={21} />
      </span>
      <h3>Sin acceso con este rol</h3>
      <p>
        La vista solicitada no está disponible para <b>{role}</b>
        {demoMode ? " en este modo de demostración" : ""}.
      </p>
      {role === "Administrador Mizar" && (
        <p className="gate-copy">
          <b>Gate de autoservicio:</b> catálogos y normalización permanecen
          disponibles solo para Administrador Sixteam hasta habilitar la fase
          Completo.
        </p>
      )}
      <button
        className="button button-dark"
        type="button"
        onClick={() => go("/")}
      >
        Volver al inicio
      </button>
    </div>
  );
}

function Placeholder({
  title,
  eyebrow = "Módulo demo",
}: {
  title: string;
  eyebrow?: string;
}) {
  return (
    <>
      <SectionTitle
        eyebrow={eyebrow}
        title={title}
        description="Esta pantalla es navegable en demo; aún no persiste cambios."
      />
      <div className="panel">
        <div className="empty-state">
          <span className="empty-icon">
            <Inbox aria-hidden="true" size={21} />
          </span>
          <h3>Sin datos conectados</h3>
          <p>La integración real se habilitará con el servicio de negocio.</p>
        </div>
      </div>
    </>
  );
}
function IntegrationGate({ role }: { role: Role }) {
  return (
    <>
      <SectionTitle
        eyebrow="Sesión autenticada"
        title="Integración pendiente"
        description={`Tu sesión tiene el rol ${role}, pero esta instalación aún no expone datos conectados.`}
      />
      <div className="panel integration-gate" role="status">
        <span className="empty-icon">
          <Inbox aria-hidden="true" size={21} />
        </span>
        <h2>Datos no disponibles en este entorno</h2>
        <p>
          No se muestran cifras sintéticas fuera del modo demo. Configura y
          valida los servicios de negocio, RLS y auditoría antes de habilitar la
          operación.
        </p>
        <ul>
          <li>Supabase/Auth y permisos por rol</li>
          <li>Servicios de requisiciones, órdenes y gastos</li>
          <li>Auditoría y exportación contable</li>
        </ul>
      </div>
    </>
  );
}

const DEMO_ROLE_STORAGE_KEY = "mizar-demo-role";
// sessionStorage como store externo: en SSR/hidratación devuelve null (sin mismatch)
// y en cliente entrega el rol demo persistido tras cada remontaje de ruta.
const subscribeToNothing = () => () => {};
const getServerDemoRole = () => null;
function readStoredDemoRole(): Role | null {
  try {
    const stored = window.sessionStorage.getItem(DEMO_ROLE_STORAGE_KEY);
    return stored && stored in roleAllowed ? (stored as Role) : null;
  } catch {
    // sessionStorage no disponible (p.ej. modo privado estricto).
    return null;
  }
}

export default function MizarApp({
  initialRole = "Revisor",
  demoMode = false,
  actorName,
  publicConfigured = false,
}: {
  initialRole?: Role;
  demoMode?: boolean;
  actorName?: string;
  publicConfigured?: boolean;
}) {
  const pathname = usePathname() || "/";
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // El componente se remonta en cada navegación de ruta y el useState perdía el rol demo:
  // el rol elegido se persiste en sessionStorage y se relee tras cada montaje.
  const storedDemoRole = useSyncExternalStore(
    subscribeToNothing,
    readStoredDemoRole,
    getServerDemoRole,
  );
  const [roleOverride, setRoleOverride] = useState<Role | null>(null);
  const role: Role =
    roleOverride ?? (demoMode ? (storedDemoRole ?? initialRole) : initialRole);
  const changeRole = (next: Role) => {
    setRoleOverride(next);
    if (!demoMode) return;
    try {
      window.sessionStorage.setItem(DEMO_ROLE_STORAGE_KEY, next);
    } catch {
      // Sin persistencia disponible el selector sigue funcionando durante la vista actual.
    }
  };
  const go = (path: string) => {
    setSidebarOpen(false);
    router.push(path as never);
  };
  if (pathname === "/requisiciones/publica")
    return (
      <PublicRequestScreen
        demoMode={demoMode}
        publicConfigured={publicConfigured}
      />
    );
  if (pathname === "/requisiciones/publica-movil")
    return (
      <MobilePublicRequestScreen
        demoMode={demoMode}
        publicConfigured={publicConfigured}
      />
    );
  const allowed = roleAllowed[role];
  // Ítem de navegación cuyo href es prefijo (por segmentos) del pathname; gana el más largo.
  const navMatch = navigation.reduce<(typeof navigation)[number] | undefined>(
    (best, item) => {
      if (item.href === "/") return best;
      if (pathname !== item.href && !pathname.startsWith(`${item.href}/`))
        return best;
      return !best || item.href.length > best.href.length ? item : best;
    },
    undefined,
  );
  const isHome = pathname === "/" || pathname === "/inicio";
  // Detalle de requisición (/requisiciones/REQ-…): ningún href de navegación lo prefija.
  const isRequisitionDetail =
    !navMatch && pathname.startsWith("/requisiciones/");
  const detailParentHref = ["/revision", "/requisiciones/mis"].find((href) =>
    allowed.includes(href),
  );
  const detailParent = isRequisitionDetail
    ? navigation.find((item) => item.href === detailParentHref)
    : undefined;
  const currentHref = isHome
    ? "/"
    : (navMatch?.href ?? detailParent?.href ?? pathname);
  const currentLabel = isHome
    ? navigation[0].label
    : navMatch
      ? demoMode
        ? navMatch.label
        : (navMatch.genericLabel ?? navMatch.label)
      : isRequisitionDetail
        ? decodeURIComponent(pathname.split("/")[2] || "") ||
          (detailParent?.label ?? "Requisición")
        : pathname.startsWith("/configuracion")
          ? "Configuración"
          : pathname.startsWith("/ayuda")
            ? "Ayuda"
            : navigation[0].label;
  // Control de acceso: misma semántica de antes (rutas sin ítem de navegación caen a "/").
  const accessHref = navMatch?.href ?? "/";
  const routeKey = pathname.startsWith("/configuracion")
    ? "/configuracion"
    : accessHref;
  const routeIsAllowed =
    role === "Administrador Sixteam"
      ? pathname.startsWith("/configuracion") || allowed.includes(accessHref)
      : allowed.includes(routeKey);
  let content: React.ReactNode;
  if (!routeIsAllowed)
    content = <AccessDenied go={go} role={role} demoMode={demoMode} />;
  else if (!demoMode && pathname.startsWith("/mensajes"))
    content = <MessagesScreen />;
  else if (pathname.startsWith("/proveedores"))
    content = <SuppliersScreen role={role} demoMode={demoMode} />;
  else if (!demoMode && isConnectedReadRoute(pathname))
    content = <ConnectedScreen pathname={pathname} role={role} go={go} />;
  else if (!demoMode) content = <IntegrationGate role={role} />;
  else if (pathname === "/" || pathname === "/inicio")
    content = <DashboardScreen go={go} />;
  else if (pathname === "/requisiciones/nueva")
    content = <DemoRequisitionScreen />;
  else if (pathname.startsWith("/requisiciones/mis"))
    content = <Placeholder title="Mis requisiciones" eyebrow="Solicitante" />;
  else if (pathname.startsWith("/requisiciones/"))
    content = (
      <RequestDetailScreen id={pathname.split("/").pop() || ""} go={go} />
    );
  else if (pathname.startsWith("/revision")) content = <ReviewScreen go={go} />;
  else if (pathname.startsWith("/aprobaciones"))
    content = <ApprovalsScreen go={go} />;
  else if (pathname.startsWith("/ordenes")) content = <OrdersScreen />;
  else if (pathname.startsWith("/gastos")) content = <ExpensesScreen role={role} />;
  else if (pathname.startsWith("/catalogos"))
    content = <AdminScreen role={role} />;
  else if (pathname.startsWith("/reportes"))
    content = <ReportsScreen go={go} />;
  else if (pathname.startsWith("/mensajes")) content = <MessagesScreen />;
  else if (pathname.startsWith("/configuracion"))
    content = (
      <Placeholder title="Configuración" eyebrow="Administración Sixteam" />
    );
  else if (pathname.startsWith("/ayuda"))
    content = <Placeholder title="Centro de ayuda" eyebrow="Ayuda" />;
  else content = <DashboardScreen go={go} />;
  return (
    <AppShell
      currentHref={currentHref}
      currentLabel={currentLabel}
      pathname={pathname}
      onNavigate={go}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      role={role}
      setRole={changeRole}
      demoMode={demoMode}
      actorName={actorName}
    >
      {content}
    </AppShell>
  );
}
