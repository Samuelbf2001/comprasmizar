import { FlaskConical } from 'lucide-react';

export function DemoNotice({ compact = false }: { compact?: boolean }) {
  return <div className={`demo-notice${compact ? ' demo-notice-compact' : ''}`} role="status" aria-label="Modo demostración, sin persistencia" title="Modo demostración · sin persistencia"><FlaskConical aria-hidden="true" size={14} /><span><b>Modo demostración</b> · sin persistencia</span></div>;
}

export function ScreenState({ state, onRetry, onClear }: { state: 'loading' | 'error' | 'empty'; onRetry?: () => void; onClear?: () => void }) {
  if (state === 'loading') return <div className="state-panel" role="status" aria-live="polite"><span className="state-spinner" /><h3>Cargando datos de demo…</h3><p>Esta espera es simulada; no consulta ningún backend.</p></div>;
  if (state === 'error') return <div className="state-panel state-error" role="alert"><span className="empty-icon">!</span><h3>No pudimos cargar esta vista</h3><p>El error es simulado para validar el estado visual. No se ha enviado información.</p>{onRetry && <button className="button button-secondary" onClick={onRetry} type="button">Reintentar</button>}</div>;
  return <div className="state-panel"><span className="empty-icon">—</span><h3>No hay resultados</h3><p>Prueba con otro filtro o limpia la búsqueda.</p>{onClear && <button className="button button-secondary" onClick={onClear} type="button">Limpiar filtros</button>}</div>;
}
