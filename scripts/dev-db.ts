// Postgres LOCAL de desarrollo, equivalente al servicio `db` de compose.yaml pero sin Docker
// (roto en esta máquina — ver el encabezado de scripts/verify-schema.ts).
//
// Levanta un cluster PERSISTENTE en .dev-postgres/, aplica el mismo bootstrap y las mismas
// migraciones que ops/apply-migrations.sh aplicará en el VPS, y siembra datos. Es la forma de correr
// la plataforma autoalojada de punta a punta en local: la app se conecta por DATABASE_URL igual que
// en producción, sin Supabase de por medio.
//
// Diferencia deliberada con verify-schema.ts: aquel crea y destruye un cluster efímero en cada
// corrida para probar el esquema desde cero; este CONSERVA los datos entre reinicios, que es lo que
// se necesita para trabajar y para demostrar la plataforma.
//
// Uso:
//   npx tsx scripts/dev-db.ts            arranca y se queda escuchando (Ctrl+C para parar)
//   npx tsx scripts/dev-db.ts --reset    borra el cluster y lo recrea desde cero
//   npx tsx scripts/dev-db.ts --no-demo  sin los datos de demostración (solo seed.sql)
import EmbeddedPostgres from "embedded-postgres";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, ".dev-postgres");
export const DEV_PORT = 55432;
export const DEV_DB = "mizar_dev";
export const DEV_URL = `postgresql://postgres:postgres@127.0.0.1:${DEV_PORT}/${DEV_DB}`;

const BOOTSTRAP = path.join(ROOT, "supabase", "bootstrap", "00_compat_autoalojado.sql");
const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const SEED = path.join(ROOT, "supabase", "seed.sql");
const SEED_DEMO = path.join(ROOT, "supabase", "seed-demo.sql");

const reset = process.argv.includes("--reset");
const withDemo = !process.argv.includes("--no-demo");

async function run(client: import("pg").Client, filePath: string): Promise<void> {
  const label = path.relative(ROOT, filePath);
  process.stdout.write(`-> ${label} ... `);
  // Protocolo "simple query" (sin parámetros): admite varias sentencias en un solo texto, que es
  // como está escrito cada archivo de este repo.
  await client.query(readFileSync(filePath, "utf8"));
  console.log("ok");
}

async function main(): Promise<void> {
  const fresh = reset || !existsSync(DATA_DIR);
  if (reset) { console.log("--reset: borrando el cluster anterior"); rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 }); }

  // UTF8 explícito: sin esto, initdb hereda la configuración regional de Windows y crea el cluster en
  // WIN1252, donde cualquier carácter fuera de esa página falla al insertarse. La imagen
  // postgres:18-alpine de compose.yaml es UTF8, así que un local en WIN1252 aceptaría cosas distintas
  // a producción — exactamente la clase de diferencia que se descubre el día del despliegue.
  const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: "postgres", password: "postgres", port: DEV_PORT, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  if (fresh) await pg.initialise();
  await pg.start();
  console.log(`Postgres escuchando en 127.0.0.1:${DEV_PORT}`);

  if (fresh) await pg.createDatabase(DEV_DB);
  const client = pg.getPgClient(DEV_DB);
  await client.connect();
  try {
    // El bootstrap es idempotente por construcción, igual que en ops/apply-migrations.sh.
    await run(client, BOOTSTRAP);
    await client.query(`create table if not exists public.migraciones_aplicadas (nombre text primary key, aplicada_at timestamptz not null default now())`);

    for (const name of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      const applied = await client.query<{ n: string }>(`select nombre as n from public.migraciones_aplicadas where nombre = $1`, [name]);
      if (applied.rowCount) { console.log(`-- ${name} (ya aplicada)`); continue; }
      await run(client, path.join(MIGRATIONS_DIR, name));
      await client.query(`insert into public.migraciones_aplicadas (nombre) values ($1)`, [name]);
    }

    await run(client, SEED);
    if (withDemo && existsSync(SEED_DEMO)) await run(client, SEED_DEMO);
  } finally { await client.end(); }

  console.log(`\nListo. DATABASE_URL=${DEV_URL}`);
  console.log("Ctrl+C para detener.\n");

  // Sin esto el proceso terminaría y se llevaría el servidor por delante.
  const stop = async () => { console.log("\ndeteniendo Postgres..."); await pg.stop().catch(() => {}); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

main().catch((error) => { console.error("\nFalló el arranque de la base de desarrollo:", error); process.exit(1); });
