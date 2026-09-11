import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../lib/domain";
import { PublicAccessAdminService, type PublicAccessAuditEvent, type PublicAccessAdminRepository } from "../../lib/services";
import { PostgresPorts } from "../../lib/infrastructure/postgres-repositories";
import { auditMcpTool } from "../../lib/security/mcp-audit";

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
const TESTS = fileURLToPath(new URL("..", import.meta.url));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Literales de `entityId` dentro de una llamada a `.append({ … })`.
 *
 * DOS CANDADOS, Y HACEN FALTA LOS DOS. Este escáner solo ve lo SINTÁCTICO, y siempre irá por detrás:
 * un `entityId` que llega como argumento posicional, dentro de una variable o desde fuera se le
 * escapa. Un barrido encontró exactamente ese caso — `auditMcpTool(..., "audit-id")` en
 * security.test.ts, invisible para la versión anterior, que solo casaba la propiedad de objeto.
 *
 * Lo que cubre TODOS los caminos es la comprobación en ejecución de `PostgresPorts.append`
 * (lib/infrastructure/postgres-repositories.ts), verificada más abajo. Este escáner existe para dar
 * el aviso ANTES, en revisión, donde es barato; aquel para que no se cuele nada, ni siquiera lo que
 * esta regex no sabe leer.
 */
function literalesDeEntityId(fuente: string): string[] {
  // Solo DENTRO de una llamada a `.append({ … })`. `entityId` no es exclusivo de la auditoría: los
  // adjuntos lo usan también (`AttachmentRow.entityId`, con ids como "req-1"), y esos no van a
  // `auditoria.entidad_id`. Sin acotar por el sitio de llamada, este candado fallaría por el motivo
  // equivocado y acabaría desactivado — que es la peor forma de perder una comprobación.
  return [...fuente.matchAll(/\.append\(\s*\{[^}]*\}/g)]
    .flatMap(([bloque]) => [...bloque.matchAll(/entityId\s*:\s*"([^"]*)"/g)].map(([, valor]) => valor));
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

    // Y NO confunde el `entityId` de los adjuntos, que no va a `auditoria`.
    expect(literalesDeEntityId(`const fila = { entity: "requisicion", entityId: "req-1" };`)).toEqual([]);
  });

  it("reconoce su propio límite: un entityId posicional se le escapa", () => {
    // No es un defecto que se pueda cerrar a base de regex, y fingir lo contrario sería peor que
    // admitirlo: `auditMcpTool(audit, actor, tool, fn, "audit-id")` pasa el id como QUINTO ARGUMENTO,
    // sin la palabra `entityId` por ninguna parte. Así se coló durante meses.
    //
    // Se deja fijado para que quien lea esta prueba sepa que NO basta, y mire la de abajo, que es la
    // que de verdad cierra la puerta.
    expect(literalesDeEntityId(`auditMcpTool(audit, actor, "consultar", fn, "audit-id")`)).toEqual([]);
  });

  it("ningún literal del repositorio deja de serlo", () => {
    const infractores: string[] = [];
    // `tests/` incluido a propósito: ahí vivía `"audit-id"`, un valor que Postgres habría rechazado
    // y que la prueba bendecía como correcto. Una prueba que fija un valor inválido es tan dañina
    // como el código que lo produce — peor, porque además da confianza.
    const esteArchivo = fileURLToPath(import.meta.url);
    for (const archivo of [...archivosTs(LIB), ...archivosTs(APP), ...archivosTs(TESTS)]) {
      // Este archivo queda fuera: sus literales "global"/"audit-id" son ejemplos negativos escritos
      // a propósito para verificar el detector.
      if (archivo === esteArchivo) continue;
      for (const valor of literalesDeEntityId(readFileSync(archivo, "utf8"))) {
        if (!UUID_RE.test(valor)) infractores.push(`${path.relative(path.join(LIB, ".."), archivo)}: "${valor}"`);
      }
    }
    // El mensaje explica el fallo, porque el síntoma (500 tras guardar bien) no apunta aquí ni de lejos.
    expect(infractores, `auditoria.entidad_id es uuid: estos literales harían fallar el insert con 22P02 DESPUÉS de commitear la escritura auditada:\n${infractores.join("\n")}`).toEqual([]);
  });
});

describe("PostgresPorts.append rechaza un entityId que no es uuid, venga de donde venga", () => {
  /** Etiqueta de mentira: si `append` llegara a consultar, lo sabríamos por `consultas`. */
  function puertos() {
    const consultas: string[] = [];
    // `.json` porque el insert serializa `datos_json` con `asJsonb` (lib/infrastructure/jsonb.ts).
    const sql = Object.assign(
      (strings: TemplateStringsArray) => { consultas.push(strings.join("?")); return Promise.resolve([]); },
      { json: (value: unknown) => value },
    );
    return { puertos: new PostgresPorts(sql as never), consultas };
  }

  const evento = (entityId: string) => ({ entity: "mcp", entityId, event: "MCP_TOOL", at: new Date("2026-09-11T12:00:00.000Z"), origin: "mcp" as const });

  it("falla ANTES de tocar la base, con un mensaje que dice dónde mirar", async () => {
    // Es la diferencia que importa: sin esto, Postgres lanza 22P02 "invalid input syntax for type
    // uuid" DESPUÉS de que la escritura auditada ya ocurrió, y ese error no apunta ni de lejos al
    // sitio donde alguien escribió el literal.
    const { puertos: ports, consultas } = puertos();
    await expect(ports.append(evento("audit-id"))).rejects.toThrow(/AUDIT_ENTITY_ID_INVALIDO.*audit-id.*mcp/s);
    expect(consultas, "no debe llegar a insertar").toEqual([]);
  });

  it("deja pasar un uuid bien formado", async () => {
    const { puertos: ports, consultas } = puertos();
    await ports.append(evento("33333333-3333-4333-8333-333333333333"));
    expect(consultas).toHaveLength(1);
    expect(consultas[0]).toMatch(/insert into auditoria/);
  });

  it("cubre el caso que el escáner no ve: el id llega por argumento posicional", async () => {
    // `auditMcpTool` acepta el id como quinto argumento. Ninguna regex sobre `entityId` lo detecta;
    // esta comprobación sí, porque mira el valor y no cómo se escribió.
    const { puertos: ports } = puertos();
    await expect(auditMcpTool(ports, { id: "reader", roles: ["revisor"] }, "consultar_requisiciones", async () => "ok", "audit-id")).rejects.toThrow("AUDIT_ENTITY_ID_INVALIDO");
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
