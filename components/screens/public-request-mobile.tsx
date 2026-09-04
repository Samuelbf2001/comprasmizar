'use client';

import { FormEvent, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Check, ClipboardList, FileText, HardHat, LockKeyhole, PackageCheck, Phone, ShieldCheck, SquarePen, Upload } from 'lucide-react';
import { items, works } from '../../lib/demo-data';
import styles from './public-request-mobile.module.css';

type PublicAccess = { workId: string; token: string };
type RequestValues = {
  type: 'compra' | 'pago'; work: string; date: string; requestor: string; destination: string;
  item: string; description: string; quantity: string; unit: string; supplier: string; productLink: string; notes: string;
};
type FieldErrors = Partial<Record<keyof RequestValues, string>>;

function initialValues(): RequestValues {
  return { type: 'compra', work: '', date: new Date().toISOString().slice(0, 10), requestor: '', destination: '', item: '', description: '', quantity: '1', unit: 'Unidad', supplier: '', productLink: '', notes: '' };
}

function focusFirstError(errors: FieldErrors) {
  const field = Object.keys(errors)[0];
  if (!field) return;
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
}

function MobileFrame({ children }: { children: React.ReactNode }) {
  return <div className={styles.frame}>
    <header className={styles.header}>
      <div className={styles.brand}><span className={styles.brandMark}>M</span><span><b className={styles.brandName}>MIZAR</b><small className={styles.brandSubtitle}>Portal de obra</small></span></div>
      <span className={styles.mobileBadge}>Versión móvil</span>
    </header>
    <main className={styles.main}>{children}</main>
    <footer className={styles.footer}><FileText aria-hidden="true" size={15} /><span>Tus datos se usan solo para gestionar esta solicitud. <Link href="/ayuda">¿Necesitas ayuda?</Link></span></footer>
  </div>;
}

function AccessGate({ code, phone, error, onCodeChange, onPhoneChange, onSubmit, showHelp = false }: {
  code: string; phone: string; error: string; onCodeChange: (value: string) => void; onPhoneChange: (value: string) => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; showHelp?: boolean;
}) {
  return <MobileFrame><section className={styles.access} aria-labelledby="mobile-access-title">
    <div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Acceso protegido</div>
    <h1 id="mobile-access-title">Pide lo que tu obra necesita.</h1>
    <p className={styles.accessCopy}>Primero confirma tus datos. Después solo tendrás que completar dos pasos claros.</p>
    <form className={styles.accessCard} onSubmit={onSubmit} noValidate>
      <label className={styles.field}><span className={styles.fieldLabel}>Código de obra <em className={styles.required}>*</em></span><input className={styles.control} name="access-code" value={code} onChange={event => onCodeChange(event.target.value)} placeholder="Ej. MIZAR-PRADERA" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'mobile-access-error' : undefined} /></label>
      <label className={styles.field}><span className={styles.fieldLabel}>Teléfono autorizado <em className={styles.required}>*</em></span><span className={styles.inputWithIcon}><Phone aria-hidden="true" size={18} /><input className={styles.control} name="access-phone" value={phone} onChange={event => onPhoneChange(event.target.value)} placeholder="300 000 0000" inputMode="tel" autoComplete="tel" aria-invalid={Boolean(error)} aria-describedby={error ? 'mobile-access-error' : undefined} /></span></label>
      {error && <p className={styles.error} id="mobile-access-error" role="alert">{error}</p>}
      <button className={styles.primaryButton} type="submit">Continuar <ArrowRight aria-hidden="true" size={19} /></button>
    </form>
    {showHelp && <div className={styles.accessHelp}><ShieldCheck aria-hidden="true" size={19} /><span><b>¿No tienes el código?</b><small>Pídeselo al responsable de la obra. Este enlace solo permite crear una requisición.</small></span></div>}
  </section></MobileFrame>;
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

