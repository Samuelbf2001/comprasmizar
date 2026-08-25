import type { Metadata } from 'next';
import { PantallaClient } from './pantalla-client';

export const metadata: Metadata = { title: 'Pantalla · Mizar' };

/**
 * RF-1104: modo pantalla. Deliberadamente FUERA del shell autenticado: esta carpeta (`app/pantalla/`)
 * con su propio `page.tsx` tiene precedencia sobre el catch-all `app/[...slug]/page.tsx`, así que nunca
 * pasa por `getAuthSnapshot`/`redirect` a `/login` (ver app/auth-guard.ts y app/[...slug]/page.tsx). La
 * autorización real ocurre del lado del cliente contra /api/pantalla con el token de sesión de pantalla;
 * sin token válido no se revela nada (ver pantalla-client.tsx).
 */
export default function PantallaPage() {
  return <PantallaClient />;
}
