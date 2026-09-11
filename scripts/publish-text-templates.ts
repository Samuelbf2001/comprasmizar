/**
 * Crea (o reporta) las cuatro plantillas de texto que la plataforma envía por nombre:
 * `requisicion_recibida`, `requisicion_aprobada`, `requisicion_declinada` y `pendiente_aprobador`.
 *
 * Hermano de `publish-approval-template.ts` y por la misma razón: la definición vive versionada en
 * el repo (lib/infrastructure/plantillas-whatsapp.ts), así que se puede reproducir en otra WABA,
 * revisar en un diff y corregir sin adivinar qué se configuró por pantalla. La diferencia es que
 * aquella lleva un botón de Flow y parámetros POSICIONALES, y estas cuatro son texto puro con
 * parámetros CON NOMBRE, porque es la forma que realmente viaja por la API de Kapso (el porqué está
 * explicado en el módulo de definiciones).
 *
 * Uso:
 *   npx tsx --env-file=.env.local scripts/publish-text-templates.ts --dry-run   # imprime el JSON
 *   npx tsx --env-file=.env.local scripts/publish-text-templates.ts --status    # consulta el estado
 *   npx tsx --env-file=.env.local scripts/publish-text-templates.ts --crear     # crea y manda a revision
 *
 * Variables requeridas: KAPSO_API_KEY, KAPSO_WABA_ID. KAPSO_META_PROXY_URL es opcional.
 *
 * `--crear` es explícito a propósito, al revés que el script de aprobación, donde crear es el modo
 * por defecto. Someter contenido a revisión de Meta bajo la cuenta de Mizar es una acción hacia
 * fuera e irreversible en la práctica (queda registrada, y el nombre no se puede reutilizar
 * mientras la plantilla exista), así que correr el script sin argumentos no debe disparar nada:
 * enseña el JSON y para. El texto tiene que aprobarlo el cliente ANTES.
 */

import {
  PLANTILLAS_WHATSAPP,
  definicionParaMeta,
  type NombrePlantilla,
} from "../lib/infrastructure/plantillas-whatsapp";

const NOMBRES = Object.keys(PLANTILLAS_WHATSAPP) as NombrePlantilla[];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} no está configurado`);
  return value;
}

function baseUrl(): string {
  return (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
}

async function estado(apiKey: string, wabaId: string): Promise<void> {
  const response = await fetch(
    `${baseUrl()}/${wabaId}/message_templates?fields=name,status,category,language,rejected_reason&limit=100`,
    { headers: { "X-API-Key": apiKey } },
  );
  const body = (await response.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> };
  const enMeta = new Map((body.data ?? []).map((plantilla) => [String(plantilla.name), plantilla]));
  for (const nombre of NOMBRES) {
    const plantilla = enMeta.get(nombre);
    if (!plantilla) {
      process.stdout.write(`FALTA      ${nombre}\n`);
      continue;
    }
    const motivo = plantilla.rejected_reason && plantilla.rejected_reason !== "NONE" ? `  motivo: ${plantilla.rejected_reason}` : "";
    process.stdout.write(`${String(plantilla.status).padEnd(10)} ${nombre}  (${plantilla.language})${motivo}\n`);
  }
}

async function crear(apiKey: string, wabaId: string): Promise<void> {
  let fallidas = 0;
  for (const nombre of NOMBRES) {
    const response = await fetch(`${baseUrl()}/${wabaId}/message_templates`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify(definicionParaMeta(nombre)),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    process.stdout.write(`${response.ok ? "OK    " : "ERROR "} ${nombre}  ${JSON.stringify(body)}\n`);
    if (!response.ok) fallidas++;
  }
  if (fallidas) {
    process.stderr.write(`Meta rechazó ${fallidas} de ${NOMBRES.length} plantillas.\n`);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--dry-run") || process.argv.length <= 2) {
    for (const nombre of NOMBRES) {
      process.stdout.write(`${JSON.stringify(definicionParaMeta(nombre), null, 2)}\n`);
    }
    if (process.argv.length <= 2) {
      process.stdout.write("\n(modo por defecto: solo muestra el JSON. Usa --status para consultar o --crear para someterlas a Meta.)\n");
    }
    return;
  }

  const apiKey = requireEnv("KAPSO_API_KEY");
  const wabaId = requireEnv("KAPSO_WABA_ID");

  if (process.argv.includes("--status")) return estado(apiKey, wabaId);
  if (process.argv.includes("--crear")) return crear(apiKey, wabaId);

  process.stderr.write("Uso: --dry-run | --status | --crear\n");
  process.exitCode = 2;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
