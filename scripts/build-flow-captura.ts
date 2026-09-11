/**
 * Genera `requisicion-v2.flow.json`, el Flow de captura v2.
 *
 * POR QUÉ SE GENERA Y NO SE ESCRIBE A MANO. El v1 tenía tres pantallas de artículo; el v2 tiene
 * ocho, y cada pantalla debe DECLARAR en su `data` todo lo que recibe y REENVIARLO en el `payload`
 * de su navegación. Eso son cientos de entradas repetidas: a mano es ilegible y se presta a erratas
 * silenciosas (una clave mal escrita no falla, simplemente pinta vacío). El JSON generado se
 * commitea igual —es el artefacto que se sube a Meta— y `tests/unit/flow-captura-v2.test.ts` vigila
 * que no se separe de este generador.
 *
 * LOS DOS DEFECTOS QUE ARREGLA, reportados por Ernesto probando desde su celular:
 *
 * 1. «En el resumen aparecen las llaves pero no los datos». El v1 pintaba
 *    `${screen.TIPO_Y_EMPRESA.form.empresa}` dentro del `text` de un TextBody. Esa sintaxis de
 *    referencia entre pantallas vale en el `payload` de una acción, pero NO en una propiedad de
 *    texto: ahí solo se resuelven `${data.x}` (lo que la pantalla declara recibir) y `${form.x}`
 *    (lo de la propia pantalla). Al no resolverse, se imprimía literal. Y no se resolvía nada
 *    porque NINGUNA pantalla del v1 declaraba `data` ni pasaba `payload`: todos los `navigate`
 *    llevaban `payload: {}`.
 *
 * 2. «Solo caben 3 artículos y me preocupa no poder agregar más». Sin Data Endpoint las pantallas
 *    son fijas, así que la salida es tener ocho preparadas y que solo se visiten bajo demanda: cada
 *    pantalla de artículo lleva el botón principal "Continuar" (va al resumen) y, debajo, "Agregar
 *    otro artículo" (va a la siguiente). Es el «enviar / agregar otro» que pidió, sin preguntar de
 *    antemano cuántos van a ser.
 *
 * DECISIÓN DE DISEÑO IMPORTANTE: cada pantalla reenvía lo acumulado y NUNCA referencia una pantalla
 * que quizá no se visitó. El v1 sí lo hacía (`${screen.ARTICULO_TRES.form.descripcion}` en el
 * `complete`), y con ocho pantallas opcionales eso sería apostar a un comportamiento que Meta no
 * documenta. Encadenar es más verboso pero solo depende de lo que la persona recorrió de verdad.
 *
 * Uso:  npx tsx scripts/build-flow-captura.ts
 *       npx tsx scripts/build-flow-captura.ts --check   (no escribe; falla si difiere)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Tipos deliberadamente laxos: el Flow JSON tiene decenas de formas de componente y modelarlas
 * todas aquí sería reimplementar el esquema de Meta, que es quien valida de verdad
 * (`validation_errors` de la Graph API). Lo que sí conviene fijar es la FORMA de navegación, que es
 * donde estaban los dos defectos.
 */
export interface ComponenteFlow { type: string; [clave: string]: unknown }
export interface PantallaFlow {
  id: string; title: string; terminal?: boolean; success?: boolean;
  data?: Record<string, unknown>;
  layout: { type: string; children: ComponenteFlow[] };
}
export interface FlowCaptura { version: string; screens: PantallaFlow[] }

export const MAX_ITEMS = 8;

/**
 * Los ids de pantalla de Meta solo admiten letras y guion bajo: `ARTICULO_1` se rechaza con
 * "Property id should only consist of alphabets and underscores". Por eso el v1 ya usaba
 * ARTICULO_UNO/DOS/TRES; aquí se extiende la misma serie. Las CLAVES de datos (`item_1_cantidad`)
 * sí admiten dígitos y se dejan numéricas, que es lo que espera el adaptador.
 */
