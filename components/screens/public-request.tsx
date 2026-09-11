'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, ClipboardList, FileText, HardHat, LockKeyhole, PackageCheck, Phone, ShieldCheck, SquarePen, Upload } from 'lucide-react';
import { items, works } from '../../lib/demo-data';
import styles from './public-request.module.css';

// `workId` ausente = enlace GENERAL (uno solo para todas las obras): la obra se elige en el
// formulario, no viene firmada en el enlace. Ver lib/security/public-link.ts.
type PublicAccess = { workId?: string; token: string };
type PublicWork = { id: string; name: string };
// Reunión 2026-08-31: el antiguo campo "frente o actividad" sale del modelo (se fusiona en
// notes/observations, ver el campo "Observaciones" del paso 2); requiredDate ya era opcional aquí.
type RequestValues = {
  type: 'compra' | 'pago'; work: string; date: string; requestor: string;
  item: string; description: string; quantity: string; unit: string; supplier: string; productLink: string; notes: string;
};
/** `phone` no vive en `RequestValues` —tiene su propio estado, porque también viaja aparte en el
 *  envío— pero desde 2026-09-11 se valida en el paso 1 como un campo más, así que necesita error. */
type FieldErrors = Partial<Record<keyof RequestValues | 'phone', string>>;

function initialValues(): RequestValues {
  return { type: 'compra', work: '', date: new Date().toISOString().slice(0, 10), requestor: '', item: '', description: '', quantity: '1', unit: 'Unidad', supplier: '', productLink: '', notes: '' };
}

function focusFirstError(errors: FieldErrors) {
  const field = Object.keys(errors)[0];
  if (!field) return;
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
}

function PortalFrame({ children }: { children: React.ReactNode }) {
  return <div className={styles.frame}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.brandMark}>M</span><span><b className={styles.brandName}>MIZAR</b><small className={styles.brandSubtitle}>Portal de obra</small></span></div>
    </header>
    <main className={styles.main}>{children}</main>
    <footer className={styles.footer}><FileText aria-hidden="true" size={15} /><span>Tus datos se usan solo para gestionar esta solicitud. <Link href="/ayuda">¿Necesitas ayuda?</Link></span></footer>
  </div>;
}

/**
 * La compuerta es NO CONTROLADA a propósito (2026-09-11).
 *
 * Con campos controlados se perdía lo que la persona tecleara antes de que React hidratara: el
 * navegador pinta el HTML del servidor y acepta escritura de inmediato, pero el primer render de
 * cliente impone el estado —vacío— y borra lo escrito. En un maestro que abre el enlace y teclea sin
 * esperar, eso significa entrar la contraseña a medias y recibir "contraseña incorrecta" sin
 * entender por qué. Se descubrió porque los recorridos de navegador fallaban al rellenar justo
 * después de `goto()` (ver tests/e2e/public-portal.spec.ts).
 *
 * Sin estado que imponer, el DOM conserva lo tecleado y los valores se leen del formulario al
 * enviar. La alternativa era deshabilitar los campos hasta hidratar, pero eso cambia un problema
 * invisible por uno visible: la persona ve un formulario que no la deja escribir.
 *
 * `defaultValue` mantiene lo ya introducido al volver con "Cambiar datos": el componente se
 * desmonta, así que sin eso los campos aparecerían en blanco.
 */
/**
 * La compuerta pide SOLO la contraseña (2026-09-11).
 *
 * Antes pedía también el teléfono, y Ernesto lo señaló probando: había pedido «para ingresar, solo
 * una contraseña». Tenía razón, y no es solo cuestión de gusto — el teléfono no era una llave:
 * cualquiera podía escribir cualquier número y entrar igual. Pedirlo en la puerta daba la
 * apariencia de un segundo control que no existía, y de paso ponía dos obstáculos antes de dejar
 * ver el formulario.
 *
 * El teléfono no desaparece: se pide en el paso 1, junto al nombre, que es donde se entiende para
 * qué sirve —avisar por WhatsApp del avance—. Sigue siendo obligatorio al enviar, y alimenta
 * `solicitante_telefono_externo`, que es lo que hace funcionar «Mis requisiciones» y las
 * notificaciones. El contrato HTTP no cambia.
 */
