import { createSupabaseUserClient } from '../lib/infrastructure/supabase';
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

export async function getAuthSnapshot(): Promise<AuthSnapshot> {
  if (isDemoMode()) return { authenticated: true, demoMode: true, role: 'Revisor', displayName: 'Daniel Hernández', email: 'demo@mizar.local' };
  try {
    const client = await createSupabaseUserClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'unauthenticated' };
    // Ambas consultas dependen solo de data.user.id y son independientes entre si: en
    // secuencia costaban dos viajes a Supabase en CADA peticion autenticada. En paralelo
    // cuestan uno. Si el usuario resulta inactivo se descarta el resultado de roles, que es
    // el caso raro; el comun se ahorra un viaje completo.
    const [userResult, rolesResult] = await Promise.all([
      client.from('usuarios').select('estado,nombre,email').eq('id', data.user.id).maybeSingle(),
      client.from('usuario_roles').select('rol').eq('usuario_id', data.user.id),
    ]);
    const userRow = userResult.data as unknown as { estado: string; nombre: string; email: string } | null;
    if (userResult.error || !userRow || userRow.estado !== 'activo') return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: userRow ? 'inactive' : 'role' };
    if (rolesResult.error) return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'role' };
    const roleRows = (rolesResult.data ?? []) as Array<{ rol: string }>;
    const roleKeys = new Set(roleRows.map(row => String(row.rol)));
    const selected = priority.find(item => roleKeys.has(item.key));
    if (!selected) return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'role' };
    const role = selected.role;
    return { authenticated: true, demoMode: false, role, displayName: String(userRow.nombre || data.user.user_metadata?.full_name || data.user.email || 'Usuario'), email: data.user.email ?? undefined };
  } catch {
    // Missing runtime credentials must fail closed; never turn this into demo mode.
    return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'config' };
  }
}
