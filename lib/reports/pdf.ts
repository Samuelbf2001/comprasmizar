import { PDFDocument, StandardFonts } from "pdf-lib";
import type { OrderDocument, ReportExpense } from "./types";

const cop = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
/** Desc/IVA se guardan como TASA (0..1) en el modelo (reunión 2026-08-31); el documento impreso
 * siempre los muestra como porcentaje — nunca la fracción cruda. */
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

const PAGE: [number, number] = [595, 842];
const MARGIN = 50, BOTTOM = 65, RIGHT = 545;
const COLS = { desc: MARGIN, und: 300, cant: 335, precio: 375, discount: 460, total: 495 };

/**
 * Orden de compra/pago real — calcada de la hoja "ORDEN DE ANTICIPO" del Excel del cliente, ya
 * podada en la reunión 2026-08-31 (docs/reunion-2026-08-31-analisis.md): se elimina CÓDIGO/VERSIÓN,
 * el bloque EMPRESA+NIT repetido (solo aparece una vez), T. ENTREGA y las 6 líneas de observaciones
 * legales. Reemplaza al stub anterior, que imprimía un marcador de borrador en el título, el UUID crudo de la
 * obra y el literal "Proveedor asignado" — ver tests/unit/order-document-pdf.test.ts.
 */
export async function buildOrderPdf(order: OrderDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage(PAGE), y = 792;
  const text = (value: string, x: number, size = 9, useBold = false) => page.drawText(value, { x, y, size, font: useBold ? bold : font });
  const advance = (size = 9) => { y -= size + 5; };
  // Encabezado repetido en cada página (incluidas las de continuación de la tabla de ítems): razón
  // social + NIT UNA sola vez (el Excel original los repetía dos veces; "eso es repetitivo").
  const header = () => {
    text(order.company.name, MARGIN, 14, true); advance(14);
    if (order.company.nit) { text(`NIT ${order.company.nit}`, MARGIN, 9); advance(9); }
    text(`${order.type === "OC" ? "ORDEN DE COMPRA" : "ORDEN DE PAGO"} No. ${order.consecutive}`, MARGIN, 11, true); advance(11);
    text(`Fecha: ${order.date}`, MARGIN, 9); advance(9);
    text(`Obra: ${order.work}`, MARGIN, 9); advance(12);
  };
  let justPaged = false;
  const newPage = () => { page = pdf.addPage(PAGE); y = 792; header(); justPaged = true; };
  const ensureSpace = (needed: number) => { if (y - needed < BOTTOM) newPage(); };
  const tableHeader = () => {
    text("DESCRIPCION", COLS.desc, 9, true); text("UND", COLS.und, 9, true); text("CANT", COLS.cant, 9, true);
    text("Precio Unitario", COLS.precio, 9, true); text("Desc", COLS.discount, 9, true); text("Vr Total", COLS.total, 9, true);
    advance(9);
  };

  header();

  // Bloque proveedor — razón social, NIT, contacto, dirección, correo, teléfono/celular. "Por
  // definir" en vez de un literal falso cuando la orden aún no tiene proveedor asignado.
  text("PROVEEDOR", MARGIN, 10, true); advance(10);
  if (order.supplier) {
    text(order.supplier.name, MARGIN, 9); advance(9);
    if (order.supplier.nit) { text(`NIT: ${order.supplier.nit}`, MARGIN, 9); advance(9); }
    if (order.supplier.contact) { text(`Contacto: ${order.supplier.contact}`, MARGIN, 9); advance(9); }
    if (order.supplier.address) { text(`Dirección: ${order.supplier.address}`, MARGIN, 9); advance(9); }
    if (order.supplier.email) { text(`Correo: ${order.supplier.email}`, MARGIN, 9); advance(9); }
    if (order.supplier.phone) { text(`Teléfono/Celular: ${order.supplier.phone}`, MARGIN, 9); advance(9); }
  } else {
    text("Por definir", MARGIN, 9); advance(9);
  }
  advance(6);

  ensureSpace(9 * 2); tableHeader(); justPaged = false;
  for (const item of order.items) {
    ensureSpace(9 * 2);
    if (justPaged) { tableHeader(); justPaged = false; } // recién saltó de página: reimprime encabezado de columnas
    const description = item.description.length > 40 ? `${item.description.slice(0, 39)}…` : item.description;
    text(description, COLS.desc, 9); text(item.unit, COLS.und, 9); text(String(item.quantity), COLS.cant, 9);
    text(cop.format(item.unitPrice), COLS.precio, 9); text(pct(item.discountRate), COLS.discount, 9); text(cop.format(item.base), COLS.total, 9);
    advance(9);
  }

  advance(4);
  ensureSpace(9 * 4);
  text("Subtotal", COLS.precio, 9, true); text(cop.format(order.subtotal), COLS.total, 9); advance(9);
  text("IVA", COLS.precio, 9, true); text(cop.format(order.ivaTotal), COLS.total, 9); advance(9);
  text("TOTAL FACTURA", COLS.precio, 10, true); text(cop.format(order.total), COLS.total, 10, true); advance(12);

  if (order.paymentTerms) { ensureSpace(16); text(`Forma de pago: ${order.paymentTerms}`, MARGIN, 9); advance(14); }

  // Observaciones: viaja en el dato (order.observations) pero NO se imprime — acuerdo explícito con
  // el cliente en la reunión 2026-08-31. Descomentar activa el campo sin tocar nada más:
  // if (order.observations) { ensureSpace(16); text(`Observaciones: ${order.observations}`, MARGIN, 9); advance(14); }

  ensureSpace(9 * 2 + 10);
  text("ELABORADO", MARGIN, 9, true); text("APROBADO", MARGIN + (RIGHT - MARGIN) / 2, 9, true); advance(9);
  text(order.elaboratedBy ?? "—", MARGIN, 9); text(order.approvedBy ?? "—", MARGIN + (RIGHT - MARGIN) / 2, 9); advance(9);

  if (order.administrativeAddress) { ensureSpace(14); text(order.administrativeAddress, MARGIN, 8); }

  return pdf.save();
}

