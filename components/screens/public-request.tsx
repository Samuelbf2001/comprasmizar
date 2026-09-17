'use client';

import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight, Banknote, Camera, Check, ClipboardList, FileText, HardHat, LockKeyhole, PackageCheck, Phone, Plus, ShieldCheck, SquarePen, UserRound, X } from 'lucide-react';
import { companies } from '../../lib/demo-data';
import { attachmentAccept, DOCUMENT_MIME_TYPES, formatAttachmentSize, IMAGE_MIME_TYPES, validateAttachmentFile } from './attachment-upload';
import styles from './public-request.module.css';

/**
 * 10 MB — el MISMO tope que vuelve a comprobar el servidor con los bytes reales
 * (`MAX_PUBLIC_ATTACHMENT_BYTES` en `lib/infrastructure/public-attachments.ts`). Duplicado a
 * propósito: cliente y servidor no comparten build, igual que `MAX_LINEAS` de abajo y el
 * `items.max(20)` del endpoint. Esta comprobación es solo cortesía —evita subir 40 MB para que el
 * servidor los rechace— nunca la autoridad: quien decide de verdad es el servidor, oliendo los bytes.
 *
 * Subió de 5 a 10 MB el 2026-09-17 junto con los formatos: una factura escaneada en PDF o un Excel
 * de cantidades pasan de 5 MB con facilidad, y una foto de teléfono ya rozaba el tope anterior.
 */
const MAX_PUBLIC_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Lo que el portal dice en el campo y lo que el diálogo del navegador deja elegir: la misma lista
 *  que acepta el servidor (ver `attachment-upload.tsx`), en palabras de quien radica. */
const AYUDA_SOPORTE = 'Foto, PDF, Excel, Word o CSV. Hasta 10 MB.';

// `workId` ausente = enlace GENERAL (uno solo para todas las obras): la obra se elige en el
// formulario, no viene firmada en el enlace. Ver lib/security/public-link.ts.
/**
 * `token` es OPCIONAL desde 2026-09-11. Decisión de Ernesto, literal: «que el enlace no necesite un
 * token, sea ruta pública». Es decir, `/requisiciones/publica` a secas abre la compuerta y la
 * contraseña es la única llave. Los enlaces firmados que ya se repartieron siguen valiendo y siguen
 * sirviendo para acotar a una obra concreta, que es lo único que el token hace ahora.
 */
type PublicAccess = { workId?: string; token?: string };
type PublicCompany = { id: string; name: string };
// Reunión 2026-08-31: el antiguo campo "frente o actividad" sale del modelo (se fusiona en
// notes/observations, ver "Observaciones" del paso ¿Para cuándo?); requiredDate ya era opcional aquí.
/** Una línea del pedido. Ernesto, 11-sep-2026: "solo dejas agregar un ítem por form, debe permitir ir
 *  agregando más" — un maestro que necesita cemento, arena y varilla tenía que radicar tres veces. */
/** `photo` es EL ARCHIVO tal cual, nunca serializado: viaja aparte en el envío (multipart, ver
 *  `ProductionPublicRequest.handleEnviar`), calcado del `PhotoPicker` del Flow de WhatsApp — una foto
 *  opcional por artículo. `null` = sin foto, el caso normal. */
type RequestLine = { description: string; quantity: string; unit: string; supplier: string; productLink: string; photo: File | null };
/** Mismos valores que `SUPPLIER_IDENTIFICATION_TYPE_VALUES` (lib/http/schemas.ts) y que el CHECK de
 *  `proveedores.tipo_identificacion`; repetidos aquí porque cliente y servidor no comparten build. */
type IdentificationType = 'CC' | 'NIT' | 'CE' | 'PAS';
const TIPOS_IDENTIFICACION: { valor: IdentificationType; etiqueta: string }[] = [
  { valor: 'CC', etiqueta: 'Cédula de ciudadanía' },
  { valor: 'NIT', etiqueta: 'NIT' },
  { valor: 'CE', etiqueta: 'Cédula de extranjería' },
  { valor: 'PAS', etiqueta: 'Pasaporte' },
];
/** Mismo tope que `MAX_PUBLIC_PAYMENT_CONCEPT_LENGTH` en el endpoint (RF-108: "concepto corto"). */
const MAX_CONCEPTO = 120;
/**
 * Solicitud de pago (RF-108, A12 del plan): quien la radica ES el beneficiario —un profesional o un
 * proveedor que cobra—, así que aquí no hay "solicitante" aparte: `beneficiaryName` es el nombre que
 * viaja como solicitante externo y el teléfono es el mismo `phone` de siempre. `amount` se guarda
 * como dígitos (texto) y se convierte a número solo al enviar; `photo` es la factura o cuenta de
 * cobro, con el MISMO mecanismo que la foto de un artículo (viaja como `foto_0`).
 */
type PaymentValues = { identificationType: IdentificationType; identification: string; beneficiaryName: string; amount: string; concept: string; photo: File | null };
type RequestValues = {
  // `company`, no `work`: el solicitante elige EMPRESA y la obra la asigna el revisor (reunión
  // 2026-08-31; Ernesto: "ya dijimos era empresa"). El enlace POR OBRA sigue trayendo la suya fija,
  // y entonces este campo ni se pide.
  type: 'compra' | 'pago'; company: string; date: string; requestor: string;
  notes: string; lines: RequestLine[]; payment: PaymentValues;
};
/**
 * `phone` no vive en `RequestValues` —tiene su propio estado, porque también viaja aparte en el
 * envío—; desde 2026-09-11 se valida como un campo más (ahora en la pantalla "Tus datos"), así que
 * necesita error.
 *
 * Las claves de línea llevan el ÍNDICE (`description-0`, `quantity-1`) y coinciden con el atributo
 * `name` del campo, que es como `focusFirstError` lo encuentra. Sin el índice, con varios ítems el
 * foco saltaría siempre al primero y quien se equivocara en el tercero no vería dónde.
 */
type FieldErrors = Record<string, string>;

/**
 * Las cinco fases del asistente guiado (11-sep-2026). Ernesto pidió que el portal se pareciera al
 * Flow de WhatsApp que ya le gusta al cliente (`integrations/whatsapp-flow/requisicion-captura.flow.json`):
 * pantallas cortas, una cosa a la vez, un artículo por pantalla. No es una copia pantalla por
 * pantalla —aquí "tus datos" y "el tipo de solicitud" tienen su propio momento, distinto del Flow—,
 * pero la idea es la misma: nunca más de una decisión por pantalla.
 *
 * `item` es UNA fase que cubre VARIAS pantallas (una por artículo, ver `itemIndex` en el estado del
 * formulario): el indicador de avance las trata como un solo tramo porque su número no es fijo.
 */
type Phase = 'tipo' | 'datos' | 'item' | 'cuando' | 'beneficiario' | 'pago' | 'resumen';
type Etapa = { fase: Phase; etiqueta: string };
const ETAPAS_COMPRA: Etapa[] = [
  { fase: 'tipo', etiqueta: 'Solicitud' },
  { fase: 'datos', etiqueta: 'Tus datos' },
  { fase: 'item', etiqueta: 'Material' },
  { fase: 'cuando', etiqueta: '¿Cuándo?' },
  { fase: 'resumen', etiqueta: 'Resumen' },
];
/** RF-108 (A12): tras «Solicitud de pago» el camino es de tres pasos —quién cobra, el pago, resumen—.
 *  Sin "Tus datos" (quien radica es el beneficiario) y sin artículos ni "¿Para cuándo?": el concepto
 *  y el monto son la única línea. */
const ETAPAS_PAGO: Etapa[] = [
  { fase: 'tipo', etiqueta: 'Solicitud' },
  { fase: 'beneficiario', etiqueta: 'Quién cobra' },
  { fase: 'pago', etiqueta: 'El pago' },
  { fase: 'resumen', etiqueta: 'Resumen' },
];
const etapasDe = (type: RequestValues['type']) => (type === 'pago' ? ETAPAS_PAGO : ETAPAS_COMPRA);
const TYPE_LABELS: Record<RequestValues['type'], string> = { compra: 'Compra de material', pago: 'Solicitud de pago' };

function nuevaLinea(): RequestLine {
  // Unidad VACÍA, no "Unidad": era el valor por defecto de un desplegable que ya no existe, y dejarlo
  // haría que se radicara "Unidad" como unidad real sin que nadie lo eligiera.
  return { description: "", quantity: "1", unit: "", supplier: "", productLink: "", photo: null };
}

/** Tope de ítems por requisición. Es el mismo orden de magnitud que el esquema del endpoint
 *  (`items.max(20)`), el Flow de WhatsApp y el CheckboxGroup de aprobación: una requisición
 *  radicada por el portal sigue cabiendo entera en el resto del ciclo. */
const MAX_LINEAS = 20;
/** Sugerencias del `datalist` de unidad. NO es una lista cerrada (ver el campo del artículo).
 *  La descripción del artículo, en cambio, sigue siendo texto libre sin sugerencias: el endpoint
 *  público (`app/api/public/companies`) no expone ningún catálogo de ítems, así que no hay de dónde
 *  sacarlas. Si algún día existe ese catálogo, aquí es donde se conectaría un `datalist` igual. */
