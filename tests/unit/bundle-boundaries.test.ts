// Fase 2 (rendimiento, docs/plan-rendimiento.md, hallazgo H4): guarda estática de los límites
// de bundle que motivaron partir components/screens/connected.tsx. No renderiza nada: lee el
// código fuente de los módulos que deben quedarse "ligeros" y falla si alguno vuelve a
// importar de forma ESTÁTICA `recharts` o cualquiera de las pantallas pesadas. Una importación
// dinámica (`dynamic(() => import(...))` o `import(...)` a secas) no cuenta como estática: es
// justo el mecanismo que separa cada pantalla en su propio chunk.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

// Módulos de pantalla / recharts que NUNCA deben aparecer en un `import ... from "..."`
// estático dentro de los archivos vigilados. Los nombres son los especificadores tal como
// se escriben en el código (relativos al archivo que importa), por eso se repiten variantes
// como "./catalog-admin" y "../catalog-admin": cada archivo vigilado los referenciaría con
// una profundidad distinta si volviera a importarlos por error.
const FORBIDDEN_SPECIFIERS = [
  "recharts",
  "./catalog-admin",
  "../catalog-admin",
  "./suppliers",
  "../suppliers",
  "./demo-screens",
  "../demo-screens",
  "./workflow",
  "../workflow",
  "./operations",
  "../operations",
  "./reports-admin",
  "../reports-admin",
  "./dashboard",
  "../dashboard",
  "./detail",
  "../detail",
  "./orders",
  "../orders",
  "./expenses",
  "../expenses",
  "./requisitions",
  "../requisitions",
  "./new-requisition",
  "../new-requisition",
  "./dashboard-charts",
  "../dashboard-charts",
];

const WATCHED_FILES = [
  "components/mizar-app.tsx",
  "components/screens/connected/screen.tsx",
  "components/screens/connected/data.ts",
  "components/screens/connected/shared.tsx",
  "components/layout/app-shell.tsx",
];

// Solo cuentan las líneas de import ESTÁTICO (`import ... from "x"` / `import "x"`, incluidas
// las de solo-tipos `import type ...`). Una llamada a `dynamic(() => import("x"))` o a
// `import("x")` suelta no las genera esta expresión regular porque exige que la línea empiece
// (tras espacios) con la palabra clave `import` seguida de algo distinto de "(" antes del
// `from`/la cadena — es decir, la forma declarativa de ES modules, no la función `import()`.
const STATIC_IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[\s\S]*?)\s*from\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm;

function staticImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(STATIC_IMPORT_RE)) {
    const specifier = match[1] ?? match[2];
    if (specifier) specifiers.push(specifier);
  }
  return specifiers;
}

describe("límites de bundle (H4, docs/plan-rendimiento.md)", () => {
  for (const relativePath of WATCHED_FILES) {
    it(`${relativePath} no importa recharts ni pantallas pesadas de forma estática`, () => {
      const filePath = path.join(ROOT, relativePath);
      const source = fs.readFileSync(filePath, "utf-8");
      const specifiers = staticImportSpecifiers(source);
      const offenders = specifiers.filter((specifier) =>
        FORBIDDEN_SPECIFIERS.includes(specifier),
      );
      expect(offenders).toEqual([]);
    });
  }
});
