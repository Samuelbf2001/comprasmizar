import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ProcurementService } from "../../../../lib/services";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { isPublicConfigured } from "../../../../lib/security/env";
import { publicFormRateLimiter, publicWorkAggregateRateLimiter, publicWorkRateLimiter } from "../../../../lib/security/rate-limit";
import { isAuthorizedPublicRequester } from "../../../../lib/infrastructure/public-access";

export const runtime = "nodejs";
const publicItemSchema = z.object({
  itemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().finite().positive().max(1_000_000),
  unit: z.string().trim().min(1).max(40),
  possibleSupplier: z.string().trim().min(1).max(240).optional(),
  productLink: z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required").optional(),
}).strict().refine((item) => Boolean(item.itemId || item.description), { message: "itemId or description is required" });

/** Public clients may identify a catalogue item, but never line IDs or quoted amounts. */
export const publicRequisitionSchema = z.object({
  workId: z.string().uuid(), code: z.string().trim().min(4).max(64), type: z.enum(["compra", "pago"]),
  requiredDate: z.string().date(), name: z.string().trim().min(2).max(160), phone: z.string().trim().min(7).max(20),
  destination: z.string().trim().min(1).max(500).optional(), observations: z.string().trim().min(1).max(3000).optional(),
  items: z.array(publicItemSchema).min(1).max(100),
}).strict();

export function normalizePublicPhone(phone: string): string { return phone.replace(/[\s()\-]/g, ""); }
const neutral = () => Response.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
export async function POST(request: Request) {
  // Caddy must overwrite X-Real-IP; never parse a client-supplied X-Forwarded-For chain here.
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 }); const ip = request.headers.get("x-real-ip") ?? "direct"; if (!publicFormRateLimiter.consume(ip)) return neutral();
  const declaredLength = Number(request.headers.get("content-length") ?? 0); if (Number.isFinite(declaredLength) && declaredLength > 100_000) return neutral();
  const raw = await request.text(); if (Buffer.byteLength(raw, "utf8") > 100_000) return neutral();
  let payload: unknown; try { payload = JSON.parse(raw); } catch { payload = null; }
  const parsed = publicRequisitionSchema.safeParse(payload), linkToken = request.headers.get("x-public-link-token"); if (!parsed.success || !linkToken) return neutral();
  // publicWorkRateLimiter (ip:workId) por sí solo es evadible repartiendo intentos entre muchas IPs; el
  // agregado por workId (sin IP) acota el total de intentos contra una obra sin importar el origen.
  if (!publicWorkRateLimiter.consume(`${ip}:${parsed.data.workId}`) || !publicWorkAggregateRateLimiter.consume(parsed.data.workId)) return neutral();
  const phone = normalizePublicPhone(parsed.data.phone);
  try { if (!(await isAuthorizedPublicRequester(parsed.data.workId, phone))) return neutral(); const service = new ProcurementService(createPostgresDependencies()); await service.create({ type: parsed.data.type, workId: parsed.data.workId, requiredDate: parsed.data.requiredDate, channel: "publico", publicCode: parsed.data.code, publicLinkToken: linkToken, externalRequester: { name: parsed.data.name, phone }, destination: parsed.data.destination, observations: parsed.data.observations, items: parsed.data.items.map((item) => ({ ...item, id: randomUUID(), unitBase: 0, unitIva: 0 })) }, {}); return neutral(); } catch { return neutral(); }
}
