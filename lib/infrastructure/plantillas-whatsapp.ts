/**
 * Definición de las cuatro plantillas de WhatsApp que la plataforma envía por NOMBRE desde
 * `ProcurementService` (lib/services/procurement-service.ts) y que drena el despachador
 * (lib/infrastructure/notification-dispatcher.ts).
 *
 * Por qué existe este módulo y no basta el script: el nombre de la plantilla es hoy una cadena
 * suelta en el punto de encolado y el payload es JSON libre. Nada ata lo que el código manda con lo
 * que Meta aprobó, así que un desajuste no falla al compilar ni al correr: se descubre cuando a un
 * maestro no le llega el aviso. Con las definiciones aquí, el script que las crea en Meta y el
 * despachador que las envía leen la MISMA fuente, y tests/unit/plantillas-whatsapp.test.ts fija que
 * sigan cuadrando.
 *
 * ---------------------------------------------------------------------------------------------
 * PARÁMETROS CON NOMBRE, NO POSICIONALES. Es la diferencia con `aprobacion_requisicion`.
 *
 * Esa plantilla se manda por el proxy de Meta (`approval-flow-sender.ts`) armando una lista
 * posicional a mano, y por eso su texto usa {{1}}..{{4}}. Estas cuatro viajan por la API propia de
 * Kapso: `sendKapsoTemplate` (kapso.ts) hace
 *
 *     body: { to, template, parameters: input.payload }
 *
 * donde `payload` es el objeto que se encoló — `{ requisitionId, consecutive }` — con sus CLAVES.
 * No hay capa que lo convierta en lista, así que declararlas con {{1}}/{{2}} sería apostar a que
 * Kapso ordene el objeto por posición, y en ese orden {{1}} sería el UUID interno de la requisición.
 * Un identificador técnico dentro del mensaje que le llega al maestro.
 *
 * De ahí `parameter_format: "NAMED"` y variables por nombre.
 * ---------------------------------------------------------------------------------------------
 *
 * `requisitionId` NO se declara como variable a propósito. Va en el payload encolado porque el
 * despachador lo necesita para enlazar la fila de `whatsapp_eventos` con su requisición
 * (`extractRequisitionId`), pero no tiene nada que hacer dentro del texto del mensaje. Por eso
 * `parametrosDePlantilla()` recorta el payload a lo declarado antes de enviarlo: lo interno se
 * queda en la base y solo sale lo que la plantilla pide.
 *
 * Los textos van SIN TILDES, igual que `publish-approval-template.ts`: reducen los rechazos de
 * revisión y algunos clientes viejos los renderizan mal.
 */

export const IDIOMA_PLANTILLAS = "es";
export const CATEGORIA_PLANTILLAS = "UTILITY";

export interface DefinicionPlantilla {
  /** Variables del cuerpo, por nombre. Deben existir como claves del payload que se encola. */
  readonly variables: readonly string[];
  /** Texto del cuerpo con `{{variable}}`. Sin tildes y sin emojis: Meta rechaza UTILITY que parezca publicidad. */
  readonly texto: string;
  /** Valor de muestra por variable. Meta lo exige para revisar la plantilla. */
  readonly ejemplo: Readonly<Record<string, string>>;
  /** Para qué sirve, y a quién le llega. Solo documentación. */
  readonly proposito: string;
}

export const PLANTILLAS_WHATSAPP = {
  requisicion_recibida: {
    variables: ["consecutive"],
    texto: "Recibimos tu requisición {{consecutive}}. Te avisamos por este medio cuando avance.",
    ejemplo: { consecutive: "REQ-2026-0001" },
    proposito: "Acuse al solicitante cuando su requisicion queda radicada (portal publico o WhatsApp).",
  },
  requisicion_aprobada: {
    variables: ["consecutive"],
    texto: "Tu requisición {{consecutive}} fue aprobada. Compras sigue con la orden al proveedor.",
    ejemplo: { consecutive: "REQ-2026-0001" },
    proposito: "Aviso al solicitante cuando el aprobador aprueba la requisicion.",
  },
  requisicion_declinada: {
    variables: ["consecutive"],
    texto: "Tu requisición {{consecutive}} fue declinada. Consulta el motivo con el área de compras.",
    ejemplo: { consecutive: "REQ-2026-0001" },
    proposito: "Aviso al solicitante cuando la requisicion se declina completa.",
  },
  requisicion_devuelta: {
    variables: ["consecutive"],
    texto: "Tu requisición {{consecutive}} regresó a revisión para ajustes. Te avisamos cuando avance.",
    ejemplo: { consecutive: "REQ-2026-0001" },
    proposito:
      "Aviso al solicitante cuando el aprobador la devuelve a revision (`returnForCorrection`). No estaba en el encargo original: apareció al cruzar las definiciones con los sitios que encolan, y es justo lo que fija la prueba.",
  },
  pendiente_aprobador: {
    variables: ["consecutive"],
    texto: "La requisición {{consecutive}} está esperando tu aprobación en la plataforma de compras.",
    ejemplo: { consecutive: "REQ-2026-0001" },
    proposito:
      "Aviso al aprobador. Es el ULTIMO recurso del despachador: primero intenta el Flow interactivo y luego la plantilla con boton (aprobacion_requisicion); solo cae aqui cuando el Flow es imposible.",
  },
} as const satisfies Readonly<Record<string, DefinicionPlantilla>>;

export type NombrePlantilla = keyof typeof PLANTILLAS_WHATSAPP;

export function esPlantillaDeclarada(nombre: string): nombre is NombrePlantilla {
  return Object.hasOwn(PLANTILLAS_WHATSAPP, nombre);
}

/**
 * Recorta el payload encolado a las variables que la plantilla declara, como texto.
 *
 * Una plantilla no declarada devuelve `null` — el despachador conserva entonces su comportamiento
 * de siempre (mandar el payload entero). Así este módulo no cambia nada para
 * `aprobacion_requisicion`, que viaja por otro emisor, ni para cualquier plantilla que alguien
 * añada mañana sin pasar por aquí.
 *
 * Una variable declarada que falte en el payload queda como cadena vacía, igual que hacía
 * `toTemplatePayload`: es preferible un hueco en el mensaje a perder la notificación entera.
 */
export function parametrosDePlantilla(
  nombre: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, string> | null {
  if (!esPlantillaDeclarada(nombre)) return null;
  return Object.fromEntries(
    PLANTILLAS_WHATSAPP[nombre].variables.map((variable) => {
      const valor = payload[variable];
      return [variable, valor === null || valor === undefined ? "" : String(valor)];
    }),
  );
}

/** Cuerpo que espera `POST /{waba}/message_templates`, para el script que las crea en Meta. */
export function definicionParaMeta(nombre: NombrePlantilla) {
  const plantilla = PLANTILLAS_WHATSAPP[nombre];
  return {
    name: nombre,
    language: IDIOMA_PLANTILLAS,
    category: CATEGORIA_PLANTILLAS,
    parameter_format: "NAMED",
    components: [
      {
        type: "BODY",
        text: plantilla.texto,
        example: {
          body_text_named_params: plantilla.variables.map((variable) => ({
            param_name: variable,
            example: plantilla.ejemplo[variable],
          })),
        },
      },
    ],
  };
}
