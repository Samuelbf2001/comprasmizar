import { describe, expect, it, vi } from "vitest";
import { DomainError, type Actor, type CashPayment, type ItemLine, type Requisition } from "../../lib/domain";
import { ReportService, monthRange, toCashCloseReport, type ReportCatalogNames, type ReportFilters } from "../../lib/services/report-service";
import type { ListQuery, Page, ServiceDependencies } from "../../lib/services";

const item = (overrides: Partial<ItemLine> = {}): ItemLine => ({
  id: overrides.id ?? "item-1", quantity: 1, unit: "unidad", unitBase: 1000, unitIva: 190, status: "aprobado", ...overrides,
});
const requisition = (overrides: Partial<Requisition> = {}): Requisition => ({
  id: "req-1", consecutive: "REQ-2026-0001", type: "compra", channel: "web", status: "aprobada",
  items: [item()], createdAt: "2026-09-10T12:00:00.000Z", ...overrides,
});

type ListVisibleTo = ServiceDependencies["requisitions"]["listVisibleTo"];
function fakeListVisibleTo(rows: Requisition[]): { fn: ListVisibleTo; calls: Array<{ actor: Actor; query?: ListQuery }> } {
  const calls: Array<{ actor: Actor; query?: ListQuery }> = [];
  const fn: ListVisibleTo = async (actor, query) => {
    calls.push({ actor, query });
    if (!query) return rows;
    const filtered = rows.filter((row) => {
      if (query.workId && row.workId !== query.workId) return false;
      if (query.tagId && row.tagId !== query.tagId) return false;
      if (query.approverId && row.approverId !== query.approverId && !row.items.some((line) => line.approverId === query.approverId)) return false;
      if (query.from && (!row.createdAt || row.createdAt.slice(0, 10) < query.from)) return false;
      if (query.to && (!row.createdAt || row.createdAt.slice(0, 10) > query.to)) return false;
      return true;
    });
    return { rows: filtered, nextCursor: null } satisfies Page<Requisition>;
  };
  return { fn, calls };
}
function fakeDeps(listVisibleTo: ListVisibleTo): ServiceDependencies {
  return { requisitions: { listVisibleTo } } as unknown as ServiceDependencies;
}
const actor = (roles: Actor["roles"] = ["contabilidad"]): Actor => ({ id: "actor-1", roles });
const listReport = (rows: Requisition[], filters: ReportFilters, roles: Actor["roles"] = ["contabilidad"]) => {
  const { fn, calls } = fakeListVisibleTo(rows);
  const service = new ReportService(fakeDeps(fn));
  return { promise: service.listReport(filters, { actor: actor(roles) }), calls };
};

