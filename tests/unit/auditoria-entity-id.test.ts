import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../lib/domain";
import { PublicAccessAdminService, type PublicAccessAuditEvent, type PublicAccessAdminRepository } from "../../lib/services";

// `auditoria.entidad_id` es de tipo `uuid` (202608240001_core_compras.sql) y `AuditRepository.append`
// inserta el valor tal cual. Un literal que no sea uuid no falla al compilar —el tipo es `string`—
// sino en Postgres, con 22P02, y en el peor momento: DESPUÉS de que la escritura que se está
// auditando ya commiteó.
//
// Pasó de verdad. `PublicAccessAdminService.setPassword` auditaba con `entityId: "global"`, así que
// fijar la contraseña del portal guardaba bien y respondía 500 `internal_error`. El administrador
// veía un error cada vez, con la contraseña ya puesta. Y como siempre reventaba, el evento
// `CONTRASENA_ACTUALIZADA` no se escribió nunca.

const LIB = fileURLToPath(new URL("../../lib", import.meta.url));
const APP = fileURLToPath(new URL("../../app", import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `entityId: "..."` — literales, que son los que pueden colarse sin que nadie los mire. */
function literalesDeEntityId(fuente: string): string[] {
  return [...fuente.matchAll(/entityId:\s*"([^"]*)"/g)].map(([, valor]) => valor);
}

function archivosTs(raiz: string): string[] {
  const salida: string[] = [];
  for (const entrada of readdirSync(raiz)) {
    const completa = path.join(raiz, entrada);
    if (statSync(completa).isDirectory()) salida.push(...archivosTs(completa));
    else if (/\.tsx?$/.test(entrada)) salida.push(completa);
  }
  return salida;
}

describe("todo entityId auditado tiene forma de uuid", () => {
  it("el detector reconoce el literal que rompió producción", () => {
    // Autocomprobación: hoy no queda ningún literal en el repositorio, así que sin esto la prueba de
    // abajo pasaría sobre un conjunto vacío y no probaría nada. Aquí se verifica que el escáner
    // encuentra lo que busca, usando el caso real.
    const roto = `await this.deps.audit.append({ entity: "acceso_publico", entityId: "global", event: "x" });`;
    expect(literalesDeEntityId(roto)).toEqual(["global"]);
    expect(UUID_RE.test("global")).toBe(false);

    const bueno = `audit.append({ entity: "acceso_publico", entityId: "00000000-0000-0000-0000-000000000001" });`;
    expect(literalesDeEntityId(bueno).every((valor) => UUID_RE.test(valor))).toBe(true);
  });

  it("ningún literal del repositorio deja de serlo", () => {
    const infractores: string[] = [];
    for (const archivo of [...archivosTs(LIB), ...archivosTs(APP)]) {
      for (const valor of literalesDeEntityId(readFileSync(archivo, "utf8"))) {
        if (!UUID_RE.test(valor)) infractores.push(`${path.relative(path.join(LIB, ".."), archivo)}: "${valor}"`);
      }
    }
    // El mensaje explica el fallo, porque el síntoma (500 tras guardar bien) no apunta aquí ni de lejos.
    expect(infractores, `auditoria.entidad_id es uuid: estos literales harían fallar el insert con 22P02 DESPUÉS de commitear la escritura auditada:\n${infractores.join("\n")}`).toEqual([]);
  });
});

describe("PublicAccessAdminService audita la fila que realmente cambia", () => {
  const admin: Actor = { id: "10000000-0000-4000-8000-000000000006", roles: ["admin_sixteam"] };

  function deps() {
    // El evento se captura en la llamada al REPOSITORIO: desde que contraseña y auditoría se escriben
    // en una transacción, es él quien los recibe juntos, no un puerto de auditoría aparte.
    const audits: PublicAccessAuditEvent[] = [];
    const repository: PublicAccessAdminRepository = {
      getStatus: async () => ({ configured: true, updatedAt: null }),
      setPassword: async (_code, _actorId, audit) => { audits.push(audit); },
    };
    return { service: new PublicAccessAdminService({ repository, clock: { now: () => new Date("2026-09-11T12:00:00.000Z") } }), audits };
  }

  it("usa el id de la fila singleton, no una etiqueta", async () => {
    const { service, audits } = deps();
    await service.setPassword(admin, "contraseña-larga");
    expect(audits).toHaveLength(1);
    // El id lo fija un CHECK de la migración: la tabla no puede tener otra fila.
    expect(audits[0].entityId).toBe("00000000-0000-0000-0000-000000000001");
    expect(UUID_RE.test(audits[0].entityId)).toBe(true);
    expect(audits[0]).toMatchObject({ entity: "acceso_publico", event: "contrasena_actualizada" });
  });
});
