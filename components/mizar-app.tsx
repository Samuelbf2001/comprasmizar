"use client";

import { usePathname, useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import dynamic from "next/dynamic";
import { Inbox, TriangleAlert } from "lucide-react";
import { navigation, type Role } from "../lib/demo-data";
import { AppShell, roleAllowed } from "./layout/app-shell";
import { SectionTitle } from "./screens/screen-primitives";
// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): antes este archivo importaba
// TODAS las pantallas (demo y conectadas) de forma estática, así que cualquier rol en
// cualquier ruta descargaba el bundle completo. Ahora:
//   - ConnectedScreen/isConnectedReadRoute se importan directo de screen.tsx/data.ts (no del
//     barrel components/screens/connected.tsx) para no arrastrar ni los tipos de las
//     pantallas pesadas.
//   - Las pantallas demo (DashboardScreen, workflow, operations, reports-admin) viven en el
//     barrel ./screens/demo-screens y se cargan una por una con next/dynamic; en producción
//     (demoMode=false) NINGUNA de ellas llega a pedirse.
//   - MessagesScreen y SuppliersScreen se usan en ambos modos pero rara vez las dos a la vez
//     en la misma sesión; PublicRequestScreen/MobilePublicRequestScreen solo en el portal
//     público. Las cuatro se difieren igual con next/dynamic.
// Sin `loading`: estas pantallas no tienen esqueleto propio (RF-1105 solo cubre las rutas
// conectadas, ver components/screens/connected/screen.tsx) y son ligeras; un fallback nulo
// evita inventar un esqueleto nuevo solo para este caso (ver aprendizaje "pantallas sin
// esqueleto equivalente" del encargo).
import { ConnectedScreen } from "./screens/connected/screen";
import { isConnectedReadRoute } from "./screens/connected/data";

const PublicRequestScreen = dynamic(
  () => import("./screens/public-request").then((mod) => mod.PublicRequestScreen),
  { loading: () => null },
);
const PublicRequestRedirect = dynamic(
  () =>
    import("./screens/public-request").then(
      (mod) => mod.PublicRequestRedirect,
    ),
  { loading: () => null },
);
const MessagesScreen = dynamic(
  () => import("./screens/messages").then((mod) => mod.MessagesScreen),
  { loading: () => null },
);
const SuppliersScreen = dynamic(
  () => import("./screens/suppliers").then((mod) => mod.SuppliersScreen),
  { loading: () => null },
);
const DemoRequisitionScreen = dynamic(
  () =>
    import("./screens/connected/new-requisition").then(
      (mod) => mod.DemoRequisitionScreen,
    ),
  { loading: () => null },
);
const DashboardScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.DashboardScreen),
  { loading: () => null },
);
const ReviewScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.ReviewScreen),
  { loading: () => null },
);
const ApprovalsScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.ApprovalsScreen),
  { loading: () => null },
);
const RequestDetailScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.RequestDetailScreen),
  { loading: () => null },
);
const OrdersScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.OrdersScreen),
  { loading: () => null },
);
const ExpensesScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.ExpensesScreen),
  { loading: () => null },
);
const ReportsScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.ReportsScreen),
  { loading: () => null },
);
const AdminScreen = dynamic(
  () => import("./screens/demo-screens").then((mod) => mod.AdminScreen),
  { loading: () => null },
);

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
          <li>Autenticación y permisos por rol</li>
          <li>Servicios de requisiciones, órdenes y gastos</li>
          <li>Auditoría y exportación contable</li>
        </ul>
      </div>
    </>
  );
}

const DEMO_ROLE_STORAGE_KEY = "mizar-demo-role";
// Clave aparte del rol demo: en producción guarda solo la LENTE "Ver como" del Administrador
// Sixteam, nunca el rol real de la sesión (ese lo resuelve el servidor en cada petición).
const VIEW_AS_ROLE_STORAGE_KEY = "mizar-ver-como-role";
// sessionStorage como store externo: en SSR/hidratación devuelve null (sin mismatch)
// y en cliente entrega el rol persistido tras cada remontaje de ruta.
const subscribeToNothing = () => () => {};
const getServerStoredRole = () => null;
function readStoredRole(key: string): Role | null {
  try {
    const stored = window.sessionStorage.getItem(key);
    return stored && stored in roleAllowed ? (stored as Role) : null;
  } catch {
    // sessionStorage no disponible (p.ej. modo privado estricto).
    return null;
  }
}
const readStoredDemoRole = () => readStoredRole(DEMO_ROLE_STORAGE_KEY);
const readStoredViewAsRole = () => readStoredRole(VIEW_AS_ROLE_STORAGE_KEY);

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
    getServerStoredRole,
  );
  const storedViewAsRole = useSyncExternalStore(
    subscribeToNothing,
    readStoredViewAsRole,
    getServerStoredRole,
  );
  const [roleOverride, setRoleOverride] = useState<Role | null>(null);
  // Rol REAL: el que trae la sesión (o el elegido en el selector demo). "Ver como" NUNCA lo
  // toca, porque de él dependen la visibilidad del propio control y la identidad mostrada;
  // si se sobrescribiera, mirar como "Contabilidad" escondería el selector y dejaría al
  // Administrador Sixteam atrapado sin forma de volver a su vista.
  const realRole: Role = demoMode
    ? (roleOverride ?? storedDemoRole ?? initialRole)
    : initialRole;
  // La lente solo existe en producción y solo para Administrador Sixteam. Es presentación
  // pura: el servidor sigue autorizando con el rol de la sesión (lib/domain/rules.ts +
  // requireServerActor()), así que esto no otorga ni recorta permisos reales.
  const canViewAs = !demoMode && realRole === "Administrador Sixteam";
  const role: Role = canViewAs
    ? ((roleOverride ?? storedViewAsRole) ?? realRole)
    : realRole;
  const changeRole = (next: Role) => {
    if (!demoMode && !canViewAs) return;
    setRoleOverride(next);
    try {
      // MizarApp se remonta en cada navegación de ruta: sin persistir, el rol elegido
      // (demo o lente) se perdería al primer clic del menú.
      window.sessionStorage.setItem(
        demoMode ? DEMO_ROLE_STORAGE_KEY : VIEW_AS_ROLE_STORAGE_KEY,
        next,
      );
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
  // Ruta heredada: había un formulario móvil aparte y su URL se repartió en el archivo de enlaces
  // que tiene el cliente. Ahora el formulario es uno solo y responsive, así que esta ruta solo
  // reenvía. El reenvío es de CLIENTE a propósito: la obra y el token viajan en el fragmento `#`,
  // que el navegador nunca envía al servidor — un redirect de servidor los perdería y mataría
  // todos los enlaces móviles ya repartidos.
  if (pathname === "/requisiciones/publica-movil") return <PublicRequestRedirect />;
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
    content = <ConnectedScreen pathname={pathname} role={role} viewingAs={role === realRole ? null : role} go={go} />;
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
      realRole={realRole}
      setRole={changeRole}
      demoMode={demoMode}
      actorName={actorName}
    >
      {content}
    </AppShell>
  );
}
