import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { construirFlow, MAX_ITEMS, type ComponenteFlow } from "../../scripts/build-flow-captura";

/** Acción de navegación de un componente, ya acotada: el generador los tipa laxos a propósito. */
type ConAccion = ComponenteFlow & { "on-click-action"?: { name?: string; next?: { name: string }; payload?: Record<string, string> } };

// Flow de captura v2. Arregla los dos defectos que reportó Ernesto probando desde su celular:
// el resumen pintaba las llaves en vez de los valores, y solo cabían tres artículos.
//
// Lo que se vigila aquí es lo que Meta NO avisa en tiempo de validación y solo se ve en el chat:
// una pantalla que pinta `${...}` literal, o un artículo que se pierde por el camino.

const RUTA_JSON = resolve(__dirname, "../../integrations/whatsapp-flow/requisicion-v2.flow.json");
const flow = construirFlow();
const pantalla = (id: string) => flow.screens.find((s) => s.id === id)!;

describe("el JSON commiteado no se separa del generador", () => {
  it("coincide con lo que produce scripts/build-flow-captura.ts", () => {
    // El JSON es el artefacto que se sube a Meta, así que se commitea; el generador es la fuente.
    // Sin este candado, un retoque a mano sobre el JSON se perdería en la siguiente generación.
    //
    // Se normalizan los finales de línea antes de comparar. `.gitattributes` ya fuerza LF para este
    // archivo, pero un clon hecho antes de esa regla —o con otra configuración de `core.autocrlf`—
    // lo deja con CRLF, y entonces esta prueba fallaba por un motivo que no tiene NADA que ver con
    // lo que vigila. Llegó a dejar el archivo como modificado permanentemente e impedir cambiar de
    // rama durante una revisión.
    const enDisco = readFileSync(RUTA_JSON, "utf8").replace(/\r\n/g, "\n");
    expect(enDisco).toBe(`${JSON.stringify(flow, null, 2)}\n`);
  });
});

describe("defecto 1 — el resumen pinta valores, no llaves", () => {
  const resumen = pantalla("RESUMEN");

  it("declara en `data` TODO lo que pinta", () => {
    // La causa raíz del defecto: sin Data Endpoint una pantalla solo resuelve `${data.x}` de lo que
    // declara recibir. El v1 no declaraba nada, así que imprimía la expresión tal cual.
    const declaradas = new Set(Object.keys(resumen.data!));
    const usadas = JSON.stringify(resumen.layout.children.filter((c) => c.type !== "Footer"))
      .match(/\$\{data\.([a-z0-9_]+)\}/g)!
      .map((m) => m.slice(7, -1));
    expect(usadas.length).toBeGreaterThan(0);
    for (const clave of usadas) expect(declaradas, `falta declarar ${clave}`).toContain(clave);
  });

  it("NO usa la sintaxis entre pantallas en ningún texto", () => {
    // `${screen.OTRA.form.x}` vale en el payload de una acción pero no en una propiedad de texto.
    // Es exactamente lo que hacía el v1 y por lo que se veían las llaves.
    const textos = JSON.stringify(flow.screens.flatMap((s) => s.layout.children.filter((c) => typeof c.text === "string")));
    expect(textos).not.toContain("${screen.");
  });

  it("los artículos que no se pidieron NO dejan renglón vacío en el resumen", () => {
    // Lo preguntó Ernesto recorriendo la vista previa: «si no se agregan otros ítems, ¿en el resumen
    // quedan vacíos o sin aparecer?». Quedaban: siete renglones "Artículo N:  ( )" para quien pidiera
    // una sola cosa. Un resumen con siete líneas de ruido no sirve para revisar nada.
    //
    // Se condiciona con el componente `If` y NO con la propiedad `visible`: Meta rechaza una
    // comparación en `visible` —"The expression return type is 'string' which does not match the
    // schema for the property"—, porque ahí espera un booleano ya resuelto.
    const lineas = resumen.layout.children.filter((c) => c.type === "If") as (ComponenteFlow & { condition: string; then: ComponenteFlow[] })[];
    expect(lineas).toHaveLength(MAX_ITEMS - 1);
    for (const [indice, bloque] of lineas.entries()) {
      const k = indice + 2;
      expect(bloque.condition, `el artículo ${k} debe condicionarse por SU propia descripción`).toBe(`\${data.item_${k}_descripcion} != ''`);
      expect(String(bloque.then[0].text)).toContain(`Artículo ${k}:`);
    }
  });

  it("el primer artículo NO se condiciona: es obligatorio y siempre está", () => {
    const sueltos = resumen.layout.children.filter((c) => c.type === "TextBody" && String(c.text).startsWith("Artículo "));
    expect(sueltos).toHaveLength(1);
    expect(String(sueltos[0].text)).toContain("Artículo 1:");
  });

  it("el `complete` se arma con datos encadenados, sin mirar hacia atrás", () => {
    const footer = resumen.layout.children.at(-1) as ConAccion;
    expect(footer["on-click-action"]?.name).toBe("complete");
    for (const valor of Object.values(footer["on-click-action"]!.payload!)) expect(valor).not.toContain("${screen.");
  });
});

