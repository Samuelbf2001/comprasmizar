'use client';

import { useEffect, useRef, useState } from 'react';
import { MonitorOff, RadioTower } from 'lucide-react';

/** RF-1104: forma de la respuesta de GET /api/pantalla (app/api/pantalla/route.ts). Solo agregados: nunca
 *  un id, un consecutivo ni un dato de solicitante. */
interface ScreenMetrics {
  sessionName: string;
  period: string;
  metrics: {
    byStatus: Record<string, number>;
    inProcessValue: number;
    periodExpense: number;
    pendingOrders: number;
    expenseByWork: Array<{ key: string; total: number }>;
    expenseByTag: Array<{ key: string; total: number }>;
    expenseByPeriod: Array<{ key: string; total: number }>;
  };
}

type ScreenState = { authorized: false } | { authorized: true; data: ScreenMetrics };

const STORAGE_KEY = 'mizar_pantalla_token';
const REFRESH_MS = 60_000;
const STATUS_LABELS: Record<string, string> = {
  enviada: 'Enviadas', en_revision: 'En revisión', en_aprobacion: 'En aprobación',
  aprobada: 'Aprobadas', devuelta: 'Devueltas', declinada: 'Declinadas',
};
const copFormatter = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

/** Lee el token del fragmento de la URL (nunca de query string, para que no quede en logs HTTP) — el
 *  mismo patrón que scripts/generate-public-link.ts usa para el enlace público. */
function readTokenFromHash(): string | null {
  const raw = window.location.hash.replace(/^#/, '');
  return raw.length > 0 ? raw : null;
}

function readStoredToken(): string | null {
  try { return window.sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
}
function storeToken(token: string): void {
  try { window.sessionStorage.setItem(STORAGE_KEY, token); } catch { /* almacenamiento no disponible: el token sigue en memoria para esta carga */ }
}
function clearStoredToken(): void {
  try { window.sessionStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
}

/**
 * RF-1104: cliente del modo pantalla. Lee el token del fragmento (#) UNA sola vez, lo mueve a
 * sessionStorage y limpia el hash con replaceState para que nunca quede en el historial ni en un
 * "compartir URL" accidental. Sin token no autorizado; con token consulta /api/pantalla cada 60s.
 * Cualquier respuesta que no sea 200 (token revocado, expirado o cualquier falla) hace que la pantalla
 * vuelva de inmediato al estado "no autorizada": la revocación surte efecto en máximo un ciclo.
 */
export function PantallaClient() {
  const [state, setState] = useState<ScreenState>({ authorized: false });
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    const fromHash = readTokenFromHash();
    if (fromHash) {
      tokenRef.current = fromHash;
      storeToken(fromHash);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      tokenRef.current = readStoredToken();
    }
    if (!tokenRef.current) { setState({ authorized: false }); return; }

    let cancelled = false;
    // `timer` se lee dentro de `revoke`/`refresh` antes de su declaración textual, pero solo se
    // EJECUTA de forma asíncrona (tras el primer `await`), momento en el que `const timer` de más
    // abajo ya corrió de forma síncrona justo después de disparar el primer `refresh()`.
    const revoke = () => {
      if (cancelled) return;
      setState({ authorized: false });
      tokenRef.current = null;
      clearStoredToken();
      clearInterval(timer);
    };
    const refresh = async () => {
      const token = tokenRef.current;
      if (!token) { revoke(); return; }
      try {
        const response = await fetch('/api/pantalla', { headers: { 'x-pantalla-token': token }, cache: 'no-store' });
        if (!response.ok) { revoke(); return; }
        const data = (await response.json()) as ScreenMetrics;
        if (!cancelled) setState({ authorized: true, data });
      } catch {
        revoke();
      }
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (!state.authorized) {
    return (
      <main className="pantalla-page pantalla-page-empty">
        <div className="state-panel pantalla-empty" role="status" aria-live="polite">
          <span className="empty-icon"><MonitorOff size={22} /></span>
          <h1>Pantalla no autorizada</h1>
          <p>Pide a un administrador un enlace de pantalla válido para este monitor.</p>
        </div>
      </main>
    );
  }

  const { sessionName, period, metrics } = state.data;
  const statusEntries = Object.entries(metrics.byStatus);

  return (
    <main className="pantalla-page" aria-live="polite">
      <header className="pantalla-header">
        <div className="pantalla-brand"><RadioTower size={20} /><b>MIZAR</b><small>Modo pantalla</small></div>
        <div className="pantalla-meta"><span>{sessionName}</span><span>Periodo {period}</span></div>
      </header>
      <section className="pantalla-grid" aria-label="Embudo de requisiciones">
        {statusEntries.map(([status, count]) => (
          <div className="pantalla-tile" key={status}>
            <strong>{count}</strong>
            <span>{STATUS_LABELS[status] ?? status}</span>
          </div>
        ))}
      </section>
      <section className="pantalla-grid pantalla-grid-money" aria-label="Montos agregados">
        <div className="pantalla-tile pantalla-tile-money">
          <strong>{copFormatter.format(metrics.inProcessValue)}</strong>
          <span>Valor en trámite</span>
        </div>
        <div className="pantalla-tile pantalla-tile-money">
          <strong>{copFormatter.format(metrics.periodExpense)}</strong>
          <span>Gasto del periodo</span>
        </div>
        <div className="pantalla-tile">
          <strong>{metrics.pendingOrders}</strong>
          <span>Órdenes pendientes</span>
        </div>
      </section>
      {metrics.expenseByWork.length > 0 && (
        <section className="pantalla-breakdown" aria-label="Gasto por obra">
          <h2>Gasto por obra</h2>
          <ul>
            {metrics.expenseByWork.slice(0, 8).map((row) => (
              <li key={row.key}><span>{row.key}</span><b>{copFormatter.format(row.total)}</b></li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
