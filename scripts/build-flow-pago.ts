/**
 * Genera `solicitud-pago.flow.json`, el WhatsApp Flow de SOLICITUD DE PAGO (RF-908).
 *
 * Es un Flow aparte del de captura (RF-902), no una rama suya. Pide a quién se le paga
 * (identificación + nombre), a qué empresa se le cobra, cuánto y por qué concepto; no tiene
 * artículos ni fotos. Llega a la plataforma como `tipo=pago` con beneficiario por identificación
 * (ola 1, RF-606): si la identificación ya existe en el catálogo se enlaza, si no nace pendiente de
 * normalizar y Compras completa la ficha.
 *
 * Antes el Flow de captura ofrecía `tipo_solicitud=pago`, pero su payload no traía beneficiario ni
 * valor y la plataforma lo rechazaba con PAYMENT_BENEFICIARY_REQUIRED: la opción existía y no
 * funcionaba. Se retiró de allí (decisión A11 del plan) y vive aquí.
 *
 * Sigue las mismas reglas del validador de Meta que costaron tres intentos en el de captura
 * (integrations/whatsapp-flow/README.md, «Seis reglas»): cada pantalla declara en `data` todo lo que
 * recibe y lo reenvía completo en el `payload` de su `navigate`; el resumen pinta bindings PUROS
 * (`${data.x}`) bajo un rótulo estático; la única concatenación va entre acentos graves y sin
 * signos dentro; ningún texto usa la sintaxis entre pantallas.
 *
 * Uso:  npx tsx scripts/build-flow-pago.ts
 *       npx tsx scripts/build-flow-pago.ts --check   (no escribe; falla si difiere)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listaRecibida, textoRecibido, type ComponenteFlow, type FlowCaptura, type PantallaFlow } from "./build-flow-captura";

export const RUTA_FLOW_PAGO = resolve("integrations/whatsapp-flow/solicitud-pago.flow.json");

/** Pantalla de entrada: es la que recibe `sociedades` en `flow_action_payload.data` al enviar el Flow. */
export const PANTALLA_ENTRADA_PAGO = "BENEFICIARIO";

/** Discriminador estático del `complete`, igual que `kind: "aprobacion"` en el Flow de aprobación:
 * es lo único que separa esta respuesta de la del Flow de captura antes de validar nada. */
export const KIND_PAGO = "pago";

/** Claves que entrega el `complete`, en el orden en que se piden. El adaptador las lee tal cual. */
export const CAMPOS_PAGO = ["tipo_identificacion", "identificacion", "nombre", "empresa", "monto", "concepto"] as const;

/** Mismos valores que `SUPPLIER_IDENTIFICATION_TYPE_VALUES` (lib/http/schemas.ts); CC primero y por
 * defecto porque quien pide un pago por WhatsApp es casi siempre una persona, no una empresa. */
export const TIPOS_IDENTIFICACION = [
  { id: "CC", title: "Cédula de ciudadanía" },
  { id: "NIT", title: "NIT" },
  { id: "CE", title: "Cédula de extranjería" },
  { id: "PAS", title: "Pasaporte" },
];

const RESUMEN = "RESUMEN";
const PAGO = "PAGO";

function pantallaBeneficiario(): PantallaFlow {
  return {
    id: PANTALLA_ENTRADA_PAGO,
    title: "Solicitud de pago",
    data: { sociedades: listaRecibida() },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextHeading", text: "¿A quién se le paga?" },
        { type: "TextBody", text: "Puedes ser tú o un tercero. Si aún no está en el catálogo, Compras completa sus datos después." },
        { type: "RadioButtonsGroup", name: "tipo_identificacion", label: "Tipo de identificación", required: true, "init-value": "CC", "data-source": TIPOS_IDENTIFICACION },
        { type: "TextInput", name: "identificacion", label: "Identificación", "input-type": "text", required: true, "max-chars": 32, pattern: "^[0-9A-Za-z.-]{3,32}$", "helper-text": "Sin espacios; el NIT con su dígito de verificación (ej. 900123456-7)" },
        { type: "TextInput", name: "nombre", label: "Nombre completo", required: true, "max-chars": 160, "helper-text": "De la persona, o la razón social si es una empresa" },
        {
          type: "Footer", label: "Continuar",
          "on-click-action": {
            name: "navigate", next: { type: "screen", name: PAGO },
            payload: { sociedades: "${data.sociedades}", tipo_identificacion: "${form.tipo_identificacion}", identificacion: "${form.identificacion}", nombre: "${form.nombre}" },
          },
        },
      ],
    },
  };
}