describe("defecto 2 — ocho artículos bajo demanda", () => {
  it("hay ocho pantallas de artículo y solo la primera exige campos", () => {
    // Si la segunda exigiera descripción, "Continuar" no podría usarse para saltar al resumen, que
    // es justo lo que pidió Ernesto («que abajo diga enviar y otro botón agregar otro»).
    const articulos = flow.screens.filter((s) => s.id.startsWith("ARTICULO_"));
    expect(articulos).toHaveLength(MAX_ITEMS);
    const requeridos = (s: (typeof articulos)[number]) => s.layout.children.filter((c) => c.required === true).length;
    expect(requeridos(articulos[0])).toBeGreaterThan(0);
    for (const otro of articulos.slice(1)) expect(requeridos(otro)).toBe(0);
  });

  it("cada artículo ofrece seguir o ir al resumen, y el último ya no ofrece seguir", () => {
    const articulos = flow.screens.filter((s) => s.id.startsWith("ARTICULO_"));
    for (const [indice, articulo] of articulos.entries()) {
      const acciones = articulo.layout.children.filter((c) => c.type === "EmbeddedLink" || c.type === "Footer") as ConAccion[];
      const destinos = acciones.map((c) => c["on-click-action"]?.next?.name);
      expect(destinos).toContain("DETALLES");
      if (indice < MAX_ITEMS - 1) expect(destinos).toContain(articulos[indice + 1].id);
      else expect(destinos).toEqual(["DETALLES"]);
    }
  });

  it("quien salta al resumen desde un artículo intermedio rellena los que faltan", () => {
    // Meta valida que el payload traiga TODAS las claves del `data` de la pantalla destino:
    // "Following fields are expected in the next screen's data model but missing in payload".
    // DETALLES declara los ocho, así que saltar desde el tercero obliga a mandar 4..8 vacíos.
    const tercero = pantalla("ARTICULO_TRES");
    const alResumen = (tercero.layout.children as ConAccion[]).find(
      (c) => c.type === "Footer" && c["on-click-action"]?.next?.name === "DETALLES",
    )!;
    const payloadAlResumen = alResumen["on-click-action"]!.payload!;
    const declaradasEnDetalles = Object.keys(pantalla("DETALLES").data!);
    for (const clave of declaradasEnDetalles) expect(Object.keys(payloadAlResumen), `falta ${clave}`).toContain(clave);
    expect(payloadAlResumen.item_8_descripcion).toBe("");
    expect(payloadAlResumen.item_3_descripcion).toBe("${form.descripcion}");
  });

  it("ningún salto referencia una pantalla que quizá no se visitó", () => {
    // Con ocho pantallas opcionales, apostar a que Meta resuelve el `form` de una pantalla nunca
    // abierta sería confiar en algo que no documenta. Todo viaja encadenado.
    for (const p of flow.screens) {
      const acciones = JSON.stringify(p.layout.children.filter((c) => c["on-click-action"]));
      expect(acciones, `${p.id} mira hacia atrás`).not.toContain("${screen.");
    }
  });
});
