import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { DomainError } from "../../lib/domain";
import { PostgresPorts } from "../../lib/infrastructure/postgres-repositories";

/**
 * `PostgresPorts` habla directamente con `postgres.js` via tagged-template (`this.sql\`...\``).
 * No hay Postgres real en este entorno, así que este arnés imita la única superficie que
 * importa: una función invocable como plantilla etiquetada que recibe (strings, ...values).
 * Cada llamada queda registrada en `calls` para poder inspeccionar qué SQL se emitió y con
 * qué parámetros — eso es "capturar las sentencias emitidas" sin tocar una base real.
 */
interface Call { text: string; values: unknown[]; }
function fakeSql(onQuery: (call: Call) => unknown = () => []) {
  const calls: Call[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const call: Call = { text: strings.join("?"), values };
    calls.push(call);
    return Promise.resolve(onQuery(call));
  }) as unknown as Sql & { calls: Call[] };
  (sql as unknown as { calls: Call[] }).calls = calls;
  return sql as unknown as Sql & { calls: Call[] };
}

/** Imita la forma de un error de Postgres real expuesta por postgres.js (code + constraint_name). */
function pgError({ code, constraint_name, message }: { code: string; constraint_name?: string; message?: string }): Error {
  const error = new Error(message ?? "postgres error") as Error & { code: string; constraint_name?: string };
  error.code = code;
  if (constraint_name) error.constraint_name = constraint_name;
  return error;
}

const baseItem = (id: string) => ({ id, itemId: "item-1", description: undefined, quantity: 1, unit: "unidad", possibleSupplier: undefined, productLink: undefined, finalSupplierId: undefined, unitBase: 1000, unitIva: 190 });
const baseRequisition = (overrides: Partial<Parameters<PostgresPorts["saveRequisition"]>[0]> = {}) => ({
  id: "req-1", consecutive: "REQ-2026-0001", type: "compra" as const, societyId: "soc-1", workId: "work-1", requesterId: "user-1",
  channel: "web" as const, requiredDate: "2026-08-30", tagId: undefined, approverId: undefined, status: "enviada" as const,
  items: [baseItem("l1"), baseItem("l2")], ...overrides,
});

