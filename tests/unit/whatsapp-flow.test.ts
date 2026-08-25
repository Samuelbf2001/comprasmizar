import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type FlowComponent = { type: string; name?: string; required?: boolean; ["data-source"]?: unknown; ["on-click-action"]?: { name: string; next?: { type: string; name: string }; payload?: Record<string, unknown> } };
type FlowScreen = { id: string; terminal?: boolean; success?: boolean; layout: { type: string; children: FlowComponent[] } };
type FlowJson = { version: string; screens: FlowScreen[] };

const flowPath = resolve("integrations/whatsapp-flow/requisicion.flow.json");
const raw = readFileSync(flowPath, "utf8");
const flow = JSON.parse(raw) as FlowJson;

function findScreen(id: string): FlowScreen { const screen = flow.screens.find((candidate) => candidate.id === id); if (!screen) throw new Error(`Pantalla ${id} no encontrada`); return screen; }
function componentsOf(screen: FlowScreen): FlowComponent[] { return screen.layout.children; }
function footerOf(screen: FlowScreen): FlowComponent { const footer = componentsOf(screen).find((component) => component.type === "Footer"); if (!footer) throw new Error(`Pantalla ${screen.id} no tiene Footer`); return footer; }
function fieldByName(screen: FlowScreen, name: string): FlowComponent { const field = componentsOf(screen).find((component) => component.name === name); if (!field) throw new Error(`Campo ${name} no encontrado en ${screen.id}`); return field; }

describe("requisicion.flow.json — estructura", () => {
  it("es JSON válido y declara una versión soportada de Flow JSON", () => {
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(flow.version).toBe("7.3");
  });

  it("define las 4 pantallas requeridas por RF-902", () => {
    const ids = flow.screens.map((screen) => screen.id);
    expect(ids).toEqual(["TIPO_Y_OBRA", "ITEMS", "DATOS_SOLICITANTE", "RESUMEN"]);
  });

  it("tiene exactamente una pantalla terminal y es RESUMEN con success", () => {
    const terminals = flow.screens.filter((screen) => screen.terminal);
    expect(terminals).toHaveLength(1);
    expect(terminals[0].id).toBe("RESUMEN");
    expect(terminals[0].success).toBe(true);
  });

  it("TIPO_Y_OBRA es la pantalla de entrada: ninguna otra pantalla la referencia como next", () => {
    const referenced = flow.screens.flatMap((screen) => componentsOf(screen).flatMap((component) => component["on-click-action"]?.next?.name ? [component["on-click-action"]!.next!.name] : []));
    expect(referenced).not.toContain("TIPO_Y_OBRA");
    expect(referenced).toContain("ITEMS");
    expect(referenced).toContain("DATOS_SOLICITANTE");
    expect(referenced).toContain("RESUMEN");
  });

  it("cada pantalla no terminal navega hacia adelante y cada pantalla terminal completa", () => {
    for (const screen of flow.screens) {
      const footer = footerOf(screen);
      if (screen.terminal) expect(footer["on-click-action"]?.name).toBe("complete");
      else expect(footer["on-click-action"]?.name).toBe("navigate");
    }
  });

  it("pantalla 1: tipo de solicitud (compra|pago) y obra son requeridos, obra es dropdown data-driven", () => {
    const screen = findScreen("TIPO_Y_OBRA");
    const tipo = fieldByName(screen, "tipo_solicitud");
    expect(tipo.type).toBe("RadioButtonsGroup");
    expect(tipo.required).toBe(true);
    expect(tipo["data-source"]).toEqual([{ id: "compra", title: "Compra" }, { id: "pago", title: "Pago" }]);

    const obra = fieldByName(screen, "obra");
    expect(obra.type).toBe("Dropdown");
    expect(obra.required).toBe(true);
    expect(obra["data-source"]).toBe("${data.obras}"); // no viene quemada en el JSON: llega por data channel al enviar el flow
  });

  it("pantalla 2: el ítem 1 es obligatorio (descripción, cantidad, unidad); los ítems 2 y 3 son opcionales", () => {
    const screen = findScreen("ITEMS");
    for (const field of ["item_1_descripcion", "item_1_cantidad", "item_1_unidad"]) expect(fieldByName(screen, field).required).toBe(true);
    for (const n of [2, 3]) for (const suffix of ["descripcion", "cantidad", "unidad", "proveedor", "link", "catalogo"]) expect(fieldByName(screen, `item_${n}_${suffix}`).required ?? false).toBe(false);
  });

  it("pantalla 3: nombre, teléfono y fecha requerida son obligatorios; incluye un único selector de evidencia", () => {
    const screen = findScreen("DATOS_SOLICITANTE");
    expect(fieldByName(screen, "requester_name").required).toBe(true);
    expect(fieldByName(screen, "requester_phone").required).toBe(true);
    expect(fieldByName(screen, "fecha_requerida").type).toBe("DatePicker");

    const pickers = componentsOf(screen).filter((component) => component.type === "PhotoPicker" || component.type === "DocumentPicker");
    expect(pickers).toHaveLength(1); // Meta prohíbe combinar PhotoPicker y DocumentPicker en una misma pantalla
  });

  it("ningún componente PhotoPicker/DocumentPicker aparece en el payload de un navigate (restricción de Meta)", () => {
    for (const screen of flow.screens) {
      const navigateFooter = componentsOf(screen).find((component) => component["on-click-action"]?.name === "navigate");
      const payload = navigateFooter?.["on-click-action"]?.payload ?? {};
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toMatch(/evidencia/);
    }
  });

  it("el payload de complete es mapeable al contrato de KapsoFlowSubmission (workId, requiredDate, requesterName, phone, items)", () => {
    const resumen = findScreen("RESUMEN");
    const footer = footerOf(resumen);
    const payload = footer["on-click-action"]?.payload ?? {};
    for (const key of ["type", "workId", "requiredDate", "requesterName", "phone", "item_1_descripcion", "item_1_cantidad", "item_1_unidad"]) {
      expect(payload).toHaveProperty(key);
    }
  });
});