const UNIDADES_SUGERIDAS = ["und", "m", "m²", "m³", "kg", "bulto", "galón", "viaje", "global"];

function pagoInicial(): PaymentValues {
  return { identificationType: 'CC', identification: '', beneficiaryName: '', amount: '', concept: '', photo: null };
}
function initialValues(): RequestValues {
  return { type: "compra", company: "", date: new Date().toISOString().slice(0, 10), requestor: "", notes: "", lines: [nuevaLinea()], payment: pagoInicial() };
}
/** Pesos colombianos sin decimales, como se escriben en obra: "$ 1.250.000". */
const formatoCOP = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 });

function focusFirstError(errors: FieldErrors) {
  const field = Object.keys(errors)[0];
  if (!field) return;
  window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus());
}

/**
 * Estado del asistente y las operaciones sobre sus líneas, compartido por la pantalla real y la de
 * demostración.
 *
 * Vive aquí y no dentro de cada componente porque reindexar errores y detalles al quitar una línea es
 * la parte fácil de equivocarse, y tenerla escrita dos veces era garantizar que una de las dos se
 * quedara mal el día que alguien la tocara. `phase` e `itemIndex` viven en el mismo sitio que
 * `values` por la misma razón que `phone` ya vivía aparte de `RequestValues`: es estado del
 * FORMULARIO, no del envío, y las dos pantallas (demo y real) recorren el mismo asistente.
 */
function useFormularioRequisicion() {
  const [values, setValues] = useState(initialValues), [errors, setErrors] = useState<FieldErrors>({}), [detalles, setDetalles] = useState<number[]>([]);
  const [phone, setPhone] = useState('');
  const [phase, setPhase] = useState<Phase>('tipo');
  const [itemIndex, setItemIndex] = useState(0);
  const update = <K extends keyof RequestValues>(key: K, value: RequestValues[K]) => setValues(current => ({ ...current, [key]: value }));
  // Una línea cambia sola y las demás se conservan por referencia: `map` en vez de mutar, porque
  // React compara por identidad y una mutación in situ no repintaría el campo.
  const updateLinea = (indice: number, campo: keyof RequestLine, valor: string) =>
    setValues(current => ({ ...current, lines: current.lines.map((linea, i) => (i === indice ? { ...linea, [campo]: valor } : linea)) }));
  // Aparte de `updateLinea`: esa función solo mueve strings (`campo: keyof RequestLine, valor:
  // string`), y un `File` no lo es. `null` quita la foto (botón "Quitar foto").
  const setLineaFoto = (indice: number, foto: File | null) =>
    setValues(current => ({ ...current, lines: current.lines.map((linea, i) => (i === indice ? { ...linea, photo: foto } : linea)) }));
  const updatePago = <K extends keyof PaymentValues>(campo: K, valor: PaymentValues[K]) =>
    setValues(current => ({ ...current, payment: { ...current.payment, [campo]: valor } }));
  const agregarLinea = () => setValues(current => (current.lines.length >= MAX_LINEAS ? current : { ...current, lines: [...current.lines, nuevaLinea()] }));
  // NUNCA por debajo de una línea. El esquema exige `items.min(1)`, así que llegar al resumen sin
  // ítems acabaría en un 400 del endpoint sin requisición.
  //
  // Los detalles abiertos y los errores se REINDEXAN al quitar: son índices, no identidades. Sin
  // esto, quitar el ítem 1 dejaría el panel abierto y el error rojo sobre el que ocupe su lugar, que
  // nadie ha tocado.
  const quitarLinea = (indice: number) => {
    setValues(current => (current.lines.length <= 1 ? current : { ...current, lines: current.lines.filter((_, i) => i !== indice) }));
    setDetalles(abiertos => abiertos.filter(i => i !== indice).map(i => (i > indice ? i - 1 : i)));
    setErrors(actuales => Object.fromEntries(Object.entries(actuales).flatMap(([clave, mensaje]) => {
      const partes = /^([A-Za-z]+)-(\d+)$/.exec(clave);
      if (!partes) return [[clave, mensaje] as const];
      const posicion = Number(partes[2]);
      return posicion === indice ? [] : [[`${partes[1]}-${posicion > indice ? posicion - 1 : posicion}`, mensaje] as const];
    })));
  };
  const alternarDetalle = (indice: number) => setDetalles(abiertos => (abiertos.includes(indice) ? abiertos.filter(i => i !== indice) : [...abiertos, indice]));
  const reiniciar = () => { setValues(initialValues()); setErrors({}); setDetalles([]); setPhone(''); setPhase('tipo'); setItemIndex(0); };
  return { values, errors, setErrors, detalles, phone, setPhone, phase, setPhase, itemIndex, setItemIndex, update, updateLinea, setLineaFoto, updatePago, agregarLinea, quitarLinea, alternarDetalle, reiniciar };
}

/**
 * Las tres validaciones están separadas —una por pantalla— porque cada fase del asistente solo debe
 * fallar por lo que ESA fase pide. Antes había una sola función con un `targetStep` de dos ramas;
 * con cinco pantallas esa rama única habría mezclado errores de campos que ni se ven en la pantalla
 * que falla.
 */
/** Fase "¿Qué vas a solicitar?": tipo y empresa. El tipo SIEMPRE tiene un valor —el radio nace en
 *  "compra"—, así que lo único que puede fallar es la empresa, y solo si el enlace no la trae fija.
 *  En una solicitud de PAGO la empresa se pide en "El pago" (junto al monto: es a la que se cobra,
 *  A12 del plan), así que aquí no se exige. */
function validarTipoEmpresa(values: RequestValues, exigirEmpresa: boolean): FieldErrors {
  const next: FieldErrors = {};
  if (exigirEmpresa && values.type === 'compra' && !values.company) next.company = "Selecciona la empresa.";
  return next;
}
/** La misma regla del teléfono en "Tus datos" (compra) y en "¿Quién cobra?" (pago). */
function errorTelefono(phone: string): string | undefined {
  return phone.trim() && phone.replace(/[^0-9]/g, "").length < 7 ? "Ese teléfono está incompleto. Déjalo vacío o escríbelo completo." : undefined;
}
/** Mismos topes que el esquema del endpoint (3..32). Sin puntos ni espacios: el número es la
 *  identidad del beneficiario y "1.020.304" no enlazaría con "1020304"; el campo los quita al teclear. */
const IDENTIFICACION_RE = /^[0-9A-Za-z-]{3,32}$/;
/** Fase "¿Quién cobra?" (pago): identificación, nombre y teléfono opcional. */
function validarBeneficiario(pago: PaymentValues, phone: string): FieldErrors {
  const next: FieldErrors = {};
  if (!IDENTIFICACION_RE.test(pago.identification.trim())) next.identification = "Escribe el número de identificación, solo números y letras.";
  if (pago.beneficiaryName.trim().length < 2) next.beneficiaryName = "Escribe el nombre completo o la razón social.";
  const telefono = errorTelefono(phone);
  if (telefono) next.phone = telefono;
  return next;
}
/** Fase "El pago": empresa a la que se cobra (si el enlace no la trae fija), monto y concepto. */
function validarPago(values: RequestValues, exigirEmpresa: boolean): FieldErrors {
  const next: FieldErrors = {};
  if (exigirEmpresa && !values.company) next.company = "Selecciona la empresa a la que cobras.";
  if (!(Number(values.payment.amount) > 0)) next.amount = "Indica el monto a cobrar, en pesos.";
  const concepto = values.payment.concept.trim();
  if (!concepto) next.concept = "Di en pocas palabras qué se paga.";
  else if (concepto.length > MAX_CONCEPTO) next.concept = `El concepto debe tener máximo ${MAX_CONCEPTO} caracteres.`;
  return next;
}
/**
 * Fase "Tus datos": nombre y teléfono.
 *
 * TELÉFONO OPCIONAL (Ernesto, 11-sep-2026: «el teléfono no lo hagas obligatorio»). Si se deja en
 * blanco se radica igual y no hay acuse. Si se escribe algo, tiene que ser un número usable: un
 * teléfono a medias es peor que ninguno, porque el aviso se encola contra alguien que no existe y
 * nadie se entera de que no llegó.
 */
function validarDatos(values: RequestValues, phone: string): FieldErrors {
  const next: FieldErrors = {};
  if (values.requestor.trim().length < 2) next.requestor = "Escribe tu nombre.";
  const telefono = errorTelefono(phone);
  if (telefono) next.phone = telefono;
  return next;
}
/** Un artículo: la pantalla que se repite una vez por ítem. Con el índice en la clave para que el
 *  foco caiga en el campo que falla y no siempre en el primero. */
