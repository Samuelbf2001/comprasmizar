import { ArrowRight, MoreHorizontal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatMoney, statusTone, type Requisition } from '../../lib/demo-data';

export function SectionTitle({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: React.ReactNode }) { return <div className="section-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
// GRAVE 2 (QA 2026-08-31): `outline` da al eje contable un lenguaje visual distinto del eje de
// entrega (que usa `dot`) para que dos ejes independientes no se lean como una sola secuencia.
export function Tone({ children, tone = 'muted', dot = false, outline = false }: { children: React.ReactNode; tone?: string; dot?: boolean; outline?: boolean }) { return <span className={`badge badge-${tone}${outline ? ' badge-outline' : ''}`}>{dot && <i className="badge-dot" />}{children}</span>; }
export function RequestRows({ rows, onOpen }: { rows: Requisition[]; onOpen: (id: string) => void }) { return <div className="table-wrap"><table><thead><tr><th>Requisición</th><th>Solicitante</th><th>Obra</th><th>Estado</th><th className="align-right">Valor</th><th /></tr></thead><tbody>{rows.map(row => <tr key={row.id}><td><div className="request-id"><button className="request-link" type="button" onClick={() => onOpen(row.id)}><b>{row.id}</b><small>{row.item}</small></button></div></td><td>{row.requestor}</td><td>{row.work}</td><td><Tone tone={statusTone[row.status] || 'muted'} dot>{row.status}</Tone></td><td className="align-right money">{formatMoney(row.amount)}</td><td><button className="icon-button" type="button" aria-label={`Abrir ${row.id}`} onClick={() => onOpen(row.id)}><ArrowRight aria-hidden="true" size={15} /></button></td></tr>)}</tbody></table></div>; }

// Diseño aprobado (PatternFly overflow menu, GitLab Pajamas autosave, NN/g progressive disclosure):
// una acción primaria por estado/rol, las secundarias detrás de un menú «Más ⋯» accesible — botón
// disparador + `role="menu"`, cierra con Escape o clic fuera, y devuelve el foco al disparador al
// cerrar (mismo criterio de foco que el resto de diálogos de este archivo).
export type ActionMenuItem = { label: string; onSelect: () => void; disabled?: boolean; tone?: 'default' | 'danger' };
export function ActionMenu({
  label = 'Más',
  ariaLabel,
  items,
}: {
  label?: string;
  /** Nombre accesible del disparador cuando el texto visible ("⋯ a todos", repetido en cada
   *  columna) no basta para distinguir un menú de otro — sin esto, tres botones con el mismo
   *  texto visible tendrían el mismo nombre accesible, y quien navega por lector de pantalla no
   *  podría saber a cuál columna afecta cada uno. */
  ariaLabel?: string;
  items: ActionMenuItem[];
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const visible = items.filter(Boolean);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  if (!visible.length) return null;
  return (
    <div className="action-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="button button-secondary action-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((current) => !current)}
      >
        {label} <MoreHorizontal aria-hidden="true" size={15} />
      </button>
      {open && (
        <div className="action-menu-list" role="menu">
          {visible.map((item, index) => (
            <button
              key={index}
              type="button"
              role="menuitem"
              className={`action-menu-item${item.tone === 'danger' ? ' action-menu-item-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// MENOR (QA 2026-08-31): reemplaza los cinco `window.confirm` nativos de las acciones
// irreversibles por un diálogo accesible propio — mismo patrón que `.quick-supplier-dialog`
// (role="dialog", aria-modal, trampa de foco, Escape, foco devuelto al disparador) en vez del
// confirm nativo del navegador, que no se puede estilizar ni traducir su idioma de botones.
//
// `reason` (flujo un-botón, reunión 2026-09): antes cada acción con motivo (declinar, devolver)
// tenía su propia `<textarea>` siempre visible en la pantalla, ocupando espacio incluso sin
// intención de usarla. Con `reason` el motivo vive DENTRO del diálogo de confirmación — aparece
// solo al confirmar la acción que lo necesita — y `confirm()` lo devuelve junto con `ok` para que
// el llamador arme el body de la petición con una sola función.
export type ConfirmOptions = {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  reason?: { label: string; required?: boolean; rows?: number };
};
export function useConfirmDialog(): { confirm: (options: ConfirmOptions) => Promise<{ ok: boolean; reason?: string }>; dialog: React.ReactNode } {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [reasonValue, setReasonValue] = useState('');
  const resolverRef = useRef<((value: { ok: boolean; reason?: string }) => void) | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const close = (result: { ok: boolean; reason?: string }) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setOptions(null);
    setReasonValue('');
    const trigger = triggerRef.current;
    queueMicrotask(() => trigger?.focus());
  };
  const confirm = (next: ConfirmOptions) =>
    new Promise<{ ok: boolean; reason?: string }>((resolve) => {
      triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;
      resolverRef.current = resolve;
      setReasonValue('');
      setOptions(next);
    });
  useEffect(() => {
    if (!options) return;
    const dialog = dialogRef.current;
    const focusTarget = options.reason
      ? dialog?.querySelector<HTMLElement>('textarea, input')
      : dialog?.querySelector<HTMLButtonElement>('[data-confirm-default]');
    focusTarget?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close({ ok: false });
        return;
      }
      if (event.key !== 'Tab') return;
      if (!dialog) return;
      // La trampa incluye campos de formulario (no solo botones): el diálogo con motivo trae una
      // `<textarea>`, y sin esto Tab/Shift+Tab se salían del diálogo por ahí.
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'),
      );
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
  const reasonMissing = Boolean(options?.reason?.required) && !reasonValue.trim();
  const dialog = options ? (
    <div className="quick-supplier-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close({ ok: false }); }}>
      <div ref={dialogRef} className="panel quick-supplier-dialog confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-desc">
        <div className="panel-head">
          <div><h2 id="confirm-dialog-title">{options.title}</h2></div>
          <button className="icon-button" type="button" aria-label="Cancelar" onClick={() => close({ ok: false })}><X aria-hidden="true" size={16} /></button>
        </div>
        <div className="quick-supplier-body">
          <p id="confirm-dialog-desc">{options.description}</p>
          {options.reason && (
            <label className="field field-wide">
              <span>{options.reason.label}</span>
              <textarea
                required={options.reason.required}
                rows={options.reason.rows ?? 3}
                value={reasonValue}
                onChange={(event) => setReasonValue(event.target.value)}
              />
            </label>
          )}
        </div>
        <div className="form-footer">
          <button className="button button-secondary" type="button" data-testid="confirm-dialog-cancel" onClick={() => close({ ok: false })}>{options.cancelLabel ?? 'Cancelar'}</button>
          <button
            className={`button ${options.danger ? 'button-danger' : 'button-dark'}`}
            type="button"
            data-confirm-default
            data-testid="confirm-dialog-confirm"
            disabled={reasonMissing}
            onClick={() => close({ ok: true, reason: reasonValue.trim() || undefined })}
          >
            {options.confirmLabel ?? 'Continuar'}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return { confirm, dialog };
}
