import { z } from "zod";
import type { Actor } from "../domain";

/** Tools registered by the runtime today. Approval, return and decline are excluded permanently. */
export const MCP_TOOL_NAMES = ["consultar_requisiciones", "consultar_ordenes", "consultar_gastos", "estado_embudo", "registrar_caja_menor", "actualizar_estado_orden"] as const;
/** Production gates: require catalogue/notification adapters or the Helisa mapping before registration. */
export const MCP_GATED_TOOL_NAMES = ["ficha_proveedor", "exportar_reporte", "crear_requisicion", "administrar_catalogo", "reenviar_notificacion"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export function assertSafeMcpToolCatalog(names: readonly string[] = MCP_TOOL_NAMES): void { if (names.some((name) => /aprobar|devolv|declinar|approve|return/i.test(name))) throw new Error("MCP_CONTROL_ACTION_FORBIDDEN"); }
export const mcpToolInput = z.object({ name: z.enum(MCP_TOOL_NAMES), arguments: z.record(z.string(), z.unknown()).default({}) });
export interface McpReadFacade { execute(name: McpToolName, actor: Actor, args: Record<string, unknown>): Promise<unknown>; }
export async function verifyMcpApiKey(rawKey: string | null, pepper: string, lookup: (hash: string) => Promise<Actor | null>): Promise<Actor | null> { if (!rawKey?.startsWith("mizar_") || !pepper) return null; const { hmacSha256 } = await import("./crypto"); return lookup(hmacSha256(rawKey, pepper)); }
