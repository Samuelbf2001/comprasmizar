'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, MessageSquare } from 'lucide-react';
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
    <SectionTitle eyebrow="Canal de captura · Kapso" title="Mensajes" description="Conversaciones de la línea de WhatsApp de Mizar." action={<span className={`badge ${listo ? 'badge-blue' : 'badge-warning'}`} role="status"><span className="badge-dot" />{state.status === 'cargando' ? 'Verificando acceso…' : listo ? `Dominio permitido · ${kapso.host}` : 'Configuración pendiente'}</span>} />
    {listo ? <section className="kapso-frame" aria-label="Bandeja de conversaciones Kapso"><iframe src={state.url} title="Bandeja de mensajes Kapso" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" /></section> : state.status === 'cargando' ? <section className="panel kapso-empty" role="status" aria-live="polite"><span className="empty-icon"><MessageSquare aria-hidden="true" size={21} /></span><h2>Verificando acceso a la bandeja…</h2></section> : <section className="panel kapso-empty kapso-connection-pending" role="status"><span className="empty-icon"><MessageSquare aria-hidden="true" size={21} /></span><h2>La bandeja está lista para conectarse</h2><p><b>Conexión pendiente.</b> No hay una bandeja de Kapso disponible para esta sesión. Configura <code>KAPSO_EMBED_URL</code> en el servidor (HTTPS, host permitido); la URL nunca se expone en el código del navegador.</p><div className="kapso-checks"><span><CheckCircle2 aria-hidden="true" size={15} /> Entregada solo a sesiones autorizadas</span><span><CheckCircle2 aria-hidden="true" size={15} /> Host permitido: *.kapso.ai</span><span><CheckCircle2 aria-hidden="true" size={15} /> Sin tokens en el bundle público</span></div></section>}
  </>;
}