function DemoMobileRequest() {
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false);
  const [code, setCode] = useState(''), [phone, setPhone] = useState(''), [accessError, setAccessError] = useState('');
  const [step, setStep] = useState<1 | 2>(1), [values, setValues] = useState(initialValues), [errors, setErrors] = useState<FieldErrors>({}), [showDetails, setShowDetails] = useState(false);
  const update = <K extends keyof RequestValues>(key: K, value: RequestValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const handleAccess = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (code.trim().length < 4 || phone.trim().length < 7) { setAccessError('Ingresa el código de obra y un teléfono válido para continuar.'); return; } setAccessError(''); setAccessGranted(true); };
  const validate = (targetStep: 1 | 2) => {
    const next: FieldErrors = {};
    if (targetStep === 1) { if (!values.work) next.work = 'Selecciona la obra.'; if (!values.date) next.date = 'Indica la fecha requerida.'; if (values.requestor.trim().length < 2) next.requestor = 'Escribe tu nombre.'; }
    else { if (!values.item) next.item = 'Selecciona el material.'; if (!values.quantity || Number(values.quantity) < 1) next.quantity = 'Indica una cantidad mayor que cero.'; }
    setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return false; } return true;
  };
  const nextStep = () => { if (validate(1)) { setErrors({}); setStep(2); } };
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!validate(2)) return; setSent(true); };
  if (sent) return <MobileFrame><section className={styles.success}><div className={styles.successDemo} role="status"><b>Modo demostración</b>No se creó una requisición real ni se guardaron datos.</div><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>Recorrido completado.</h1><p className={styles.successCopy}>El formulario móvil quedó listo para probar. Este código no sirve para seguimiento real.</p><div className={styles.trackingCode}>REQ-DEMO-0148</div><button className={styles.primaryButton} type="button" onClick={() => { setValues(initialValues()); setErrors({}); setStep(1); setSent(false); }}>Probar otra requisición</button></section></MobileFrame>;
  if (!accessGranted) return <AccessGate code={code} phone={phone} error={accessError} onCodeChange={setCode} onPhoneChange={setPhone} onSubmit={handleAccess} showHelp />;
  return <MobileFrame><StepIntro code={code} onChangeAccess={() => setAccessGranted(false)} /><Progress step={step} />
    <form className={styles.stepCard} onSubmit={submit} noValidate>
      {step === 1 ? <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso 1 de 2</p><h2>¿Para quién y cuándo?</h2><p>Elige la obra, la fecha y escribe tu nombre.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Obra <em className={styles.required}>*</em></span><select className={styles.control} name="work" value={values.work} onChange={event => update('work', event.target.value)} aria-invalid={Boolean(errors.work)} aria-describedby={errors.work ? 'mobile-work-error' : undefined}><option value="" disabled>Selecciona tu obra</option>{works.map(work => <option key={work}>{work}</option>)}</select>{errors.work && <small className={styles.error} id="mobile-work-error">{errors.work}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Fecha requerida <em className={styles.required}>*</em></span><input className={styles.control} name="date" type="date" value={values.date} onChange={event => update('date', event.target.value)} aria-invalid={Boolean(errors.date)} aria-describedby={errors.date ? 'mobile-date-error' : undefined} />{errors.date && <small className={styles.error} id="mobile-date-error">{errors.date}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Teléfono</span><input className={styles.control} name="phone" value={phone} readOnly /></label></div>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu nombre <em className={styles.required}>*</em></span><input className={styles.control} name="requestor" value={values.requestor} onChange={event => update('requestor', event.target.value)} placeholder="Nombre completo" autoComplete="name" aria-invalid={Boolean(errors.requestor)} aria-describedby={errors.requestor ? 'mobile-requestor-error' : undefined} />{errors.requestor && <small className={styles.error} id="mobile-requestor-error">{errors.requestor}</small>}</label>
        <div className={`${styles.actionRow} ${styles.actionRowSingle}`}><button className={styles.primaryButton} type="button" onClick={nextStep}>Continuar a material <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></> : <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso 2 de 2</p><h2>¿Qué material necesitas?</h2><p>Selecciona el material y cuántas unidades necesitas.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Material <em className={styles.required}>*</em></span><select className={styles.control} name="item" value={values.item} onChange={event => update('item', event.target.value)} aria-invalid={Boolean(errors.item)} aria-describedby={errors.item ? 'mobile-item-error' : undefined}><option value="" disabled>Selecciona el material</option>{items.map(item => <option key={item.name}>{item.name}</option>)}</select>{errors.item && <small className={styles.error} id="mobile-item-error">{errors.item}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Cantidad <em className={styles.required}>*</em></span><input className={styles.control} name="quantity" type="number" inputMode="decimal" min="1" value={values.quantity} onChange={event => update('quantity', event.target.value)} aria-invalid={Boolean(errors.quantity)} aria-describedby={errors.quantity ? 'mobile-quantity-error' : undefined} />{errors.quantity && <small className={styles.error} id="mobile-quantity-error">{errors.quantity}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Unidad</span><select className={styles.control} name="unit" value={values.unit} onChange={event => update('unit', event.target.value)}><option>Bulto</option><option>Unidad</option><option>m³</option></select></label></div>
        <button className={styles.optionalToggle} type="button" onClick={() => setShowDetails(open => !open)} aria-expanded={showDetails}><span><SquarePen aria-hidden="true" size={18} /> Agregar una nota o foto <small className={styles.hint}>(opcional)</small></span><span aria-hidden="true">{showDetails ? '−' : '+'}</span></button>
        {showDetails && <div className={styles.optionalPanel}><label className={styles.field}><span className={styles.fieldLabel}>Observaciones <small className={styles.hint}>opcional</small></span><textarea className={`${styles.control} ${styles.textarea}`} name="notes" value={values.notes} onChange={event => update('notes', event.target.value)} placeholder="Marca, tamaño o instrucciones de entrega" /></label><label className={styles.uploadLabel}><Upload aria-hidden="true" size={20} /><span><b>Adjunta una foto o cotización</b><small>PDF, JPG o PNG · máximo 10 MB</small></span><input type="file" aria-label="Adjuntar una foto o cotización" /></label></div>}
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => { setErrors({}); setStep(1); }}><ArrowLeft aria-hidden="true" size={18} /> Volver</button><button className={styles.primaryButton} type="submit">Enviar requisición <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}
    </form>
  </MobileFrame>;
}

function ProductionMobileRequest({ enabled }: { enabled: boolean }) {
  const [access, setAccess] = useState<PublicAccess | undefined>(), [linkRead, setLinkRead] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false), [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState(''), [phone, setPhone] = useState(''), [accessError, setAccessError] = useState('');
  const [step, setStep] = useState<1 | 2>(1), [values, setValues] = useState(initialValues), [errors, setErrors] = useState<FieldErrors>({}), [formError, setFormError] = useState(''), [showDetails, setShowDetails] = useState(false);
  useEffect(() => { let active = true; const fragment = enabled ? new URLSearchParams(window.location.hash.replace(/^#/, '')) : new URLSearchParams(), workId = fragment.get('obra') ?? '', token = fragment.get('token') ?? '', valid = enabled && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId) && /^[0-9a-f]{64}$/.test(token); if (enabled) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); queueMicrotask(() => { if (!active) return; if (valid) setAccess({ workId, token }); setLinkRead(true); }); return () => { active = false; }; }, [enabled]);
  const update = <K extends keyof RequestValues>(key: K, value: RequestValues[K]) => setValues(current => ({ ...current, [key]: value }));
  const handleAccess = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (code.trim().length < 4 || phone.trim().length < 7) { setAccessError('Ingresa el código de obra y un teléfono válido para continuar.'); return; } setAccessError(''); setAccessGranted(true); };
  const validate = (targetStep: 1 | 2) => {
    const next: FieldErrors = {};
    if (targetStep === 1) { if (!values.date) next.date = 'Indica la fecha requerida.'; if (values.requestor.trim().length < 2) next.requestor = 'Escribe tu nombre.'; }
    else { if (values.description.trim().length < 1) next.description = 'Describe lo que necesitas.'; if (!values.quantity || Number(values.quantity) <= 0) next.quantity = 'Indica una cantidad mayor que cero.'; if (!values.unit.trim()) next.unit = 'Indica la unidad.'; if (values.productLink && !values.productLink.startsWith('https://')) next.productLink = 'El enlace debe comenzar con https://'; }
    setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return false; } return true;
  };
  const nextStep = () => { if (validate(1)) { setErrors({}); setStep(2); } };
  const submit = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!access || !validate(2)) return; setFormError(''); setSubmitting(true); const payload = { workId: access.workId, code, type: values.type, requiredDate: values.date, name: values.requestor, phone, destination: values.destination || undefined, observations: values.notes || undefined, items: [{ description: values.description, quantity: Number(values.quantity), unit: values.unit, possibleSupplier: values.supplier || undefined, productLink: values.productLink || undefined }] }; try { const response = await fetch('/api/public/requisitions', { method: 'POST', headers: { 'content-type': 'application/json', 'x-public-link-token': access.token }, body: JSON.stringify(payload) }); if (response.status === 202) setSent(true); else if (response.status === 503) setFormError('El servicio de requisiciones no está disponible. Intenta más tarde.'); else setFormError('No pudimos recibir la solicitud. Revisa los campos e intenta otra vez.'); } catch { setFormError('No pudimos conectar con el servicio. Intenta más tarde.'); } finally { setSubmitting(false); } };
  if (!linkRead) return <MobileFrame><section className={`${styles.access} ${styles.closedGate}`} role="status"><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Validando enlace</div><h1>Preparando el formulario…</h1></section></MobileFrame>;
  if (!access) return <MobileFrame><section className={`${styles.access} ${styles.closedGate}`}><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Captura cerrada</div><h1>Este enlace no está habilitado.</h1><p className={styles.accessCopy}>Solicita al responsable de tu obra un enlace vigente. No se creó ninguna requisición ni se aceptaron datos.</p></section></MobileFrame>;
  if (sent) return <MobileFrame><section className={styles.success}><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>La estamos validando.</h1><p className={styles.successCopy}>Si el enlace, código y teléfono corresponden a la obra, la requisición quedará registrada. Por seguridad no mostramos un consecutivo.</p><button className={styles.primaryButton} type="button" onClick={() => { setValues(initialValues()); setErrors({}); setStep(1); setSent(false); setAccessGranted(false); }}>Enviar otra solicitud</button></section></MobileFrame>;
  if (!accessGranted) return <AccessGate code={code} phone={phone} error={accessError} onCodeChange={setCode} onPhoneChange={setPhone} onSubmit={handleAccess} />;
  return <MobileFrame><StepIntro code="obra autorizada" onChangeAccess={() => setAccessGranted(false)} /><Progress step={step} />
    <form className={styles.stepCard} onSubmit={submit} noValidate>
      {step === 1 ? <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso 1 de 2</p><h2>¿Para quién y cuándo?</h2><p>Indica el tipo de solicitud, la fecha y tu nombre.</p></div><div className={styles.stepBody}>
        <fieldset className={styles.fieldset}><legend className={styles.fieldsetLegend}>¿Qué vas a solicitar? <em className={styles.required}>*</em></legend><div className={styles.choiceGrid}><label className={styles.choice}><input type="radio" name="type" value="compra" checked={values.type === 'compra'} onChange={() => update('type', 'compra')} /><span className={styles.choiceIcon}><PackageCheck aria-hidden="true" size={16} /></span>Compra de material</label><label className={styles.choice}><input type="radio" name="type" value="pago" checked={values.type === 'pago'} onChange={() => update('type', 'pago')} /><span className={styles.choiceIcon}><ClipboardList aria-hidden="true" size={16} /></span>Solicitud de pago</label></div></fieldset>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Fecha requerida <em className={styles.required}>*</em></span><input className={styles.control} name="date" type="date" value={values.date} onChange={event => update('date', event.target.value)} aria-invalid={Boolean(errors.date)} aria-describedby={errors.date ? 'mobile-production-date-error' : undefined} />{errors.date && <small className={styles.error} id="mobile-production-date-error">{errors.date}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Teléfono</span><input className={styles.control} name="phone" value={phone} readOnly /></label></div>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu nombre <em className={styles.required}>*</em></span><input className={styles.control} name="requestor" value={values.requestor} onChange={event => update('requestor', event.target.value)} autoComplete="name" aria-invalid={Boolean(errors.requestor)} aria-describedby={errors.requestor ? 'mobile-production-requestor-error' : undefined} />{errors.requestor && <small className={styles.error} id="mobile-production-requestor-error">{errors.requestor}</small>}</label>
        <label className={styles.field}><span className={styles.fieldLabel}>Destino o frente <small className={styles.hint}>opcional</small></span><input className={styles.control} name="destination" value={values.destination} onChange={event => update('destination', event.target.value)} maxLength={500} placeholder="Ej. Torre 2, piso 4" /></label>
        <div className={`${styles.actionRow} ${styles.actionRowSingle}`}><button className={styles.primaryButton} type="button" onClick={nextStep}>Continuar a material <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></> : <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso 2 de 2</p><h2>Describe el material.</h2><p>Con una descripción, cantidad y unidad podemos recibir la solicitud.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>¿Qué necesitas? <em className={styles.required}>*</em></span><input className={styles.control} name="description" value={values.description} onChange={event => update('description', event.target.value)} maxLength={500} placeholder="Ej. 20 bultos de cemento gris" aria-invalid={Boolean(errors.description)} aria-describedby={errors.description ? 'mobile-description-error' : undefined} />{errors.description && <small className={styles.error} id="mobile-description-error">{errors.description}</small>}</label>
        <div className={styles.twoColumns}><label className={styles.field}><span className={styles.fieldLabel}>Cantidad <em className={styles.required}>*</em></span><input className={styles.control} name="quantity" type="number" inputMode="decimal" min="0.001" step="0.001" value={values.quantity} onChange={event => update('quantity', event.target.value)} aria-invalid={Boolean(errors.quantity)} aria-describedby={errors.quantity ? 'mobile-production-quantity-error' : undefined} />{errors.quantity && <small className={styles.error} id="mobile-production-quantity-error">{errors.quantity}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Unidad <em className={styles.required}>*</em></span><input className={styles.control} name="unit" value={values.unit} onChange={event => update('unit', event.target.value)} maxLength={40} aria-invalid={Boolean(errors.unit)} aria-describedby={errors.unit ? 'mobile-unit-error' : undefined} />{errors.unit && <small className={styles.error} id="mobile-unit-error">{errors.unit}</small>}</label></div>
        <button className={styles.optionalToggle} type="button" onClick={() => setShowDetails(open => !open)} aria-expanded={showDetails}><span><SquarePen aria-hidden="true" size={18} /> Agregar detalles <small className={styles.hint}>(opcional)</small></span><span aria-hidden="true">{showDetails ? '−' : '+'}</span></button>
        {showDetails && <div className={styles.optionalPanel}><label className={styles.field}><span className={styles.fieldLabel}>Posible proveedor <small className={styles.hint}>opcional</small></span><input className={styles.control} name="supplier" value={values.supplier} onChange={event => update('supplier', event.target.value)} maxLength={240} /></label><label className={styles.field}><span className={styles.fieldLabel}>Enlace del producto <small className={styles.hint}>HTTPS opcional</small></span><input className={styles.control} name="productLink" type="url" inputMode="url" value={values.productLink} onChange={event => update('productLink', event.target.value)} maxLength={2048} placeholder="https://…" aria-invalid={Boolean(errors.productLink)} aria-describedby={errors.productLink ? 'mobile-link-error' : undefined} />{errors.productLink && <small className={styles.error} id="mobile-link-error">{errors.productLink}</small>}</label><label className={styles.field}><span className={styles.fieldLabel}>Observaciones <small className={styles.hint}>opcional</small></span><textarea className={`${styles.control} ${styles.textarea}`} name="notes" value={values.notes} onChange={event => update('notes', event.target.value)} maxLength={3000} /></label><p className={styles.securityNote}><LockKeyhole aria-hidden="true" size={17} /> Fotos y PDF aún no están disponibles en el portal público.</p></div>}
        {formError && <p className={styles.error} role="alert">{formError}</p>}<div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => { setErrors({}); setStep(1); }}><ArrowLeft aria-hidden="true" size={18} /> Volver</button><button className={styles.primaryButton} type="submit" disabled={submitting}>{submitting ? 'Enviando…' : 'Enviar requisición'} <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}
    </form>
  </MobileFrame>;
}

export function MobilePublicRequestScreen({ demoMode, publicConfigured = false }: { demoMode: boolean; publicConfigured?: boolean }) {
  return demoMode ? <DemoMobileRequest /> : <ProductionMobileRequest enabled={publicConfigured} />;
}