describe("PostgresPorts.saveRequisition — upsert por línea, sin DELETE incondicional", () => {
  it("re-guardar las mismas líneas no dispara ningún DELETE incondicional; el borrado final es selectivo por los ids que sobreviven", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveRequisition(baseRequisition());
    await ports.saveRequisition(baseRequisition());

    const deletes = sql.calls.filter((call) => /^delete from requisicion_items/i.test(call.text));
    expect(deletes.length).toBeGreaterThan(0);
    // Ninguna sentencia de borrado de requisicion_items puede carecer del filtro selectivo: esta es
    // exactamente la regresión del bug original (DELETE incondicional antes de reinsertar).
    for (const del of deletes) expect(del.text).toMatch(/id <> all\(/);

    const lastDelete = deletes.at(-1)!;
    // El último parámetro es el conjunto de ids que se CONSERVA. Como la condición SQL es
    // `id <> all(conjunto)`, ningún id de ese conjunto puede ser borrado por esa sentencia —
    // esto se verifica matemáticamente, sin necesitar Postgres real detrás.
    expect(lastDelete.values.at(-1)).toEqual(["l1", "l2"]);
  });

  it("lista de ids vacía produce un borrado selectivo con array vacío tipado, no SQL roto", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveRequisition(baseRequisition({ items: [] }));

    const inserts = sql.calls.filter((call) => /^insert into requisicion_items/i.test(call.text));
    expect(inserts).toHaveLength(0);

    const deletes = sql.calls.filter((call) => /^delete from requisicion_items/i.test(call.text));
    expect(deletes).toHaveLength(1);
    // Verifica la FORMA de la sentencia (parámetro bien tipado, sin condicional roto), no su
    // ejecución contra una base real: el cast ::uuid[] evita 42P18 de inferencia de tipo.
    expect(deletes[0].text).toMatch(/::uuid\[\]/);
    expect(deletes[0].values.at(-1)).toEqual([]);
  });

  // B1 (QA Postgres real, verificado contra embedded-postgres 18.4): orden_items_requisicion_item_id_fkey
  // es ON DELETE RESTRICT, y RESTRICT emite restrict_violation (23001), NO foreign_key_violation
  // (23503) — el código original solo aceptaba "23503", así que NUNCA se disparaba contra Postgres real
  // y el borrado bloqueado caía como 500 crudo en vez de 422 ORDER_LINE_LOCKED. Este test falla con el
  // código previo (solo 23503) porque el primer caso del loop usa 23001 y no se traduce.
  it("un 23001 (RESTRICT real) o un 23503 (NO ACTION/diferido) sobre la FK exacta se traducen a DomainError ORDER_LINE_LOCKED; cualquier otro código o FK no se toca", async () => {
    for (const code of ["23001", "23503"]) {
      const sqlLocked = fakeSql((call) => {
        if (/^delete from requisicion_items/i.test(call.text)) throw pgError({ code, constraint_name: "orden_items_requisicion_item_id_fkey" });
        return [];
      });
      await expect(new PostgresPorts(sqlLocked).saveRequisition(baseRequisition())).rejects.toMatchObject({ code: "ORDER_LINE_LOCKED" });
      await expect(new PostgresPorts(fakeSql((call) => {
        if (/^delete from requisicion_items/i.test(call.text)) throw pgError({ code, constraint_name: "orden_items_requisicion_item_id_fkey" });
        return [];
      })).saveRequisition(baseRequisition())).rejects.toBeInstanceOf(DomainError);
    }

    // Caso negativo: una FK DISTINTA no debe traducirse — la traducción es quirúrgica, no un catch-all.
    const otherFkError = pgError({ code: "23001", constraint_name: "requisicion_items_item_id_fkey" });
    const sqlOtherFk = fakeSql((call) => { if (/^delete from requisicion_items/i.test(call.text)) throw otherFkError; return []; });
    const portsOtherFk = new PostgresPorts(sqlOtherFk);
    await expect(portsOtherFk.saveRequisition(baseRequisition())).rejects.toBe(otherFkError);

    // Caso negativo: un código ajeno (ni 23001 ni 23503) tampoco se traduce, aunque la FK sí coincida.
    const unrelatedCodeError = pgError({ code: "40001", constraint_name: "orden_items_requisicion_item_id_fkey" });
    const sqlUnrelated = fakeSql((call) => { if (/^delete from requisicion_items/i.test(call.text)) throw unrelatedCodeError; return []; });
    await expect(new PostgresPorts(sqlUnrelated).saveRequisition(baseRequisition())).rejects.toBe(unrelatedCodeError);
  });

  // B2 (QA Postgres real): iva_tasa debe distinguir "tasa 0% explícita" de "tasa sin capturar". Con
  // `${line.ivaRate ?? 0}` (el código previo) ambos casos escribían 0 — este test falla con ese código
  // porque exige NULL cuando ivaRate es undefined.
  describe("iva_tasa distingue tasa 0 explícita de tasa sin capturar (B2)", () => {
    // Orden de columnas del INSERT en requisicion_items: id(0), requisicion_id(1), item_id(2),
    // descripcion_libre(3), cantidad(4), unidad(5), posible_proveedor_texto(6), link_producto(7),
    // proveedor_final_id(8), valor_base(9), iva(10), iva_tasa(11), descuento_tasa(12), estado(13),
    // motivo_declinacion(14).
    const IVA_TASA_INDEX = 11;
    it("una línea sin ivaRate (undefined) escribe NULL en iva_tasa, no 0", async () => {
      const sql = fakeSql();
      const ports = new PostgresPorts(sql);
      const sinTasa = { ...baseItem("l1"), ivaRate: undefined };
      await ports.saveRequisition(baseRequisition({ items: [sinTasa] }));
      const insertItem = sql.calls.find((call) => /^insert into requisicion_items/i.test(call.text));
      expect(insertItem!.values[IVA_TASA_INDEX]).toBeNull();
    });
    it("una línea con ivaRate=0 explícito SÍ escribe 0 (tasa 0% capturada, distinta de 'sin capturar')", async () => {
      const sql = fakeSql();
      const ports = new PostgresPorts(sql);
      const tasaCero = { ...baseItem("l1"), ivaRate: 0 };
      await ports.saveRequisition(baseRequisition({ items: [tasaCero] }));
      const insertItem = sql.calls.find((call) => /^insert into requisicion_items/i.test(call.text));
      expect(insertItem!.values[IVA_TASA_INDEX]).toBe(0);
    });
    it("una línea con ivaRate=0.19 escribe la tasa tal cual", async () => {
      const sql = fakeSql();
      const ports = new PostgresPorts(sql);
      const tasa19 = { ...baseItem("l1"), ivaRate: 0.19 };
      await ports.saveRequisition(baseRequisition({ items: [tasa19] }));
      const insertItem = sql.calls.find((call) => /^insert into requisicion_items/i.test(call.text));
      expect(insertItem!.values[IVA_TASA_INDEX]).toBe(0.19);
    });
  });

  it("fecha_requerida sobrevive a un segundo guardado (reproduce el bug conocido si el on conflict la omite)", async () => {
    const store = new Map<string, { fecha_requerida: string }>();
    const sql = fakeSql((call) => {
      if (/^insert into requisiciones/i.test(call.text)) {
        // Índice 9: id(0), consecutivo(1), tipo(2), sociedad_id(3), obra_id(4), solicitante_id(5),
        // solicitante_nombre_externo(6), solicitante_telefono_externo(7), canal(8), fecha_requerida(9).
        const id = call.values[0] as string, requiredDate = call.values[9] as string;
        const existing = store.get(id);
        // Simula el ON CONFLICT: en un insert nuevo guarda fecha_requerida; en un conflicto solo
        // la actualiza si la sentencia realmente contiene "fecha_requerida = excluded.fecha_requerida".
        if (!existing) store.set(id, { fecha_requerida: requiredDate });
        else if (/fecha_requerida\s*=\s*excluded\.fecha_requerida/.test(call.text)) store.set(id, { fecha_requerida: requiredDate });
        return [];
      }
      return [];
    });
    const ports = new PostgresPorts(sql);
    await ports.saveRequisition(baseRequisition({ requiredDate: "2026-08-30" }));
    await ports.saveRequisition(baseRequisition({ requiredDate: "2026-09-15" }));

    expect(store.get("req-1")?.fecha_requerida).toBe("2026-09-15");
  });
});

