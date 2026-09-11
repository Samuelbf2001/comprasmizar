import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Un diálogo de confirmación siempre va ENCIMA de lo que lo abrió. Parece obvio y por eso nadie lo
// comprobaba: `.quick-supplier-overlay` (useConfirmDialog y el alta rápida de proveedor) estaba en
// z-index 40 y `.supplier-overlay` (las fichas laterales de orden, proveedor y su editor) en 50, así
// que al confirmar "Marcar la orden como Contabilizada" desde la ficha de una orden, el diálogo se
// pintaba centrado en la página y la ficha lo tapaba.
//
// No se puede probar con jsdom, que no hace layout ni aplica la hoja de estilos: lo que se fija aquí
// es la INTENCIÓN, leyendo el CSS. Si alguien sube una capa por encima del diálogo, esto falla
// nombrando la regla culpable. La verificación de que además se ve encima se hizo en el navegador
// contra la hoja real (elementFromPoint sobre las dos capas apiladas).
const CSS = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");

/** z-index de un selector exacto, tal como está declarado en la hoja. */
function capaDe(selector: string): number {
  const regla = new RegExp(`${selector.replace(".", "\\.")}\\{[^}]*?z-index:(-?\\d+)`).exec(CSS);
  if (!regla) throw new Error(`no encontré z-index para ${selector} en app/globals.css`);
  return Number(regla[1]);
}

/** Todas las capas fijas declaradas, para que el diálogo se compare contra el techo real y no contra una lista a mano. */
function capasDeclaradas(): number[] {
  return [...CSS.matchAll(/z-index:(-?\d+)/g)].map(([, valor]) => Number(valor));
}

describe("orden de las capas fijas", () => {
  const DIALOGO = ".quick-supplier-overlay";
  const FICHA_LATERAL = ".supplier-overlay";

  it("el diálogo modal va por encima de las fichas laterales", () => {
    expect(capaDe(DIALOGO)).toBeGreaterThan(capaDe(FICHA_LATERAL));
  });

  it("el diálogo modal es la capa más alta de toda la hoja", () => {
    // Vale para CUALQUIER diálogo abierto desde CUALQUIER ficha, que es lo que se pidió: las tres
    // fichas (orden, proveedor, editor de proveedor) comparten `.supplier-overlay`, y todo diálogo de
    // confirmación comparte `.quick-supplier-overlay`. Si mañana aparece otra capa fija por encima,
    // esta prueba la caza antes de que un usuario vea otra vez una confirmación tapada.
    const techo = Math.max(...capasDeclaradas());
    expect(capaDe(DIALOGO), `hay una capa en z-index ${techo} por encima o al nivel del diálogo`).toBe(techo);
  });

  it("las fichas laterales siguen por encima del menú lateral y del topbar", () => {
    // La corrección no debía alterar el resto del orden: menú lateral 20, topbar 10.
    expect(capaDe(FICHA_LATERAL)).toBeGreaterThan(capaDe(".sidebar"));
    expect(capaDe(".sidebar")).toBeGreaterThan(capaDe(".topbar"));
  });
});
