/**
 * Crea (o reporta) la plantilla de WhatsApp `aprobacion_requisicion`: el aviso al aprobador con un
 * **botón de tipo FLOW** que abre el Flow de aprobación.
 *
 * Por qué existe este script y no se hace a mano en el Manager: misma razón que
 * `publish-whatsapp-flow.ts`. La definición vive versionada aquí, así que se puede reproducir en
 * otra WABA, revisar en un diff y corregir sin adivinar qué se configuró por pantalla.
 *
 * Uso:
 *   npx tsx --env-file=.env.local scripts/publish-approval-template.ts --dry-run   # imprime el JSON
 *   npx tsx --env-file=.env.local scripts/publish-approval-template.ts             # crea y manda a revisión
 *   npx tsx --env-file=.env.local scripts/publish-approval-template.ts --status    # consulta el estado
 *
 * Variables requeridas: KAPSO_API_KEY, KAPSO_WABA_ID, WHATSAPP_APPROVAL_FLOW_ID.
 * KAPSO_META_PROXY_URL es opcional (por defecto el proxy de Kapso).
 *
 * IMPORTANTE: Meta EXIGE que el Flow del botón esté PUBLICADO. Con el Flow en borrador la creación
 * falla con "Debe publicarse el flujo asociado con el botón" (error_subcode 2388142), verificado en
 * vivo el 2026-09-10. Publicar el Flow es una decisión de una sola vía: ver
 * integrations/whatsapp-flow/README.md.
 *
 * El nombre y el idioma deben coincidir con lo que envía `sendApprovalTemplate`
 * (lib/infrastructure/approval-flow-sender.ts) y el ORDEN de las variables del cuerpo con el orden
 * posicional que arma `buildApprovalTemplatePayload`: nombre, consecutivo, obra, total.
 */

const TEMPLATE_NAME = "aprobacion_requisicion";
const TEMPLATE_LANGUAGE = "es";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} no está configurado`);
  return value;
}

function baseUrl(): string {
  return (process.env.KAPSO_META_PROXY_URL?.trim() || "https://api.kapso.ai/meta/whatsapp/v24.0").replace(/\/+$/, "");
}

function templateDefinition(flowId: string) {
  return {
    name: TEMPLATE_NAME,
    language: TEMPLATE_LANGUAGE,
    category: "UTILITY",
    components: [
      {
        type: "BODY",
        // Sin tildes ni caracteres raros a propósito: reducen los rechazos de revisión y algunos
        // clientes viejos los renderizan mal. El contenido es puramente transaccional (utility).
        text: "Hola {{1}}. La requisicion {{2}} de la obra {{3}} esta esperando tu aprobacion. Total: {{4}}. Abre el boton para revisar los items y decidir.",
        example: { body_text: [["Daniel", "REQ-2026-0003", "Obra La Pradera", "$4.373.250"]] },
      },
      {
        type: "BUTTONS",
        // `navigate_screen` es la pantalla de entrada del Flow: debe existir en aprobacion.flow.json.
        buttons: [{ type: "FLOW", text: "Revisar y aprobar", flow_id: flowId, navigate_screen: "REVISION", flow_action: "navigate" }],
      },
    ],
  };
}

async function main(): Promise<void> {
  const apiKey = requireEnv("KAPSO_API_KEY");
  const wabaId = requireEnv("KAPSO_WABA_ID");

  if (process.argv.includes("--status")) {
    const response = await fetch(`${baseUrl()}/${wabaId}/message_templates?name=${TEMPLATE_NAME}&fields=name,status,category,rejected_reason`, { headers: { "X-API-Key": apiKey } });
    const body = (await response.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>> };
    process.stdout.write(`${JSON.stringify(body.data ?? [], null, 2)}\n`);
    return;
  }

  const definition = templateDefinition(requireEnv("WHATSAPP_APPROVAL_FLOW_ID"));
  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
    return;
  }

  const response = await fetch(`${baseUrl()}/${wabaId}/message_templates`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(definition),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (!response.ok) {
    process.stderr.write("Meta rechazó la creación de la plantilla.\n");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
