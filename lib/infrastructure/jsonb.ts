import type { Sql } from "postgres";

/**
 * Serializa un objeto hacia una columna jsonb.
 *
 * Por que existe este helper: `${JSON.stringify(x)}::jsonb` NO guarda un objeto.
 * postgres.js recibe el string ya serializado y lo vuelve a serializar, asi que la
 * columna termina con un STRING JSON ("{\"a\":1}") en vez de un objeto. Verificado
 * contra Postgres 17: jsonb_typeof devuelve 'string'. En `auditoria` eso viola el
 * check `auditoria_datos_objeto` y hace fallar toda la transaccion — es decir,
 * ninguna requisicion se podia crear — y en las columnas sin check (contacto,
 * datos_bancarios, payload) corrompe el dato en silencio.
 *
 * El cast es deliberado y acotado: nuestros objetos de dominio son datos planos
 * serializables, pero no declaran la index signature que exige el tipo JSONValue
 * de la libreria. Centralizarlo aqui evita repetir el cast en cada repositorio.
 */
/** Acepta tanto la conexion normal (`Sql`) como la de una transaccion (`TransactionSql`). */
type SerializadorJson = { json: Sql["json"] };

export function asJsonb(sql: SerializadorJson, value: unknown) {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}
