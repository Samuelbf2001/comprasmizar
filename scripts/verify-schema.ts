// Arnés de esquema contra Postgres REAL (embedded-postgres, Postgres 18.4, sin Docker — roto en esta
// máquina — y sin proyecto Supabase). Levanta un cluster efímero, aplica el prelude que stubea lo que
// Supabase da por hecho (supabase/tests/embedded_postgres_prelude.sql), las migraciones de
// supabase/migrations/ EN ORDEN (con el mecanismo legado descrito abajo intercalado), supabase/seed.sql,
// y los arneses SQL de supabase/tests/*.sql. Sale con código != 0 si algo falla, para poder engancharse
// a CI.
//
// Por qué existe: dos bloqueantes "solo-DB-real" (traducción de error de FK con código equivocado,
// e IVA legacy) pasaron los 342 tests unitarios con mocks y solo se vieron corriendo la migración
// contra un motor real (ver AGENTS.md/informe de la reunión 2026-08-31, y el commit be06b83, que ya
// pagó esta misma clase de bug una vez). Este arnés es la red que evita que vuelvan a colarse.
//
// MECANISMO LEGADO (2026-09-07, QA Postgres real): lo anterior corre las migraciones sobre una base
// VACÍA — un backfill no-op y uno correcto son indistinguibles ahí, porque no hay ninguna fila previa
// que backfillear. `supabase/tests/legacy/` cierra ese hueco de forma genérica: para cada migración
// `supabase/migrations/<nombre>.sql`,
//   - si existe `supabase/tests/legacy/<nombre>.pre.sql`, se ejecuta JUSTO ANTES de esa migración —
//     siembra filas como las que ya existirían en una base de producción (SIN `rollback`: esas filas
//     deben sobrevivir para que la migración bajo prueba, y su .post, las encuentren);
//   - si existe `supabase/tests/legacy/<nombre>.post.sql`, se ejecuta JUSTO DESPUÉS de esa misma
//     migración — asserta el resultado del backfill sobre esas filas legado, con el mismo formato
//     `do $$ ... raise exception ... $$` que el resto de arneses de este repo (el .post SÍ puede
//     limpiar lo que sembró el .pre si hace falta que el seed.sql posterior no choque; no es
//     obligatorio si los IDs usados no colisionan con supabase/seed.sql).
// Ninguno de los dos es obligatorio por migración: la mayoría no toca datos existentes y no necesita
// par legado. Ver docs/modelo-datos.md para el mismo mecanismo explicado del lado de documentación.
//
// Uso: npm run verify:schema  (equivalente a `npx tsx scripts/verify-schema.ts`).
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, ".embedded-postgres-verify");
const PORT = 55987; // puerto alto, poco probable que choque con un Postgres local de verdad.
const DB_NAME = "mizar_verify";

