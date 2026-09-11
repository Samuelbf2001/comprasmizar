/**
 * Crea o actualiza el WhatsApp Flow "Requisición de obra – Mizar" como BORRADOR
 * (publish:false) contra la Graph API de Meta, vía el proxy de Kapso.
 *
 * NUNCA publica el Flow: eso es una decisión humana explícita. Ver el comando
 * exacto en integrations/whatsapp-flow/README.md.
 *
 * Uso:
 *   npx tsx scripts/publish-whatsapp-flow.ts             # Flow de captura (por defecto)
 *   npx tsx scripts/publish-whatsapp-flow.ts aprobacion  # Flow de aprobación
 *
 * Variables de entorno requeridas (ver .env.local):
 *   KAPSO_API_KEY        - header X-API-Key contra el proxy de Kapso
 *   KAPSO_WABA_ID        - WABA de Mizar
 *   KAPSO_META_PROXY_URL - opcional; por defecto https://api.kapso.ai/meta/whatsapp/v24.0
 *
 * NOTA SOBRE EL PROXY: los endpoints con forma /{flow_id}/... (detalle, /assets
 * para actualizar el JSON) son ambiguos para el proxy de Kapso si un mismo
 * proyecto tiene más de una configuración de WhatsApp conectada: hace falta
 * pasar `business_account_id` (o `phone_number_id`) como query param para que
 * resuelva a qué cuenta pertenece el flow_id. Sin ese parámetro, el proxy
 * responde 404 "WhatsApp configuration not found" aunque el flow exista.
 * (Confirmado contra api/meta/whatsapp/openapi-whatsapp.yaml del corpus de
 * documentación de Kapso y por prueba directa.)
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Los dos Flows del proyecto. El nombre es la CLAVE de búsqueda contra la WABA (por eso debe ser
 * estable: cambiarlo haría que el script cree un Flow nuevo en vez de actualizar el existente).
 * `requisicion` sigue siendo el valor por defecto para no romper el comando ya documentado.
 */
const FLOWS = {
  /**
   * El Flow de captura VIGENTE. `requisicion` apunta siempre aquí para que el comando por defecto,
   * el documentado y el que escriba cualquiera de memoria toquen el bueno. El JSON lo genera
   * `scripts/build-flow-captura.ts`; no se edita a mano.
   *
   * El ARCHIVO no lleva versión a propósito (`requisicion-captura.flow.json`): Meta no deja editar
   * un Flow publicado, así que cada corrección obliga a crear uno nuevo, y renombrar el artefacto en
   * cada vuelta solo genera churn y enlaces rotos. La versión vive donde importa —el `name`, que es
   * la clave de búsqueda contra la WABA— y el historial, en git.
   */
  requisicion: { name: "Requisición de obra – Mizar v3", path: "integrations/whatsapp-flow/requisicion-captura.flow.json" },
  /**
   * DEPRECADO. Flow de captura v1, `1972861836748301`. Sustituido por el v2 el 2026-09-11 por dos
   * defectos que solo se vieron usándolo: el resumen pintaba las llaves en vez de los datos (ninguna
   * pantalla declaraba `data` ni pasaba `payload`) y solo cabían tres artículos.
   *
   * Se conserva la entrada a propósito, y no se borra, porque el Flow sigue existiendo en Meta y su
   * JSON sigue en el repositorio: sin esta anotación, el siguiente que vea `requisicion.flow.json`
   * podría subirlo creyendo que es la fuente vigente y pisar el bueno. NO se actualiza ni se
   * republica.
   */
  requisicion_v1_deprecado: { name: "Requisición de obra – Mizar", path: "integrations/whatsapp-flow/requisicion.flow.json" },
  /**
   * DEPRECADO. Flow de captura v2, `1076158778395724`. Estuvo en producción unas horas el
   * 2026-09-11 y lo sustituye el v3 por un defecto de la reconstrucción: el `complete` se quedó SIN
   * `item_N_foto` mientras las ocho pantallas seguían mostrando el `PhotoPicker`, así que la foto
   * del artículo se perdía sin un solo error visible.
   *
   * No tiene `path` propio: su JSON era el mismo archivo generado, que ya avanzó al v3. Queda aquí
   * como registro de que ese id existe y está deprecado, para que nadie lo reviva buscándolo por id.
   */

  aprobacion: { name: "Aprobación de requisición – Mizar", path: "integrations/whatsapp-flow/aprobacion.flow.json" },
} as const;
type FlowKey = keyof typeof FLOWS;
const requestedFlow = (process.argv[2]?.trim() || "requisicion") as FlowKey;
if (!(requestedFlow in FLOWS)) {
  process.stderr.write(`Flow desconocido: "${requestedFlow}". Opciones: ${Object.keys(FLOWS).join(", ")}\n`);
  process.exit(1);
}
const FLOW_NAME = FLOWS[requestedFlow].name;
const FLOW_JSON_PATH = resolve(FLOWS[requestedFlow].path);

