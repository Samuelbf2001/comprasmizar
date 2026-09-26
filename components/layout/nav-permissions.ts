"use client";

import { useEffect, useState } from "react";
import type { Role } from "../../lib/demo-data";
import { resolveRolePermissions, WILDCARD_PERMISSION } from "../../lib/domain/rules";
import { DOMAIN_ROLE, type ViewerPermissions } from "../screens/connected/shared";
import { loadCatalogsBootstrap, peekCatalogs } from "../screens/connected/data";

/**
 * 25-sep-2026 («Daniel puede hacer todo»): el menú y el acceso a las rutas de administración dejan de
 * decidirse por el NOMBRE del rol de sesión y pasan a decidirse por PERMISO EFECTIVO, el mismo que
 * usa el servidor. Daniel (revisor + aprobador) entra a Configuración y al Historial de cambios porque
 * su rol los tiene por defecto, y si Administrador Sixteam se los quita en la matriz, desaparecen.
 *
 * Solo estas rutas se gobiernan por permiso; el resto del menú sigue con `roleAllowed` (sus pantallas
 * ya se autorizan dentro, dato a dato). Basta con UNO de los permisos de la lista para ver la entrada.
 */
export const PERMISSION_ROUTES: ReadonlyArray<{ href: string; anyOf: readonly string[] }> = [
  { href: "/auditoria", anyOf: ["audit:read"] },
  { href: "/configuracion", anyOf: ["config:manage", "user:read", "user:manage", "user:reset_password", "public_access:manage"] },
  { href: "/catalogos", anyOf: ["catalog:manage", "item:manage", "supplier:manage", "society:manage", "requester:manage", "user:read", "user:manage"] },
];

export type Puede = (permiso: string) => boolean;
export function puedeCon(list: readonly string[]): Puede {
  return (permiso) => list.includes(WILDCARD_PERMISSION) || list.includes(permiso);
}

/** Rutas permitidas: las del rol, cambiando las gobernadas por permiso por lo que diga `puede`. */
export function allowedRoutes(base: readonly string[], puede: Puede): string[] {
  const governed = new Set(PERMISSION_ROUTES.map((route) => route.href));
  return [
    ...base.filter((href) => !governed.has(href)),
    ...PERMISSION_ROUTES.filter((route) => route.anyOf.some(puede)).map((route) => route.href),
  ];
}

/**
 * Permisos de quien mira, para el menú. Arranca con los DEFAULTS del rol que se pinta (lo mismo que
 * ya hacía el menú) y en cuanto llega el bootstrap de catálogos usa los efectivos del servidor. Con la
 * lente «Ver como», los efectivos del rol prestado (`rolePermissions`), igual que `conLaLente`.
 */
export function usePermisosDelMenu(role: Role, realRole: Role, demoMode: boolean): Puede {
  const fromPayload = (payload: unknown): readonly string[] | undefined => {
    const bundle = (payload ?? {}) as ViewerPermissions;
    if (role !== realRole) return bundle.rolePermissions?.[DOMAIN_ROLE[role]] ?? undefined;
    return bundle.viewerPermissions;
  };
  const [payload, setPayload] = useState<unknown>(() => (demoMode ? undefined : peekCatalogs()));
  useEffect(() => {
    if (demoMode) return;
    let active = true;
    loadCatalogsBootstrap().then((value) => { if (active) setPayload(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [demoMode]);
  return puedeCon(fromPayload(payload) ?? resolveRolePermissions(DOMAIN_ROLE[role]));
}