function validarItem(indice: number, linea: RequestLine): FieldErrors {
  const next: FieldErrors = {};
  if (linea.description.trim().length < 1) next[`description-${indice}`] = "Describe lo que necesitas.";
  if (!linea.quantity || Number(linea.quantity) <= 0) next[`quantity-${indice}`] = "Indica una cantidad mayor que cero.";
  if (!linea.unit.trim()) next[`unit-${indice}`] = "Indica la unidad.";
  if (linea.productLink && !linea.productLink.startsWith("https://")) next[`productLink-${indice}`] = "El enlace debe comenzar con https://";
  return next;
}
/** Todos los artículos juntos: la red de seguridad del RESUMEN antes de enviar. Cada pantalla ya
 *  valida el suyo al avanzar, así que esto nunca debería encontrar nada — pero si lo encuentra, es
 *  mejor devolver al asistente a la fase que falla que dejar pasar un envío que el servidor va a
 *  rechazar con un 400 sin decir en qué pantalla estaba el campo. */
function validarItems(lines: RequestLine[]): FieldErrors {
  return lines.reduce<FieldErrors>((acumulado, linea, indice) => ({ ...acumulado, ...validarItem(indice, linea) }), {});
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
 * El teléfono no desaparece: se pide en la fase "Tus datos", que es donde se entiende para qué
 * sirve —avisar por WhatsApp del avance—. Desde el 11-sep-2026 es además OPCIONAL, así que lo
 * que alimenta `solicitante_telefono_externo` —y con ello «Mis requisiciones» y los avisos— solo
 * llega cuando quien radica quiere que le avisen.
 */
/**
 * Y la contraseña se comprueba CONTRA EL SERVIDOR antes de dejar pasar (`POST /api/public/access`).
 *
 * Hasta el 11-sep-2026 la compuerta solo miraba, en el navegador, que tuviera cuatro caracteres. Con
 * eso dejaba entrar cualquier cosa: Ernesto se equivocó de contraseña en producción, llenó los dos
 * pasos, pulsó enviar y leyó «La estamos validando» — el 202 del endpoint de radicación es neutro a
 * propósito y no distingue el acierto del error. La requisición no existía, nadie la recibió y él se
 * quedó esperando. Fallar en la puerta y decirlo cuesta un oráculo de la contraseña (ver el
 * comentario del endpoint, que lo asume por escrito); fallar al final no cuesta nada y se lleva el
 * pedido por delante.
 *
 * `comprobando` deshabilita el botón mientras se pregunta, que es medio segundo en el que, sin esto,
 * se pulsa dos veces y se gastan dos intentos del limitador.
 */
function AccessGate({ code, error, onSubmit, comprobando = false, showHelp = false }: {
  code: string; error: string; onSubmit: (datos: { code: string }) => void; comprobando?: boolean; showHelp?: boolean;
}) {
  const enviar = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit({ code: String(new FormData(event.currentTarget).get('access-code') ?? '') });
  };
  return <PortalFrame><section className={styles.access} aria-labelledby="portal-access-title">
    <div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Acceso protegido</div>
    <h1 id="portal-access-title">Pide lo que tu obra necesita.</h1>
    <p className={styles.accessCopy}>Escribe la contraseña que te dio Mizar. Después son unos pasos cortos.</p>
    <form className={styles.accessCard} onSubmit={enviar} noValidate>
      <label className={styles.field}><span className={styles.fieldLabel}>Contraseña del portal <em className={styles.required}>*</em></span><input className={styles.control} name="access-code" defaultValue={code} placeholder="Contraseña entregada por Mizar" autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? 'portal-access-error' : undefined} /></label>
      {error && <p className={styles.error} id="portal-access-error" role="alert">{error}</p>}
      <button className={styles.primaryButton} type="submit" disabled={comprobando}>{comprobando ? 'Comprobando…' : 'Continuar'} <ArrowRight aria-hidden="true" size={19} /></button>
    </form>
    {showHelp && <div className={styles.accessHelp}><ShieldCheck aria-hidden="true" size={19} /><span><b>¿No tienes la contraseña?</b><small>Pídesela al responsable de la obra. Este enlace solo permite crear una requisición.</small></span></div>}
  </section></PortalFrame>;
}

/** Indicador de avance: cinco fases en compra, cuatro en pago. `item` se marca como una sola etapa
 *  aunque cubra varias pantallas —una por artículo—, porque su número total no es fijo (depende de
 *  cuántos se agreguen). Las columnas van en línea porque el módulo CSS fija cinco y este es el único
 *  sitio que sabe cuántas hay. */
function Progress({ phase, etapas }: { phase: Phase; etapas: Etapa[] }) {
  const actual = etapas.findIndex(etapa => etapa.fase === phase);
  return <ol className={styles.progress} style={{ gridTemplateColumns: `repeat(${etapas.length}, 1fr)` }} aria-label="Avance de la requisición">
    {etapas.map((etapa, indice) => <li key={etapa.fase} className={`${styles.progressStep} ${indice === actual ? styles.progressCurrent : indice < actual ? styles.progressDone : ''}`} aria-current={indice === actual ? 'step' : undefined}>
      <strong>{indice < actual ? <Check aria-hidden="true" size={14} /> : indice + 1}</strong><span>{etapa.etiqueta}</span>
    </li>)}
  </ol>;
}

function StepIntro({ acceso, onChangeAccess }: { acceso: string; onChangeAccess: () => void }) {
  return <div className={styles.intro}><div className={styles.introLine}><div><div className={styles.kicker}><HardHat aria-hidden="true" size={17} /> Requisición de obra</div><h1>Haz la solicitud sin enredos.</h1></div><button className={styles.changeButton} type="button" onClick={onChangeAccess}>Cambiar datos</button></div><p>Unos pasos cortos, uno a la vez. Los campos con <em className={styles.required}>*</em> son necesarios para enviarla.</p><p className={styles.hint}>Acceso para: <b>{acceso}</b></p></div>;
}

/** QA H14: por la ruta general no hay obra; el acceso es para la empresa que se elige en el primer paso. */
function accesoPara(empresas: PublicCompany[], companyId: string, workId?: string): string {
  if (workId) return 'obra autorizada';
  return empresas.find(empresa => empresa.id === companyId)?.name ?? 'la empresa que elijas';
}

/**
 * Selector de EMPRESA, compartido por las dos pantallas.
 *
 * Reunión 2026-08-31 y recordatorio de Ernesto el 11-sep-2026 («en el formulario público aparece
 * seleccionar obra y ya dijimos era empresa»). La obra es el centro de costo y la asigna el revisor,
 * que es quien sabe a qué contrato cargar el gasto; el Flow de WhatsApp ya funcionaba así y el
 * portal se había quedado con el selector viejo.
 */
function SelectorEmpresa({ empresas, cargadas, valor, error, onChange, etiqueta = 'Empresa', ayuda = 'La obra la asigna quien revisa tu solicitud.' }: {
  empresas: PublicCompany[]; cargadas: boolean; valor: string; error?: string; onChange: (valor: string) => void; etiqueta?: string; ayuda?: string;
}) {
  return <label className={styles.field}><span className={styles.fieldLabel}>{etiqueta} <em className={styles.required}>*</em></span>
    <select className={styles.control} name="company" value={valor} onChange={event => onChange(event.target.value)} disabled={!cargadas || empresas.length === 0} aria-invalid={Boolean(error)} aria-describedby={error ? 'portal-company-error' : undefined}>
      <option value="" disabled>{cargadas ? (empresas.length ? 'Selecciona la empresa' : 'No hay empresas disponibles') : 'Cargando empresas…'}</option>
      {empresas.map(empresa => <option key={empresa.id} value={empresa.id}>{empresa.name}</option>)}
    </select>
    <small className={styles.hint}>{ayuda}</small>
    {error && <small className={styles.error} id="portal-company-error">{error}</small>}
  </label>;
}

/**
 * Los campos de UN artículo — la pantalla se repite una vez por ítem (ver la fase `item` del
 * asistente). Antes esto vivía en `LineasDePedido`, que pintaba TODAS las líneas en una sola
 * pantalla; Ernesto pidió que fuera "un artículo por pantalla", así que ahora recibe un solo índice
 * y una sola línea en vez de un arreglo.
 *
 * Proveedor y enlace SIGUEN opcionales y detrás de "Agregar detalles": son justo los dos campos que
 * el Flow de WhatsApp también deja opcionales en su pantalla de artículo.
 */
/**
 * Vista previa de una foto ya elegida, en miniatura. Vive aparte de `CampoSoporte` porque su único
 * trabajo es el ciclo de vida del `object URL` (crearlo al montar/cambiar de archivo, revocarlo al
 * desmontar): con un `useEffect` propio, quitar el artículo (que desmonta este componente) libera la
 * miniatura sola, sin que `quitarLinea` tenga que saber nada de URLs.
 */
function FotoPreview({ file, className }: { file: File; className: string }) {
  // `useMemo`, no `useState`+efecto: el object URL se calcula EN EL RENDER a partir de `file` (con la
  // misma identidad de archivo, siempre la misma URL), y el único trabajo del efecto es revocar la
  // anterior — nunca dispara un segundo render llamando `setState` desde dentro de sí mismo.
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  // Vista previa de un archivo LOCAL (object URL), nunca una imagen remota: el optimizador de
  // next/image no aplica aquí.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt="" className={className} />;
}