// El mismo bootstrap que se aplica al Postgres autoalojado en producción (ver
// docs/migracion-autoalojado.md). Deliberadamente NO es una copia: CI debe arrancar desde el mismo
// punto de partida que el servidor real, o dejaría de probar lo que se despliega.
const PRELUDE = path.join(ROOT, "supabase", "bootstrap", "00_compat_autoalojado.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const LEGACY_DIR = path.join(ROOT, "supabase", "tests", "legacy");
const SEED = path.join(ROOT, "supabase", "seed.sql");
// El seed de DEMOSTRACIÓN, que hasta ahora no verificaba nadie: verify-schema solo cargaba seed.sql,
// así que el archivo que se usa para enseñar el producto —y el que se carga en el servidor— no
// pasaba por ningún arnés. Ahí sobrevivió el defecto de las órdenes sin orden_items: la ficha
// lateral decía "0 ítems de esta orden" y solo se veía mirando la pantalla.
// Se carga DESPUÉS de los arneses de arriba, no antes: esos afirman sobre lo que deja seed.sql, y
// sembrarles encima requisiciones, órdenes y gastos de demostración cambiaría lo que cuentan.
const SEED_DEMO = path.join(ROOT, "supabase", "seed-demo.sql");
// Arneses que EXIGEN el seed de demostración cargado (órdenes reales sobre las que afirmar).
const DEMO_HARNESSES = [path.join(ROOT, "supabase", "tests", "orden_items_verification.sql")];
const HARNESSES = [
  path.join(ROOT, "supabase", "tests", "schema_verification.sql"),
  path.join(ROOT, "supabase", "tests", "generic_attachments_verification.sql"),
  path.join(ROOT, "supabase", "tests", "supplier_documents_verification.sql"),
  // Decisiones del 2026-09-07: cada una trae su propio arnés en vez de crecer schema_verification,
  // para que varios cambios de esquema puedan verificarse en paralelo sin pisarse el archivo.
  path.join(ROOT, "supabase", "tests", "aprobador_elegido_verification.sql"),
  path.join(ROOT, "supabase", "tests", "acceso_publico_verification.sql"),
  path.join(ROOT, "supabase", "tests", "gasto_fecha_pago_verification.sql"),
  // Migración a autoalojado (2026-09-10): sesiones propias en reemplazo del JWT de Supabase.
  path.join(ROOT, "supabase", "tests", "sesiones_verification.sql"),
  // Fase 3 del plan de rendimiento (2026-09-10, hallazgo H3): índices para las consultas paginadas y
  // los agregados del dashboard.
  path.join(ROOT, "supabase", "tests", "indices_rendimiento_verification.sql"),
  // Alta de usuarios desde la plataforma (2026-09-11): unicidad del correo y el camino completo del alta.
  path.join(ROOT, "supabase", "tests", "alta_usuarios_verification.sql"),
  // Cola de notificaciones (2026-09-11): que se pueda ACTUALIZAR, y que ninguna tabla lleve el
  // disparador set_updated_at sin la columna que ese disparador escribe.
  path.join(ROOT, "supabase", "tests", "notificaciones_cola_verification.sql"),
  // Acuses de entrega (2026-09-11): el avance monotónico del estado. No se puede probar en unidad
  // —vive en el `where` de la consulta— y protege contra el desorden de entrega que Kapso anuncia.
  path.join(ROOT, "supabase", "tests", "estado_entrega_verification.sql"),
  path.join(ROOT, "supabase", "tests", "aprobador_por_item_verification.sql"),
  path.join(ROOT, "supabase", "tests", "adjuntos_aprobador_verification.sql"),
  // Pagos parciales de orden (2026-09-12): el trigger que impide que la suma de pagos supere el
  // total del gasto de la orden, y la RLS de lectura/escritura — ninguno de los dos vive en TypeScript.
  path.join(ROOT, "supabase", "tests", "pagos_orden_verification.sql"),
  // Centros de costo (2026-09-12, decisión del dueño): catálogo nuevo + herencia obra->requisición y
  // copia (no derivación) en gasto.
  path.join(ROOT, "supabase", "tests", "centros_costo_verification.sql"),
  // Cajas, ingresos y cierres mensuales (2026-09-12, reunión con el cliente): catálogo de cajas,
  // ingresos como tabla aparte (nunca un gasto negativo), el trigger que bloquea movimientos de un
  // periodo ya cerrado, y el cruce ingresos/gastos por centro de costo.
  path.join(ROOT, "supabase", "tests", "cajas_ingresos_cierres_verification.sql"),
];

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort() // los nombres son timestamp-prefijados (YYYYMMDDHHMM...): el orden alfabético YA es el orden cronológico.
    .map((name) => path.join(MIGRATIONS_DIR, name));
}

/** `<nombre>.pre.sql`/`<nombre>.post.sql` en supabase/tests/legacy/ para la migración dada, si existen. */
function legacyPairFor(migrationPath: string): { pre: string | null; post: string | null } {
  const base = path.basename(migrationPath, ".sql");
  const pre = path.join(LEGACY_DIR, `${base}.pre.sql`);
  const post = path.join(LEGACY_DIR, `${base}.post.sql`);
  return { pre: existsSync(pre) ? pre : null, post: existsSync(post) ? post : null };
}

async function runFile(client: import("pg").Client, filePath: string): Promise<void> {
  const sql = readFileSync(filePath, "utf8");
  const label = path.relative(ROOT, filePath);
  process.stdout.write(`-> ${label} ... `);
  try {
    // Sin parámetros: node-postgres usa el protocolo "simple query", que SÍ admite múltiples
    // sentencias separadas por ";" en un solo texto — necesario porque cada archivo de este repo es
    // un script largo, no una sentencia aislada.
    await client.query(sql);
    console.log("ok");
  } catch (error) {
    console.log("FALLÓ");
    throw error instanceof Error ? new Error(`${label}: ${error.message}`, { cause: error }) : error;
  }
}

