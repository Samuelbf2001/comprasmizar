export function normalizeItemName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
/**
 * RF-606: MISMO criterio que las columnas generadas `nit_normalizado`/`identificacion_normalizada`
 * (202608240001/202609150002) \u2014 solo se quitan puntos, guiones y espacios; las letras conservan su
 * caja. "900.123.456-7" y "9001234567" son la misma identificaci\u00f3n; "" (nada que comparar) queda "".
 */
export function normalizeIdentification(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "");
}
