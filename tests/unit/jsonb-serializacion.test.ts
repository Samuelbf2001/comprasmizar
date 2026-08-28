import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guardian de regresion de un bug que ninguna prueba con mocks podia atrapar y que
 * dejaba la plataforma inservible en produccion.
 *
 * `${JSON.stringify(obj)}::jsonb` NO guarda un objeto: postgres.js recibe el string
 * ya serializado y lo vuelve a serializar, asi que la columna termina con un STRING
 * JSON. Verificado contra Postgres 17: jsonb_typeof devuelve 'string'. En `auditoria`
 * eso viola el check `auditoria_datos_objeto` y aborta la transaccion completa —
 * ninguna requisicion se podia crear — y en las columnas sin check corrompe el dato
 * en silencio.
 *
 * La forma correcta es asJsonb(sql, obj) (lib/infrastructure/jsonb.ts). Esta prueba
 * escanea el codigo real, asi que falla si alguien reintroduce el patron.
 */
describe("serializacion a columnas jsonb", () => {
  const dir = join(process.cwd(), "lib", "infrastructure");
  // jsonb.ts es el helper: define asJsonb y documenta el antipatron en su comentario,
  // asi que se excluye del escaneo para no auto-delatarse.
  const archivos = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "jsonb.ts");

  it("ningun repositorio usa JSON.stringify hacia una columna jsonb", () => {
    const infractores: string[] = [];
    for (const archivo of archivos) {
      const src = readFileSync(join(dir, archivo), "utf8");
      // Busca JSON.stringify(...) cuyo cierre esté seguido de }::jsonb, balanceando parentesis.
      const marca = "JSON.stringify(";
      for (let inicio = src.indexOf(marca); inicio !== -1; inicio = src.indexOf(marca, inicio + 1)) {
        let i = inicio + marca.length;
        let profundidad = 1;
        while (i < src.length && profundidad > 0) {
          if (src[i] === "(") profundidad++;
          else if (src[i] === ")") profundidad--;
          i++;
        }
        if (src.slice(i, i + 8) === "}::jsonb") {
          const linea = src.slice(0, inicio).split("\n").length;
          infractores.push(`${archivo}:${linea}`);
        }
      }
    }
    expect(infractores, `Usa asJsonb(sql, valor) en vez de JSON.stringify(valor)}::jsonb en: ${infractores.join(", ")}`).toEqual([]);
  });

  it("los repositorios que escriben jsonb importan el helper", () => {
    const conJsonb = archivos.filter((f) => /asJsonb\(/.test(readFileSync(join(dir, f), "utf8")));
    expect(conJsonb.length, "se esperaba que varios repositorios escriban jsonb").toBeGreaterThan(0);
    for (const archivo of conJsonb) {
      const src = readFileSync(join(dir, archivo), "utf8");
      expect(src, `${archivo} usa asJsonb sin importarlo`).toMatch(/import \{ asJsonb \} from "\.\/jsonb"/);
    }
  });
});

/**
 * Guardian de un bug que solo aparece contra Postgres real: un parámetro en `${x} is null` o
 * `${x} is not null` SIN un cast de tipo (`::text`, `::boolean`, `::uuid`, …) no permite a Postgres
 * inferir el tipo del parámetro EN TIEMPO DE PREPARE — independiente del valor en runtime — y dispara
 * `42P18 could not determine data type of parameter`. Rompió la creación de proveedores y la edición
 * de catálogos, y ningún test con mocks lo atrapa. La forma correcta es castear: `${x}::text is null`.
 */
/**
 * Reemplaza comentarios (`//` y `/* *​/`) y literales de string comilla-simple/doble por espacios,
 * preservando saltos de línea y posiciones, para que el escáner solo vea CÓDIGO y plantillas ``…``.
 * Sin esto, el propio comentario que documenta la regla («`${nit} is not null`») se autodelata.
 */
function soloCodigo(src: string): string {
  let out = "";
  type Estado = "code" | "line" | "block" | "tmpl" | "sq" | "dq";
  let estado: Estado = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i], c2 = src[i + 1], nl = c === "\n";
    if (estado === "code") {
      if (c === "/" && c2 === "/") { estado = "line"; out += "  "; i++; continue; }
      if (c === "/" && c2 === "*") { estado = "block"; out += "  "; i++; continue; }
      if (c === "`") estado = "tmpl";
      else if (c === "'") estado = "sq";
      else if (c === '"') estado = "dq";
      out += c;
    } else if (estado === "line") {
      if (nl) { estado = "code"; out += c; } else out += " ";
    } else if (estado === "block") {
      if (c === "*" && c2 === "/") { estado = "code"; out += "  "; i++; } else out += nl ? c : " ";
    } else if (estado === "tmpl") {
      // Dentro de la plantilla conservamos el texto (es el SQL que queremos escanear).
      out += c; if (c === "`") estado = "code";
    } else { // sq | dq: string JS opaco → espacios (pero conserva el delimitador de cierre)
      const cierre = estado === "sq" ? "'" : '"';
      if (c === cierre && src[i - 1] !== "\\") { estado = "code"; out += c; } else out += nl ? c : " ";
    }
  }
  return out;
}

describe("parámetros en is null / is not null llevan cast de tipo", () => {
  const dir = join(process.cwd(), "lib", "infrastructure");
  const archivos = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("ningún `${param} is (not) null` va sin cast en el SQL de los repositorios", () => {
    const infractores: string[] = [];
    // `}` seguido de `is null`/`is not null`: el cierre de una interpolación pelada, sin `::tipo`.
    // El cast válido termina en `::tipo` antes del `is`, así que `${x}::text is null` no matchea.
    const patron = /\}\s+is\s+(?:not\s+)?null\b/gi;
    for (const archivo of archivos) {
      const src = soloCodigo(readFileSync(join(dir, archivo), "utf8"));
      src.split("\n").forEach((linea, i) => {
        if (patron.test(linea)) infractores.push(`${archivo}:${i + 1}`);
        patron.lastIndex = 0;
      });
    }
    expect(infractores, `Usa \${x}::text is null (o ::boolean/::uuid) en: ${infractores.join(", ")}`).toEqual([]);
  });
});