describe("ReportService.listReport — RF-1301", () => {
  it("exige 'report:read'; un rol sin ese permiso (solicitante) no puede ni ver el reporte", async () => {
    const { promise } = listReport([requisition()], {}, ["solicitante"]);
    await expect(promise).rejects.toThrow(DomainError);
  });

  it("filtra por aprobador de CABECERA", async () => {
    const rows = [
      requisition({ id: "req-cabecera", approverId: "juliana" }),
      requisition({ id: "req-otra", approverId: "nelson" }),
    ];
    const { promise } = listReport(rows, { approverId: "juliana" });
    const report = await promise;
    expect(report.map((row) => row.id)).toEqual(["req-cabecera"]);
  });

  // RF-1301 punto 1: "cuente una requisición si el aprobador es de cabecera O de algún ítem" — el
  // filtro debe reconocer al aprobador aunque la cabecera sea de otra persona, exactamente como
  // public.es_aprobador_de ya distingue en la base (ver postgres-repositories.test.ts).
  it("filtra por aprobador de ÍTEM, aunque la cabecera sea de otro aprobador", async () => {
    const rows = [
      requisition({ id: "req-item", approverId: "nelson", items: [item({ approverId: "juliana" }), item({ id: "item-2" })] }),
      requisition({ id: "req-ajena", approverId: "nelson" }),
    ];
    const { promise } = listReport(rows, { approverId: "juliana" });
    const report = await promise;
    expect(report.map((row) => row.id)).toEqual(["req-item"]);
  });

  it("filtra por etiqueta", async () => {
    const rows = [requisition({ id: "req-etiqueta-a", tagId: "tag-a" }), requisition({ id: "req-etiqueta-b", tagId: "tag-b" })];
    const { promise } = listReport(rows, { tagId: "tag-a" });
    expect((await promise).map((row) => row.id)).toEqual(["req-etiqueta-a"]);
  });

  // Centros de costo (UI, 2026-09-12): mismo contrato que workId/tagId/approverId — el filtro se le pasa
  // tal cual a listVisibleTo (el fake de este archivo no filtra por costCenterId, pero verifica que
  // ReportService.listReport lo propague sin transformarlo).
  it("propaga costCenterId al filtro de listVisibleTo", async () => {
    const { promise, calls } = listReport([requisition()], { costCenterId: "cc-1" });
    await promise;
    expect(calls[0]?.query).toMatchObject({ costCenterId: "cc-1" });
  });

  it("toReportRow expone el costCenterId EFECTIVO de la requisición", async () => {
    const rows = [requisition({ costCenterId: "cc-1" }), requisition({ id: "req-sin-centro" })];
    const report = await listReport(rows, {}).promise;
    expect(report.find((row) => row.id === "req-1")?.costCenterId).toBe("cc-1");
    expect(report.find((row) => row.id === "req-sin-centro")?.costCenterId).toBeUndefined();
  });

  it("mantiene obra y periodo (mes completo)", async () => {
    const rows = [
      requisition({ id: "req-agosto", workId: "obra-1", createdAt: "2026-08-15T00:00:00.000Z" }),
      requisition({ id: "req-septiembre", workId: "obra-1", createdAt: "2026-09-15T00:00:00.000Z" }),
      requisition({ id: "req-otra-obra", workId: "obra-2", createdAt: "2026-09-15T00:00:00.000Z" }),
    ];
    const { promise, calls } = listReport(rows, { workId: "obra-1", period: "2026-09" });
    const report = await promise;
    expect(report.map((row) => row.id)).toEqual(["req-septiembre"]);
    expect(calls[0]?.query).toMatchObject({ workId: "obra-1", from: "2026-09-01", to: "2026-09-30" });
  });

  it("suma base/IVA/total solo de los ítems NO declinados (mismo criterio que approvedLines)", async () => {
    const rows = [
      requisition({
        items: [
          item({ id: "aprobado", quantity: 2, unitBase: 1000, unitIva: 190, status: "aprobado" }),
          item({ id: "declinado", quantity: 100, unitBase: 5000, unitIva: 950, status: "declinado" }),
        ],
      }),
    ];
    const report = await listReport(rows, {}).promise;
    expect(report[0].base).toBe(2000);
    expect(report[0].iva).toBe(380);
    expect(report[0].total).toBe(2380);
  });

  it("aprobador(es) y proveedor(es) salen deduplicados de cabecera + ítems", async () => {
    const rows = [
      requisition({
        approverId: "juliana",
        items: [
          item({ id: "a", approverId: "juliana", finalSupplierId: "prov-1" }),
          item({ id: "b", approverId: "nelson", finalSupplierId: "prov-2" }),
          item({ id: "c", finalSupplierId: "prov-1" }),
        ],
      }),
    ];
    const report = await listReport(rows, {}).promise;
    expect(report[0].approverIds.sort()).toEqual(["juliana", "nelson"]);
    expect(report[0].supplierIds.sort()).toEqual(["prov-1", "prov-2"]);
  });

  it("respeta la visibilidad del repositorio: NO duplica ni sustituye el filtro por rol (le pasa el actor tal cual)", async () => {
    const rows = [requisition()];
    const { promise, calls } = listReport(rows, { approverId: "otro-id" }, ["aprobador"]);
    await promise;
    expect(calls[0]?.actor.roles).toEqual(["aprobador"]);
  });

  it("pagina hasta agotar el cursor, sin perder ni duplicar filas", async () => {
    const page1 = requisition({ id: "p1" }), page2 = requisition({ id: "p2" });
    const fn = vi.fn()
      .mockResolvedValueOnce({ rows: [page1], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({ rows: [page2], nextCursor: null });
    const service = new ReportService(fakeDeps(fn as unknown as ListVisibleTo));
    const report = await service.listReport({}, { actor: actor() });
    expect(report.map((row) => row.id)).toEqual(["p1", "p2"]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn.mock.calls[1]?.[1]?.cursor).toBe("cursor-1");
  });

  it("assertCanExport: contabilidad/aprobador pueden exportar, revisor no (aunque sí pueda leer)", () => {
    const service = new ReportService(fakeDeps(fakeListVisibleTo([]).fn));
    expect(() => service.assertCanExport(actor(["contabilidad"]))).not.toThrow();
    expect(() => service.assertCanExport(actor(["aprobador"]))).not.toThrow();
    expect(() => service.assertCanExport(actor(["revisor"]))).toThrow(DomainError);
  });
});

describe("toCashCloseReport — RF-708 (cierre de caja)", () => {
  const names: ReportCatalogNames = {
    works: new Map([["work-1", "Altos de La Pradera"]]), tags: new Map(), societies: new Map([["soc-1", "Constructora Mizar S.A.S."]]),
    users: new Map(), suppliers: new Map([["sup-1", "Pedro Topógrafo"]]), costCenters: new Map([["cc-1", "Administración"]]),
  };
  const payment = (overrides: Partial<CashPayment> = {}): CashPayment => ({
    id: "pay-1", orderId: "ord-1", date: "2026-09-14", amount: 640_000, method: "efectivo", orderConsecutive: "OP-2026-0007", orderType: "OP",
    requisitionId: "req-1", requisitionConsecutive: "REQ-2026-0041", workId: "work-1", costCenterId: "cc-1", billedCompanyId: "soc-1", supplierId: "sup-1", ...overrides,
  });

  it("resuelve beneficiario, obra, centro de costo y empresa facturada a nombre, y suma el total", () => {
    const report = toCashCloseReport([payment(), payment({ id: "pay-2", amount: 80_000 })], names, { from: "2026-09-14", to: "2026-09-18", costCenterId: "cc-1" });
    expect(report).toMatchObject({ from: "2026-09-14", to: "2026-09-18", costCenterId: "cc-1", total: 720_000 });
    expect(report.rows[0]).toMatchObject({ supplierName: "Pedro Topógrafo", workName: "Altos de La Pradera", costCenterName: "Administración", billedCompanyName: "Constructora Mizar S.A.S." });
  });

  it("un pago de una orden sin obra (N4: workId vacío) sale con '—', nunca con el id crudo ni vacío", () => {
    const report = toCashCloseReport([payment({ workId: "" }), payment({ id: "pay-2", workId: undefined, supplierId: "desconocido" })], names, { from: "2026-09-14", to: "2026-09-18" });
    expect(report.rows.map((row) => row.workName)).toEqual(["—", "—"]);
    expect(report.rows[1].supplierName).toBe("—");
    expect(report.costCenterId).toBeUndefined();
  });
});

describe("monthRange — RF-1301", () => {
  it("cubre el mes completo, incluidos meses de 28/30/31 días", () => {
    expect(monthRange("2026-09")).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" }); // bisiesto
    expect(monthRange("2026-01")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });
  it("rechaza un periodo mal formado", () => {
    expect(() => monthRange("2026-9")).toThrow(/INVALID_PERIOD/);
  });
});