/** La miniatura del resumen: imagen de verdad cuando el archivo lo es, icono cuando es un documento. */
function SoportePreview({ file }: { file: File }) {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(file.type)
    ? <FotoPreview file={file} className={styles.summaryPhoto} />
    : <span className={styles.summaryDoc}><FileText aria-hidden="true" size={22} /></span>;
}

/**
 * Soporte opcional por artículo (RF portal-fotos-articulo). Nació como UNA foto, calcada del
 * `PhotoPicker` del Flow de WhatsApp; desde el 2026-09-17 admite además PDF, Excel, Word y CSV
 * (decisión de Ernesto: «muchos tipos de archivos, CSV, Excel, etc., PDF, imágenes, lo que sea»),
 * porque quien radica por el portal suele ser un proveedor con una factura, no un maestro con una
 * foto. Por eso ya no se fuerza la cámara con `capture`: en el móvil el diálogo sigue ofreciendo
 * "tomar foto" porque `accept` incluye imágenes, pero también deja llegar a los archivos.
 *
 * Reutiliza `validateAttachmentFile` de `attachment-upload.tsx` en vez de reinventar "¿esto pesa
 * demasiado o no es un formato admitido?" — es la MISMA comprobación que ya usa el resto de la
 * plataforma para adjuntos internos, solo que aquí es cortesía de cliente, no la autoridad: esa es
 * del servidor, que husmea los bytes (ver `lib/infrastructure/public-attachments.ts`).
 */
function CampoSoporte({ indice, foto, error, onFoto, onError, etiqueta = 'Soporte', titulo = 'Agregar un archivo', ariaLabel = 'Soporte (opcional)' }: {
  indice: number; foto: File | null; error?: string; onFoto: (file: File | null) => void; onError: (mensaje: string) => void;
  /** En la solicitud de pago el mismo campo es la factura o cuenta de cobro (RF-108): cambia el rótulo, no el mecanismo. */
  etiqueta?: string; titulo?: string; ariaLabel?: string;
}) {
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    // Se limpia SIEMPRE, se acepte o no el archivo: sin esto, elegir el MISMO archivo dos veces
    // seguidas (p.ej. tras "Quitar archivo") no dispararía un segundo `change` — el navegador no ve
    // diferencia.
    event.target.value = '';
    if (!file) return;
    const mensaje = validateAttachmentFile(file, { allowedMimeTypes: DOCUMENT_MIME_TYPES, maxBytes: MAX_PUBLIC_ATTACHMENT_BYTES });
    if (mensaje) { onError(mensaje); return; }
    onError('');
    onFoto(file);
  };
  // La miniatura solo tiene sentido con una imagen; un PDF o un Excel se anuncian con su icono y su
  // nombre, que es toda la confirmación que necesita quien acaba de elegirlo.
  const esImagen = foto !== null && (IMAGE_MIME_TYPES as readonly string[]).includes(foto.type);
  // `<div>`, no `<label>`, envolviendo todo: el `<label htmlFor>` de verdad es el interno
  // (`.uploadLabel`), que ya asocia el input con su texto. Anidar dos `<label>` es HTML inválido y
  // duplicaría el disparo del selector de archivos al hacer click.
  return <div className={styles.field}>
    <span className={styles.fieldLabel}>{etiqueta} <small className={styles.hint}>opcional</small></span>
    <label className={styles.uploadLabel} htmlFor={`photo-${indice}`}>
      {foto
        ? (esImagen ? <FotoPreview file={foto} className={styles.photoThumb} /> : <FileText aria-hidden="true" size={18} />)
        : <Camera aria-hidden="true" size={18} />}
      <span><b>{foto ? foto.name : titulo}</b><small>{foto ? formatAttachmentSize(foto.size) : AYUDA_SOPORTE}</small></span>
      <input aria-label={ariaLabel} id={`photo-${indice}`} name={`photo-${indice}`} type="file" accept={attachmentAccept(DOCUMENT_MIME_TYPES)} onChange={onChange} aria-invalid={Boolean(error)} aria-describedby={error ? `portal-photo-${indice}-error` : undefined} />
    </label>
    {foto && <button className={styles.lineRemove} type="button" onClick={() => onFoto(null)}><X aria-hidden="true" size={13} /> Quitar archivo</button>}
    {error && <small className={styles.error} id={`portal-photo-${indice}-error`}>{error}</small>}
  </div>;
}

function PantallaArticulo({ indice, linea, errors, detalleAbierto, onCampo, onAlternarDetalle, onFoto, onFotoError }: {
  indice: number; linea: RequestLine; errors: FieldErrors; detalleAbierto: boolean;
  onCampo: (campo: keyof RequestLine, valor: string) => void; onAlternarDetalle: () => void;
  onFoto: (file: File | null) => void; onFotoError: (mensaje: string) => void;
}) {
  return <>
    <label className={styles.field}><span className={styles.fieldLabel}>¿Qué necesitas? <em className={styles.required}>*</em></span><input className={styles.control} name={`description-${indice}`} value={linea.description} onChange={event => onCampo('description', event.target.value)} maxLength={500} placeholder="Ej. 20 bultos de cemento gris" aria-invalid={Boolean(errors[`description-${indice}`])} aria-describedby={errors[`description-${indice}`] ? `portal-description-${indice}-error` : undefined} />{errors[`description-${indice}`] && <small className={styles.error} id={`portal-description-${indice}-error`}>{errors[`description-${indice}`]}</small>}</label>
    <div className={styles.twoColumns}>
      <label className={styles.field}><span className={styles.fieldLabel}>Cantidad <em className={styles.required}>*</em></span><input className={styles.control} name={`quantity-${indice}`} type="number" inputMode="decimal" min="0.001" step="0.001" value={linea.quantity} onChange={event => onCampo('quantity', event.target.value)} aria-invalid={Boolean(errors[`quantity-${indice}`])} aria-describedby={errors[`quantity-${indice}`] ? `portal-quantity-${indice}-error` : undefined} />{errors[`quantity-${indice}`] && <small className={styles.error} id={`portal-quantity-${indice}-error`}>{errors[`quantity-${indice}`]}</small>}</label>
      <label className={styles.field}><span className={styles.fieldLabel}>Unidad <em className={styles.required}>*</em></span><input className={styles.control} name={`unit-${indice}`} list="portal-unidades" value={linea.unit} onChange={event => onCampo('unit', event.target.value)} maxLength={20} placeholder="und, m², bulto…" aria-invalid={Boolean(errors[`unit-${indice}`])} aria-describedby={errors[`unit-${indice}`] ? `portal-unit-${indice}-error` : undefined} />{errors[`unit-${indice}`] && <small className={styles.error} id={`portal-unit-${indice}-error`}>{errors[`unit-${indice}`]}</small>}</label>
    </div>
    <CampoSoporte indice={indice} foto={linea.photo} error={errors[`photo-${indice}`]} onFoto={onFoto} onError={onFotoError} />
    <button className={styles.optionalToggle} type="button" onClick={onAlternarDetalle} aria-expanded={detalleAbierto}><span><SquarePen aria-hidden="true" size={18} /> Agregar detalles <small className={styles.hint}>(opcional)</small></span><span aria-hidden="true">{detalleAbierto ? '−' : '+'}</span></button>
    {detalleAbierto && <div className={styles.optionalPanel}>
      <label className={styles.field}><span className={styles.fieldLabel}>Posible proveedor <small className={styles.hint}>opcional</small></span><input className={styles.control} name={`supplier-${indice}`} value={linea.supplier} onChange={event => onCampo('supplier', event.target.value)} maxLength={240} /></label>
      <label className={styles.field}><span className={styles.fieldLabel}>Enlace del producto <small className={styles.hint}>HTTPS opcional</small></span><input className={styles.control} name={`productLink-${indice}`} type="url" inputMode="url" value={linea.productLink} onChange={event => onCampo('productLink', event.target.value)} maxLength={2048} placeholder="https://…" aria-invalid={Boolean(errors[`productLink-${indice}`])} aria-describedby={errors[`productLink-${indice}`] ? `portal-link-${indice}-error` : undefined} />{errors[`productLink-${indice}`] && <small className={styles.error} id={`portal-link-${indice}-error`}>{errors[`productLink-${indice}`]}</small>}</label>
    </div>}
    <p className={styles.securityNote}><LockKeyhole aria-hidden="true" size={17} /> El archivo solo lo ve quien revisa tu solicitud.</p>
  </>;
}

