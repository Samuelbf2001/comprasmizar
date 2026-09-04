'use client';

import { useEffect } from 'react';
import { TriangleAlert, RefreshCw } from 'lucide-react';

// Red de seguridad para cualquier error de render no controlado (bug, dato inesperado,
// etc.) que no pasó por un try/catch propio. Un Client Component puede reenviar el
// mensaje original del error incluso en producción (ver docs de Next.js), así que
// deliberadamente NUNCA se muestra `error.message` al usuario: solo se registra para
// diagnóstico. Lo que ve el usuario es siempre el mismo texto genérico y accionable.
export default function ErrorBoundary({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="auth-page">
      <div className="auth-card state-panel" role="alert">
        <span className="empty-icon"><TriangleAlert aria-hidden="true" size={21} /></span>
        <h2>Algo salió mal</h2>
        <p>No pudimos mostrar esta pantalla. No perdiste ningún dato guardado.</p>
        <p className="state-panel-hint">
          Intenta de nuevo. Si el problema continúa, recarga la página o contacta a soporte
          {error.digest ? ` (código ${error.digest})` : ''}.
        </p>
        <div className="button-row">
          <button className="button button-dark" type="button" onClick={() => retry()}>
            <RefreshCw aria-hidden="true" size={15} /> Reintentar
          </button>
        </div>
      </div>
    </main>
  );
}
