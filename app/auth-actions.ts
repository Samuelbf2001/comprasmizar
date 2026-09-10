'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, destroySession, sessionCookieOptions, setPassword, signIn, verifySession } from '../lib/infrastructure/local-auth';
import { loginAggregateRateLimiter, loginRateLimiter } from '../lib/security/rate-limit';

export type AuthActionState = { error?: string; success?: string };

function safeNext(value: FormDataEntryValue | null) { const next = String(value || '/'); return next.startsWith('/') && !next.startsWith('//') ? next : '/'; }

/**
 * Autoalojado (2026-09-10): estas acciones hablaban con Supabase Auth; ahora con la sesión propia
 * (lib/infrastructure/local-auth.ts). El contrato con la UI no cambió — mismos nombres, mismo
 * `AuthActionState` — así que components/auth/auth-form.tsx sigue igual.
 */

/** Primera IP de `x-forwarded-for` (la que puso Caddy). Solo alimenta el limitador de intentos. */
async function clientIp(): Promise<string> {
  const forwarded = (await headers()).get('x-forwarded-for') ?? '';
  return forwarded.split(',')[0]?.trim() || 'desconocida';
}

export async function signInAction(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') || '').trim();
  const password = String(formData.get('password') || '');
  if (!email || !password) return { error: 'Escribe tu correo y contraseña.' };

  // El límite se consume ANTES de verificar la contraseña: si no, cada intento fallido seguiría
  // costando un bcrypt completo y el freno no protegería de nada.
  const key = email.toLowerCase();
  if (!loginRateLimiter.consume(`${await clientIp()}:${key}`) || !loginAggregateRateLimiter.consume(key)) {
    return { error: 'Demasiados intentos seguidos. Espera un minuto y vuelve a intentarlo.' };
  }

  let result: Awaited<ReturnType<typeof signIn>>;
  try { result = await signIn(email, password); }
  catch { return { error: 'El servicio de autenticación no está disponible en este momento.' }; }

  // Credenciales malas y cuenta inactiva dan mensajes distintos a propósito: la segunda no es un
  // error del usuario y decirle "correo o contraseña incorrectos" lo mandaría a probar contraseñas
  // que nunca van a funcionar. No filtra nada útil: para llegar ahí ya acertó la contraseña.
  if (result === 'INVALID_CREDENTIALS') return { error: 'No pudimos iniciar sesión con esos datos.' };
  if (result === 'ACCOUNT_INACTIVE') return { error: 'Tu cuenta no tiene acceso vigente. Contacta al administrador.' };

  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions(result.maxAgeSeconds));
  redirect(safeNext(formData.get('next')) as never);
}

/**
 * Sin Supabase Auth no hay servicio de correo detrás, y montar SMTP solo para esto sería añadir una
 * pieza de infraestructura (y su mantenimiento) para menos de 30 usuarios. La recuperación pasa a
 * ser administrada: un Administrador asigna una contraseña temporal desde
 * `POST /api/usuarios/:id/clave` y el usuario la cambia al entrar.
 *
 * Se responde igual siempre, exista o no el correo, por la misma razón de antes: no convertir esta
 * pantalla en un verificador de qué cuentas existen.
 */
export async function requestPasswordReset(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const email = String(formData.get('email') || '').trim();
  if (!email) return { error: 'Escribe el correo de tu usuario.' };
  return { success: 'Pídele a un administrador de Mizar que restablezca tu contraseña; te entregará una temporal para que la cambies al entrar.' };
}

export async function updatePassword(_previous: AuthActionState, formData: FormData): Promise<AuthActionState> {
  const password = String(formData.get('password') || '');
  const confirmation = String(formData.get('confirmation') || '');
  if (password.length < 8) return { error: 'La contraseña debe tener al menos 8 caracteres.' };
  if (password !== confirmation) return { error: 'Las contraseñas no coinciden.' };
  try {
    const token = (await cookies()).get(SESSION_COOKIE)?.value;
    const userId = token ? await verifySession(token) : null;
    if (!userId || !token) return { error: 'Tu sesión no está activa o ya expiró. Vuelve a iniciar sesión.' };
    // `keepToken` conserva ESTA sesión y cierra las demás: quien cambia la clave no se autoexpulsa,
    // pero cualquier otra sesión abierta con la contraseña vieja muere en el acto.
    await setPassword(userId, password, token);
  } catch (error) {
    if (error instanceof Error && error.message.includes('NEXT_REDIRECT')) throw error;
    return { error: 'No pudimos actualizar la contraseña.' };
  }
  redirect('/login?updated=1');
}

export async function logout() {
  const store = await cookies();
  try {
    const token = store.get(SESSION_COOKIE)?.value;
    if (token) await destroySession(token);
  } finally {
    store.delete(SESSION_COOKIE);
    redirect('/login');
  }
}