function pantallaPago(): PantallaFlow {
  return {
    id: PAGO,
    title: "Empresa y monto",
    data: { sociedades: listaRecibida(), tipo_identificacion: textoRecibido("CC"), identificacion: textoRecibido("1020304050"), nombre: textoRecibido("Juan Pérez") },
    layout: {
      type: "SingleColumnLayout",
      children: [
        { type: "TextHeading", text: "¿Cuánto y a qué empresa?" },
        { type: "Dropdown", name: "empresa", label: "Empresa que paga", required: true, "data-source": "${data.sociedades}" },
        // Texto con patrón, y no `input-type: number`, por la misma razón que `cantidad` en el Flow
        // de captura: es la combinación que Meta ya validó y que se probó en un teléfono real.
        { type: "TextInput", name: "monto", label: "Monto en pesos", "input-type": "text", required: true, "max-chars": 12, pattern: "^[1-9][0-9]{0,11}$", "helper-text": "Solo números, sin puntos ni signo (ej. 1500000)" },
        { type: "TextInput", name: "concepto", label: "Concepto", required: true, "max-chars": 160, "helper-text": "Qué se paga, en pocas palabras (ej. corte de obra semana 37)" },
        {
          type: "Footer", label: "Continuar",
          "on-click-action": {
            name: "navigate", next: { type: "screen", name: RESUMEN },
            payload: {
              tipo_identificacion: "${data.tipo_identificacion}", identificacion: "${data.identificacion}", nombre: "${data.nombre}",
              empresa: "${form.empresa}", monto: "${form.monto}", concepto: "${form.concepto}",
            },
          },
        },
      ],
    },
  };
}

function pantallaResumen(): PantallaFlow {
  const data = {
    tipo_identificacion: textoRecibido("CC"), identificacion: textoRecibido("1020304050"), nombre: textoRecibido("Juan Pérez"),
    empresa: textoRecibido("Mizar"), monto: textoRecibido("1500000"), concepto: textoRecibido("Corte de obra semana 37"),
  };
  const payload: Record<string, string> = { kind: KIND_PAGO };
  for (const campo of CAMPOS_PAGO) payload[campo] = `\${data.${campo}}`;
  const hijos: ComponenteFlow[] = [
    { type: "TextHeading", text: "Revisa antes de enviar" },
    { type: "TextCaption", text: "Beneficiario" },
    { type: "TextBody", text: "${data.nombre}" },
    { type: "TextCaption", text: "Identificación" },
    { type: "TextBody", text: "`${data.tipo_identificacion} ${data.identificacion}`" },
    { type: "TextCaption", text: "Empresa que paga" },
    { type: "TextBody", text: "${data.empresa}" },
    { type: "TextCaption", text: "Monto en pesos" },
    { type: "TextBody", text: "${data.monto}" },
    { type: "TextCaption", text: "Concepto" },
    { type: "TextBody", text: "${data.concepto}" },
    { type: "Footer", label: "Enviar solicitud", "on-click-action": { name: "complete", payload } },
  ];
  return { id: RESUMEN, title: "Resumen", terminal: true, success: true, data, layout: { type: "SingleColumnLayout", children: hijos } };
}

export function construirFlowPago(): FlowCaptura {
  return { version: "7.3", screens: [pantallaBeneficiario(), pantallaPago(), pantallaResumen()] };
}

/** Misma guarda que build-flow-captura.ts: importar este módulo desde una prueba no debe escribir en disco. */
const ejecutadoComoGuion = (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("scripts/build-flow-pago.ts");

if (ejecutadoComoGuion) {
  const json = `${JSON.stringify(construirFlowPago(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(RUTA_FLOW_PAGO, "utf8").replace(/\r\n/g, "\n") !== json) {
      process.stderr.write("solicitud-pago.flow.json no coincide con el generador. Ejecuta: npx tsx scripts/build-flow-pago.ts\n");
      process.exit(1);
    }
    process.stdout.write("solicitud-pago.flow.json al día\n");
  } else {
    writeFileSync(RUTA_FLOW_PAGO, json, "utf8");
    process.stdout.write(`escrito ${RUTA_FLOW_PAGO} (${construirFlowPago().screens.length} pantallas)\n`);
  }
}