function AccessGate({ code, error, onSubmit, showHelp = false }: {
  code: string; error: string; onSubmit: (datos: { code: string }) => void; showHelp?: boolean;
}) {
  const enviar = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({ code: String(new FormData(event.currentTarget).get('access-code') ?? '') });
  };
  return <PortalFrame><section className={styles.access} aria-labelledby="portal-access-title">
    <div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Acceso protegido</div>
    <h1 id="portal-access-title">Pide lo que tu obra necesita.</h1>
    <p className={styles.accessCopy}>Escribe la contraseña que te dio Mizar. Después solo son dos pasos.</p>
    <form className={styles.accessCard} onSubmit={enviar} noValidate>
      <label className={styles.field}><span className={styles.fieldLabel}>Contraseña del portal <em className={styles.required}>*</em></span><input className={styles.control} name="access-code" defaultValue={code} placeholder="Contraseña entregada por Mizar" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'portal-access-error' : undefined} /></label>
      {error && <p className={styles.error} id="portal-access-error" role="alert">{error}</p>}
      <button className={styles.primaryButton} type="submit">Continuar <ArrowRight aria-hidden="true" size={19} /></button>
    </form>
    {showHelp && <div className={styles.accessHelp}><ShieldCheck aria-hidden="true" size={19} /><span><b>¿No tienes la contraseña?</b><small>Pídesela al responsable de la obra. Este enlace solo permite crear una requisición.</small></span></div>}
  </section></PortalFrame>;
}

function Progress({ step }: { step: 1 | 2 }) {
  return <ol className={styles.progress} aria-label="Avance de la requisición">
    <li className={`${styles.progressStep} ${step === 1 ? styles.progressCurrent : styles.progressDone}`} aria-current={step === 1 ? 'step' : undefined}><strong>{step > 1 ? <Check aria-hidden="true" size={14} /> : '1'}</strong><span>Tus datos</span></li>
    <li className={`${styles.progressStep} ${step === 2 ? styles.progressCurrent : ''}`} aria-current={step === 2 ? 'step' : undefined}><strong>2</strong><span>Material</span></li>
  </ol>;
}

function StepIntro({ code, onChangeAccess }: { code: string; onChangeAccess: () => void }) {
  return <div className={styles.intro}><div className={styles.introLine}><div><div className={styles.kicker}><HardHat aria-hidden="true" size={17} /> Requisición de obra</div><h1>Haz la solicitud sin enredos.</h1></div><button className={styles.changeButton} type="button" onClick={onChangeAccess}>Cambiar datos</button></div><p>Dos pasos. Los campos con <em className={styles.required}>*</em> son necesarios para enviarla.</p><p className={styles.hint}>Acceso para: <b>{code}</b></p></div>;
}

