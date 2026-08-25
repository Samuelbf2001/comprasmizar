'use server';

import { redirect } from 'next/navigation';
import { createSupabaseUserClient } from '../lib/infrastructure/supabase';

export type AuthActionState = { error?: string; success?: string };

function safeNext(value: FormDataEntryValue | null) { const next = String(value || '/'); return next.startsWith('/') && !next.startsWith('//') ? next : '/'; }

export async function signInAction(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '');
  if (!email || !password) return { error: 'Escribe tu correo y contraseña.' };
  try {
    const client = await createSupabaseUserClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { error: 'No pudimos iniciar sesión con esos datos.' };
  } catch { return { error: 'El servicio de autenticación no está configurado en este entorno.' }; }
  redirect(safeNext(formData.get('next')) as never);
}

export async function requestPasswordReset(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') || '').trim();
  if (!email) return { error: 'Escribe el correo de tu usuario.' };
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) return { error: 'Falta configurar la URL pública para recuperación de contraseña.' };
  try {
    const client = await createSupabaseUserClient();
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: `${appUrl.replace(/\/$/, '')}/auth/callback?next=/cambiar-clave` });
    if (error) return { error: 'No pudimos solicitar el correo de recuperación.' };
    return { success: 'Si el correo existe, recibirás instrucciones para continuar.' };
  } catch { return { error: 'El servicio de autenticación no está configurado en este entorno.' }; }
}

export async function updatePassword(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const password = String(formData.get('password') || '');
  const confirmation = String(formData.get('confirmation') || '');
  if (password.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres.' };
  if (password !== confirmation) return { error: 'Las contraseñas no coinciden.' };
  try {
    const client = await createSupabaseUserClient();
    const { data } = await client.auth.getUser();
    if (!data.user) return { error: 'Tu enlace de recuperación no está activo o ya expiró.' };
    const { error } = await client.auth.updateUser({ password });
    if (error) return { error: 'No pudimos actualizar la contraseña.' };
    redirect('/login?updated=1');
  } catch (error) { if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) throw error; return { error: 'El servicio de autenticación no está configurado en este entorno.' }; }
}

export async function logout() { try { const client = await createSupabaseUserClient(); await client.auth.signOut(); } finally { redirect('/login'); } }