const ORDINAL = ["UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO"];
const idArticulo = (k: number) => `ARTICULO_${ORDINAL[k - 1]}`;
export const RUTA_FLOW_V2 = resolve("integrations/whatsapp-flow/requisicion-v2.flow.json");

/** Campos escalares de un artículo. La foto va aparte: no se encadena (ver abajo). */
const CAMPOS_ITEM = ["catalogo", "descripcion", "cantidad", "unidad", "proveedor", "link"];

const UNIDADES = [
  ["unidad", "Unidad"], ["bulto", "Bulto"], ["kg", "Kilogramo (kg)"], ["lt", "Litro (L)"],
  ["m", "Metro (m)"], ["m2", "Metro cuadrado (m²)"], ["m3", "Metro cúbico (m³)"],
  ["gal", "Galón"], ["rollo", "Rollo"], ["caja", "Caja"], ["juego", "Juego"], ["viaje", "Viaje"],
].map(([id, title]) => ({ id, title }));

/** Declaración `data` de un texto que la pantalla recibe y puede pintar. */
const textoRecibido = (ejemplo: string) => ({ type: "string", __example__: ejemplo });
/** Declaración `data` de una lista para un Dropdown. */
const listaRecibida = () => ({
  type: "array",
  items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" } } },
  __example__: [{ id: "ejemplo", title: "Ejemplo" }],
});

/** Claves que viajan desde TIPO_Y_EMPRESA y acompañan a todas las pantallas siguientes. */
function cabeceraData() {
  return {
    catalogo: listaRecibida(),
    tipo_solicitud: textoRecibido("compra"),
    empresa: textoRecibido("20000000-0000-4000-8000-000000000001"),
  };
}

/** Claves de los artículos 1..n tal como se declaran al RECIBIRLAS. */
function itemsData(n: number) {
  const data: Record<string, unknown> = {};
  for (let k = 1; k <= n; k += 1) for (const campo of CAMPOS_ITEM) data[`item_${k}_${campo}`] = textoRecibido("");
  return data;
}

/** Reenvío de lo ya recibido: se lee de `data`, no de `form`, porque no es de esta pantalla. */
function reenvioCabecera() {
  return { catalogo: "${data.catalogo}", tipo_solicitud: "${data.tipo_solicitud}", empresa: "${data.empresa}" };
}
function reenvioItems(n: number) {
  const payload: Record<string, string> = {};
  for (let k = 1; k <= n; k += 1) for (const campo of CAMPOS_ITEM) payload[`item_${k}_${campo}`] = `\${data.item_${k}_${campo}}`;
  return payload;
}
/** Lo que la pantalla de artículo k aporta: sus propios campos, leídos de `form`. */
function aporteItem(k: number) {
  const payload: Record<string, string> = {};
  for (const campo of CAMPOS_ITEM) payload[`item_${k}_${campo}`] = `\${form.${campo}}`;
  return payload;
}

/**
 * Artículos desde `desde` hasta el tope, en blanco.
 *
 * Hace falta porque Meta valida que el `payload` de un `navigate` traiga TODAS las claves que la
 * pantalla destino declara en su `data`, no solo las que existan:
 *   "Following fields are expected in the next screen's data model but missing in payload:
 *    [item_8_catalogo, ...]"
 * DETALLES declara los ocho artículos —tiene que poder recibirlos todos—, así que quien salte al
 * resumen desde el artículo 3 debe rellenar del 4 al 8 con cadenas vacías. El adaptador ya descarta
 * los artículos sin descripción, de modo que llegar con huecos es inocuo.
 */
function itemsEnBlanco(desde: number) {
  const payload: Record<string, string> = {};
  for (let k = desde; k <= MAX_ITEMS; k += 1) for (const campo of CAMPOS_ITEM) payload[`item_${k}_${campo}`] = "";
  return payload;
}

