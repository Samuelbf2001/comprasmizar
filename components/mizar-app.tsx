"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { navigation, type Role } from "../lib/demo-data";
import { AppShell, roleAllowed } from "./layout/app-shell";
import { PublicRequestScreen } from "./screens/public-request";
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
      <span className="empty-icon">!</span>
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
          <span className="empty-icon">—</span>
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
        <span className="empty-icon">—</span>
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
  const [role, setRole] = useState<Role>(initialRole);
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
  const current =
    navigation.find(
      (item) => item.href !== "/" && pathname.startsWith(item.href),
    ) || navigation[0];
  const allowed = roleAllowed[role];
  const routeKey = pathname.startsWith("/configuracion")
    ? "/configuracion"
    : current.href;
  const routeIsAllowed =
    role === "Administrador Sixteam"
      ? pathname.startsWith("/configuracion") || allowed.includes(current.href)
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
      currentHref={current.href}
      currentLabel={current.label}
      pathname={pathname}
      onNavigate={go}
      sidebarOpen={sidebarOpen}
      setSidebarOpen={setSidebarOpen}
      role={role}
      setRole={setRole}
      demoMode={demoMode}
      actorName={actorName}
    >
      {content}
    </AppShell>
  );
}
