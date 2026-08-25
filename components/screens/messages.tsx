'use client';

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

export function MessagesScreen() {
  const rawUrl = process.env.NEXT_PUBLIC_KAPSO_INBOX_URL || '';
  const kapso = parseKapsoUrl(rawUrl);
  return <>
    <SectionTitle eyebrow="Canal de captura · Kapso" title="Mensajes" description="La bandeja de conversaciones pertenece a Kapso; Mizar conserva el log vinculado a requisiciones." action={<span className={`badge ${kapso.valid ? 'badge-blue' : 'badge-warning'}`} role="status"><span className="badge-dot" />{kapso.valid ? `Dominio permitido · ${kapso.host}` : 'Configuración pendiente'}</span>} />
    <div className="kapso-banner"><div className="kapso-mark">K</div><div><b>Inbox de Kapso</b><span>{kapso.valid ? 'Dominio HTTPS permitido para el embedded inbox' : 'No se monta contenido externo hasta validar la configuración pública'}</span></div><div className="kapso-status"><span className={`status-pulse ${kapso.valid ? 'on' : ''}`} />{kapso.valid ? 'Listo para configurar' : 'Conexión pendiente'}</div></div>
    {kapso.valid ? <section className="kapso-frame" aria-label="Bandeja de conversaciones Kapso"><div className="kapso-auth-note" role="status"><ShieldCheck size={15} /> Dominio permitido: <b>{kapso.host}</b>. La autenticación embedded debe configurarse en Kapso; esta pantalla no afirma que exista una sesión autenticada.</div><iframe src={rawUrl} title="Bandeja de mensajes Kapso" sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" allow="clipboard-read; clipboard-write" /></section> : <section className="panel kapso-empty kapso-connection-pending" role="status"><span className="empty-icon"><MessageSquare size={21} /></span><h2>La bandeja está lista para conectarse</h2><p><b>Conexión pendiente.</b> No hay una bandeja de Kapso configurada para este entorno. Configura <code>NEXT_PUBLIC_KAPSO_INBOX_URL</code> con HTTPS y un host permitido; no se ha montado un iframe ni se ha afirmado autenticación.</p><div className="kapso-checks"><span><CheckCircle2 size={15} /> URL pública HTTPS requerida</span><span><CheckCircle2 size={15} /> Host permitido: *.kapso.ai</span><span><CheckCircle2 size={15} /> Sin tokens en el navegador</span></div></section>}
    <section className="panel message-log"><div className="panel-head"><div><div className="eyebrow">Log propio · demo</div><h2>Actividad reciente</h2></div><span className="badge badge-muted"><ExternalLink size={12} /> Kapso administra la conversación</span></div><div className="message-row"><span className="message-state delivered"><CheckCircle2 size={13} /></span><span><b>Los eventos aparecerán aquí</b><small>Cuando el webhook y el log propio estén conectados.</small></span><time>Sin conexión</time></div></section>
  </>;
}
