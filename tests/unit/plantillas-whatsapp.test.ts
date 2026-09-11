import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CATEGORIA_PLANTILLAS,
  IDIOMA_PLANTILLAS,
  PLANTILLAS_WHATSAPP,
  definicionParaMeta,
  parametrosDePlantilla,
  type NombrePlantilla,
} from "../../lib/infrastructure/plantillas-whatsapp";

// El nombre de la plantilla es una cadena suelta en el punto de encolado y el payload es JSON libre:
// nada ata lo que el código manda con lo que Meta aprobó. Un desajuste no rompe la compilación ni la
// ejecución — se descubre cuando a un maestro no le llega el aviso, o cuando le llega con un hueco.
// Estas pruebas leen el CÓDIGO FUENTE de ProcurementService y lo cruzan con las definiciones.
//
// Ya valió la pena: al escribirlas apareció `requisicion_devuelta`, que el encargo no mencionaba y
// que el servicio sí envía. Sin este cruce habría quedado fuera de la creación en Meta y esa
// notificación habría fallado en silencio, igual que las otras cuatro.
const FUENTE_SERVICIO = readFileSync(
  fileURLToPath(new URL("../../lib/services/procurement-service.ts", import.meta.url)),
  "utf8",
);

/** Nombres que el servicio envía: los literales de `notifyRequester(...)` y los `template:` de `enqueue({...})`. */
function plantillasQueEnviaElServicio(): string[] {
  const nombres = new Set<string>();
  for (const [, nombre] of FUENTE_SERVICIO.matchAll(/notifyRequester\(\s*\w+\s*,\s*"([a-z_]+)"/g)) nombres.add(nombre);
  for (const [, nombre] of FUENTE_SERVICIO.matchAll(/enqueue\(\{[^}]*?template:\s*"([a-z_]+)"/g)) nombres.add(nombre);
  return [...nombres].sort();
}

/** Claves del `payload:` de cada `enqueue({...})`, que es lo que llega al despachador. */
function clavesDePayloadEncolado(): string[][] {
  return [...FUENTE_SERVICIO.matchAll(/enqueue\(\{[^)]*?payload:\s*\{([^}]*)\}/g)].map(([, cuerpo]) =>
    [...cuerpo.matchAll(/(\w+)\s*:/g)].map(([, clave]) => clave).sort(),
  );
}

describe("las plantillas declaradas cubren lo que el servicio realmente envía", () => {
  it("encuentra los puntos de envío (si esto falla, las expresiones regulares se quedaron atrás)", () => {
    expect(plantillasQueEnviaElServicio().length).toBeGreaterThanOrEqual(5);
    expect(clavesDePayloadEncolado().length).toBeGreaterThanOrEqual(4);
  });

  it("toda plantilla que el servicio envía está declarada", () => {
    const declaradas = Object.keys(PLANTILLAS_WHATSAPP);
    const sinDeclarar = plantillasQueEnviaElServicio().filter((nombre) => !declaradas.includes(nombre));
    // Mensaje explícito: quien añada una notificación nueva tiene que declararla aquí Y crearla en
    // Meta, o su envío morirá con KAPSO_SEND_FAILED_4xx tras quemar los cinco reintentos.
    expect(sinDeclarar, `plantillas enviadas por el servicio pero sin declarar (y por tanto sin crear en Meta): ${sinDeclarar.join(", ")}`).toEqual([]);
  });

  it("no se declara ninguna plantilla que nadie envíe", () => {
    const enviadas = plantillasQueEnviaElServicio();
    const huerfanas = Object.keys(PLANTILLAS_WHATSAPP).filter((nombre) => !enviadas.includes(nombre));
    expect(huerfanas, `declaradas pero que el servicio nunca envía: ${huerfanas.join(", ")}`).toEqual([]);
  });

  it("cada variable declarada existe en el payload que se encola", () => {
    // Si una variable no llega en el payload, el mensaje sale con un hueco donde debía ir el dato.
    const payloads = clavesDePayloadEncolado();
    for (const [nombre, plantilla] of Object.entries(PLANTILLAS_WHATSAPP)) {
      for (const variable of plantilla.variables) {
        for (const claves of payloads) {
          expect(claves, `${nombre} usa {{${variable}}}, que no viaja en el payload encolado (${claves.join(", ")})`).toContain(variable);
        }
      }
    }
  });
});

describe("el texto y sus variables no se desalinean", () => {
  it("el texto usa exactamente las variables declaradas, ni más ni menos", () => {
    for (const [nombre, plantilla] of Object.entries(PLANTILLAS_WHATSAPP)) {
      const enElTexto = [...plantilla.texto.matchAll(/\{\{(\w+)\}\}/g)].map(([, variable]) => variable).sort();
      expect(enElTexto, `${nombre}: el texto y la lista de variables no coinciden`).toEqual([...plantilla.variables].sort());
    }
  });

  it("cada variable tiene un ejemplo, que Meta exige para revisar", () => {
    for (const [nombre, plantilla] of Object.entries(PLANTILLAS_WHATSAPP)) {
      for (const variable of plantilla.variables) {
        expect(plantilla.ejemplo[variable], `${nombre}: falta el ejemplo de {{${variable}}}`).toBeTruthy();
      }
    }
  });

  it("el texto va sin tildes ni emojis", () => {
    // Misma razón que publish-approval-template.ts: reduce los rechazos de revisión y algunos
    // clientes viejos renderizan mal los acentos. Y una UTILITY con emojis parece publicidad, que es
    // el motivo de rechazo más común.
    for (const [nombre, plantilla] of Object.entries(PLANTILLAS_WHATSAPP)) {
      expect(plantilla.texto, `${nombre}: el texto lleva caracteres fuera de ASCII`).toMatch(/^[\x20-\x7E]*$/);
    }
  });
});

describe("parametrosDePlantilla recorta lo interno antes de enviarlo", () => {
  const payloadReal = { requisitionId: "0198f3a1-7c4d-4e2b-9f1a-2b3c4d5e6f70", consecutive: "REQ-2026-0007" };

  it("manda solo las variables declaradas: el UUID interno no sale en el mensaje", () => {
    // `sendKapsoTemplate` pasa este objeto tal cual como `parameters`. Sin el recorte, el
    // identificador interno acabaría dentro del WhatsApp del maestro, o Meta rechazaría el envío por
    // un parámetro que la plantilla no declara.
    for (const nombre of Object.keys(PLANTILLAS_WHATSAPP) as NombrePlantilla[]) {
      const parametros = parametrosDePlantilla(nombre, payloadReal);
      expect(parametros).toEqual({ consecutive: "REQ-2026-0007" });
      expect(parametros).not.toHaveProperty("requisitionId");
    }
  });

  it("una plantilla no declarada conserva el comportamiento anterior (devuelve null)", () => {
    // El despachador interpreta el null como "manda el payload entero", que es lo que hacía siempre.
    // Así este módulo no altera `aprobacion_requisicion` ni nada que alguien añada sin pasar por aquí.
    expect(parametrosDePlantilla("aprobacion_requisicion", payloadReal)).toBeNull();
    expect(parametrosDePlantilla("plantilla_inventada", payloadReal)).toBeNull();
  });

  it("una variable ausente queda vacía en vez de tumbar la notificación", () => {
    expect(parametrosDePlantilla("requisicion_recibida", { requisitionId: "x" })).toEqual({ consecutive: "" });
  });
});

describe("la definición que se manda a Meta", () => {
  it("declara parámetros CON NOMBRE, no posicionales", () => {
    // Es la diferencia con aprobacion_requisicion, que viaja por el proxy de Meta con una lista
    // posicional. Estas van por la API de Kapso, que manda el objeto con sus claves.
    for (const nombre of Object.keys(PLANTILLAS_WHATSAPP) as NombrePlantilla[]) {
      const definicion = definicionParaMeta(nombre);
      expect(definicion.parameter_format).toBe("NAMED");
      expect(definicion.name).toBe(nombre);
      expect(definicion.language).toBe(IDIOMA_PLANTILLAS);
      expect(definicion.category).toBe(CATEGORIA_PLANTILLAS);
    }
  });

  it("el ejemplo nombra cada variable del cuerpo", () => {
    for (const nombre of Object.keys(PLANTILLAS_WHATSAPP) as NombrePlantilla[]) {
      const cuerpo = definicionParaMeta(nombre).components.find((componente) => componente.type === "BODY");
      expect(cuerpo?.text).toBe(PLANTILLAS_WHATSAPP[nombre].texto);
      expect(cuerpo?.example.body_text_named_params.map((parametro) => parametro.param_name)).toEqual([...PLANTILLAS_WHATSAPP[nombre].variables]);
    }
  });

  it("no lleva botones: son avisos, no acciones", () => {
    // La única con botón es aprobacion_requisicion, y su botón es un Flow que exige el Flow publicado.
    for (const nombre of Object.keys(PLANTILLAS_WHATSAPP) as NombrePlantilla[]) {
      expect(definicionParaMeta(nombre).components.every((componente) => componente.type === "BODY")).toBe(true);
    }
  });
});