function pantallaTipoYEmpresa() {
  return {
    id: "TIPO_Y_EMPRESA",
    title: "Nueva requisición",
    data: { sociedades: listaRecibida(), catalogo: listaRecibida() },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextHeading", text: "¿Qué necesitas?" },
        { type: "TextBody", text: "Elige el tipo de solicitud y la empresa. La obra la asigna Compras." },
        {
          type: "RadioButtonsGroup", name: "tipo_solicitud", label: "Tipo de solicitud", required: true,
          "data-source": [{ id: "compra", title: "Compra de material" }, { id: "pago", title: "Solicitud de pago" }],
        },
        { type: "Dropdown", name: "empresa", label: "Empresa", required: true, "data-source": "${data.sociedades}" },
        {
          type: "Footer", label: "Continuar",
          "on-click-action": {
            name: "navigate", next: { type: "screen", name: idArticulo(1) },
            // El catálogo se ARRASTRA en vez de releerse en cada pantalla: sin Data Endpoint, una
            // pantalla solo ve lo que le entregan. El v1 lo referenciaba como
            // `${screen.TIPO_Y_EMPRESA.data.catalogo}` desde las pantallas de artículo, que es la
            // misma sintaxis entre pantallas que fallaba en el resumen.
            payload: { catalogo: "${data.catalogo}", tipo_solicitud: "${form.tipo_solicitud}", empresa: "${form.empresa}" },
          },
        },
      ],
    },
  };
}

function pantallaArticulo(k: number) {
  const primero = k === 1;
  const hayOtro = k < MAX_ITEMS;
  const acumulado = { ...reenvioCabecera(), ...reenvioItems(k - 1), ...aporteItem(k) };
  const hijos: ComponenteFlow[] = [
    { type: "TextHeading", text: primero ? "Artículo 1" : `Artículo ${k} · opcional` },
    {
      type: "TextBody",
      text: primero
        ? "Elígelo del catálogo o descríbelo. Es el único obligatorio."
        : "Si ya no necesitas más, pulsa Continuar y pasamos al resumen.",
    },
    { type: "Dropdown", name: "catalogo", label: "Del catálogo", required: false, "data-source": "${data.catalogo}" },
    // Obligatorio SOLO en el primero: a partir del segundo, exigir campos impediría usar
    // "Continuar" para saltar al resumen, que es justo lo que pidió Ernesto.
    { type: "TextInput", name: "descripcion", label: "Descripción", required: primero, "max-chars": 500, "helper-text": "Si no está en el catálogo, descríbelo aquí" },
    { type: "TextInput", name: "cantidad", label: "Cantidad", "input-type": "text", required: primero, "max-chars": 12, pattern: "^[0-9]+(\\.[0-9]+)?$", "helper-text": "Solo números; punto para decimales (ej. 2.5)" },
    { type: "Dropdown", name: "unidad", label: "Unidad", required: primero, "data-source": UNIDADES },
    { type: "TextInput", name: "proveedor", label: "Posible proveedor", required: false, "max-chars": 240 },
    { type: "TextInput", name: "link", label: "Enlace del producto", "input-type": "text", required: false, "max-chars": 2048, "helper-text": "Opcional, debe empezar por https://" },
    { type: "PhotoPicker", name: "foto", label: "Foto del artículo", description: "Opcional", "photo-source": "camera_gallery", "max-uploaded-photos": 1, "max-file-size-kb": 10240 },
  ];
  if (hayOtro) {
    // Hacia el siguiente artículo basta lo acumulado: esa pantalla solo declara 1..k.
    hijos.push({
      type: "EmbeddedLink", text: "Agregar otro artículo",
      "on-click-action": { name: "navigate", next: { type: "screen", name: idArticulo(k + 1) }, payload: acumulado },
    });
  }
  hijos.push({
    type: "Footer", label: "Continuar",
    // Hacia DETALLES hay que completar hasta el octavo, aunque no se hayan visitado (ver itemsEnBlanco).
    "on-click-action": { name: "navigate", next: { type: "screen", name: "DETALLES" }, payload: { ...acumulado, ...itemsEnBlanco(k + 1) } },
  });
  return { id: idArticulo(k), title: primero ? "Artículo 1" : `Artículo ${k} · opcional`, data: { ...cabeceraData(), ...itemsData(k - 1) }, layout: { type: "SingleColumnLayout", children: hijos } };
}

