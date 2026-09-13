import { randomUUID } from "node:crypto";
import { authenticatedJson, assertSameOrigin, hasListFilters, parseJson, parseListQuery } from "../../../lib/http/api";
import { createRequisitionSchema, REQUISITION_STATUS_VALUES } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../lib/services";

export const runtime = "nodejs";
// H3 (docs/plan-rendimiento.md, Fase 3): `?status=a,b&workId=&from=&to=&limit=&cursor=` son ADITIVOS —
// sin ninguno de los seis, responde exactamente el array de siempre (compatibilidad hacia atrás
// obligatoria: la bandeja/mis requisiciones/detalle actuales lo consumen tal cual). `limit`/`cursor`
// deciden el shape de la respuesta (`{ rows, nextCursor }` vs el array de siempre); status/workId/
// from/to sin limit/cursor filtran mientras siguen devolviendo un array plano.
//
// «Aprobar desde la lista» (reunión 11-sep, patrón Precoro): la bandeja necesita saber, por fila,
// qué ítems decide QUIEN MIRA — misma pregunta que ya resuelve DetailBundle.viewerId en
// app/api/requisitions/[id]/detail/route.ts. Se añade SOLO a la forma paginada `{ rows, nextCursor }`
// (la única que consume components/screens/connected/data.ts): la forma en array (sin filtros/paginación,
// compatibilidad hacia atrás) se deja intacta a propósito, para no romper a quien todavía espera un array.
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const { query, paginated } = parseListQuery(new URL(request.url), REQUISITION_STATUS_VALUES);
    const service = new ProcurementService(createPostgresDependencies());
    if (!paginated && !hasListFilters(query)) return service.listRequisitions({ actor });
    return service
      .listRequisitionsPage(query, { actor })
      .then((page) => (paginated ? { ...page, viewerId: actor.id } : page.rows));
  });
}
// Solicitud de pago (feat/solicitud-de-pago): `unitBase`/`ivaRate`/`finalSupplierId` viajan tal
// cual cuando el cliente los manda (captura de una solicitud de pago, ver
// components/screens/connected/new-requisition.tsx); una compra sigue sin mandarlos y cae en los
// mismos 0/ausente de siempre — el dominio (ProcurementService.create) es quien exige los tres para
// `type === "pago"`.
export function POST(request: Request) { return authenticatedJson(async (actor) => { assertSameOrigin(request); const input = await parseJson(request, createRequisitionSchema); return new ProcurementService(createPostgresDependencies()).create({ ...input, channel: "web", items: input.items.map((item) => ({ ...item, id: randomUUID(), unitBase: item.unitBase ?? 0, unitIva: 0 })) }, { actor }); }, 201); }
