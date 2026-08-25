import { randomUUID } from "node:crypto";
import { authenticatedJson, assertSameOrigin, parseJson } from "../../../lib/http/api";
import { createRequisitionSchema } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
export function GET() { return authenticatedJson((actor) => new ProcurementService(createPostgresDependencies()).listRequisitions({ actor })); }
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, createRequisitionSchema); return new ProcurementService(createPostgresDependencies()).create({ ...input, channel: "web", items: input.items.map((item) => ({ ...item, id: randomUUID(), unitBase: 0, unitIva: 0 })) }, { actor }); }, 201); }
