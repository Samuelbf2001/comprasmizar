import type { Actor } from "../domain";
import type { AuditRepository } from "../services";

/** Records every MCP invocation, including reads, before calling its handler. */
export async function auditMcpTool<T>(audit: AuditRepository, actor: Actor, tool: string, execute: () => Promise<T>, id = crypto.randomUUID()): Promise<T> {
  await audit.append({ entity: "mcp", entityId: id, event: "MCP_TOOL", actorId: actor.id, at: new Date(), origin: "mcp", data: { tool } });
  return execute();
}
