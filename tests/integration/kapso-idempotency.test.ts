import { describe, expect, it } from "vitest";
import { processKapsoEvent } from "../../lib/infrastructure/kapso-processor";
import type { KapsoProcessingStore } from "../../lib/infrastructure/kapso";
import { adaptNfmReply, type RawKapsoWebhookPayload } from "../../lib/infrastructure/nfm-reply-adapter";
import { issueFlowToken } from "../../lib/infrastructure/flow-sender";

const event = { eventId: "evt-1", type: "flow_submission" as const, receivedAt: "2026-08-24T00:00:00.000Z", submission: { eventId: "evt-1", phone: "+573001234567", workId: "work", requiredDate: "2026-08-30", type: "compra" as const, requesterName: "Maestro", items: [] } };
function store(options: { failCompleteOnce?: boolean } = {}): KapsoProcessingStore { let state: "new" | "processing" | "completed" = "new", completionAttempts = 0, requisitionId: string | null = null; return { claim: async () => { if (state === "completed") return "completed"; if (state === "processing") return "in_progress"; state = "processing"; return "claimed"; }, complete: async (_eventId, id) => { completionAttempts++; if (options.failCompleteOnce && completionAttempts === 1) throw new Error("completion interrupted"); requisitionId = id ?? null; state = "completed"; }, release: async () => { state = "new"; }, findRequisitionId: async () => requisitionId }; }
describe("Kapso idempotency coordinator", () => {
  it("allows exactly one concurrent creator", async () => { const durable = store(); let creates = 0; const creator = { findExisting: async () => null, create: async () => { creates++; await new Promise((resolve) => setTimeout(resolve, 5)); return { id: "req", consecutive: "REQ", type: "compra" as const, workId: "work", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; } }; const [first, second] = await Promise.all([processKapsoEvent(durable, creator, event), processKapsoEvent(durable, creator, event)]); expect([first, second].sort()).toEqual(["created", "in_progress"]); expect(creates).toBe(1); });
  it("releases a failed claim so the retry creates once successfully", async () => { const durable = store(); let attempts = 0; const creator = { findExisting: async () => null, create: async () => { attempts++; if (attempts === 1) throw new Error("db down"); return { id: "req", consecutive: "REQ", type: "compra" as const, workId: "work", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; } }; await expect(processKapsoEvent(durable, creator, event)).rejects.toThrow("db down"); await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created"); expect(attempts).toBe(2); });
  it("recovers a crash after creation without creating a duplicate requisition", async () => { const durable = store({ failCompleteOnce: true }); let created = false, creates = 0; const requisition = { id: "req", consecutive: "REQ", type: "compra" as const, workId: "work", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; const creator = { findExisting: async () => created ? requisition : null, create: async () => { creates++; created = true; return requisition; } }; await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("duplicate"); await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("duplicate"); expect(creates).toBe(1); });
  it("allows a lease-expired processing claim to be recovered while a live one stays in progress", async () => { let claimCalls = 0, creates = 0; const durable: KapsoProcessingStore = { claim: async () => ++claimCalls === 1 ? "in_progress" : "claimed", complete: async () => {}, release: async () => {}, findRequisitionId: async () => null }; const creator = { findExisting: async () => null, create: async () => { creates++; return { id: "recovered", consecutive: "REQ", type: "compra" as const, workId: "work", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; } }; await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("in_progress"); await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created"); expect(creates).toBe(1); });
});

describe("Kapso attachment hook (attachEvidence)", () => {
  const requisition = { id: "req", consecutive: "REQ", type: "compra" as const, workId: "work", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] };
  it("calls attachEvidence exactly once after a fresh create, with the created requisition", async () => {
    const durable = store();
    const calls: Array<[unknown, unknown]> = [];
    const creator = { findExisting: async () => null, create: async () => requisition, attachEvidence: async (inputEvent: unknown, inputRequisition: unknown) => { calls.push([inputEvent, inputRequisition]); } };
    await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created");
    expect(calls).toEqual([[event, requisition]]);
  });
  it("still completes as created when attachEvidence rejects — a lost attachment must never block the requisition", async () => {
    const durable = store();
    let attachCalls = 0;
    const creator = { findExisting: async () => null, create: async () => requisition, attachEvidence: async () => { attachCalls++; throw new Error("copy failed"); } };
    await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created");
    expect(attachCalls).toBe(1);
    await expect(durable.findRequisitionId(event.eventId)).resolves.toBe("req");
  });
  it("never invokes attachEvidence once the event is found already created (duplicate path)", async () => {
    let calls = 0, created = false;
    const durable: KapsoProcessingStore = { claim: async () => "claimed", complete: async () => {}, release: async () => {}, findRequisitionId: async () => null };
    const creator = { findExisting: async () => (created ? requisition : null), create: async () => { created = true; return requisition; }, attachEvidence: async () => { calls++; } };
    await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created");
    expect(calls).toBe(1);
    await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("duplicate");
    expect(calls).toBe(1);
  });
  it("does not require attachEvidence to be implemented", async () => {
    const durable = store();
    const creator = { findExisting: async () => null, create: async () => requisition };
    await expect(processKapsoEvent(durable, creator, event)).resolves.toBe("created");
  });
});

// RF-902 (canal WhatsApp): un evento traducido por nfm-reply-adapter.ts debe entrar por el MISMO
// camino idempotente de arriba sin que processKapsoEvent tenga que saber nada de Flows. Esto prueba
// esa costura directamente (adaptador -> processKapsoEvent), sin pasar por HTTP ni por Postgres —
// la ruta completa vía POST /api/kapso está en tests/integration/nfm-reply.test.ts.
describe("Adaptador de WhatsApp Flow (nfm_reply) + coordinador de idempotencia", () => {
  const secret = "secreto-de-prueba-para-flow-token";
  const okRequester = async () => ({ name: "Maestro de obra" });
  const phone = "573005550001";
  const now = new Date("2026-08-24T12:00:00.000Z");
  function rawNfmReply(wamid: string): RawKapsoWebhookPayload {
    const responseJson = JSON.stringify({
      flow_token: issueFlowToken(phone, secret, now),
      type: "compra", workId: "22222222-2222-4222-8222-222222222222", requiredDate: "2026-08-30", requesterName: "Maestro Flow",
      item_1_catalogo: "", item_1_descripcion: "Cemento gris 50kg", item_1_cantidad: "5", item_1_unidad: "bulto", item_1_proveedor: "", item_1_link: "",
      item_2_catalogo: "", item_2_descripcion: "", item_2_cantidad: "", item_2_unidad: "", item_2_proveedor: "", item_2_link: "",
      item_3_catalogo: "", item_3_descripcion: "", item_3_cantidad: "", item_3_unidad: "", item_3_proveedor: "", item_3_link: "",
    });
    return { message: { id: wamid, from: phone, type: "interactive", interactive: { type: "nfm_reply", nfm_reply: { name: "flow", body: "Sent", response_json: responseJson } } } };
  }

  it("traduce y crea exactamente una vez; el reintento del mismo wamid da 'duplicate'", async () => {
    const durable = store();
    let creates = 0;
    const creator = { findExisting: async () => null, create: async () => { creates++; return { id: "req-flow", consecutive: "REQ", type: "compra" as const, workId: "22222222-2222-4222-8222-222222222222", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; } };

    const adapted = await adaptNfmReply(rawNfmReply("wamid.flow-1"), { secret, resolveRequester: okRequester, now });
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;

    await expect(processKapsoEvent(durable, creator, adapted.event)).resolves.toBe("created");
    // Mismo wamid llega de nuevo (reintento de Meta/Kapso): se vuelve a traducir igual, pero el
    // coordinador de idempotencia ya lo tiene completado.
    const adaptedAgain = await adaptNfmReply(rawNfmReply("wamid.flow-1"), { secret, resolveRequester: okRequester, now });
    expect(adaptedAgain.ok).toBe(true);
    if (!adaptedAgain.ok) return;
    await expect(processKapsoEvent(durable, creator, adaptedAgain.event)).resolves.toBe("duplicate");
    expect(creates).toBe(1);
  });

  it("un wamid distinto sí crea una segunda requisición", async () => {
    // El fake `store()` de este archivo modela una sola fila durable (un solo event_id a la vez,
    // como en las demás pruebas de este describe) — para dos wamids independientes se necesita una
    // instancia por evento, igual que en Postgres real cada event_id tiene su propia fila.
    let creates = 0;
    const creator = { findExisting: async () => null, create: async () => { creates++; return { id: `req-flow-${creates}`, consecutive: "REQ", type: "compra" as const, workId: "22222222-2222-4222-8222-222222222222", channel: "whatsapp" as const, requiredDate: "2026-08-30", status: "enviada" as const, items: [] }; } };

    const first = await adaptNfmReply(rawNfmReply("wamid.flow-a"), { secret, resolveRequester: okRequester, now });
    const second = await adaptNfmReply(rawNfmReply("wamid.flow-b"), { secret, resolveRequester: okRequester, now });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    await expect(processKapsoEvent(store(), creator, first.event)).resolves.toBe("created");
    await expect(processKapsoEvent(store(), creator, second.event)).resolves.toBe("created");
    expect(creates).toBe(2);
  });
});
