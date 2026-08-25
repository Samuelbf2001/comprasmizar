import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { describe, expect, it } from "vitest";

// El runbook describe de memoria el cron y los secretos del workflow de respaldo.
// Esta prueba los ata al archivo real: si alguien cambia el cron o el nombre de un
// secreto en backup.yml sin tocar el runbook, la documentación queda mintiendo.
const root = resolve(__dirname, "../..");
const workflowPath = resolve(root, ".github/workflows/backup.yml");
const docPath = resolve(root, "docs/runbook-operacion.md");
const workflow = readFileSync(workflowPath, "utf8");
const runbook = readFileSync(docPath, "utf8");

describe("docs/runbook-operacion.md coincide con .github/workflows/backup.yml", () => {
  it("enlaza un workflow que existe", () => {
    const enlaces = [...runbook.matchAll(/\]\((\.\.\/\.github\/workflows\/[^)]+)\)/g)].map((m) => m[1]);
    expect(enlaces.length).toBeGreaterThanOrEqual(1);
    for (const enlace of enlaces) {
      expect(existsSync(resolve(dirname(docPath), enlace)), `enlace roto: ${enlace}`).toBe(true);
    }
  });

  it("documenta el cron real del workflow", () => {
    const [, cron] = workflow.match(/cron:\s*"([^"]+)"/) ?? [];
    expect(cron, "backup.yml no declara un cron entre comillas").toBeTruthy();
    expect(runbook).toContain(cron as string);
  });

  it("documenta los secretos de Actions que el workflow exige", () => {
    const secretos = [...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(secretos)).toEqual(new Set(["DATABASE_URL", "BACKUP_ENCRYPTION_PASSPHRASE"]));
    for (const secreto of secretos) {
      expect(runbook, `falta mencionar el secreto ${secreto}`).toContain(secreto);
    }
  });
});
