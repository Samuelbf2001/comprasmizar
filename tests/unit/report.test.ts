import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
import { buildOrderPdf, buildPartnersExpensePdf, buildProvisionalHelisaXlsx } from "../../lib/reports";
import { compareExactCop } from "../../scripts/compare-parity";

describe("report outputs", () => {
  const expenses = [{ date: "2026-08-01", work: "Obra A", tag: "Materiales", origin: "requisicion" as const, base: 100, iva: 19, total: 119 }];
  it("generates a clearly provisional workbook", async () => { const bytes = await buildProvisionalHelisaXlsx(expenses); expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe("PK"); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); expect(workbook.getWorksheet("Gastos provisional")?.getCell("A1").text).toContain("PROVISIONAL"); });
  it("generates nonempty paginated provisional PDFs and detects parity at the peso", async () => { expect((await buildOrderPdf({ consecutive: "OC-2026-0001", type: "OC", work: "Obra A", date: "2026-08-01", items: [{ description: "Cemento ".repeat(30), quantity: 1, unit: "und", total: 119 }], total: 119 })).byteLength).toBeGreaterThan(100); const volume = Array.from({ length: 100 }, (_, index) => ({ ...expenses[0], date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` })), partners = await PDFDocument.load(await buildPartnersExpensePdf("Gastos", volume)); expect(partners.getPageCount()).toBeGreaterThan(1); expect(compareExactCop([{ id: "a", total: 100 }], [{ id: "a", total: 99 }])).toEqual({ equal: false, differences: ["a: esperado 100, obtenido 99"] }); });
});
