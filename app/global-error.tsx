'use client';

import { useEffect } from 'react';

// Última red de seguridad: se activa solo si el layout raíz mismo falla al renderizar.
// Reemplaza <html>/<body> por completo (no hereda globals.css ni la fuente de marca, ver
// docs de Next.js), así que va con su propio CSS mínimo en línea. Igual que app/error.tsx,
// nunca se muestra `error.message` al usuario: solo se registra para diagnóstico.
export default function GlobalError({
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
    <html lang="es">
      <body>
        <style>{`
          body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;
            background:#ffffff;color:#2c2f36;
            font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
          .card{width:min(420px,100%);text-align:center;background:#ffffff;
            border:1px solid #dfe3eb;border-radius:12px;padding:40px 24px;
            box-shadow:0 12px 32px rgba(10,35,66,.08)}
          .icon{height:46px;width:46px;border-radius:50%;margin:0 auto 12px;
            background:#fbeae8;color:#d12e45;display:grid;place-items:center;font-weight:700}
          h1{font-size:20px;margin:8px 0 8px;letter-spacing:-.01em}
          p{font-size:13px;line-height:1.5;color:#5a6472;max-width:340px;margin:0 auto 20px}
          button{height:42px;padding:0 20px;border:0;border-radius:8px;background:#d12e45;
            color:#fff;font-size:13px;font-weight:700;cursor:pointer}
          button:active{transform:scale(.97)}
        `}</style>
        <div className="card" role="alert">
          <span className="icon" aria-hidden="true">!</span>
          <h1>Mizar no pudo cargar</h1>
          <p>
            Ocurrió un error inesperado al iniciar la plataforma. No perdiste ningún dato
            guardado. Si el problema continúa después de reintentar, contacta a soporte
            {error.digest ? ` (código ${error.digest})` : ''}.
          </p>
          <button type="button" onClick={() => retry()}>Reintentar</button>
        </div>
      </body>
    </html>
  );
}