function DemoPublicRequest() {
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false);
  const [code, setCode] = useState(''), [phone, setPhone] = useState(''), [accessError, setAccessError] = useState('');
  const [step, setStep] = useState<1 | 2>(1), [values, setValues] = useState(initialValues), [errors, setErrors] = useState<FieldErrors>({}), [showDetails, setShowDetails] = useState(false);
  const update = <K extends keyof RequestValues>(key: K, value: RequestValues[K]) => setValues(current => ({ ...current, [key]: value }));
  // Los valores llegan leídos del formulario, no del estado: la compuerta es no controlada para no
  // perder lo que se teclee antes de hidratar (ver AccessGate). Se guardan en estado AQUÍ, ya
  // validados, porque los pasos siguientes los necesitan (el teléfono se muestra, la contraseña viaja
  // en el envío).
  // Solo la contraseña abre la compuerta. El teléfono se pide en el paso 1 y se valida allí.
  const handleAccess = ({ code: claveEscrita }: { code: string }) => { if (claveEscrita.trim().length < 4) { setAccessError('Escribe la contraseña del portal para continuar.'); return; } setCode(claveEscrita); setAccessError(''); setAccessGranted(true); };
  const validate = (targetStep: 1 | 2) => {
    const next: FieldErrors = {};
    if (targetStep === 1) { if (!values.work) next.work = 'Selecciona la obra.'; if (values.requestor.trim().length < 2) next.requestor = 'Escribe tu nombre.'; if (phone.replace(/[^0-9]/g, '').length < 7) next.phone = 'Escribe tu teléfono para avisarte por WhatsApp.'; }
    else { if (!values.item) next.item = 'Selecciona el material.'; if (!values.quantity || Number(values.quantity) < 1) next.quantity = 'Indica una cantidad mayor que cero.'; }
    setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return false; } return true;
  };
  const nextStep = () => { if (validate(1)) { setErrors({}); setStep(2); } };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!validate(2)) return; setSent(true); };
  if (sent) return <PortalFrame><section className={styles.success}><div className={styles.successDemo} role="status"><b>Modo demostración</b>No se creó una requisición real ni se guardaron datos.</div><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>Recorrido completado.</h1><p className={styles.successCopy}>El formulario móvil quedó listo para probar. Este código no sirve para seguimiento real.</p><div className={styles.trackingCode}>REQ-DEMO-0148</div><button className={styles.primaryButton} type="button" onClick={() => { setValues(initialValues()); setErrors({}); setStep(1); setSent(false); }}>Probar otra requisición</button></section></PortalFrame>;
  if (!accessGranted) return <AccessGate code={code} error={accessError} onSubmit={handleAccess} showHelp />;
  return <PortalFrame><StepIntro code={code} onChangeAccess={() => setAccessGranted(false)} /><Progress step={step} />
    <form className={styles.stepCard} onSubmit={submit} noValidate>
      {step === 1 ? <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso 1 de 2</p><h2>¿Para quién y cuándo?</h2><p>Elige la obra, la fecha y escribe tu nombre.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Obra <em className={styles.required}>*</em></span><select className={styles.control} name="work" value={values.work} onChange={event => update('work', event.target.value)} aria-invalid={Boolean(errors.work)} aria-describedby={errors.work ? 'portal-work-error' : undefined}><option value="" disabled>Selecciona tu obra</option>{works.map(work => <option key={work}>{work}</option>)}</select>{errors.work && <small className={styles.error} id="portal-work-error">{errors.work}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Fecha requerida <small className={styles.hint}>opcional</small></span><input className={styles.control} name="date" type="date" value={values.date} onChange={event => update('date', event.target.value)} aria-invalid={Boolean(errors.date)} aria-describedby={errors.date ? 'portal-date-error' : undefined} />{errors.date && <small className={styles.error} id="portal-date-error">{errors.date}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Tu teléfono <em className={styles.required}>*</em></span><span className={styles.inputWithIcon}><Phone aria-hidden="true" size={18} /><input className={styles.control} name="phone" value={phone} onChange={event => setPhone(event.target.value)} placeholder="300 000 0000" inputMode="tel" autoComplete="tel" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'portal-phone-error' : undefined} /></span><small className={styles.hint}>Para avisarte por WhatsApp del avance de tu requisición</small>{errors.phone && <small className={styles.error} id="portal-phone-error">{errors.phone}</small>}</label></div>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu nombre <em className={styles.required}>*</em></span><input className={styles.control} name="requestor" value={values.requestor} onChange={event => update('requestor', event.target.value)} placeholder="Nombre completo" autoComplete="name" aria-invalid={Boolean(errors.requestor)} aria-describedby={errors.requestor ? 'portal-requestor-error' : undefined} />{errors.requestor && <small className={styles.error} id="portal-requestor-error">{errors.requestor}</small>}</label>
        <div className={`${styles.actionRow} ${styles.actionRowSingle}`}><button className={styles.primaryButton} type="button" onClick={nextStep}>Continuar a material <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></> : <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso 2 de 2</p><h2>¿Qué material necesitas?</h2><p>Selecciona el material y cuántas unidades necesitas.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Material <em className={styles.required}>*</em></span><select className={styles.control} name="item" value={values.item} onChange={event => update('item', event.target.value)} aria-invalid={Boolean(errors.item)} aria-describedby={errors.item ? 'portal-item-error' : undefined}><option value="" disabled>Selecciona el material</option>{items.map(item => <option key={item.name}>{item.name}</option>)}</select>{errors.item && <small className={styles.error} id="portal-item-error">{errors.item}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Cantidad <em className={styles.required}>*</em></span><input className={styles.control} name="quantity" type="number" inputMode="decimal" min="1" value={values.quantity} onChange={event => update('quantity', event.target.value)} aria-invalid={Boolean(errors.quantity)} aria-describedby={errors.quantity ? 'portal-quantity-error' : undefined} />{errors.quantity && <small className={styles.error} id="portal-quantity-error">{errors.quantity}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Unidad</span><select className={styles.control} name="unit" value={values.unit} onChange={event => update('unit', event.target.value)}><option>Bulto</option><option>Unidad</option><option>m³</option></select></label></div>
        <button className={styles.optionalToggle} type="button" onClick={() => setShowDetails(open => !open)} aria-expanded={showDetails}><span><SquarePen aria-hidden="true" size={18} /> Agregar una nota o foto <small className={styles.hint}>(opcional)</small></span><span aria-hidden="true">{showDetails ? '−' : '+'}</span></button>
        {showDetails && <div className={styles.optionalPanel}><label className={styles.field}><span className={styles.fieldLabel}>Observaciones <small className={styles.hint}>opcional</small></span><textarea className={`${styles.control} ${styles.textarea}`} name="notes" value={values.notes} onChange={event => update('notes', event.target.value)} placeholder="Marca, tamaño o instrucciones de entrega" /></label><label className={styles.uploadLabel}><Upload aria-hidden="true" size={20} /><span><b>Adjunta una foto o cotización</b><small>PDF, JPG o PNG · máximo 10 MB</small></span><input type="file" aria-label="Adjuntar una foto o cotización" /></label></div>}
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => { setErrors({}); setStep(1); }}><ArrowLeft aria-hidden="true" size={18} /> Volver</button><button className={styles.primaryButton} type="submit">Enviar requisición <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}
    </form>
  </PortalFrame>;
}

function ProductionPublicRequest({ enabled }: { enabled: boolean }) {
  const [access, setAccess] = useState<PublicAccess | undefined>(), [linkRead, setLinkRead] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false), [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState(''), [phone, setPhone] = useState(''), [accessError, setAccessError] = useState('');
  const [step, setStep] = useState<1 | 2>(1), [values, setValues] = useState(initialValues), [errors, setErrors] = useState<FieldErrors>({}), [formError, setFormError] = useState(''), [showDetails, setShowDetails] = useState(false);
  const [publicWorks, setPublicWorks] = useState<PublicWork[]>([]), [worksLoaded, setWorksLoaded] = useState(false);
  // EL FRAGMENTO SE QUEDA EN LA URL (2026-09-11). Antes se borraba con `history.replaceState` nada
  // más leerlo, por precaución. La precaución estaba mal dirigida: lo que nunca puede ir en la URL
  // es la CONTRASEÑA, y nunca ha ido — se teclea. El fragmento lleva la obra y el token, que SON el
  // enlace que se reparte en un archivo; borrarlos no oculta nada que no estuviera ya compartido.
  //
  // Lo que sí hacía era romper el portal: Ernesto recargó la página y le salió "Este enlace no está
  // habilitado", porque al recargar ya no quedaba token que leer. Y lo mismo con "atrás" o con
  // guardar en favoritos — exactamente lo que hace un maestro que se queda a medias y vuelve luego.
  //
  // El fragmento sigue sin viajar al servidor: el navegador nunca lo envía, así que no aparece en
  // los registros del proxy ni en los nuestros.
  useEffect(() => { let active = true; const fragment = enabled ? new URLSearchParams(window.location.hash.replace(/^#/, '')) : new URLSearchParams(), workId = fragment.get('obra') ?? '', token = fragment.get('token') ?? '', valid = enabled && /^[0-9a-f]{64}$/.test(token) && (workId === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId)); queueMicrotask(() => { if (!active) return; if (valid) setAccess({ workId: workId || undefined, token }); setLinkRead(true); }); return () => { active = false; }; }, [enabled]);
  // Enlace general: la obra no viene firmada, hay que ofrecer la lista. Se pide con el token y sin
  // contraseña (ver app/api/public/works/route.ts); si falla, la lista queda vacía y se dice, en vez
  // de dejar un selector mudo.
  useEffect(() => { if (!access || access.workId) return; let active = true; fetch(`/api/public/works?token=${encodeURIComponent(access.token)}`).then(response => response.ok ? response.json() : { works: [] }).then((body: { works?: PublicWork[] }) => { if (active) setPublicWorks(Array.isArray(body.works) ? body.works : []); }).catch(() => { if (active) setPublicWorks([]); }).finally(() => { if (active) setWorksLoaded(true); }); return () => { active = false; }; }, [access]);
  const update = <K extends keyof RequestValues>(key: K, value: RequestValues[K]) => setValues(current => ({ ...current, [key]: value }));
  // Los valores llegan leídos del formulario, no del estado: la compuerta es no controlada para no
  // perder lo que se teclee antes de hidratar (ver AccessGate). Se guardan en estado AQUÍ, ya
  // validados, porque los pasos siguientes los necesitan (el teléfono se muestra, la contraseña viaja
  // en el envío).
  // Solo la contraseña abre la compuerta. El teléfono se pide en el paso 1 y se valida allí.
  const handleAccess = ({ code: claveEscrita }: { code: string }) => { if (claveEscrita.trim().length < 4) { setAccessError('Escribe la contraseña del portal para continuar.'); return; } setCode(claveEscrita); setAccessError(''); setAccessGranted(true); };
  const validate = (targetStep: 1 | 2) => {
    const next: FieldErrors = {};
    if (targetStep === 1) { if (!access?.workId && !values.work) next.work = 'Selecciona la obra.'; if (values.requestor.trim().length < 2) next.requestor = 'Escribe tu nombre.'; if (phone.replace(/[^0-9]/g, '').length < 7) next.phone = 'Escribe tu teléfono para avisarte por WhatsApp.'; }
    else { if (values.description.trim().length < 1) next.description = 'Describe lo que necesitas.'; if (!values.quantity || Number(values.quantity) <= 0) next.quantity = 'Indica una cantidad mayor que cero.'; if (!values.unit.trim()) next.unit = 'Indica la unidad.'; if (values.productLink && !values.productLink.startsWith('https://')) next.productLink = 'El enlace debe comenzar con https://'; }
    setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return false; } return true;
  };
  const nextStep = () => { if (validate(1)) { setErrors({}); setStep(2); } };
  // requiredDate va con `|| undefined` (mismo idioma que observations, abajo): el esquema HTTP la acepta
  // OPCIONAL con z.string().date() — enviar '' cuando el campo queda vacío no es "sin fecha", es una
  // fecha inválida, y .strict() la rechazaba en silencio (el endpoint público siempre responde 202
  // neutro, así que ese rechazo pasaba desapercibido en vez de fallar de forma visible).
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!access || !validate(2)) return; setFormError(''); setSubmitting(true); const payload = { workId: access.workId ?? values.work, code, type: values.type, requiredDate: values.date || undefined, name: values.requestor, phone, observations: values.notes || undefined, items: [{ description: values.description, quantity: Number(values.quantity), unit: values.unit, possibleSupplier: values.supplier || undefined, productLink: values.productLink || undefined }] }; try { const response = await fetch('/api/public/requisitions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-public-link-token': access.token }, body: JSON.stringify(payload) }); if (response.status === 202) setSent(true); else if (response.status === 503) setFormError('El servicio de requisiciones no está disponible. Intenta más tarde.'); else setFormError('No pudimos recibir la solicitud. Revisa los campos e intenta otra vez.'); } catch { setFormError('No pudimos conectar con el servicio. Intenta más tarde.'); } finally { setSubmitting(false); } };
  if (!linkRead) return <PortalFrame><section className={`${styles.access} ${styles.closedGate}`} role="status"><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Validando enlace</div><h1>Preparando el formulario…</h1></section></PortalFrame>;
  if (!access) return <PortalFrame><section className={`${styles.access} ${styles.closedGate}`}><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Captura cerrada</div><h1>Este enlace no está habilitado.</h1><p className={styles.accessCopy}>Solicita al responsable de tu obra un enlace vigente. No se creó ninguna requisición ni se aceptaron datos.</p></section></PortalFrame>;
  if (sent) return <PortalFrame><section className={styles.success}><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>La estamos validando.</h1><p className={styles.successCopy}>Si el enlace, la contraseña y el teléfono corresponden a la obra, la requisición quedará registrada. Por seguridad no mostramos un consecutivo.</p><button className={styles.primaryButton} type="button" onClick={() => { setValues(initialValues()); setErrors({}); setStep(1); setSent(false); setAccessGranted(false); }}>Enviar otra solicitud</button></section></PortalFrame>;
  if (!accessGranted) return <AccessGate code={code} error={accessError} onSubmit={handleAccess} />;
  return <PortalFrame><StepIntro code="obra autorizada" onChangeAccess={() => setAccessGranted(false)} /><Progress step={step} />
    <form className={styles.stepCard} onSubmit={submit} noValidate>
      {step === 1 ? <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso 1 de 2</p><h2>¿Para quién y cuándo?</h2><p>Indica el tipo de solicitud, la fecha y tu nombre.</p></div><div className={styles.stepBody}>
        <fieldset className={styles.fieldset}><legend className={styles.fieldsetLegend}>¿Qué vas a solicitar? <em className={styles.required}>*</em></legend><div className={styles.choiceGrid}><label className={styles.choice}><input type="radio" name="type" value="compra" checked={values.type === 'compra'} onChange={() => update('type', 'compra')} /><span className={styles.choiceIcon}><PackageCheck aria-hidden="true" size={16} /></span>Compra de material</label><label className={styles.choice}><input type="radio" name="type" value="pago" checked={values.type === 'pago'} onChange={() => update('type', 'pago')} /><span className={styles.choiceIcon}><ClipboardList aria-hidden="true" size={16} /></span>Solicitud de pago</label></div></fieldset>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Fecha requerida <small className={styles.hint}>opcional</small></span><input className={styles.control} name="date" type="date" value={values.date} onChange={event => update('date', event.target.value)} aria-invalid={Boolean(errors.date)} aria-describedby={errors.date ? 'portal-date-error' : undefined} />{errors.date && <small className={styles.error} id="portal-date-error">{errors.date}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Tu teléfono <em className={styles.required}>*</em></span><span className={styles.inputWithIcon}><Phone aria-hidden="true" size={18} /><input className={styles.control} name="phone" value={phone} onChange={event => setPhone(event.target.value)} placeholder="300 000 0000" inputMode="tel" autoComplete="tel" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'portal-phone-error' : undefined} /></span><small className={styles.hint}>Para avisarte por WhatsApp del avance de tu requisición</small>{errors.phone && <small className={styles.error} id="portal-phone-error">{errors.phone}</small>}</label></div>
        {!access.workId && <label className={styles.field}><span className={styles.fieldLabel}>Obra <em className={styles.required}>*</em></span><select className={styles.control} name="work" value={values.work} onChange={event => update('work', event.target.value)} disabled={!worksLoaded || publicWorks.length === 0} aria-invalid={Boolean(errors.work)} aria-describedby={errors.work ? 'portal-work-error' : undefined}><option value="" disabled>{worksLoaded ? (publicWorks.length ? 'Selecciona una obra' : 'No hay obras habilitadas') : 'Cargando obras…'}</option>{publicWorks.map(work => <option key={work.id} value={work.id}>{work.name}</option>)}</select>{errors.work && <small className={styles.error} id="portal-work-error">{errors.work}</small>}</label>}
        <label className={styles.field}><span className={styles.fieldLabel}>Tu nombre <em className={styles.required}>*</em></span><input className={styles.control} name="requestor" value={values.requestor} onChange={event => update('requestor', event.target.value)} autoComplete="name" aria-invalid={Boolean(errors.requestor)} aria-describedby={errors.requestor ? 'portal-requestor-error' : undefined} />{errors.requestor && <small className={styles.error} id="portal-requestor-error">{errors.requestor}</small>}</label>
        <div className={`${styles.actionRow} ${styles.actionRowSingle}`}><button className={styles.primaryButton} type="button" onClick={nextStep}>Continuar a material <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></> : <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso 2 de 2</p><h2>Describe el material.</h2><p>Con una descripción, cantidad y unidad podemos recibir la solicitud.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>¿Qué necesitas? <em className={styles.required}>*</em></span><input className={styles.control} name="description" value={values.description} onChange={event => update('description', event.target.value)} maxLength={500} placeholder="Ej. 20 bultos de cemento gris" aria-invalid={Boolean(errors.description)} aria-describedby={errors.description ? 'portal-description-error' : undefined} />{errors.description && <small className={styles.error} id="portal-description-error">{errors.description}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Cantidad <em className={styles.required}>*</em></span><input className={styles.control} name="quantity" type="number" inputMode="decimal" min="0.001" step="0.001" value={values.quantity} onChange={event => update('quantity', event.target.value)} aria-invalid={Boolean(errors.quantity)} aria-describedby={errors.quantity ? 'portal-quantity-error' : undefined} />{errors.quantity && <small className={styles.error} id="portal-quantity-error">{errors.quantity}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Unidad <em className={styles.required}>*</em></span><input className={styles.control} name="unit" value={values.unit} onChange={event => update('unit', event.target.value)} maxLength={40} aria-invalid={Boolean(errors.unit)} aria-describedby={errors.unit ? 'portal-unit-error' : undefined} />{errors.unit && <small className={styles.error} id="portal-unit-error">{errors.unit}</small>}</label></div>
        <button className={styles.optionalToggle} type="button" onClick={() => setShowDetails(open => !open)} aria-expanded={showDetails}><span><SquarePen aria-hidden="true" size={18} /> Agregar detalles <small className={styles.hint}>(opcional)</small></span><span aria-hidden="true">{showDetails ? '−' : '+'}</span></button>
        {showDetails && <div className={styles.optionalPanel}><label className={styles.field}><span className={styles.fieldLabel}>Posible proveedor <small className={styles.hint}>opcional</small></span><input className={styles.control} name="supplier" value={values.supplier} onChange={event => update('supplier', event.target.value)} maxLength={240} /></label><label className={styles.field}><span className={styles.fieldLabel}>Enlace del producto <small className={styles.hint}>HTTPS opcional</small></span><input className={styles.control} name="productLink" type="url" inputMode="url" value={values.productLink} onChange={event => update('productLink', event.target.value)} maxLength={2048} placeholder="https://…" aria-invalid={Boolean(errors.productLink)} aria-describedby={errors.productLink ? 'portal-link-error' : undefined} />{errors.productLink && <small className={styles.error} id="portal-link-error">{errors.productLink}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Observaciones <small className={styles.hint}>di a dónde va, opcional</small></span><textarea className={`${styles.control} ${styles.textarea}`} name="notes" value={values.notes} onChange={event => update('notes', event.target.value)} maxLength={3000} placeholder="Ej. Torre 2, piso 4" /></label><p className={styles.securityNote}><LockKeyhole aria-hidden="true" size={17} /> Fotos y PDF aún no están disponibles en el portal público.</p></div>}
        {formError && <p className={styles.error} role="alert">{formError}</p>}<div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => { setErrors({}); setStep(1); }}><ArrowLeft aria-hidden="true" size={18} /> Volver</button><button className={styles.primaryButton} type="submit" disabled={submitting}>{submitting ? 'Enviando…' : 'Enviar requisición'} <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}
    </form>
  </PortalFrame>;
}

export function PublicRequestScreen({ demoMode, publicConfigured = false }: { demoMode: boolean; publicConfigured?: boolean }) {
  return demoMode ? <DemoPublicRequest /> : <ProductionPublicRequest enabled={publicConfigured} />;
}

/**
 * Reenvío de la ruta heredada `/requisiciones/publica-movil` (2026-09-11).
 *
 * Hubo un formulario móvil aparte, con su propia URL, y esa URL se repartió en el archivo de
 * enlaces que tiene el cliente. Ahora el formulario es uno solo, pero ninguno de los dos enlaces
 * puede morir.
 *
 * El reenvío es de CLIENTE y no de servidor por una razón que no es de estilo: la obra y el token
 * viajan en el fragmento (`#obra=…&token=…`), y el navegador NUNCA envía el fragmento al servidor.
 * Un `redirect()` de Next, o una regla en el proxy, devolverían al usuario a `/requisiciones/publica`
 * sin token, y el portal le diría "este enlace no está habilitado" — rompiendo en silencio todos
 * los enlaces móviles ya repartidos.
 *
 * `replace` y no `assign`: quien llegue por el enlace viejo no debería encontrarse la ruta muerta
 * al pulsar "atrás".
 */
export function PublicRequestRedirect() {
  useEffect(() => {
    const { hash, search } = window.location;
    window.location.replace(`/requisiciones/publica${search}${hash}`);
  }, []);
  return <PortalFrame><section className={`${styles.access} ${styles.closedGate}`} role="status"><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Validando enlace</div><h1>Preparando el formulario…</h1></section></PortalFrame>;
}
