import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type FlowComponent = { type: string; name?: string; label?: string; required?: boolean; ["data-source"]?: unknown; ["photo-source"]?: string; ["on-click-action"]?: { name: string; next?: { type: string; name: string }; payload?: Record<string, unknown> } };
type FlowScreen = { id: string; terminal?: boolean; success?: boolean; layout: { type: string; children: FlowComponent[] } };
type FlowJson = { version: string; screens: FlowScreen[] };

const flowPath = resolve("integrations/whatsapp-flow/requisicion.flow.json");
const raw = readFileSync(flowPath, "utf8");
const flow = JSON.parse(raw) as FlowJson;

function findScreen(id: string): FlowScreen { const screen = flow.screens.find((candidate) => candidate.id === id); if (!screen) throw new Error(`Pantalla ${id} no encontrada`); return screen; }
function componentsOf(screen: FlowScreen): FlowComponent[] { return screen.layout.children; }
function footerOf(screen: FlowScreen): FlowComponent { const footer = componentsOf(screen).find((component) => component.type === "Footer"); if (!footer) throw new Error(`Pantalla ${screen.id} no tiene Footer`); return footer; }
function fieldByName(screen: FlowScreen, name: string): FlowComponent { const field = componentsOf(screen).find((component) => component.name === name); if (!field) throw new Error(`Campo ${name} no encontrado en ${screen.id}`); return field; }

const ITEM_SCREENS = ["ARTICULO_UNO", "ARTICULO_DOS", "ARTICULO_TRES"] as const;

