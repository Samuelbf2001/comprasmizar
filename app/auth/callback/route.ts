import { NextResponse } from 'next/server';
import { createSupabaseUserClient } from '../../../lib/infrastructure/supabase';

function safeNext(value: string | null) { const next = value || '/'; return next.startsWith('/') && !next.startsWith('//') ? next : '/'; }

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeNext(url.searchParams.get('next'));
  if (!code) return NextResponse.redirect(new URL('/login?error=auth_callback', url));
  try {
    const client = await createSupabaseUserClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    if (error) return NextResponse.redirect(new URL('/login?error=auth_callback', url));
    return NextResponse.redirect(new URL(next, url));
  } catch { return NextResponse.redirect(new URL('/login?error=auth_callback', url)); }
}
