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
