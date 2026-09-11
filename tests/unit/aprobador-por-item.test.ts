import { describe, expect, it } from "vitest";
import { combinedDeclineReason, itemApproverId, pendingApproverIds, pendingItemsFor, canTransition, type ItemLine } from "../../lib/domain";

// APROBADOR POR ÍTEM. Ernesto, 11-sep-2026, corrigiendo la lectura de la reunión: «no es aprobador por
// tiempo, es aprobador por ítem: así como se puede declinar por ítem, se puede designar un aprobador
// para todo o aprobadores por ítems».
//
// Este archivo cubre las reglas PURAS (herencia, quién falta, motivo combinado, transición). El control
// de acceso —«no puedo decidir ítems ajenos»— vive en las pruebas de servicio, que es donde se aplica.
const linea = (id: string, extra: Partial<ItemLine> = {}): ItemLine => ({ id, description: `Ítem ${id}`, quantity: 1, unit: "und", ...extra });

describe("herencia del aprobador", () => {
  it("un ítem sin aprobador propio lo hereda de la cabecera", () => {
    // Es lo que deja intacto todo lo que ya está en vuelo: una requisición sin aprobadores por ítem se
    // decide exactamente como hasta hoy.
    expect(itemApproverId(linea("1"), "nelson")).toBe("nelson");
  });

  it("el suyo manda sobre el de la cabecera", () => {
    expect(itemApproverId(linea("1", { approverId: "sonia" }), "nelson")).toBe("sonia");
  });

  it("sin ninguno de los dos, nadie: no se inventa un aprobador", () => {
    // Una requisición en revisión todavía puede no tener aprobador. Devolver "" o el actor de turno
    // sería peor que devolver nada: cualquiera de los dos acabaría dejando decidir a quien no debe.
    expect(itemApproverId(linea("1"), undefined)).toBeUndefined();
  });
});

describe("a quién se le espera todavía", () => {
  const lineas = [
    linea("1", { approverId: "sonia", status: "aprobado" }),
    linea("2", { approverId: "sonia" }),
    linea("3"),
    linea("4", { status: "declinado", declineReason: "sin presupuesto" }),
  ];

  it("cuenta los pendientes por aprobador, resolviendo la herencia y sin repetir", () => {
    expect(pendingApproverIds(lineas, "nelson").sort()).toEqual(["nelson", "sonia"]);
  });

  it("un ítem ya decidido deja de esperar a nadie", () => {
    const todosDecididos = lineas.map((l) => ({ ...l, status: "aprobado" as const }));
    expect(pendingApproverIds(todosDecididos, "nelson")).toEqual([]);
  });

  it("«pendiente» es el estado por defecto: un ítem sin `status` sigue esperando", () => {
    // Las filas cargadas de BD traen 'pendiente' por defecto de columna, pero un objeto construido en
    // memoria puede no traer nada. Si `undefined` no contara como pendiente, una requisición recién
    // enviada a aprobación se daría por decidida y se cerraría sola.
    expect(pendingApproverIds([linea("1")], "nelson")).toEqual(["nelson"]);
  });

  it("pendingItemsFor devuelve solo lo del actor, no lo de los demás", () => {
    expect(pendingItemsFor("sonia", lineas, "nelson").map((l) => l.id)).toEqual(["2"]);
    expect(pendingItemsFor("nelson", lineas, "nelson").map((l) => l.id)).toEqual(["3"]);
  });
});

describe("motivo de cabecera cuando se declina todo", () => {
  it("arrastra los motivos de ítem sin repetirlos", () => {
    // `requisiciones_motivo_declinacion_check` EXIGE motivo al declinar y el trigger de historial lo
    // copia como comentario, así que esto no es cosmético: sin motivo, la base rechaza el cierre.
    const motivo = combinedDeclineReason([
      linea("1", { status: "declinado", declineReason: "sin presupuesto" }),
      linea("2", { status: "declinado", declineReason: "sin presupuesto" }),
      linea("3", { status: "declinado", declineReason: "llega tarde" }),
    ]);
    expect(motivo).toBe("Todos los ítems fueron declinados: sin presupuesto; llega tarde");
  });

  it("sin motivos escritos, uno genérico pero NUNCA vacío", () => {
    // Una cadena vacía volvería a romper el check de la base, que es justo lo que esto evita.
    expect(combinedDeclineReason([linea("1", { status: "declinado" })])).toBe("Todos los ítems fueron declinados.");
    expect(combinedDeclineReason([linea("1", { status: "declinado", declineReason: "   " })]).trim().length).toBeGreaterThan(0);
  });
});

describe("la transición que no existía", () => {
  it("en_aprobacion -> declinada ya es legal", () => {
    // Sin ella, una requisición con todos los ítems declinados se queda atascada en aprobación para
    // siempre. Va también en el trigger de Postgres (202609110004); el arnés SQL cubre ese lado.
    expect(canTransition("en_aprobacion", "declinada")).toBe(true);
  });

  it("y abrirla no abrió las demás", () => {
    expect(canTransition("declinada", "en_revision")).toBe(false);
    expect(canTransition("aprobada", "declinada")).toBe(false);
  });
});
