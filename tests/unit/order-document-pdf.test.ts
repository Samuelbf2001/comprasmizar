import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { buildOrderPdf } from "../../lib/reports";
import type { OrderDocument, OrderDocumentItem } from "../../lib/reports/types";

/**
 * pdf-lib comprime cada content stream con FlateDecode incluso con `useObjectStreams: false`
 * (verificado: `PDFDocument.save()` deja el texto ilegible en el buffer crudo). Sin una librería de
 * lectura de PDF en el repo, este helper infla cada bloque `stream…endstream` con `zlib` (nativo de
 * Node, sin dependencia nueva) y extrae los literales de texto de los operadores `Tj`/`TJ` — la
 * única superficie que hace falta para probar "el documento SÍ/NO contiene tal texto".
 */
function extractPdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const chunks: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue; // no era un stream Flate (p. ej. una fuente embebida) — se ignora, no es texto.
    }
    // pdf-lib codifica el operando de Tj/TJ como STRING HEXADECIMAL <...> (WinAnsiEncoding byte a
    // byte), no como literal entre paréntesis — verificado generando un PDF de prueba e inspeccionando
    // el content stream inflado a mano. Se soportan ambas formas por si acaso.
    for (const literal of content.matchAll(/\(((?:[^()\\]|\\.)*)\)|<([0-9A-Fa-f\s]+)>/g)) {
      if (literal[1] !== undefined) chunks.push(literal[1].replace(/\\([()\\])/g, "$1"));
      else if (literal[2] !== undefined) chunks.push(Buffer.from(literal[2].replace(/\s/g, ""), "hex").toString("latin1"));
    }
  }
  return chunks.join(" ");
}

const baseItem = (overrides: Partial<OrderDocumentItem> = {}): OrderDocumentItem => ({
  description: "Cemento gris 50kg", unit: "bulto", quantity: 10, unitPrice: 30_000, discountRate: 0, ivaRate: 0.19, base: 300_000, iva: 57_000, total: 357_000, ...overrides,
});

function baseOrder(overrides: Partial<OrderDocument> = {}): OrderDocument {
  const items = overrides.items ?? [baseItem()];
  const subtotal = items.reduce((sum, item) => sum + item.base, 0), ivaTotal = items.reduce((sum, item) => sum + item.iva, 0);
  return {
    consecutive: "OC-2026-0001", type: "OC", date: "2026-09-05",
    company: { name: "Constructora Mizar S.A.S.", nit: "900123456-1" }, work: "Obra La Pradera",
    supplier: { name: "Ferretería El Roble S.A.S.", nit: "800987654-2", contact: "Andrea Gómez", address: "Cra 10 # 20-30", email: "ventas@elroble.test", phone: "+57 300 555 1234" },
    items, subtotal, ivaTotal, total: subtotal + ivaTotal, paymentTerms: "Contado",
    elaboratedBy: "Daniel Ramírez", approvedBy: "Nelson Ortiz", observations: "Entregar en bodega 2",
    ...overrides,
  };
}

