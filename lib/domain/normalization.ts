export function normalizeItemName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-CO").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