function pantallaDetalles() {
  return {
    id: "DETALLES",
    title: "Detalles",
    data: { ...cabeceraData(), ...itemsData(MAX_ITEMS) },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextHeading", text: "Últimos detalles" },
        { type: "DatePicker", name: "fecha_requerida", label: "¿Para cuándo la necesitas?", required: false },
        { type: "TextArea", name: "observaciones", label: "Observaciones", required: false, "max-length": 1024, "helper-text": "Di a dónde va o cualquier instrucción de entrega" },
        {
          type: "Footer", label: "Continuar",
          "on-click-action": {
            name: "navigate", next: { type: "screen", name: "RESUMEN" },
            payload: { ...reenvioCabecera(), ...reenvioItems(MAX_ITEMS), fecha_requerida: "${form.fecha_requerida}", observaciones: "${form.observaciones}" },
          },
        },
      ],
    },
  };
}

function pantallaResumen() {
  const data = { ...cabeceraData(), ...itemsData(MAX_ITEMS), fecha_requerida: textoRecibido(""), observaciones: textoRecibido("") };
  // El `complete` se arma con `${data.*}`, no con referencias entre pantallas: llega aquí ya
  // encadenado, así que no hace falta —ni conviene— volver a mirar hacia atrás.
  const payload: Record<string, string> = { type: "${data.tipo_solicitud}", societyId: "${data.empresa}", requiredDate: "${data.fecha_requerida}", observations: "${data.observaciones}" };
  for (let k = 1; k <= MAX_ITEMS; k += 1) for (const campo of CAMPOS_ITEM) payload[`item_${k}_${campo}`] = `\${data.item_${k}_${campo}}`;

  const hijos: ComponenteFlow[] = [
    { type: "TextHeading", text: "Revisa antes de enviar" },
    { type: "TextBody", text: "Empresa: ${data.empresa}" },
    { type: "TextBody", text: "Tipo: ${data.tipo_solicitud}" },
    { type: "TextBody", text: "Fecha requerida: ${data.fecha_requerida}" },
  ];
  // Una línea por artículo. Los no usados llegan vacíos; se pintan igual porque ocultarlos exigiría
  // condicionales sobre cadena vacía, que es terreno que Meta no documenta con claridad y que, si
  // falla, falla en silencio — exactamente el defecto que estamos arreglando.
  for (let k = 1; k <= MAX_ITEMS; k += 1) {
    hijos.push({ type: "TextBody", text: `Artículo ${k}: \${data.item_${k}_descripcion} (\${data.item_${k}_cantidad} \${data.item_${k}_unidad})` });
  }
  hijos.push({ type: "Footer", label: "Enviar solicitud", "on-click-action": { name: "complete", payload } });
  return { id: "RESUMEN", title: "Resumen", terminal: true, success: true, data, layout: { type: "SingleColumnLayout", children: hijos } };
}

export function construirFlow(): FlowCaptura {
  const screens: PantallaFlow[] = [pantallaTipoYEmpresa()];
  for (let k = 1; k <= MAX_ITEMS; k += 1) screens.push(pantallaArticulo(k));
  screens.push(pantallaDetalles(), pantallaResumen());
  return { version: "7.3", screens };
}

const json = `${JSON.stringify(construirFlow(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const actual = readFileSync(RUTA_FLOW_V2, "utf8");
  if (actual !== json) {
    process.stderr.write("requisicion-v2.flow.json no coincide con el generador. Ejecuta: npx tsx scripts/build-flow-captura.ts\n");
    process.exit(1);
  }
  process.stdout.write("requisicion-v2.flow.json al día\n");
} else {
  writeFileSync(RUTA_FLOW_V2, json, "utf8");
  process.stdout.write(`escrito ${RUTA_FLOW_V2} (${construirFlow().screens.length} pantallas, ${MAX_ITEMS} artículos)\n`);
}