type FlowListItem = { id: string; name: string; status: string; categories?: string[]; validation_errors?: unknown[] };
type FlowListResponse = { data: FlowListItem[] };
type FlowMutationResponse = { id?: string; success?: boolean; validation_errors?: unknown[]; error?: unknown };

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} no está configurado`);
  return value;
}

function baseUrl(): string {
  return (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
}

async function kapsoFetch(apiKey: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, { ...init, headers: { "X-API-Key": apiKey, ...(init?.headers ?? {}) } });
}

async function listFlows(apiKey: string, wabaId: string): Promise<FlowListItem[]> {
  const response = await kapsoFetch(apiKey, `/${wabaId}/flows`);
  if (!response.ok) throw new Error(`GET /${wabaId}/flows falló con status ${response.status}: ${await response.text()}`);
  const body = (await response.json()) as FlowListResponse;
  return body.data;
}

async function createFlow(apiKey: string, wabaId: string, name: string, flowJson: string): Promise<FlowMutationResponse> {
  const response = await kapsoFetch(apiKey, `/${wabaId}/flows`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, categories: ["OTHER"], flow_json: flowJson, publish: false }),
  });
  const body = (await response.json().catch(() => ({}))) as FlowMutationResponse;
  if (!response.ok) throw new Error(`POST /${wabaId}/flows falló con status ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function updateFlowJson(apiKey: string, wabaId: string, flowId: string, flowJson: string): Promise<FlowMutationResponse> {
  const form = new FormData();
  form.set("name", "flow.json");
  form.set("asset_type", "FLOW_JSON");
  form.set("file", new Blob([flowJson], { type: "application/json" }), "flow.json");
  const response = await kapsoFetch(apiKey, `/${flowId}/assets?business_account_id=${wabaId}`, { method: "POST", body: form });
  const body = (await response.json().catch(() => ({}))) as FlowMutationResponse;
  if (!response.ok) throw new Error(`POST /${flowId}/assets falló con status ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main(): Promise<void> {
  const apiKey = requireEnv("KAPSO_API_KEY");
  const wabaId = requireEnv("KAPSO_WABA_ID");
  const flowJson = await readFile(FLOW_JSON_PATH, "utf8");
  JSON.parse(flowJson); // valida que el archivo local sea JSON válido antes de llamar a la API

  const existing = (await listFlows(apiKey, wabaId)).find((flow) => flow.name === FLOW_NAME);
  const action = existing ? "updated" : "created";
  let flowId: string | undefined;
  let validationErrors: unknown[];
  if (existing) {
    flowId = existing.id;
    validationErrors = (await updateFlowJson(apiKey, wabaId, flowId, flowJson)).validation_errors ?? [];
  } else {
    const created = await createFlow(apiKey, wabaId, FLOW_NAME, flowJson);
    if (!created.id) throw new Error(`La API no devolvió un flow_id al crear el Flow: ${JSON.stringify(created)}`);
    flowId = created.id;
    validationErrors = created.validation_errors ?? [];
  }

  process.stdout.write(`${JSON.stringify({ flow: requestedFlow, action, flow_id: flowId, validation_errors: validationErrors }, null, 2)}\n`);
  if (validationErrors.length > 0) {
    process.stderr.write("La API de Meta reportó errores de validación en el Flow JSON. Corrígelos antes de publicar.\n");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
