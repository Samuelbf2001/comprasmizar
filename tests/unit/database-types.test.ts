import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// lib/database.types.ts se mantiene a mano (no hay Supabase CLI en este entorno).
// Esta prueba lo compara contra las migraciones reales para detectar el drift que
// el compilador no puede ver: una tabla o vista nueva que nadie declaró en el tipo.
const root = resolve(__dirname, "../..");
const migrationsDir = resolve(root, "supabase/migrations");
const typesSource = readFileSync(resolve(root, "lib/database.types.ts"), "utf8");
const migrationsSql = readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .map((file) => readFileSync(resolve(migrationsDir, file), "utf8"))
  .join("\n");

function namesDeclaradosEnBloque(source: string, inicio: string, fin: string) {
  const start = source.indexOf(inicio);
  const end = source.indexOf(fin, start);
  return source.slice(start + inicio.length, end === -1 ? undefined : end);
}

describe("lib/database.types.ts refleja el esquema de supabase/migrations", () => {
  it("declara cada tabla creada por las migraciones aplicadas", () => {
    const tablas = [...migrationsSql.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
    expect(tablas.length).toBeGreaterThanOrEqual(26);
    const bloqueTablas = namesDeclaradosEnBloque(typesSource, "Tables: {", "Views:");
    for (const tabla of tablas) {
      expect(bloqueTablas, `falta "${tabla}" en Database["public"]["Tables"]`).toMatch(new RegExp(`\\b${tabla}:\\s*\\{`));
    }
  });

  it("declara cada vista creada por las migraciones aplicadas", () => {
    const vistas = [...migrationsSql.matchAll(/create (?:or replace )?view public\.(\w+)/g)].map((m) => m[1]);
    expect(vistas.length).toBeGreaterThanOrEqual(2);
    const bloqueVistas = namesDeclaradosEnBloque(typesSource, "Views: {", "Functions:");
    for (const vista of vistas) {
      expect(bloqueVistas, `falta "${vista}" en Database["public"]["Views"]`).toMatch(new RegExp(`\\b${vista}:\\s*\\{`));
    }
  });
});