describe("PostgresPorts.saveOrder — proveedor_id persistido y sin huérfanos en orden_items", () => {
  // Menor (QA Postgres real): antes fecha_generacion no se escribía y quedaba confiada al `default
  // now()` de la BD, ignorando value.generatedAt (el reloj inyectado del servicio).
  it("escribe fecha_generacion a partir de generatedAt, con coalesce a now() como red de seguridad", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveOrder({ id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", supplierId: "sup-1", itemIds: ["a"], status: "generada", adminStatus: "pendiente", generatedAt: "2026-08-24T12:00:00.000Z" });
    const insertOrdenes = sql.calls.find((call) => /^insert into ordenes/i.test(call.text));
    expect(insertOrdenes!.text).toMatch(/coalesce\(.*::timestamptz,\s*now\(\)\)/);
    expect(insertOrdenes!.values).toContain("2026-08-24T12:00:00.000Z");
  });
  it("proveedor_id se incluye en el on conflict do update de ordenes", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveOrder({ id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", supplierId: "sup-1", itemIds: ["a"], status: "generada", adminStatus: "pendiente" });

    const insertOrdenes = sql.calls.find((call) => /^insert into ordenes/i.test(call.text));
    expect(insertOrdenes).toBeDefined();
    expect(insertOrdenes!.text).toMatch(/proveedor_id\s*=\s*excluded\.proveedor_id/);
  });

  it("regenerar una orden con menos líneas no deja huérfanos en orden_items", async () => {
    const pares = new Set<string>();
    const sql = fakeSql((call) => {
      if (/^insert into orden_items/i.test(call.text)) { const [ordenId, itemId] = call.values as [string, string]; pares.add(`${ordenId}:${itemId}`); return []; }
      if (/^delete from orden_items/i.test(call.text)) {
        const [ordenId, itemIds] = call.values as [string, string[]];
        for (const clave of [...pares]) { const [o, i] = clave.split(":"); if (o === ordenId && !itemIds.includes(i)) pares.delete(clave); }
        return [];
      }
      return [];
    });
    const ports = new PostgresPorts(sql);
    await ports.saveOrder({ id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", supplierId: "sup-1", itemIds: ["a", "b", "c"], status: "generada", adminStatus: "pendiente" });
    expect([...pares].sort()).toEqual(["o1:a", "o1:b", "o1:c"]);

    await ports.saveOrder({ id: "o1", consecutive: "OC-2026-0001", type: "OC", requisitionId: "req-1", supplierId: "sup-1", itemIds: ["a"], status: "generada", adminStatus: "pendiente" });
    expect([...pares].sort()).toEqual(["o1:a"]);
  });
});
