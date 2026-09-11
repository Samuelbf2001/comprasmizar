import { cookies } from 'next/headers';
import { resolveServerActor } from '../lib/infrastructure/auth';
import type { Role } from '../lib/demo-data';
import { demoModeEnabled } from '../lib/security/demo-mode';

const priority: Array<{ key: string; role: Role }> = [
  { key: 'admin_sixteam', role: 'Administrador Sixteam' },
  { key: 'admin_mizar', role: 'Administrador Mizar' },
  { key: 'revisor', role: 'Revisor' },
  { key: 'aprobador', role: 'Aprobador' },
  { key: 'contabilidad', role: 'Contabilidad' },
  { key: 'solicitante', role: 'Solicitante' },
];

export type AuthSnapshot = { authenticated: boolean; demoMode: boolean; role: Role; displayName: string; email?: string; reason?: 'unauthenticated' | 'inactive' | 'role' | 'config' };

export function isDemoMode() { return demoModeEnabled(); }

/** Query string suffix para /login que explica por qué se redirigió, sin exponer detalle
 *  técnico: 'role'/'inactive' -> cuenta sin acceso vigente; 'config' -> falla del servidor,
 *  no del usuario (nunca debe leerse como "credenciales incorrectas"). */
export function loginErrorParam(reason: AuthSnapshot['reason']): string {
  if (reason === 'role' || reason === 'inactive') return '&error=access_denied';
  if (reason === 'config') return '&error=config';
  return '';
}

// H1 (docs/plan-rendimiento.md): getAuthSnapshot() ya no repite la consulta getUser() + 2 consultas
// PostgREST — delega en resolveServerActor() (lib/infrastructure/auth.ts), que hace UNA sola consulta
// SQL (con caché en proceso de 60 s) y está envuelta en `cache()` de react para deduplicar dentro de
// un mismo render cuando más de un Server Component la invoca en la misma petición.
export async function getAuthSnapshot(): Promise<AuthSnapshot> {
  if (isDemoMode()) return { authenticated: true, demoMode: true, role: 'Revisor', displayName: 'Daniel Hernández', email: 'demo@mizar.local' };
  // BLOQUEANTE DE PRODUCCIÓN, encontrado corriendo la pila real en Docker (2026-09-10): esta lectura
  // va FUERA del try a propósito.
  //
  // Next marca una página como dinámica lanzando un error especial desde `cookies()` durante el
  // prerender. El `catch` de abajo, que existe para fallar cerrado, se tragaba también esa señal: la
  // página quedaba PRERENDERIZADA como estática con el resultado "config" congelado dentro, y en
  // producción `/`, `/cambiar-clave` y `/pantalla` servían ese HTML a todo el mundo. Nadie podía
  // entrar, con la sesión creándose correctamente en la base. En desarrollo no se ve, porque no hay
  // prerender; `next build` tampoco se queja, porque para él la página simplemente resultó estática.
  //
  // Tocar la cookie aquí deja escapar la señal y ancla la decisión donde se entiende: cualquier
  // pantalla cuyo contenido dependa de quién mira no puede cachearse nunca.
  await cookies();
  try {
    const actor = await resolveServerActor();
    // roles ya viene filtrado contra ALL_ROLES (mismo conjunto de claves que `priority`), así que
    // este find siempre encuentra una coincidencia salvo un error de programación — se conserva el
    // fallback por si algún día ambas listas se desalinean.
    const roleKeys = new Set<string>(actor.roles);
    const selected = priority.find((item) => roleKeys.has(item.key));
    if (!selected) return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'role' };
    return { authenticated: true, demoMode: false, role: selected.role, displayName: actor.displayName, email: actor.email };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (code === 'UNAUTHENTICATED') return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'unauthenticated' };
    if (code === 'ACCOUNT_INACTIVE') return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'inactive' };
    if (code === 'ROLE_REQUIRED') return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'role' };
    // AUTHZ_LOOKUP_FAILED (falla la consulta SQL) y credenciales de runtime ausentes deben fallar
    // cerrado igual: nunca se traduce en demo mode, siempre en 'config' (falla del servidor).
    return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'config' };
  }
}
