import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

// El runbook describe de memoria el cron y los secretos del respaldo. Esta prueba los ata a los
// archivos reales: si alguien cambia el guion o el nombre de una variable sin tocar el runbook, la
// documentación queda mintiendo — y en un procedimiento de recuperación, documentación que miente es
// peor que no tener ninguna.
//
// Migración a autoalojado (2026-09-10): antes esto ataba el runbook a
// .github/workflows/backup.yml. Ese workflow se retiró porque hacía `pg_dump` contra la base por
// internet, y la base autoalojada ya no expone puerto público a propósito. Ahora el respaldo lo hace
// un cron en el VPS (ops/backup-daily.sh) que sube a Google Drive, y la prueba vigila ESE guion.
const root = resolve(__dirname, "../..");
const docPath = resolve(root, "docs/runbook-operacion.md");
const backupScriptPath = resolve(root, "ops/backup-daily.sh");
const runbook = readFileSync(docPath, "utf8");
const backupScript = readFileSync(backupScriptPath, "utf8");

describe("docs/runbook-operacion.md coincide con ops/backup-daily.sh", () => {
  it("enlaza guiones de ops que existen", () => {
    const enlaces = [...runbook.matchAll(/\]\((\.\.\/ops\/[^)]+)\)/g)].map((m) => m[1]);
    expect(enlaces.length).toBeGreaterThanOrEqual(1);
    for (const enlace of enlaces) {
      expect(existsSync(resolve(dirname(docPath), enlace)), `enlace roto: ${enlace}`).toBe(true);
    }
  });

  it("documenta las variables que el guion exige de forma obligatoria", () => {
    const [, block] = backupScript.match(/for variable in ([A-Z0-9_ ]+); do/) ?? [];
    expect(block, "backup-daily.sh no declara su lista de variables obligatorias").toBeTruthy();
    for (const variable of (block as string).trim().split(/\s+/)) {
      expect(runbook, `falta mencionar la variable ${variable}`).toContain(variable);
    }
  });

  it("documenta el ensayo de restauración como paso obligatorio", () => {
    // No se comprueba una frase exacta (invitaría a satisfacerla sin decir nada), sino que el
    // runbook siga nombrando el guion del ensayo y su periodicidad.
    expect(runbook).toContain("ops/restore-verify.sh");
    expect(runbook.toLowerCase()).toContain("trimestral");
  });
});