async function main(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: "postgres", password: "postgres", port: PORT, persistent: false });
  await pg.initialise();
  await pg.start();
  let ok = false;
  try {
    // La base de pruebas se crea explícitamente en UTF8, no con pg.createDatabase(), que hereda la
    // codificación del clúster. En Windows con configuración regional española initdb la deja en
    // WIN1252, y entonces el arnés NO verifica lo mismo que producción: cualquier carácter fuera de
    // WIN1252 revienta aquí y pasa en CI (Linux, UTF8) y en el servidor. Lo descubrió el seed de
    // demostración al entrar al arnés — sus separadores de sección usan U+2500 ("──") y el servidor
    // los rechazó con "has no equivalent in encoding WIN1252".
    // template0 + LC_COLLATE/LC_CTYPE "C" es lo que permite cambiar de codificación sobre un clúster
    // que nació en otra: template1 impone la del clúster.
    const crearBase = async (nombre: string) => {
      const bootstrapClient = pg.getPgClient("postgres");
      await bootstrapClient.connect();
      try {
        await bootstrapClient.query(`create database "${nombre}" with encoding 'UTF8' lc_collate 'C' lc_ctype 'C' template template0`);
      } finally {
        await bootstrapClient.end();
      }
      const client = pg.getPgClient(nombre);
      await client.connect();
      return client;
    };

    await crearBase(DB_NAME).then(async (client) => {
      try {
        await runFile(client, PRELUDE);
        for (const migration of migrationFiles()) {
          const { pre, post } = legacyPairFor(migration);
          if (pre) await runFile(client, pre);
          await runFile(client, migration);
          if (post) await runFile(client, post);
        }
        await runFile(client, SEED);
        for (const harness of HARNESSES) await runFile(client, harness);
      } finally {
        await client.end();
      }
    });

    // El seed de demostración va en su PROPIA base, y sin los fixtures legados. No es manía de
    // aislamiento: `seed-demo.sql` empieza con un guardián —"ya hay requisiciones, no se siembra de
    // nuevo"— que existe para que nadie mezcle datos inventados con datos reales en producción. Los
    // fixtures legados dejan requisiciones a propósito (simulan la base vieja para probar los
    // backfills), así que en la base de arriba ese guardián se dispara y el seed de demostración se
    // salta ENTERO, en silencio. Verificarlo ahí sería verificar que no se cargó nada.
    // Las migraciones se repiten en esta segunda base; son segundos y evitan tener que borrar los
    // fixtures legados a mano, que es justo lo que no debe hacer un arnés.
    await crearBase(`${DB_NAME}_demo`).then(async (client) => {
      try {
        await runFile(client, PRELUDE);
        for (const migration of migrationFiles()) await runFile(client, migration);
        await runFile(client, SEED);
        await runFile(client, SEED_DEMO);
        for (const harness of DEMO_HARNESSES) await runFile(client, harness);
      } finally {
        await client.end();
      }
    });
    ok = true;
  } finally {
    await pg.stop().catch((error: unknown) => {
      // El cleanup interno de embedded-postgres a veces choca con locks de archivo de Windows
      // (EBUSY) DESPUÉS de que el resultado ya quedó decidido arriba; no debe enmascarar un éxito
      // real ni cambiar el código de salida.
      console.warn("Aviso: fallo no crítico al detener el cluster embebido:", error);
    });
    // Igual que arriba: en Windows el proceso de postgres a veces tarda un instante en soltar sus
    // manejadores de archivo después de detenerse, y borrar el directorio de datos justo después
    // puede fallar con EBUSY/EPERM. Es limpieza de un directorio TEMPORAL (.embedded-postgres-verify,
    // recreado desde cero en cada corrida) — nunca debe convertir una corrida EXITOSA en un fallo.
    try { rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); }
    catch (error) { console.warn("Aviso: no se pudo borrar el directorio temporal (se recreará en la próxima corrida):", error); }
  }
  if (!ok) throw new Error("El arnés de esquema no completó todos los pasos");
}

main().then(
  () => {
    const legacyPairs = migrationFiles().filter((m) => { const { pre, post } = legacyPairFor(m); return pre ?? post; }).length;
    console.log(`\nTodo verde: prelude + ${migrationFiles().length} migraciones (${legacyPairs} con .pre/.post de datos legado) + seed + seed-demo + ${HARNESSES.length + DEMO_HARNESSES.length} arneses SQL pasaron contra Postgres real.`);
    process.exit(0);
  },
  (error) => { console.error("\nArnés de esquema FALLÓ:", error); process.exit(1); },
);
