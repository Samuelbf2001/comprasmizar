import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

// docs/modelo-datos.md enlaza a los archivos de migración por nombre exacto; un
// nombre en plural/singular equivocado deja el enlace roto sin que build/lint lo note.
const docPath = resolve(__dirname, "../../docs/modelo-datos.md");
const docDir = dirname(docPath);
const doc = readFileSync(docPath, "utf8");

describe("docs/modelo-datos.md enlaza archivos que existen", () => {
  it("resuelve cada enlace relativo a supabase/migrations", () => {
    const enlaces = [...doc.matchAll(/\]\((\.\.\/supabase\/migrations\/[^)]+)\)/g)].map((m) => m[1]);
    expect(enlaces.length).toBeGreaterThanOrEqual(3);
    for (const enlace of enlaces) {
      expect(existsSync(resolve(docDir, enlace)), `enlace roto: ${enlace}`).toBe(true);
    }
  });
});