/**
 * El asistente guiado: una cosa a la vez, como el Flow de WhatsApp que ya conoce el cliente
 * (`integrations/whatsapp-flow/requisicion-captura.flow.json`) — sin copiarlo pantalla por pantalla,
 * porque aquí "tus datos" y "el tipo de solicitud" tienen su propio momento en vez de compartir la
 * primera pantalla del Flow.
 *
 * Es EL MISMO componente para la demo y para el portal real (ver `PublicRequestScreen` más abajo):
 * comparten estado, validación y navegación entre fases, y solo difieren en qué pasa al pulsar
 * "Enviar solicitud" (`onEnviar`) — la demo no llama a ningún endpoint, el portal real sí. Mantenerlo
 * así es lo que garantiza que la demo enseñe al cliente el mismo recorrido que existe de verdad, y es
 * la única versión que corre en Playwright (ver tests/e2e/public-portal.spec.ts).
 */
function AsistenteFormulario({ formulario, exigirEmpresa, empresas, empresasCargadas, onEnviar, enviando = false, errorEnvio = '' }: {
  formulario: ReturnType<typeof useFormularioRequisicion>;
  exigirEmpresa: boolean; empresas: PublicCompany[]; empresasCargadas: boolean;
  onEnviar: () => void | Promise<void>; enviando?: boolean; errorEnvio?: string;
}) {
  const { values, errors, setErrors, detalles, phone, setPhone, phase, setPhase, itemIndex, setItemIndex, update, updateLinea, setLineaFoto, updatePago, agregarLinea, quitarLinea, alternarDetalle } = formulario;
  // Un error de foto no es como los demás: no lo pone `validarItem` al avanzar de pantalla (la foto es
  // opcional, nunca bloquea "Ir al resumen"), lo pone `CampoSoporte` EN EL MOMENTO de elegir un archivo
  // inválido. Por eso es un `set`/`delete` puntual sobre la clave `photo-<índice>`, no parte de un
  // objeto de errores que se reconstruye entero como `validarItem`.
  const onFotoError = (indiceArticulo: number, mensaje: string) => setErrors(actuales => {
    const clave = `photo-${indiceArticulo}`;
    if (!mensaje) { if (!(clave in actuales)) return actuales; const resto = { ...actuales }; delete resto[clave]; return resto; }
    return { ...actuales, [clave]: mensaje };
  });
  const etapas = etapasDe(values.type);
  const etapaActual = etapas.findIndex(etapa => etapa.fase === phase) + 1;

  const validarEsteItem = () => {
    const next = validarItem(itemIndex, values.lines[itemIndex]);
    setErrors(next);
    if (Object.keys(next).length) { focusFirstError(next); return false; }
    return true;
  };
  // Desde "¿Qué vas a solicitar?" el camino se bifurca: compra sigue a "Tus datos"; pago, a "¿Quién cobra?".
  const salirDeTipo = () => { const next = validarTipoEmpresa(values, exigirEmpresa); setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return; } setErrors({}); setPhase(values.type === 'pago' ? 'beneficiario' : 'datos'); };
  const irAPago = () => { const next = validarBeneficiario(values.payment, phone); setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return; } setErrors({}); setPhase('pago'); };
  const irAResumenDesdePago = () => { const next = validarPago(values, exigirEmpresa); setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return; } setErrors({}); setPhase('resumen'); };
  const irAMaterial = () => { const next = validarDatos(values, phone); setErrors(next); if (Object.keys(next).length) { focusFirstError(next); return; } setErrors({}); setItemIndex(0); setPhase('item'); };
  const agregarOtroArticulo = () => {
    if (!validarEsteItem()) return;
    // Si el siguiente YA EXISTE (se volvió con "Atrás" desde uno posterior), se navega a él en vez de
    // duplicarlo: solo se crea una línea nueva cuando se está editando la última.
    if (itemIndex < values.lines.length - 1) { setItemIndex(itemIndex + 1); return; }
    agregarLinea();
    setItemIndex(itemIndex + 1);
  };
  // El botón dice "Ir al resumen" (así lo pidió Ernesto), aunque la pantalla que sigue es
  // "¿Para cuándo?": es la última pregunta antes del resumen de verdad, y agruparla con "material"
  // habría hecho que la fecha y las observaciones parecieran parte de los artículos.
  const irACuando = () => { if (!validarEsteItem()) return; setPhase('cuando'); };
  const atrasDesdeItem = () => { if (itemIndex > 0) setItemIndex(itemIndex - 1); else setPhase('datos'); };
  const atrasDesdeCuando = () => { setItemIndex(values.lines.length - 1); setPhase('item'); };
  const irAResumen = () => setPhase('resumen');
  const atrasDesdeResumen = () => setPhase(values.type === 'pago' ? 'pago' : 'cuando');
  /** Red de seguridad antes de enviar: si algo quedara mal marcado, devuelve a la fase que falla en
   *  vez de dejar pasar un envío que el servidor va a rechazar con un 400 sin señalar la pantalla. */
  const enviar = () => {
    const tipoErr = validarTipoEmpresa(values, exigirEmpresa);
    if (Object.keys(tipoErr).length) { setErrors(tipoErr); setPhase('tipo'); focusFirstError(tipoErr); return; }
    if (values.type === 'pago') {
      const beneficiarioErr = validarBeneficiario(values.payment, phone);
      if (Object.keys(beneficiarioErr).length) { setErrors(beneficiarioErr); setPhase('beneficiario'); focusFirstError(beneficiarioErr); return; }
      const pagoErr = validarPago(values, exigirEmpresa);
      if (Object.keys(pagoErr).length) { setErrors(pagoErr); setPhase('pago'); focusFirstError(pagoErr); return; }
      setErrors({});
      void onEnviar();
      return;
    }
    const datosErr = validarDatos(values, phone);
    if (Object.keys(datosErr).length) { setErrors(datosErr); setPhase('datos'); focusFirstError(datosErr); return; }
    const itemsErr = validarItems(values.lines);
    if (Object.keys(itemsErr).length) {
      const primerIndiceConError = values.lines.findIndex((_, indice) => Object.keys(itemsErr).some(clave => clave.endsWith(`-${indice}`)));
      setErrors(itemsErr); setItemIndex(Math.max(primerIndiceConError, 0)); setPhase('item'); focusFirstError(itemsErr);
      return;
    }
    setErrors({});
    void onEnviar();
  };
  const empresaSeleccionada = empresas.find(empresa => empresa.id === values.company)?.name;

  return <>
    <Progress phase={phase} etapas={etapas} />
    <form className={styles.stepCard} onSubmit={event => { event.preventDefault(); enviar(); }} noValidate>
      {phase === 'tipo' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>¿Qué vas a solicitar?</h2><p>Elige el tipo de solicitud{exigirEmpresa && values.type === 'compra' ? ' y la empresa' : ''}.</p></div><div className={styles.stepBody}>
        <fieldset className={styles.fieldset}><legend className={styles.fieldsetLegend}>Tipo de solicitud <em className={styles.required}>*</em></legend><div className={styles.choiceGrid}><label className={styles.choice}><input type="radio" name="type" value="compra" checked={values.type === 'compra'} onChange={() => update('type', 'compra')} /><span className={styles.choiceIcon}><PackageCheck aria-hidden="true" size={16} /></span>Compra de material</label><label className={styles.choice}><input type="radio" name="type" value="pago" checked={values.type === 'pago'} onChange={() => update('type', 'pago')} /><span className={styles.choiceIcon}><Banknote aria-hidden="true" size={16} /></span>Solicitud de pago</label></div>
        {values.type === 'pago' && <small className={styles.hint}>Para cobrar un servicio o una cuenta: tu identificación, a qué empresa le cobras, el monto y el concepto. Tres pasos.</small>}</fieldset>
        {exigirEmpresa && values.type === 'compra' && <SelectorEmpresa empresas={empresas} cargadas={empresasCargadas} valor={values.company} error={errors.company} onChange={valor => update('company', valor)} />}
        <div className={`${styles.actionRow} ${styles.actionRowSingle}`}><button className={styles.primaryButton} type="button" onClick={salirDeTipo}>Continuar <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}

      {phase === 'beneficiario' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><UserRound aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>¿Quién cobra?</h2><p>La persona o empresa a la que Mizar le paga. Si ya está en el catálogo, la enlazamos por su identificación.</p></div><div className={styles.stepBody}>
        <div className={styles.twoColumns}>
          <label className={styles.field}><span className={styles.fieldLabel}>Tipo de identificación <em className={styles.required}>*</em></span><select className={styles.control} name="identificationType" value={values.payment.identificationType} onChange={event => updatePago('identificationType', event.target.value as IdentificationType)}>{TIPOS_IDENTIFICACION.map(tipo => <option key={tipo.valor} value={tipo.valor}>{tipo.etiqueta}</option>)}</select></label>
          <label className={styles.field}><span className={styles.fieldLabel}>Número de identificación <em className={styles.required}>*</em></span><input className={styles.control} name="identification" value={values.payment.identification} onChange={event => updatePago('identification', event.target.value.replace(/[.\s]/g, ''))} inputMode={values.payment.identificationType === 'CC' || values.payment.identificationType === 'NIT' ? 'numeric' : 'text'} maxLength={32} placeholder={values.payment.identificationType === 'NIT' ? 'Ej. 900123456-7' : 'Ej. 1020304050'} autoComplete="off" aria-invalid={Boolean(errors.identification)} aria-describedby={errors.identification ? 'portal-identification-error' : undefined} />{errors.identification && <small className={styles.error} id="portal-identification-error">{errors.identification}</small>}</label>
        </div>
        <label className={styles.field}><span className={styles.fieldLabel}>Nombre completo o razón social <em className={styles.required}>*</em></span><input className={styles.control} name="beneficiaryName" value={values.payment.beneficiaryName} onChange={event => updatePago('beneficiaryName', event.target.value)} maxLength={160} placeholder="Como aparece en la cédula o el RUT" autoComplete="name" aria-invalid={Boolean(errors.beneficiaryName)} aria-describedby={errors.beneficiaryName ? 'portal-beneficiary-name-error' : undefined} />{errors.beneficiaryName && <small className={styles.error} id="portal-beneficiary-name-error">{errors.beneficiaryName}</small>}</label>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu teléfono <small className={styles.hint}>opcional</small></span><span className={styles.inputWithIcon}><Phone aria-hidden="true" size={18} /><input className={styles.control} name="phone" value={phone} onChange={event => setPhone(event.target.value)} placeholder="300 000 0000" inputMode="tel" autoComplete="tel" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'portal-phone-error' : undefined} /></span><small className={styles.hint}>Para avisarte por WhatsApp cuando el pago avance. Sin él la radicamos igual, pero no podremos avisarte.</small>{errors.phone && <small className={styles.error} id="portal-phone-error">{errors.phone}</small>}</label>
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => setPhase('tipo')}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button><button className={styles.primaryButton} type="button" onClick={irAPago}>Continuar al pago <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}

      {phase === 'pago' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><Banknote aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>El pago</h2><p>A qué empresa le cobras, cuánto y por qué.</p></div><div className={styles.stepBody}>
        {exigirEmpresa && <SelectorEmpresa etiqueta="Empresa a la que cobras" ayuda="La obra y el centro de costo los asigna quien revisa tu solicitud." empresas={empresas} cargadas={empresasCargadas} valor={values.company} error={errors.company} onChange={valor => update('company', valor)} />}
        <label className={styles.field}><span className={styles.fieldLabel}>Monto a cobrar (COP) <em className={styles.required}>*</em></span><input className={styles.control} name="amount" value={values.payment.amount} onChange={event => updatePago('amount', event.target.value.replace(/\D/g, '').slice(0, 12))} inputMode="numeric" placeholder="Ej. 1250000" aria-invalid={Boolean(errors.amount)} aria-describedby={errors.amount ? 'portal-amount-error' : 'portal-amount-hint'} /><small className={styles.hint} id="portal-amount-hint">{values.payment.amount ? `Se solicita ${formatoCOP.format(Number(values.payment.amount))}` : 'Solo números, sin puntos ni decimales.'}</small>{errors.amount && <small className={styles.error} id="portal-amount-error">{errors.amount}</small>}</label>
        <label className={styles.field}><span className={styles.fieldLabel}>Concepto <em className={styles.required}>*</em></span><input className={styles.control} name="concept" value={values.payment.concept} onChange={event => updatePago('concept', event.target.value)} maxLength={MAX_CONCEPTO} placeholder="Ej. Levantamiento topográfico lote 3" aria-invalid={Boolean(errors.concept)} aria-describedby={errors.concept ? 'portal-concept-error' : 'portal-concept-hint'} /><small className={styles.hint} id="portal-concept-hint">Qué se paga, en pocas palabras. {values.payment.concept.length}/{MAX_CONCEPTO}</small>{errors.concept && <small className={styles.error} id="portal-concept-error">{errors.concept}</small>}</label>
        <CampoSoporte indice={0} etiqueta="Factura o cuenta de cobro" titulo="Agregar el archivo" ariaLabel="Factura o cuenta de cobro (opcional)" foto={values.payment.photo} error={errors['photo-0']} onFoto={foto => updatePago('photo', foto)} onError={mensaje => onFotoError(0, mensaje)} />
        <p className={styles.securityNote}><LockKeyhole aria-hidden="true" size={17} /> El archivo solo lo ve quien revisa tu solicitud.</p>
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => setPhase('beneficiario')}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button><button className={styles.primaryButton} type="button" onClick={irAResumenDesdePago}>Ver resumen <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}

      {phase === 'datos' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>Tus datos</h2><p>Con quién hablamos si hay que confirmar algo.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu nombre <em className={styles.required}>*</em></span><input className={styles.control} name="requestor" value={values.requestor} onChange={event => update('requestor', event.target.value)} placeholder="Nombre completo" autoComplete="name" aria-invalid={Boolean(errors.requestor)} aria-describedby={errors.requestor ? 'portal-requestor-error' : undefined} />{errors.requestor && <small className={styles.error} id="portal-requestor-error">{errors.requestor}</small>}</label>
        <label className={styles.field}><span className={styles.fieldLabel}>Tu teléfono <small className={styles.hint}>opcional</small></span><span className={styles.inputWithIcon}><Phone aria-hidden="true" size={18} /><input className={styles.control} name="phone" value={phone} onChange={event => setPhone(event.target.value)} placeholder="300 000 0000" inputMode="tel" autoComplete="tel" aria-invalid={Boolean(errors.phone)} aria-describedby={errors.phone ? 'portal-phone-error' : undefined} /></span><small className={styles.hint}>Para avisarte por WhatsApp del avance. Sin él la radicamos igual, pero no podremos avisarte.</small>{errors.phone && <small className={styles.error} id="portal-phone-error">{errors.phone}</small>}</label>
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={() => setPhase('tipo')}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button><button className={styles.primaryButton} type="button" onClick={irAMaterial}>Continuar a material <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}

      {phase === 'item' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length} · Artículo {itemIndex + 1}</p><h2>Artículo {itemIndex + 1}</h2><p>Uno a la vez. Si necesitas más materiales, los agregamos después de este.</p></div><div className={styles.stepBody}>
        <fieldset className={styles.lineCard}>
          <legend className={styles.lineLegend}><span>Ítem {itemIndex + 1}</span></legend>
          <PantallaArticulo indice={itemIndex} linea={values.lines[itemIndex]} errors={errors} detalleAbierto={detalles.includes(itemIndex)} onCampo={(campo, valor) => updateLinea(itemIndex, campo, valor)} onAlternarDetalle={() => alternarDetalle(itemIndex)} onFoto={foto => setLineaFoto(itemIndex, foto)} onFotoError={mensaje => onFotoError(itemIndex, mensaje)} />
        </fieldset>
        <datalist id="portal-unidades">{UNIDADES_SUGERIDAS.map(unidad => <option key={unidad} value={unidad} />)}</datalist>
        <div className={styles.itemActions}>
          <button className={styles.secondaryButton} type="button" onClick={atrasDesdeItem}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button>
          {values.lines.length < MAX_LINEAS && <button className={styles.addLine} type="button" onClick={agregarOtroArticulo}><Plus aria-hidden="true" size={18} /> Agregar otro artículo</button>}
          <button className={styles.primaryButton} type="button" onClick={irACuando}>Ir al resumen <ArrowRight aria-hidden="true" size={19} /></button>
        </div>
      </div></>}

      {phase === 'cuando' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><ClipboardList aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>¿Para cuándo?</h2><p>Fecha y cualquier instrucción de entrega. Las dos son opcionales.</p></div><div className={styles.stepBody}>
        <label className={styles.field}><span className={styles.fieldLabel}>Fecha requerida <small className={styles.hint}>opcional</small></span><input className={styles.control} name="date" type="date" value={values.date} onChange={event => update('date', event.target.value)} aria-invalid={Boolean(errors.date)} aria-describedby={errors.date ? 'portal-date-error' : undefined} />{errors.date && <small className={styles.error} id="portal-date-error">{errors.date}</small>}</label>
        <label className={styles.field}><span className={styles.fieldLabel}>Observaciones <small className={styles.hint}>di a dónde va, opcional</small></span><textarea className={`${styles.control} ${styles.textarea}`} name="notes" value={values.notes} onChange={event => update('notes', event.target.value)} maxLength={3000} placeholder="Ej. Torre 2, piso 4" /></label>
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={atrasDesdeCuando}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button><button className={styles.primaryButton} type="button" onClick={irAResumen}>Ver resumen <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}

      {phase === 'resumen' && <><div className={styles.stepHeader}><p className={styles.stepEyebrow}><PackageCheck aria-hidden="true" size={16} /> Paso {etapaActual} de {etapas.length}</p><h2>Resumen</h2><p>{values.type === 'pago' ? 'Revisa antes de enviar. Puedes volver atrás para corregir.' : 'Revisa antes de enviar. Puedes volver atrás o quitar un artículo.'}</p></div><div className={styles.stepBody}>
        {values.type === 'pago' ? <>
          <dl className={styles.summaryMeta}>
            <div className={styles.summaryRow}><dt>Tipo</dt><dd>{TYPE_LABELS.pago}</dd></div>
            <div className={styles.summaryRow}><dt>Empresa</dt><dd>{exigirEmpresa ? (empresaSeleccionada ?? '—') : 'La define el enlace de tu obra'}</dd></div>
            <div className={styles.summaryRow}><dt>Beneficiario</dt><dd>{values.payment.beneficiaryName || '—'}</dd></div>
            <div className={styles.summaryRow}><dt>Identificación</dt><dd>{values.payment.identificationType} {values.payment.identification}</dd></div>
            <div className={styles.summaryRow}><dt>Teléfono</dt><dd>{phone.trim() || 'Sin teléfono (sin aviso por WhatsApp)'}</dd></div>
            <div className={styles.summaryRow}><dt>Monto</dt><dd>{formatoCOP.format(Number(values.payment.amount) || 0)}</dd></div>
          </dl>
          <div className={styles.summaryLine} aria-label="Concepto del pago">
            {values.payment.photo && <SoportePreview file={values.payment.photo} />}
            <div><b>{values.payment.concept}</b><span className={styles.hint}>{values.payment.photo ? `Factura o cuenta de cobro: ${values.payment.photo.name}` : 'Sin factura ni cuenta de cobro adjunta'}</span></div>
          </div>
        </> : <>
        <dl className={styles.summaryMeta}>
          <div className={styles.summaryRow}><dt>Tipo</dt><dd>{TYPE_LABELS[values.type]}</dd></div>
          <div className={styles.summaryRow}><dt>Empresa</dt><dd>{exigirEmpresa ? (empresaSeleccionada ?? '—') : 'La define el enlace de tu obra'}</dd></div>
          <div className={styles.summaryRow}><dt>Solicitante</dt><dd>{values.requestor || '—'}</dd></div>
          <div className={styles.summaryRow}><dt>Teléfono</dt><dd>{phone.trim() || 'Sin teléfono (sin aviso por WhatsApp)'}</dd></div>
          <div className={styles.summaryRow}><dt>Fecha requerida</dt><dd>{values.date || 'Sin fecha definida'}</dd></div>
          {values.notes.trim() && <div className={styles.summaryRow}><dt>Observaciones</dt><dd>{values.notes}</dd></div>}
        </dl>
        <ol className={styles.summaryList} aria-label="Artículos de la requisición">
          {values.lines.map((linea, indice) => <li className={styles.summaryLine} key={indice}>
            {linea.photo && <SoportePreview file={linea.photo} />}
            <div><b>{indice + 1}. {linea.description}</b><span className={styles.hint}>{linea.quantity} {linea.unit}{linea.supplier ? ` · ${linea.supplier}` : ''}</span></div>
            {values.lines.length > 1 && <button className={styles.lineRemove} type="button" onClick={() => quitarLinea(indice)}>Quitar</button>}
          </li>)}
        </ol>
        </>}
        {errorEnvio && <p className={styles.error} role="alert">{errorEnvio}</p>}
        <div className={styles.actionRow}><button className={styles.secondaryButton} type="button" onClick={atrasDesdeResumen}><ArrowLeft aria-hidden="true" size={18} /> Atrás</button><button className={styles.primaryButton} type="submit" disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar solicitud'} <ArrowRight aria-hidden="true" size={19} /></button></div>
      </div></>}
    </form>
  </>;
}

