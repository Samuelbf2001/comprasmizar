/**
 * Crea o actualiza el WhatsApp Flow "Requisición de obra – Mizar" como BORRADOR
 * (publish:false) contra la Graph API de Meta, vía el proxy de Kapso.
 *
 * NUNCA publica el Flow: eso es una decisión humana explícita. Ver el comando
 * exacto en integrations/whatsapp-flow/README.md.
 *
 * Uso:
 *   npx tsx scripts/publish-whatsapp-flow.ts
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

const FLOW_NAME = "Requisición de obra – Mizar";
const FLOW_JSON_PATH = resolve("integrations/whatsapp-flow/requisicion.flow.json");

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

  process.stdout.write(`${JSON.stringify({ action, flow_id: flowId, validation_errors: validationErrors }, null, 2)}\n`);
  if (validationErrors.length > 0) {
    process.stderr.write("La API de Meta reportó errores de validación en el Flow JSON. Corrígelos antes de publicar.\n");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
