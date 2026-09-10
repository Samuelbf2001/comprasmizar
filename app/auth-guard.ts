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