/**
 * Pantalla de DEMOSTRACIÓN (NEXT_PUBLIC_DEMO_MODE). No llama a ningún endpoint ni guarda nada.
 *
 * Va deliberadamente A LA PAR del formulario real: recorre el MISMO `AsistenteFormulario`, así que
 * cualquier cambio de recorrido —como este, de dos pasos a cinco pantallas guiadas— llega a las dos
 * pantallas a la vez y no hay forma de que una se quede atrás. Hasta el 11-sep-2026 esto no era así
 * (el paso 1 de la demo ni siquiera tenía el selector de tipo), y una demo que enseña un portal
 * distinto del real es peor que no tener demo: es justo lo que se le muestra al cliente.
 *
 * Y es la ÚNICA versión que recorre un navegador: playwright.config.ts levanta el servidor con
 * NEXT_PUBLIC_DEMO_MODE=true, así que los e2e de escritorio y de móvil pasan por aquí. Dejarla atrás
 * habría significado que los cambios del portal no los probara ninguno.
 *
 * Lo único suyo es el final: un consecutivo falso y el aviso de que no se creó nada.
 */
function DemoPublicRequest() {
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false);
  const [code, setCode] = useState(''), [accessError, setAccessError] = useState('');
  const formulario = useFormularioRequisicion();
  // Las sociedades reales del cliente (ver supabase/seed.sql). En la demo la lista es fija: no hay
  // base a la que preguntarle, y nombres inventados harían dudar de si la pantalla es la de verdad.
  const empresas = companies.map((nombre, indice) => ({ id: `demo-${indice}`, name: nombre }));
  // Los valores llegan leídos del formulario, no del estado: la compuerta es no controlada para no
  // perder lo que se teclee antes de hidratar (ver AccessGate). Se guardan en estado AQUÍ, ya
  // validados, porque los pasos siguientes los necesitan.
  //
  // AQUÍ NO se pregunta al servidor, al revés que en el portal real: en modo demostración no hay
  // base ni contraseña que comprobar, y una compuerta que llamara a un endpoint inexistente no
  // dejaría entrar a nadie a la demo. Es la única diferencia de comportamiento que queda entre las
  // dos pantallas, y por eso está escrita.
  const handleAccess = ({ code: claveEscrita }: { code: string }) => { if (claveEscrita.trim().length < 4) { setAccessError('Escribe la contraseña del portal para continuar.'); return; } setCode(claveEscrita); setAccessError(''); setAccessGranted(true); };
  const handleEnviar = () => setSent(true);
  if (sent) return <PortalFrame><section className={styles.success}><div className={styles.successDemo} role="status"><b>Modo demostración</b>No se creó una requisición real ni se guardaron datos.</div><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>Recorrido completado.</h1><p className={styles.successCopy}>El formulario quedó listo para probar. Este código no sirve para seguimiento real.</p><div className={styles.trackingCode}>REQ-DEMO-0148</div><button className={styles.primaryButton} type="button" onClick={() => { formulario.reiniciar(); setSent(false); }}>Probar otra requisición</button></section></PortalFrame>;
  if (!accessGranted) return <AccessGate code={code} error={accessError} onSubmit={handleAccess} showHelp />;
  return <PortalFrame><StepIntro acceso={accesoPara(empresas, formulario.values.company)} onChangeAccess={() => setAccessGranted(false)} /><AsistenteFormulario formulario={formulario} exigirEmpresa empresas={empresas} empresasCargadas onEnviar={handleEnviar} /></PortalFrame>;
}