/**
 * Reunión 2026-09: `expense.date` (fecha de pago) es opcional — falta mientras la orden que originó
 * el gasto no se ha pagado. Antes `expenses[0]?.date.slice(0, 7)` reventaba en cuanto la primera fila
 * llegaba sin pagar (el `?.` solo protegía `expenses[0]`, no `.date`); ahora se busca el primer gasto
 * CON fecha de pago para el periodo del encabezado, y cada fila imprime sus dos fechas por separado
 * ("Fecha orden" siempre presente, "Fecha pago" o "Sin pagar"). De paso se retira del título el
 * marcador de borrador en mayúsculas que traía antes: ya estaba anotado como identificador técnico a
 * la vista.
 */
export async function buildPartnersExpensePdf(title: string, expenses: readonly ReportExpense[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let page = pdf.addPage([595, 842]), y = 790, total = 0, pageNumber = 1;
  const periodLabel = expenses.find((expense) => expense.date)?.date?.slice(0, 7) ?? "sin datos";
  const header = () => { page.drawText(title, { x: 50, y, size: 16, font: bold }); y -= 20; page.drawText(`Periodo: ${periodLabel} | Página ${pageNumber}`, { x: 50, y, size: 9, font }); y -= 20; };
  header();
  for (const expense of expenses) {
    if (y < 65) { page = pdf.addPage([595, 842]); pageNumber++; y = 790; header(); }
    total += expense.total;
    page.drawText(`${expense.orderDate} | ${expense.date ?? "Sin pagar"} | ${expense.work.slice(0, 25)} | ${(expense.tag ?? "").slice(0, 20)} | ${cop.format(expense.total)}`, { x: 50, y, size: 9, font });
    y -= 15;
  }
  if (y < 65) { page = pdf.addPage([595, 842]); y = 790; header(); }
  page.drawText(`TOTAL: ${cop.format(total)}`, { x: 50, y: y - 12, size: 13, font: bold });
  return pdf.save();
}