describe("buildOrderPdf — documento real de la orden (Fase 6, reunión 2026-08-31)", () => {
  it("no imprime UUIDs ni el literal 'Proveedor asignado'; sí imprime la obra por nombre y la razón social del proveedor", async () => {
    const uuidWork = "11111111-1111-4111-8111-111111111111", uuidItem = "33333333-3333-4333-8333-333333333333";
    const order = baseOrder({ work: "Obra La Pradera", items: [baseItem({ description: "Varilla 1/2 pulgada" })] });
    const text = extractPdfText(await buildOrderPdf(order));
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(text).not.toContain(uuidWork);
    expect(text).not.toContain(uuidItem);
    expect(text).not.toContain("Proveedor asignado");
    expect(text).toContain("Obra La Pradera");
    expect(text).toContain("Ferretería El Roble S.A.S.");
  });

  it("no repite el bloque empresa/NIT (el Excel original lo traía dos veces) y no imprime CÓDIGO/VERSIÓN ni T. ENTREGA", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder()));
    expect(text.split("Constructora Mizar S.A.S.")).toHaveLength(2); // aparece exactamente una vez
    expect(text).not.toContain("CÓDIGO");
    expect(text).not.toContain("VERSIÓN");
    expect(text).not.toContain("T. ENTREGA");
  });

  it("las observaciones viajan en el dato pero NO se imprimen (acuerdo explícito con el cliente)", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder({ observations: "Marcador-observacion-oculta-9f2c" })));
    expect(text).not.toContain("Marcador-observacion-oculta-9f2c");
  });

  it("imprime la fecha_generacion de la orden, no una fecha requerida de la requisición", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder({ date: "2026-09-05" })));
    expect(text).toContain("2026-09-05");
  });

  it("imprime firmas ELABORADO/APROBADO con nombres reales del sistema", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder({ elaboratedBy: "Daniel Ramírez", approvedBy: "Nelson Ortiz" })));
    expect(text).toContain("ELABORADO");
    expect(text).toContain("APROBADO");
    expect(text).toContain("Daniel Ramírez");
    expect(text).toContain("Nelson Ortiz");
  });

  it("Desc/IVA se imprimen como PORCENTAJE aunque el modelo los guarde como tasa (0..1)", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder({ items: [baseItem({ discountRate: 0.1, ivaRate: 0.19 })] })));
    expect(text).toContain("10%");
  });

  it("dos ítems, uno con descuento: subtotal/IVA/total impresos cuadran con la suma de líneas", async () => {
    // bruto=200_000 desc 10% -> base 180_000; segundo item sin desc, base 300_000. Subtotal 480_000.
    const conDescuento = baseItem({ description: "Ítem con descuento", quantity: 2, unitPrice: 100_000, discountRate: 0.1, ivaRate: 0.19, base: 180_000, iva: 34_200, total: 214_200 });
    const sinDescuento = baseItem({ description: "Ítem sin descuento", quantity: 1, unitPrice: 300_000, discountRate: 0, ivaRate: 0, base: 300_000, iva: 0, total: 300_000 });
    const order = baseOrder({ items: [conDescuento, sinDescuento], subtotal: 480_000, ivaTotal: 34_200, total: 514_200 });
    const text = extractPdfText(await buildOrderPdf(order));
    expect(order.subtotal).toBe(conDescuento.base + sinDescuento.base);
    expect(order.total).toBe(order.subtotal + order.ivaTotal);
    expect(text).toContain("Ítem con descuento");
    expect(text).toContain("Ítem sin descuento");
    // Literales, no `new Intl.NumberFormat(...)` con las MISMAS opciones que lib/reports/pdf.ts. Así
    // solo se comprobaba que el PDF llama a Intl, no lo que el cliente acaba leyendo: si ICU cambiara
    // el separador de miles o el espacio tras el "$", cambiaría en los dos lados a la vez y la prueba
    // no se enteraría. Mismo criterio que approval-flow.test.ts, que fija "$18.088.000" a mano.
    //
    // ` ` explícito, y no un espacio escrito: lo que ICU pone tras el "$" es un espacio DURO, y
    // en el código fuente es indistinguible de uno normal. Escribirlo así es lo único que hace
    // legible por qué esta cadena no se puede teclear a ojo.
    //
    // Si un día ICU cambia ese formato, esta prueba falla — y debe fallar: significa que la orden que
    // recibe el proveedor se ve distinta. Ahí se decide si se acepta el formato nuevo, no aquí.
    for (const esperado of ["$ 480.000", "$ 34.200", "$ 514.200", "$ 180.000", "$ 300.000"]) {
      expect(text).toContain(esperado);
    }
  });

  it("sin proveedor asignado todavía, muestra 'Por definir' en vez de un literal falso o un campo vacío", async () => {
    const text = extractPdfText(await buildOrderPdf(baseOrder({ supplier: undefined })));
    expect(text).toContain("Por definir");
  });

  it("paginación: repite el encabezado (razón social, obra, consecutivo) en la página siguiente", async () => {
    const items = Array.from({ length: 60 }, (_, index) => baseItem({ description: `Ítem de prueba número ${index + 1}` }));
    const subtotal = items.reduce((sum, item) => sum + item.base, 0), ivaTotal = items.reduce((sum, item) => sum + item.iva, 0);
    const text = extractPdfText(await buildOrderPdf(baseOrder({ items, subtotal, ivaTotal, total: subtotal + ivaTotal })));
    expect(text.split("Constructora Mizar S.A.S.").length).toBeGreaterThan(2);
  });
});