function ProductionPublicRequest({ enabled }: { enabled: boolean }) {
  const [access, setAccess] = useState<PublicAccess | undefined>(), [linkRead, setLinkRead] = useState(false);
  const [accessGranted, setAccessGranted] = useState(false), [sent, setSent] = useState(false), [submitting, setSubmitting] = useState(false);
  const [code, setCode] = useState(''), [accessError, setAccessError] = useState('');
  const [formError, setFormError] = useState(''), [comprobandoClave, setComprobandoClave] = useState(false);
  const formulario = useFormularioRequisicion();
  const [empresas, setEmpresas] = useState<PublicCompany[]>([]), [empresasCargadas, setEmpresasCargadas] = useState(false);
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
  // Sin fragmento se entra igual: la ruta es pública. Solo se rechaza un fragmento MAL FORMADO —un
  // token que no son 64 hex, o una obra que no es un uuid—, porque eso no es "sin enlace" sino un
  // enlace roto, y tratarlo como acceso libre escondería el error a quien reparta un enlace mal.
  useEffect(() => {
    let active = true;
    const fragment = enabled ? new URLSearchParams(window.location.hash.replace(/^#/, '')) : new URLSearchParams();
    const workId = fragment.get('obra') ?? '', token = fragment.get('token') ?? '';
    const sinEnlace = token === '' && workId === '';
    const enlaceValido = /^[0-9a-f]{64}$/.test(token) && (workId === '' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId));
    queueMicrotask(() => {
      if (!active) return;
      if (enabled && sinEnlace) setAccess({});
      else if (enabled && enlaceValido) setAccess({ workId: workId || undefined, token });
      setLinkRead(true);
    });
    return () => { active = false; };
  }, [enabled]);
  // La lista de EMPRESAS se pide SIN contraseña ni token: son los nombres de las sociedades del
  // cliente, que están en la marca y en las facturas. Antes eran obras y había dos caminos (GET con
  // token para el enlace general, POST con contraseña para la ruta pública); el segundo era un
  // oráculo de la contraseña y se ha borrado con el endpoint entero.
  //
  // Por eso esto ya no espera a la compuerta: no hay nada que la contraseña autorice aquí, y pedirla
  // antes deja el selector lleno para cuando se llega a la fase "¿Qué vas a solicitar?".
  //
  // Un enlace POR OBRA no necesita la lista: trae su obra fija y la empresa se deriva de ella. Si la
  // petición falla, la lista queda vacía y se dice, en vez de dejar un selector mudo.
  useEffect(() => {
    if (!access || access.workId) return;
    let active = true;
    fetch("/api/public/companies")
      .then(response => (response.ok ? response.json() : { companies: [] }))
      .then((body: { companies?: PublicCompany[] }) => { if (active) setEmpresas(Array.isArray(body.companies) ? body.companies : []); })
      .catch(() => { if (active) setEmpresas([]); })
      .finally(() => { if (active) setEmpresasCargadas(true); });
    return () => { active = false; };
  }, [access]);
  // Los valores llegan leídos del formulario, no del estado: la compuerta es no controlada para no
  // perder lo que se teclee antes de hidratar (ver AccessGate). Se guardan en estado AQUÍ, ya
  // validados, porque las fases siguientes los necesitan: la contraseña vuelve a viajar en el envío.
  // Solo la contraseña abre la compuerta. El teléfono se pide en "Tus datos" y se valida allí.
  //
  // Y LA COMPRUEBA EL SERVIDOR. Antes bastaba con que tuviera cuatro caracteres en el navegador, así
  // que una contraseña equivocada dejaba entrar, llenar el formulario entero y recibir el 202 neutro
  // de la radicación: ni requisición ni aviso. Ahora se pregunta en la puerta y se dice qué pasó.
  //
  // El envío final SIGUE verificando la contraseña en el servidor (`publicAccess.verify` /
  // `verifySociety` en el endpoint de radicación). Esto es una cortesía para quien se equivoca, no
  // una autorización: nada de lo que decida el navegador puede sustituir a esa comprobación.
  const handleAccess = async ({ code: claveEscrita }: { code: string }) => {
    const clave = claveEscrita.trim();
    if (clave.length < 4) { setAccessError('Escribe la contraseña del portal para continuar.'); return; }
    setAccessError(''); setComprobandoClave(true);
    try {
      const response = await fetch('/api/public/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: clave }) });
      // Un 503 es el portal apagado, no una contraseña mala: decir "incorrecta" mandaría a buscar
      // una contraseña nueva a quien tiene la buena.
      if (response.status === 503) { setAccessError('El portal no está disponible ahora mismo. Intenta más tarde.'); return; }
      const cuerpo = (await response.json()) as { ok?: boolean };
      if (cuerpo.ok !== true) { setAccessError('Contraseña incorrecta. Revísala con quien te la entregó.'); return; }
      setCode(clave); setAccessGranted(true);
    } catch { setAccessError('No pudimos comprobar la contraseña. Revisa tu conexión e intenta de nuevo.'); }
    finally { setComprobandoClave(false); }
  };
  const handleEnviar = async () => {
    if (!access) return;
    setFormError(''); setSubmitting(true);
    // TELÉFONO SOLO SI SE ESCRIBIÓ. Mandar `phone: ''` no es "sin teléfono": el esquema exige min(7)
    // y rechazaría el envío entero con un 400.
    const telefono = formulario.phone.trim();
    // Obra O empresa, exactamente una (lo exige el esquema del endpoint). Con enlace por obra manda
    // la obra firmada; por la ruta general, la empresa elegida.
    const destino = access.workId ? { workId: access.workId } : { societyId: formulario.values.company };
    const esPago = formulario.values.type === 'pago', pago = formulario.values.payment;
    // requiredDate va con `|| undefined` (mismo idioma que observations): el esquema la acepta
    // OPCIONAL con z.string().date() — enviar '' cuando el campo queda vacío no es "sin fecha", es
    // una fecha inválida, y .strict() la rechazaría con el mismo 400.
    //
    // Solicitud de pago (RF-108): sin `items` ni `name` — el beneficiario es quien radica, y el
    // concepto y el monto son la única línea, que arma el endpoint. `amount` viaja como NÚMERO entero.
    const payload = esPago
      ? {
        ...destino, code, type: 'pago' as const,
        ...(telefono ? { phone: telefono } : {}),
        beneficiary: { identificationType: pago.identificationType, identification: pago.identification.trim(), name: pago.beneficiaryName.trim() },
        amount: Number(pago.amount), concept: pago.concept.trim(),
      }
      : {
        ...destino, code, type: 'compra' as const, requiredDate: formulario.values.date || undefined, name: formulario.values.requestor,
        ...(telefono ? { phone: telefono } : {}),
        observations: formulario.values.notes || undefined,
        items: formulario.values.lines.map(linea => ({ description: linea.description, quantity: Number(linea.quantity), unit: linea.unit, possibleSupplier: linea.supplier || undefined, productLink: linea.productLink || undefined })),
      };
    // El ÍNDICE de cada foto es su posición en `items` arriba — el mismo que usa el servidor para
    // ligarla al ítem que crea (ver app/api/public/requisitions/route.ts). `payload.items` y
    // `formulario.values.lines` nacen del mismo `.map` en el mismo orden, así que el índice de una
    // lista sirve para la otra sin traducción. En un pago la única línea es la 0: la factura va en `foto_0`.
    const fotos = esPago
      ? (pago.photo ? [{ indice: 0, file: pago.photo }] : [])
      : formulario.values.lines
        .map((linea, indice) => ({ indice, file: linea.photo }))
        .filter((entrada): entrada is { indice: number; file: File } => entrada.file !== null);
    try {
      // Con fotos, `multipart/form-data`: el JSON de siempre viaja intacto en el campo `payload`, y
      // cada foto en su propio campo `foto_<índice>` (ver el endpoint). SIN fotos, el envío es
      // EXACTAMENTE el de siempre — nunca se cambia a FormData sin necesidad.
      //
      // Nunca se fija `content-type` a mano cuando el cuerpo es FormData: el navegador necesita
      // calcular el boundary del multipart, y un `content-type` manual se lo pisaría.
      const headers: Record<string, string> = access.token ? { 'x-public-link-token': access.token } : {};
      let body: BodyInit;
      if (fotos.length) {
        const formData = new FormData();
        formData.set('payload', JSON.stringify(payload));
        for (const { indice, file } of fotos) formData.set(`foto_${indice}`, file, file.name);
        body = formData;
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(payload);
      }
      const response = await fetch('/api/public/requisitions', { method: 'POST', headers, body });
      if (response.status === 202) setSent(true);
      else if (response.status === 503) setFormError('El servicio de requisiciones no está disponible. Intenta más tarde.');
      else if (response.status === 413) setFormError('El envío pesa demasiado. Quita el archivo o elige uno más liviano e intenta otra vez.');
      else {
        // Desde la adenda de pagos el endpoint dice POR QUÉ rechaza (400/409/422 con `message`, p. ej.
        // un beneficiario homónimo con otra identificación): se muestra tal cual en vez de mandar a
        // "revisar los campos" sin decir cuál. Sin mensaje —un 400 de esquema— queda el genérico.
        const cuerpo = await response.json().catch(() => null) as { message?: string } | null;
        setFormError(cuerpo?.message || 'No pudimos recibir la solicitud. Revisa los campos e intenta otra vez.');
      }
    } catch { setFormError('No pudimos conectar con el servicio. Intenta más tarde.'); }
    finally { setSubmitting(false); }
  };
  if (!linkRead) return <PortalFrame><section className={`${styles.access} ${styles.closedGate}`} role="status"><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Validando enlace</div><h1>Preparando el formulario…</h1></section></PortalFrame>;
  if (!access) return <PortalFrame><section className={`${styles.access} ${styles.closedGate}`}><div className={styles.kicker}><LockKeyhole aria-hidden="true" size={17} /> Captura cerrada</div><h1>Este enlace no está habilitado.</h1><p className={styles.accessCopy}>Solicita al responsable de tu obra un enlace vigente. No se creó ninguna requisición ni se aceptaron datos.</p></section></PortalFrame>;
  if (sent) return <PortalFrame><section className={styles.success}><span className={styles.successIcon}><Check aria-hidden="true" size={28} /></span><h1>La estamos validando.</h1><p className={styles.successCopy}>Si el enlace y la contraseña corresponden, la requisición quedará registrada. Por seguridad no mostramos un consecutivo.</p><button className={styles.primaryButton} type="button" onClick={() => { formulario.reiniciar(); setSent(false); setAccessGranted(false); }}>Enviar otra solicitud</button></section></PortalFrame>;
  if (!accessGranted) return <AccessGate code={code} error={accessError} onSubmit={handleAccess} comprobando={comprobandoClave} />;
  return <PortalFrame><StepIntro acceso={accesoPara(empresas, formulario.values.company, access.workId)} onChangeAccess={() => setAccessGranted(false)} /><AsistenteFormulario formulario={formulario} exigirEmpresa={!access.workId} empresas={empresas} empresasCargadas={empresasCargadas} onEnviar={handleEnviar} enviando={submitting} errorEnvio={formError} /></PortalFrame>;
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
