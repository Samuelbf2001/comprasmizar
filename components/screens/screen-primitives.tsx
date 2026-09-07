import { ArrowRight, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatMoney, statusTone, type Requisition } from '../../lib/demo-data';

export function SectionTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="section-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
// GRAVE 2 (QA 2026-08-31): `outline` da al eje contable un lenguaje visual distinto del eje de
// entrega (que usa `dot`) para que dos ejes independientes no se lean como una sola secuencia.
export function Tone({ children, tone = 'muted', dot = false, outline = false }: { children: React.ReactNode; tone?: string; dot?: boolean; outline?: boolean }) { return <span className={`badge badge-${tone}${outline ? ' badge-outline' : ''}`}>{dot && <i className="badge-dot" />}{children}</span>; }
export function RequestRows({ rows, onOpen }: { rows: Requisition[]; onOpen: (id: string) => void }) { return <div className="table-wrap"><table><thead><tr><th>Requisición</th><th>Solicitante</th><th>Obra</th><th>Estado</th><th className="align-right">Valor</th><th /></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><div className="request-id"><button className="request-link" type="button" onClick={() => onOpen(row.id)}><b>{row.id}</b><small>{row.item}</small></button></div></td><td>{row.requestor}</td><td>{row.work}</td><td><Tone tone={statusTone[row.status] || 'muted'} dot>{row.status}</Tone></td><td className="align-right money">{formatMoney(row.amount)}</td><td><button className="icon-button" type="button" aria-label={`Abrir ${row.id}`} onClick={() => onOpen(row.id)}><ArrowRight aria-hidden="true" size={15} /></button></td></tr>)}</tbody></table></div>; }

// MENOR (QA 2026-08-31): reemplaza los cinco `window.confirm` nativos de las acciones
// irreversibles por un diálogo accesible propio — mismo patrón que `.quick-supplier-dialog`
// (role="dialog", aria-modal, trampa de foco, Escape, foco devuelto al disparador) en vez del
// confirm nativo del navegador, que no se puede estilizar ni traducir su idioma de botones.
export type ConfirmOptions = { title: string; description: string; confirmLabel?: string; cancelLabel?: string; danger?: boolean };
export function useConfirmDialog(): { confirm: (options: ConfirmOptions) => Promise<boolean>; dialog: React.ReactNode } {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const close = (result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
    const trigger = triggerRef.current;
    queueMicrotask(() => trigger?.focus());
  };
  const confirm = (next: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
      resolverRef.current = resolve;
      setOptions(next);
    });
  useEffect(() => {
    if (!options) return;
    const confirmButton = dialogRef.current?.querySelector<HTMLButtonElement>('[data-confirm-default]');
    confirmButton?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled])'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [options]);
  const dialog = options ? (
    <div className="quick-supplier-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(false); }}>
      <div ref={dialogRef} className="panel quick-supplier-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-desc">
        <div className="panel-head">
          <div><h2 id="confirm-dialog-title">{options.title}</h2></div>
          <button className="icon-button" type="button" aria-label="Cancelar" onClick={() => close(false)}><X aria-hidden="true" size={16} /></button>
        </div>
        <div className="quick-supplier-body">
          <p id="confirm-dialog-desc">{options.description}</p>
        </div>
        <div className="form-footer">
          <button className="button button-secondary" type="button" data-testid="confirm-dialog-cancel" onClick={() => close(false)}>{options.cancelLabel ?? 'Cancelar'}</button>
          <button className={`button ${options.danger ? 'button-danger' : 'button-dark'}`} type="button" data-confirm-default data-testid="confirm-dialog-confirm" onClick={() => close(true)}>{options.confirmLabel ?? 'Continuar'}</button>
        </div>
      </div>
    </div>
  ) : null;
  return { confirm, dialog };
}
