import { z } from "zod";
import { DomainError } from "../../../lib/domain";
import { authenticatedJson, assertSameOrigin, parseJson } from "../../../lib/http/api";
import { cashCloseSchema } from "../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { CashService } from "../../../lib/services";

export const runtime = "nodejs";
const cashBoxIdSchema = z.string().uuid();
const periodSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

// `?cashBoxId=` (obligatorio): con `&period=AAAA-MM` devuelve el resumen de ESE mes (existente o
// calculado en vivo si todavía no se cerró, ver CashService.getCashPeriodSummary); sin `period`,
// devuelve el historial de cierres de esa caja (más reciente primero).
export function GET(request: Request) {
  return authenticatedJson((actor) => {
    const url = new URL(request.url);
    const rawCashBoxId = url.searchParams.get("cashBoxId");
    const parsedCashBoxId = cashBoxIdSchema.safeParse(rawCashBoxId);
    if (!parsedCashBoxId.success) throw new DomainError("INVALID_INPUT", "cashBoxId es obligatorio y debe ser un uuid válido");
    const service = new CashService(createPostgresDependencies());
    const rawPeriod = url.searchParams.get("period");
    if (rawPeriod !== null) {
      const parsedPeriod = periodSchema.safeParse(rawPeriod);
      if (!parsedPeriod.success) throw new DomainError("INVALID_INPUT", "period debe tener el formato AAAA-MM");
      return service.getCashPeriodSummary(parsedCashBoxId.data, parsedPeriod.data, { actor });
    }
    return service.listCashCloses(parsedCashBoxId.data, { actor });
  });
}
// `action: "close"` cierra el mes (CashService.closeCashPeriod, cash:close: contabilidad/
// admin_sixteam); `action: "reopen"` lo reabre (exclusivo de admin_sixteam, con auditoría).
export function POST(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, cashCloseSchema);
    const service = new CashService(createPostgresDependencies());
    return input.action === "reopen"
      ? service.reopenCashPeriod(input.cashBoxId, input.period, { actor })
      : service.closeCashPeriod(input.cashBoxId, input.period, { actor });
  });
}
