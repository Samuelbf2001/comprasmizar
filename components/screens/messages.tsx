'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, MessageSquare, ShieldCheck } from 'lucide-react';
import { SectionTitle } from './screen-primitives';

const KAPSO_HOST_SUFFIX = '.kapso.ai';

function parseKapsoUrl(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    const allowedHost = host === 'kapso.ai' || host.endsWith(KAPSO_HOST_SUFFIX);
    return { valid: url.protocol === 'https:' && allowedHost, host };
  } catch {
    return { valid: false, host: '' };
  }
}

// La URL del embed es una credencial portadora (abre las conversaciones sin login),
// así que jamás se incrusta en el bundle como NEXT_PUBLIC_*: se pide al servidor,
// que solo la entrega a una sesión autenticada con rol autorizado (/api/kapso-embed).
export function MessagesScreen() {
  const [state, setState] = useState<{ status: 'cargando' | 'listo' | 'pendiente'; url: string }>({ status: 'cargando', url: '' });
  useEffect(() => {
    let active = true;
    fetch('/api/kapso-embed', { cache: 'no-store' })
      .then(async (res) => {
        if (!active) return;
        if (!res.ok) { setState({ status: 'pendiente', url: '' }); return; }
        const body = (await res.json()) as { url?: string };
        const kapso = parseKapsoUrl(body.url || '');
        setState(kapso.valid ? { status: 'listo', url: body.url as string } : { status: 'pendiente', url: '' });
      })
      .catch(() => { if (active) setState({ status: 'pendiente', url: '' }); });
    return () => { active = false; };
  }, []);
  const kapso = parseKapsoUrl(state.url);
  const listo = state.status === 'listo' && kapso.valid;
  return <>
    <SectionTitle eyebrow="Canal de captura · Kapso" title="Mensajes" description="La bandeja de conversaciones pertenece a Kapso; Mizar conserva el log vinculado a requisiciones." action={<span className={`badge ${listo ? 'badge-blue' : 'badge-warning'}`} role="status"><span className="badge-dot" />{state.status === 'cargando' ? 'Verificando acceso…' : listo ? `Dominio permitido · ${kapso.host}` : 'Configuración pendiente'}</span>} />
    <div className="kapso-banner"><div className="kapso-mark">K</div><div><b>Inbox de Kapso</b><span>{listo ? 'Bandeja embebida entregada por el servidor a esta sesión autenticada' : 'No se monta contenido externo hasta validar acceso y configuración'}</span></div><div className="kapso-status"><span className={`status-pulse ${listo ? 'on' : ''}`} />{state.status === 'cargando' ? 'Verificando' : listo ? 'Conectada' : 'Conexión pendiente'}</div></div>
    {listo ? <section className="kapso-frame" aria-label="Bandeja de conversaciones Kapso"><div className="kapso-auth-note" role="status"><ShieldCheck size={15} /> Dominio permitido: <b>{kapso.host}</b>. La URL del embed la entrega el servidor solo a sesiones con rol autorizado; no viaja en el código público.</div><iframe src={state.url} title="Bandeja de mensajes Kapso" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" /></section> : state.status === 'cargando' ? <section className="panel kapso-empty" role="status" aria-live="polite"><span className="empty-icon"><MessageSquare size={21} /></span><h2>Verificando acceso a la bandeja…</h2></section> : <section className="panel kapso-empty kapso-connection-pending" role="status"><span className="empty-icon"><MessageSquare size={21} /></span><h2>La bandeja está lista para conectarse</h2><p><b>Conexión pendiente.</b> No hay una bandeja de Kapso disponible para esta sesión. Configura <code>KAPSO_EMBED_URL</code> en el servidor (HTTPS, host permitido); la URL nunca se expone en el código del navegador.</p><div className="kapso-checks"><span><CheckCircle2 size={15} /> Entregada solo a sesiones autorizadas</span><span><CheckCircle2 size={15} /> Host permitido: *.kapso.ai</span><span><CheckCircle2 size={15} /> Sin tokens en el bundle público</span></div></section>}
    <section className="panel message-log"><div className="panel-head"><div><div className="eyebrow">Log propio · demo</div><h2>Actividad reciente</h2></div><span className="badge badge-muted"><ExternalLink size={12} /> Kapso administra la conversación</span></div><div className="message-row"><span className="message-state delivered"><CheckCircle2 size={13} /></span><span><b>Los eventos aparecerán aquí</b><small>Cuando el webhook y el log propio estén conectados.</small></span><time>Sin conexión</time></div></section>
  </>;
}
