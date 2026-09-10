"use client";

// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): ConnectedScreen, partido de
// components/screens/connected.tsx. Misma lógica, mismos nombres (estados loading/error/ready
// + revalidating, aria-busy, barra de revalidación y el caso especial catalogs + error +
// "Administrador Mizar" se conservan intactos).
//
// DECISIÓN Suspense vs `loading`: a diferencia de dashboard.tsx (donde el fallback de los
// gráficos es fijo, solo `.skeleton-chart`), aquí el fallback correcto depende de valores que
// solo existen en el render (`kind`, `pathname`) — RouteSkeleton los necesita para elegir el
// esqueleto y el título de cada ruta (ver bandejaTitle/expensesTitle en skeletons.tsx). La
// opción `loading` de next/dynamic NO puede recibir esos props (Loadable solo le pasa
// isLoading/pastDelay/error, ver node_modules/next/dist/shared/lib/lazy-dynamic/loadable.js),
// así que aquí se envuelve a mano en <Suspense fallback={<RouteSkeleton kind={kind}
// pathname={pathname} />}> — la alternativa que la propia guía de Next documenta
// (node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md, "Skipping SSR"). Cada
// dynamic() de abajo se deja sin `loading` a propósito: sin él y con `ssr` en su valor por
// defecto (true) Next NO crea su propia frontera de Suspense, así que sin este <Suspense>
// explícito una pantalla nueva (chunk aún no descargado) rompería el árbol en vez de mostrar
// el esqueleto de su ruta.
import { Suspense, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { SectionTitle } from "../screen-primitives";
import { RouteSkeleton } from "../skeletons";
import { friendlyErrorText, isFriendlyApiError } from "../../../lib/http/friendly-error";
import {
  emptyCatalogs,
  type CatalogData,
  type ConnectedProps,
  type DetailBundle,
  type ExpenseBundle,
  type LoadState,
  type OrdersBundle,
  type RequisitionsBundle,
} from "./shared";
import { getPersistedRoute, initialLoadState, loadRoute, routeKind, setCachedRoute } from "./data";

const ConnectedDashboard = dynamic(() =>
  import("./dashboard").then((mod) => mod.ConnectedDashboard),
);
const ConnectedNewRequisition = dynamic(() =>
  import("./new-requisition").then((mod) => mod.ConnectedNewRequisition),
);
const ConnectedRequisitions = dynamic(() =>
  import("./requisitions").then((mod) => mod.ConnectedRequisitions),
);
const ConnectedRequisitionDetail = dynamic(() =>
  import("./detail").then((mod) => mod.ConnectedRequisitionDetail),
);
const ConnectedOrders = dynamic(() =>
  import("./orders").then((mod) => mod.ConnectedOrders),
);
const ConnectedExpenses = dynamic(() =>
  import("./expenses").then((mod) => mod.ConnectedExpenses),
);
const ConnectedCatalogAdmin = dynamic(() =>
  import("../catalog-admin").then((mod) => mod.ConnectedCatalogAdmin),
);

export function ConnectedScreen({ pathname, role, go }: ConnectedProps) {
  const kind = useMemo(() => routeKind(pathname), [pathname]);
  const [version, setVersion] = useState(0);
  const [routeState, setRouteState] = useState(() => ({
    pathname,
    load: initialLoadState(pathname, kind),
  }));
  // Cambio de ruta: adopta de inmediato el cache (o el esqueleto) de la ruta nueva en
  // lugar de esperar al efecto de abajo. Sin esto habría un cuadro mostrando el
  // contenido de la ruta ANTERIOR bajo el `kind` de la ruta nueva. Es el patrón
  // documentado de React para "ajustar estado cuando cambia una prop".
  if (routeState.pathname !== pathname) {
    setRouteState({ pathname, load: initialLoadState(pathname, kind) });
  }
  const load =
    routeState.pathname === pathname
      ? routeState.load
      : initialLoadState(pathname, kind);
  const setLoad = (updater: LoadState | ((current: LoadState) => LoadState)) => {
    setRouteState((current) => ({
      pathname: current.pathname,
      load:
        typeof updater === "function"
          ? (updater as (value: LoadState) => LoadState)(current.load)
          : updater,
    }));
  };
  // RF-1105: refrescar (manual o tras aprobar/declinar/crear, ver `mutate`) NUNCA borra
  // datos ya visibles: si hay datos previos se marcan `revalidating` (stale-while-
  // revalidate); solo si no hay nada que mostrar cae al esqueleto de carga.
  const refresh = () => {
    setLoad((current) =>
      current.state === "ready"
        ? { ...current, revalidating: true }
        : kind
          ? { state: "loading", kind }
          : current,
    );
    setVersion((value) => value + 1);
  };
  // H6 (respaldo en sessionStorage) sin romper la hidratación: el estado inicial de arriba solo
  // mira la caché en memoria, que en el servidor y en el primer render del cliente vale lo mismo
  // (vacía tras una recarga). Aquí, ya montados y solo en cliente, se adopta la entrada persistida
  // si la ruta sigue en "loading": pinta el contenido guardado y deja que el efecto de abajo
  // revalide en segundo plano, igual que con la caché en memoria.
  useEffect(() => {
    if (!kind) return;
    const persisted = getPersistedRoute(pathname);
    if (!persisted) return;
    setRouteState((current) =>
      current.pathname === pathname && current.load.state === "loading"
        ? { pathname, load: { state: "ready", data: persisted.data, revalidating: true } }
        : current,
    );
  }, [pathname, kind]);
  useEffect(() => {
    if (!kind) return;
    let active = true;
    void loadRoute(pathname, role)
      .then((data) => {
        if (!active) return;
        setCachedRoute(pathname, kind, data);
        setLoad({ state: "ready", data, revalidating: false });
      })
      .catch((error) => {
        if (!active) return;
        setLoad((current) =>
          // Si ya había datos visibles (revalidación fallida), se conservan tal cual:
          // no se tapa un dashboard de dinero con un error por un fallo de red pasajero.
          current.state === "ready"
            ? { ...current, revalidating: false }
            : {
                state: "error",
                message: friendlyErrorText(error, "No fue posible consultar el servicio."),
                friendly: isFriendlyApiError(error) ? error.friendly : undefined,
              },
        );
      });
    return () => {
      active = false;
    };
  }, [pathname, role, version, kind]);
  if (!kind) return null;
  if (load.state === "loading")
    return <RouteSkeleton kind={load.kind} pathname={pathname} />;
  if (
    load.state === "error" &&
    kind === "catalogs" &&
    role === "Administrador Mizar"
  )
    return (
      <Suspense fallback={<RouteSkeleton kind="catalogs" pathname={pathname} />}>
        <ConnectedCatalogAdmin
          pathname={pathname}
          role={role}
          initialData={emptyCatalogs}
        />
      </Suspense>
    );
  if (load.state === "error")
    return (
      <>
        <SectionTitle
          eyebrow="Sesión autenticada"
          title="Datos no disponibles"
          description={`Rol activo: ${role}`}
        />
        <div className="panel state-panel" role="alert">
          <span className="empty-icon"><TriangleAlert aria-hidden="true" size={21} /></span>
          <h3>{load.friendly?.title ?? "No pudimos cargar esta vista"}</h3>
          <p>{load.friendly?.message ?? load.message}</p>
          {load.friendly?.solution && (
            <p className="state-panel-hint">{load.friendly.solution}</p>
          )}
          <div className="button-row">
            <button
              className="button button-dark"
              type="button"
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" size={15} /> Reintentar
            </button>
            {load.friendly?.action?.kind === "link" && (
              <a className="button button-secondary" href={load.friendly.action.href}>
                {load.friendly.action.label}
              </a>
            )}
          </div>
        </div>
      </>
    );
  const revalidating = load.revalidating;
  return (
    <div
      aria-busy={revalidating}
      className={revalidating ? "is-revalidating" : undefined}
    >
      {revalidating && (
        <>
          <div className="revalidating-bar" aria-hidden="true" />
          <span className="sr-only" role="status">
            Actualizando información…
          </span>
        </>
      )}
      <Suspense fallback={<RouteSkeleton kind={kind} pathname={pathname} />}>
        {kind === "dashboard" && (
          <ConnectedDashboard data={load.data} go={go} />
        )}
        {kind === "new" && (
          <ConnectedNewRequisition catalogs={load.data as CatalogData} go={go} />
        )}
        {kind === "detail" && (
          <ConnectedRequisitionDetail
            data={load.data as DetailBundle}
            role={role}
            go={go}
            refresh={refresh}
          />
        )}
        {kind === "requisitions" && (
          <ConnectedRequisitions
            data={load.data as RequisitionsBundle}
            pathname={pathname}
            go={go}
          />
        )}
        {kind === "orders" && (
          <ConnectedOrders
            data={load.data as OrdersBundle}
            role={role}
            refresh={refresh}
            go={go}
          />
        )}
        {kind === "catalogs" && (
          <ConnectedCatalogAdmin
            pathname={pathname}
            role={role}
            initialData={load.data as CatalogData}
          />
        )}
        {kind === "expenses" && (
          <ConnectedExpenses
            data={load.data as ExpenseBundle}
            pathname={pathname}
            role={role}
            refresh={refresh}
          />
        )}
      </Suspense>
    </div>
  );
}
