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

export async function getAuthSnapshot(): Promise<AuthSnapshot> {
  if (isDemoMode()) return { authenticated: true, demoMode: true, role: 'Revisor', displayName: 'Daniel Hernández', email: 'demo@mizar.local' };
  try {
    const client = await createSupabaseUserClient();
    const { data, error } = await client.auth.getUser();
    if (error || !data.user) return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: 'unauthenticated' };
    const userResult = await client.from('usuarios').select('estado,nombre,email').eq('id', data.user.id).maybeSingle();
    const userRow = userResult.data as unknown as { estado: string; nombre: string; email: string } | null;
    if (userResult.error || !userRow || userRow.estado !== 'activo') return { authenticated: false, demoMode: false, role: 'Solicitante', displayName: 'Usuario', reason: userRow ? 'inactive' : 'role' };
    const rolesResult = await client.from('usuario_roles').select('rol').eq('usuario_id', data.user.id);
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
