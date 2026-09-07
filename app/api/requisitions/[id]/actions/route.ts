import { authenticatedJson, assertSameOrigin, parseJson } from "../../../../../lib/http/api";
import { requisitionActionSchema } from "../../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../../lib/infrastructure/postgres-repositories";
import { ProcurementService } from "../../../../../lib/services";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, requisitionActionSchema), service = new ProcurementService(createPostgresDependencies()), requestContext = { actor };
    switch (input.action) {
      case "start_review": return service.startReview(id, requestContext);
      case "review": return service.review(id, { tagId: input.tagId, approverId: input.approverId, workId: input.workId, paymentTerms: input.paymentTerms, items: input.items }, requestContext);
      case "send_for_approval": return service.sendForApproval(id, requestContext);
      case "approve": return service.approve(id, requestContext);
      case "return": return service.returnForCorrection(id, input.comment, requestContext);
      case "decline": return service.decline(id, input.reason, requestContext);
      case "propose_item": return service.proposeItem(id, input.description, requestContext);
      case "decide_items": return service.decideItems(id, input.decisions, requestContext);
      case "assign_suppliers": return service.assignSuppliers(id, input.assignments, requestContext);
      case "generate_orders": return service.generateOrders(id, requestContext);
    }
  });
}
