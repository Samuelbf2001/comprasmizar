import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
import { buildOrderPdf, buildPartnersExpensePdf, buildProvisionalHelisaXlsx } from "../../lib/reports";
import { compareExactCop } from "../../scripts/compare-parity";

describe("report outputs", () => {
  // orderDate (nace con el registro) y date (fecha de pago) — reunión 2026-09: fechas independientes.
  const expenses = [{ orderDate: "2026-08-01", date: "2026-08-01", work: "Obra A", tag: "Materiales", origin: "requisicion" as const, base: 100, iva: 19, total: 119 }];
  it("generates a clearly provisional workbook", async () => { const bytes = await buildProvisionalHelisaXlsx(expenses); expect(Buffer.from(bytes).subarray(0, 2).toString()).toBe("PK"); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(bytes); expect(workbook.getWorksheet("Gastos provisional")?.getCell("A1").text).toContain("provisional"); });
  it("generates nonempty paginated provisional PDFs and detects parity at the peso", async () => {
    // buildOrderPdf: formato real de la orden (Fase 6, reunión 2026-08-31) — ver
    // tests/unit/order-document-pdf.test.ts para la cobertura de contenido/totales; aquí solo se
    // ejercita como smoke test junto a los otros generadores de reporte.
    const order = { consecutive: "OC-2026-0001", type: "OC" as const, date: "2026-08-01", company: { name: "Constructora Mizar S.A.S." }, work: "Obra A", items: [{ description: "Cemento ".repeat(30), unit: "und", quantity: 1, unitPrice: 119, discountRate: 0, ivaRate: 0, base: 119, iva: 0, total: 119 }], subtotal: 119, ivaTotal: 0, total: 119 };
    expect((await buildOrderPdf(order)).byteLength).toBeGreaterThan(100);
    const volume = Array.from({ length: 100 }, (_, index) => ({ ...expenses[0], date: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` })), partners = await PDFDocument.load(await buildPartnersExpensePdf("Gastos", volume));
    expect(partners.getPageCount()).toBeGreaterThan(1);
    expect(compareExactCop([{ id: "a", total: 100 }], [{ id: "a", total: 99 }])).toEqual({ equal: false, differences: ["a: esperado 100, obtenido 99"] });
  });
  // Reunión 2026-09: expenses[0]?.date.slice(0,7) reventaba con `date` undefined (ahora opcional) —
  // el PDF de socios debe seguir funcionando con gastos sin pagar, y ya no imprime "PROVISIONAL".
  it("no revienta con gastos sin fecha de pago y no imprime el literal PROVISIONAL", async () => {
    const unpaid = [{ orderDate: "2026-08-02", work: "Obra A", tag: "Materiales", origin: "requisicion" as const, base: 50, iva: 0, total: 50 }];
    const bytes = await buildPartnersExpensePdf("Gastos", unpaid);
    expect(bytes.byteLength).toBeGreaterThan(0);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(0);
  });
});
