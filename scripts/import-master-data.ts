/**
 * Importador controlado de maestros. Por defecto SOLO analiza y escribe un reporte
 * sin valores de negocio/PII. Use --apply únicamente contra el proyecto objetivo.
 * Ejemplo: npx tsx scripts/import-master-data.ts --entity items --file ./items.xlsx --apply
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import ExcelJS from "exceljs";
import postgres from "postgres";

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
  // Migración a autoalojado (2026-09-10): antes esto entraba por PostgREST con el service role de
  // Supabase. Ahora escribe por SQL directo con DATABASE_URL, igual que el resto de la plataforma.
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("--apply requiere DATABASE_URL en el entorno; no se imprimen secretos.");
  const sql = postgres(databaseUrl, { max: 1 });

  try {
    // Una sola transacción por corrida: una importación a medias es peor que ninguna, porque deja
    // el catálogo en un estado que nadie revisó.
    return await sql.begin(async (tx) => {
      if (entity === "items") {
        const payload = valid.map((row) => ({ ...row, estado: "activo" }));
        // nombre_normalizado es una columna generada: el conflicto se resuelve sobre ella, no sobre
        // el nombre crudo, para que "Cemento" y "cemento " sean el mismo ítem.
        for (const row of payload) {
          await tx`insert into items ${tx(row)} on conflict (nombre_normalizado) do update set estado = excluded.estado`;
        }
        return payload.length;
      }
      if (entity === "proveedores") {
        const payload = valid.map((row) => ({
          razon_social: row.razon_social,
          nit: row.nit || null,
          contacto: tx.json({ nombre: row.contacto_nombre || undefined, telefono: row.contacto_telefono || undefined }),
          datos_bancarios: tx.json({}),
          activo: true,
        }));
        for (const row of payload) {
          await tx`insert into proveedores ${tx(row)} on conflict (nit_normalizado) do update set razon_social = excluded.razon_social, contacto = excluded.contacto`;
        }
        return payload.length;
      }
      throw new Error(`La aplicación de obras requiere una RPC transaccional aprobada (filas válidas: ${valid.length}).`);
    });
  } finally { await sql.end(); }
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
