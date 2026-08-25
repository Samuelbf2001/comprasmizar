/**
 * Importador controlado de maestros. Por defecto SOLO analiza y escribe un reporte
 * sin valores de negocio/PII. Use --apply únicamente contra el proyecto objetivo.
 * Ejemplo: npx tsx scripts/import-master-data.ts --entity items --file ./items.xlsx --apply
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import ExcelJS from "exceljs";
import { createClient } from "@supabase/supabase-js";

type Entity = "items" | "proveedores" | "obras";
type SourceRow = { row: number; values: Record<string, string> };
type Issue = { row: number; code: string };
type ImportReport = {
  version: 1;
  entity: Entity;
  source: string;
  mode: "dry-run" | "apply";
  read: number;
  valid: number;
  duplicates: Issue[];
  errors: Issue[];
  applied: number;
};

function args(): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (!token.startsWith("--")) continue;
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(token.slice(2), next);
      index += 1;
    } else values.set(token.slice(2), true);
  }
  return values;
}

function normalized(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-CO")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function clean(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"' && quoted) {
      cell += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else cell += char;
  }
  cells.push(cell);
  return cells;
}

function asRows(matrix: string[][]): SourceRow[] {
  const [header = [], ...records] = matrix;
  const keys = header.map((value) => normalized(value));
  return records
    .map((record, index) => ({
      row: index + 2,
      values: Object.fromEntries(keys.map((key, column) => [key, clean(record[column])])),
    }))
    .filter((record) => Object.values(record.values).some(Boolean));
}

async function readSource(file: string, sheet?: string): Promise<SourceRow[]> {
  const extension = extname(file).toLowerCase();
  if (extension === ".csv") {
    const text = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
    return asRows(text.split(/\r?\n/).filter(Boolean).map(parseCsvLine));
  }
  if (extension !== ".xlsx") throw new Error("Formato no soportado. Use .xlsx o .csv.");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const worksheet = sheet ? workbook.getWorksheet(sheet) : workbook.worksheets[0];
  if (!worksheet) throw new Error("No se encontró la hoja indicada.");
  const matrix: string[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = Array.isArray(row.values) ? row.values.slice(1) : [];
    matrix.push(cells.map(clean));
  });
  return asRows(matrix);
}

function value(row: SourceRow, ...aliases: string[]): string {
  for (const alias of aliases) {
    const found = row.values[normalized(alias)];
    if (found) return found;
  }
  return "";
}

function validate(entity: Entity, source: SourceRow[]) {
  const errors: Issue[] = [];
  const duplicates: Issue[] = [];
  const seen = new Set<string>();
  const valid: Array<Record<string, string>> = [];

  for (const row of source) {
    if (entity === "items") {
      const nombre = value(row, "nombre", "item", "descripcion", "descripción");
      const unidad = value(row, "unidad", "unidad defecto", "unidad_defecto");
      if (!nombre || !unidad) {
        errors.push({ row: row.row, code: "ITEM_REQUIRED_NOMBRE_UNIDAD" });
        continue;
      }
      const key = normalized(nombre);
      if (seen.has(key)) {
        duplicates.push({ row: row.row, code: "DUPLICATE_ITEM_NORMALIZED" });
        continue;
      }
      seen.add(key);
      valid.push({ nombre, nombre_normalizado: key, unidad_defecto: unidad, especificacion: value(row, "especificacion", "especificación"), categoria: value(row, "categoria", "categoría") });
    } else if (entity === "proveedores") {
      const razon_social = value(row, "razon social", "razón social", "proveedor", "nombre");
      const nit = value(row, "nit", "n i t");
      if (!razon_social) {
        errors.push({ row: row.row, code: "SUPPLIER_REQUIRED_RAZON_SOCIAL" });
        continue;
      }
      const key = normalized(nit || razon_social);
      if (seen.has(key)) {
        duplicates.push({ row: row.row, code: "DUPLICATE_SUPPLIER_NIT_OR_NAME" });
        continue;
      }
      seen.add(key);
      valid.push({ razon_social, nit, contacto_nombre: value(row, "contacto", "nombre contacto"), contacto_telefono: value(row, "telefono", "teléfono") });
    } else {
      const nombre = value(row, "obra", "nombre", "nombre obra");
      const sociedad = value(row, "sociedad", "empresa", "razon social sociedad", "razón social sociedad");
      if (!nombre || !sociedad) {
        errors.push({ row: row.row, code: "WORK_REQUIRED_NOMBRE_SOCIEDAD" });
        continue;
      }
      const key = `${normalized(sociedad)}:${normalized(nombre)}`;
      if (seen.has(key)) {
        duplicates.push({ row: row.row, code: "DUPLICATE_WORK_AND_SOCIETY" });
        continue;
      }
      seen.add(key);
      valid.push({ nombre, sociedad });
    }
  }
  return { valid, errors, duplicates };
}

async function apply(entity: Entity, valid: Array<Record<string, string>>): Promise<number> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("--apply requiere NEXT_PUBLIC_SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno; no se imprimen secretos.");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  if (entity === "items") {
    const payload = valid.map((row) => ({ ...row, estado: "activo" }));
    const { error } = await supabase.from("items").upsert(payload, { onConflict: "nombre_normalizado" });
    if (error) throw new Error(`Error de BD al importar items: ${error.code ?? "unknown"}`);
    return payload.length;
  }
  if (entity === "proveedores") {
    const payload = valid.map((row) => ({
      razon_social: row.razon_social,
      nit: row.nit || null,
      contacto: { nombre: row.contacto_nombre || undefined, telefono: row.contacto_telefono || undefined },
      datos_bancarios: {},
      activo: true,
    }));
    const { error } = await supabase.from("proveedores").upsert(payload, { onConflict: "nit_normalizado" });
    if (error) throw new Error(`Error de BD al importar proveedores: ${error.code ?? "unknown"}`);
    return payload.length;
  }
  // Inalcanzable: main bloquea obras antes de entrar aquí. Se mantiene como defensa por si cambia el flujo.
  throw new Error(`La aplicación de obras requiere una RPC transaccional aprobada (filas válidas: ${valid.length}).`);
}

async function main(): Promise<void> {
  const options = args();
  const entity = options.get("entity");
  const file = options.get("file");
  if (entity !== "items" && entity !== "proveedores" && entity !== "obras") throw new Error("Use --entity items|proveedores|obras.");
  if (typeof file !== "string") throw new Error("Use --file ruta/al/archivo.xlsx|csv.");
  const sourcePath = resolve(file);
  const source = await readSource(sourcePath, typeof options.get("sheet") === "string" ? String(options.get("sheet")) : undefined);
  const checked = validate(entity, source);
  const shouldApply = options.get("apply") === true;
  const blockedWorksApply = shouldApply && entity === "obras";
  const errors = blockedWorksApply
    ? [...checked.errors, { row: 0, code: "WORK_APPLY_REQUIRES_TRANSACTIONAL_RPC" }]
    : checked.errors;
  const canApply = shouldApply && !blockedWorksApply && errors.length === 0;
  const applied = canApply ? await apply(entity, checked.valid) : 0;
  const report: ImportReport = {
    version: 1,
    entity,
    source: basename(sourcePath),
    mode: canApply ? "apply" : "dry-run",
    read: source.length,
    valid: checked.valid.length,
    duplicates: checked.duplicates,
    errors,
    applied,
  };
  const reportPath = resolve(typeof options.get("report") === "string" ? String(options.get("report")) : "import-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ entity, mode: report.mode, read: report.read, valid: report.valid, duplicates: report.duplicates.length, errors: report.errors.length, applied, report: basename(reportPath) })}\n`);
  if (errors.length > 0) process.exitCode = 2;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fallo desconocido del importador"}\n`);
  process.exitCode = 1;
});