describe("requisicion.flow.json — estructura", () => {
  it("es JSON válido y declara una versión soportada de Flow JSON", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(flow.version).toBe("7.3");
  });

  it("define las 6 pantallas del diseño (un artículo por pantalla)", () => {
    const ids = flow.screens.map((screen) => screen.id);
    expect(ids).toEqual(["TIPO_Y_OBRA", "ARTICULO_UNO", "ARTICULO_DOS", "ARTICULO_TRES", "DETALLES", "RESUMEN"]);
  });

  it("los id de pantalla solo usan letras y guion bajo (Meta rechaza dígitos)", () => {
    for (const screen of flow.screens) expect(screen.id).toMatch(/^[A-Z_]+$/);
  });

  it("ningún label supera los 20 caracteres (límite duro de Meta para TextInput/TextArea/Dropdown)", () => {
    const largos: string[] = [];
    for (const screen of flow.screens) for (const c of componentsOf(screen)) {
      if (["TextInput", "TextArea", "Dropdown", "DatePicker", "PhotoPicker", "DocumentPicker"].includes(c.type) && c.label && c.label.length > 20) {
        largos.push(`${screen.id}/${c.name}: "${c.label}" (${c.label.length})`);
      }
    }
    expect(largos, `labels que superan 20: ${largos.join(", ")}`).toEqual([]);
  });

  it("tiene exactamente una pantalla terminal y es RESUMEN con success", () => {
    const terminals = flow.screens.filter((screen) => screen.terminal);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe("RESUMEN");
    expect(terminals[0].success).toBe(true);
  });

  it("TIPO_Y_OBRA es la pantalla de entrada y la navegación avanza en cadena", () => {
    const referenced = flow.screens.flatMap((screen) => componentsOf(screen).flatMap((component) => component["on-click-action"]?.next?.name ? [component["on-click-action"]!.next!.name] : []));
    expect(referenced).not.toContain("TIPO_Y_OBRA");
    for (const next of ["ARTICULO_UNO", "ARTICULO_DOS", "ARTICULO_TRES", "DETALLES", "RESUMEN"]) expect(referenced).toContain(next);
  });

  it("cada pantalla no terminal navega y la terminal completa", () => {
    for (const screen of flow.screens) {
      const footer = footerOf(screen);
      if (screen.terminal) expect(footer["on-click-action"]?.name).toBe("complete");
      else expect(footer["on-click-action"]?.name).toBe("navigate");
    }
  });

  it("pantalla 1: tipo (compra|pago) y obra requeridos, obra es dropdown data-driven", () => {
    const screen = findScreen("TIPO_Y_OBRA");
    const tipo = fieldByName(screen, "tipo_solicitud");
    expect(tipo.type).toBe("RadioButtonsGroup");
    expect(tipo.required).toBe(true);
    expect(tipo["data-source"]).toEqual([{ id: "compra", title: "Compra" }, { id: "pago", title: "Pago" }]);
    const obra = fieldByName(screen, "obra");
    expect(obra.type).toBe("Dropdown");
    expect(obra.required).toBe(true);
    expect(obra["data-source"]).toBe("${data.obras}"); // llega por data channel al enviar el flow
  });

  it("NO pide datos del solicitante: la identidad sale del número de WhatsApp, no del formulario", () => {
    const serialized = JSON.stringify(flow);
    expect(serialized).not.toMatch(/requester_name|requester_phone|requesterName/);
  });

  it("artículo 1 obligatorio; artículos 2 y 3 opcionales, cada uno en su propia pantalla", () => {
    for (const field of ["descripcion", "cantidad", "unidad"]) expect(fieldByName(findScreen("ARTICULO_UNO"), field).required).toBe(true);
    for (const id of ["ARTICULO_DOS", "ARTICULO_TRES"]) for (const field of ["descripcion", "cantidad", "unidad", "proveedor", "link", "catalogo"]) {
      expect(fieldByName(findScreen(id), field).required ?? false).toBe(false);
    }
  });

  it("cada artículo tiene su propio PhotoPicker con cámara (una foto por ítem)", () => {
    for (const id of ITEM_SCREENS) {
      const screen = findScreen(id);
      const pickers = componentsOf(screen).filter((c) => c.type === "PhotoPicker" || c.type === "DocumentPicker");
      expect(pickers, `${id} debe tener exactamente un selector de foto`).toHaveLength(1); // Meta: máx 1 picker por pantalla
      const foto = fieldByName(screen, "foto");
      expect(foto.type).toBe("PhotoPicker");
      expect(foto["photo-source"]).toBe("camera_gallery"); // tomar foto o galería
    }
  });

  it("DETALLES tiene fecha requerida y ya no lleva selector de foto (está por ítem)", () => {
    const screen = findScreen("DETALLES");
    expect(fieldByName(screen, "fecha_requerida").type).toBe("DatePicker");
    expect(componentsOf(screen).some((c) => c.type === "PhotoPicker" || c.type === "DocumentPicker")).toBe(false);
  });

  it("ningún selector de fotos aparece en el payload de un navigate (restricción de Meta)", () => {
    for (const screen of flow.screens) {
      const navigateFooter = componentsOf(screen).find((component) => component["on-click-action"]?.name === "navigate");
      const serialized = JSON.stringify(navigateFooter?.["on-click-action"]?.payload ?? {});
      expect(serialized).not.toMatch(/evidencia/);
    }
  });

  it("el complete mapea al contrato del webhook, sin nombre ni teléfono del formulario", () => {
    const payload = footerOf(findScreen("RESUMEN"))["on-click-action"]?.payload ?? {};
    for (const key of ["type", "workId", "requiredDate", "item_1_descripcion", "item_1_cantidad", "item_1_unidad", "item_1_foto", "item_2_foto", "item_3_foto"]) {
      expect(payload).toHaveProperty(key);
    }
    // La identidad la resuelve la lista blanca por teléfono; el Flow no debe enviarla.
    expect(payload).not.toHaveProperty("requesterName");
    expect(payload).not.toHaveProperty("phone");
    // Los ítems 1..3 salen de sus pantallas ARTICULO_* pero conservan las claves item_N_* del contrato.
    for (const n of [1, 2, 3]) expect(payload).toHaveProperty(`item_${n}_descripcion`);
  });

  it("cada artículo referencia el catálogo compartido declarado en TIPO_Y_OBRA", () => {
    for (const id of ITEM_SCREENS) expect(fieldByName(findScreen(id), "catalogo")["data-source"]).toBe("${screen.TIPO_Y_OBRA.data.catalogo}");
  });
});
