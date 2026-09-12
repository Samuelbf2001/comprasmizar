import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { DomainError, type Actor } from "../../lib/domain";
import { PostgresPorts } from "../../lib/infrastructure/postgres-repositories";
import { decodeCursor, encodeCursor } from "../../lib/services/list-query";

/**
 * `PostgresPorts` habla directamente con `postgres.js` via tagged-template (`this.sql\`...\``).
 * No hay Postgres real en este entorno, así que este arnés imita la única superficie que
 * importa: una función invocable como plantilla etiquetada que recibe (strings, ...values).
 * Cada llamada queda registrada en `calls` para poder inspeccionar qué SQL se emitió y con
 * qué parámetros — eso es "capturar las sentencias emitidas" sin tocar una base real.
 *
 * H3 (docs/plan-rendimiento.md, Fase 3): los fragmentos condicionales (`this.sql\`\`` / `this.sql\`and
 * ...\``) que ahora usa el adaptador para filtros/paginación son "Fragments" perezosos en postgres.js
 * real — un `sql\`...\`` sin `await` no ejecuta nada por sí solo; se INLINEA (texto + parámetros, en
 * orden) dentro del `sql\`...\`` que lo recibe como valor interpolado, y solo el `await` de la plantilla
 * EXTERNA dispara una única llamada. `fakeSql` reproduce exactamente ese mecanismo: cada invocación
 * produce un objeto "fragmento" perezoso (con `strings`/`values` propios) que es a la vez thenable (para
 * que `await this.sql\`...\`` siga funcionando igual que antes) y aplanable (para que un fragmento
 * usado como valor interpolado en OTRA plantilla se inserte en su texto en vez de quedar como un
 * parámetro opaco). Con una plantilla sin fragmentos anidados esto colapsa exactamente al
 * comportamiento anterior (`strings.join("?")` + `values` tal cual), así que ningún test existente que
 * use `fakeSql` cambia de comportamiento.
 */
interface Call { text: string; values: unknown[]; }
interface Fragment { __fragment: true; flatten(): Call; then: Promise<unknown>["then"]; }
function isFragment(value: unknown): value is Fragment { return typeof value === "object" && value !== null && (value as { __fragment?: unknown }).__fragment === true; }
function fakeSql(onQuery: (call: Call) => unknown = () => []) {
  const calls: Call[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const flatten = (): Call => {
      let text = strings[0];
      const flatValues: unknown[] = [];
      for (let index = 0; index < values.length; index++) {
        const value = values[index];
        if (isFragment(value)) { const inner = value.flatten(); text += inner.text; flatValues.push(...inner.values); }
        else { text += "?"; flatValues.push(value); }
        text += strings[index + 1];
      }
      return { text, values: flatValues };
    };
    const fragment: Fragment = {
      __fragment: true,
      flatten,
      then: (onFulfilled, onRejected) => {
        const call = flatten();
        calls.push(call);
        return Promise.resolve(onQuery(call)).then(onFulfilled, onRejected);
      },
    };
    return fragment;
  }) as unknown as Sql & { calls: Call[] };
  (tag as unknown as { calls: Call[] }).calls = calls;
  return tag as unknown as Sql & { calls: Call[] };
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

  // Reunión 2026-09: aprobador_id lo asigna el revisor en review() y ya NO se deriva de etiqueta_id —
  // mismo bug que ya se pagó tres veces con fecha_requerida, obra_id y forma_pago: lo que no está en el
  // `on conflict do update set` se audita pero nunca se persiste.
  it("aprobador_id está en el on conflict do update de requisiciones y sobrevive a un segundo guardado", async () => {
    const store = new Map<string, { aprobador_id: string | null }>();
    const sql = fakeSql((call) => {
      if (/^insert into requisiciones/i.test(call.text)) {
        // Índice 12: ver comentario de columnas más arriba en este archivo (fecha_requerida=9,
        // observaciones=10, etiqueta_id=11, aprobador_id=12).
        const id = call.values[0] as string, aprobadorId = call.values[12] as string | null;
        const existing = store.get(id);
        if (!existing) store.set(id, { aprobador_id: aprobadorId });
        else if (/aprobador_id\s*=\s*excluded\.aprobador_id/.test(call.text)) store.set(id, { aprobador_id: aprobadorId });
        return [];
      }
      return [];
    });
    const ports = new PostgresPorts(sql);
    await ports.saveRequisition(baseRequisition({ approverId: "aprobador-1" }));
    const insertRequisicion = sql.calls.find((call) => /^insert into requisiciones/i.test(call.text));
    expect(insertRequisicion!.text).toMatch(/aprobador_id\s*=\s*excluded\.aprobador_id/);
    await ports.saveRequisition(baseRequisition({ approverId: "aprobador-2" }));
    expect(store.get("req-1")?.aprobador_id).toBe("aprobador-2");
  });

  // Centros de costo (2026-09-12): MISMO bug de clase que aprobador_id/fecha_requerida/obra_id/forma_pago
  // arriba — "ya van cuatro veces". review() escribe requisition.costCenterId en memoria; si esta
  // columna no estuviera en el `on conflict do update set`, el cambio se auditaría pero nunca sobreviviría
  // a un segundo guardado.
  it("centro_costo_id está en el on conflict do update de requisiciones y sobrevive a un segundo guardado", async () => {
    const store = new Map<string, { centro_costo_id: string | null }>();
    const sql = fakeSql((call) => {
      if (/^insert into requisiciones/i.test(call.text)) {
        // Índice 13: un puesto después de aprobador_id (12, ver el test de arriba).
        const id = call.values[0] as string, costCenterId = call.values[13] as string | null;
        const existing = store.get(id);
        if (!existing) store.set(id, { centro_costo_id: costCenterId });
        else if (/centro_costo_id\s*=\s*excluded\.centro_costo_id/.test(call.text)) store.set(id, { centro_costo_id: costCenterId });
        return [];
      }
      return [];
    });
    const ports = new PostgresPorts(sql);
    await ports.saveRequisition(baseRequisition({ costCenterId: "centro-1" }));
    const insertRequisicion = sql.calls.find((call) => /^insert into requisiciones/i.test(call.text));
    expect(insertRequisicion!.text).toMatch(/centro_costo_id\s*=\s*excluded\.centro_costo_id/);
    await ports.saveRequisition(baseRequisition({ costCenterId: "centro-2" }));
    expect(store.get("req-1")?.centro_costo_id).toBe("centro-2");
  });
});

describe("PostgresPorts.getRequisition / listVisibleRequisitions — aprobador_id ya no se resuelve por join con etiquetas", () => {
  it("getRequisition lee directamente de requisiciones, sin left join etiquetas", async () => {
    const sql = fakeSql((call) => (/^select \* from requisiciones/i.test(call.text) ? [{ id: "req-1", sociedad_id: "soc-1", tipo: "compra", canal: "web", estado: "enviada", consecutivo: "REQ-2026-0001" }] : []));
    const ports = new PostgresPorts(sql);
    await ports.getRequisition("req-1");
    const select = sql.calls.find((call) => /^select .* from requisiciones/i.test(call.text));
    expect(select!.text).not.toMatch(/etiquetas/i);
  });
  // La bandeja del aprobador no sale de un join con etiquetas — dos requisiciones con la MISMA
  // etiqueta pero aprobadores distintos ya no se confunden.
  //
  // Desde el aprobador por ítem (11-sep-2026) el criterio es `public.es_aprobador_de`: la cabecera
  // suya O algún ítem suyo. Se afirma la FUNCIÓN y no el predicado a mano a propósito — escrito a
  // mano estuvo copiado trece veces y se escaparon dos consultas (órdenes y gastos), con el
  // resultado de que un aprobador por ítem veía la requisición y luego una lista de órdenes vacía.
  it("un actor con rol aprobador lista con es_aprobador_de, sin join con etiquetas", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.listVisibleRequisitions({ id: "aprobador-1", roles: ["aprobador"] });
    const select = sql.calls.find((call) => /^select r\.\* from requisiciones/i.test(call.text));
    expect(select).toBeDefined();
    expect(select!.text).not.toMatch(/etiquetas/i);
    expect(select!.text).toMatch(/es_aprobador_de/);
    expect(select!.values).toContain("aprobador-1");
  });
  it("un revisor/admin ve todas las requisiciones sin filtrar por aprobador_id ni etiquetas", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.listVisibleRequisitions({ id: "daniel", roles: ["revisor"] });
    const select = sql.calls.find((call) => /^select r\.\* from requisiciones/i.test(call.text));
    expect(select!.text).not.toMatch(/etiquetas/i);
  });

  // RF-1301 (Reportes): el reporte de requisiciones usa `createdAt` como columna "fecha" y como base
  // del filtro de periodo/mes — antes se leía `created_at` en el WHERE pero nunca se exponía en el
  // objeto de dominio.
  it("getRequisition expone createdAt (created_at) en el objeto de dominio", async () => {
    const sql = fakeSql((call) => (/^select \* from requisiciones/i.test(call.text) ? [{ id: "req-1", sociedad_id: "soc-1", tipo: "compra", canal: "web", estado: "enviada", consecutivo: "REQ-2026-0001", created_at: "2026-09-10T08:00:00.000Z" }] : []));
    const requisition = await new PostgresPorts(sql).getRequisition("req-1");
    expect(requisition?.createdAt).toBe("2026-09-10T08:00:00.000Z");
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

// Reunión agosto 2026: pagos parciales de orden — `Order.paidAmount` resuelto en el MISMO select
// (left join lateral sobre pagos_orden), y el repositorio dedicado de pagos_orden.
describe("PostgresPorts — pagos parciales de orden (Order.paidAmount, saveOrderPayment, listOrderPayments)", () => {
  it("orderSelectColumns/orderFromJoins suman un left join lateral a pagos_orden y max(pago.pagado) as pagado_total", async () => {
    const sql = fakeSql((call) => (/^select o\.\*/i.test(call.text) ? [] : []));
    const ports = new PostgresPorts(sql);
    await ports.getOrder("o1");
    const select = sql.calls.find((call) => /^select o\.\*/i.test(call.text))!;
    expect(select.text).toMatch(/left join lateral \(select coalesce\(sum\(po\.valor\), 0\) as pagado from pagos_orden po where po\.orden_id = o\.id\) pago on true/);
    expect(select.text).toMatch(/max\(pago\.pagado\) as pagado_total/);
  });
  it("getOrder mapea pagado_total a Order.paidAmount (asNumber, no un string crudo del numeric)", async () => {
    const sql = fakeSql((call) => (/^select o\.\*/i.test(call.text)
      ? [{ id: "o1", consecutivo: "OC-2026-0001", tipo: "OC", requisicion_id: "req-1", estado_cumplimiento: "generada", pagado_total: "150.00" }]
      : []));
    const ports = new PostgresPorts(sql);
    const order = await ports.getOrder("o1");
    expect(order?.paidAmount).toBe(150);
  });
  // Ausente (no `0`) cuando el select no trae `pagado_total` — mismo criterio que
  // requisitionConsecutive/lines (ver el comentario de Order.paidAmount en lib/domain/model.ts):
  // "0" falso insinuaría "sin pagos" cuando en realidad es "no se preguntó".
  it("getOrder deja paidAmount undefined cuando la fila no trae pagado_total", async () => {
    const sql = fakeSql((call) => (/^select o\.\*/i.test(call.text)
      ? [{ id: "o1", consecutivo: "OC-2026-0001", tipo: "OC", requisicion_id: "req-1", estado_cumplimiento: "generada" }]
      : []));
    const ports = new PostgresPorts(sql);
    const order = await ports.getOrder("o1");
    expect(order?.paidAmount).toBeUndefined();
  });
  it("saveOrderPayment inserta en pagos_orden; los campos opcionales ausentes escriben NULL, no undefined", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveOrderPayment({ id: "pago-1", orderId: "orden-1", date: "2026-08-05", amount: 100, method: "efectivo" });
    const insert = sql.calls.find((call) => /^insert into pagos_orden/i.test(call.text));
    expect(insert).toBeDefined();
    expect(insert!.text).toMatch(/insert into pagos_orden \(id, orden_id, fecha, valor, medio_pago, referencia_externa, registrado_por\)/);
    expect(insert!.values).toEqual(["pago-1", "orden-1", "2026-08-05", 100, "efectivo", null, null]);
  });
  it("saveOrderPayment escribe referencia_externa/registrado_por cuando vienen informados", async () => {
    const sql = fakeSql();
    const ports = new PostgresPorts(sql);
    await ports.saveOrderPayment({ id: "pago-1", orderId: "orden-1", date: "2026-08-05", amount: 100, method: "transferencia", externalReference: "CONS-123", registeredBy: "daniel" });
    const insert = sql.calls.find((call) => /^insert into pagos_orden/i.test(call.text));
    expect(insert!.values).toEqual(["pago-1", "orden-1", "2026-08-05", 100, "transferencia", "CONS-123", "daniel"]);
  });
  // Mismo criterio que el índice pagos_orden_orden_fecha_idx (202609120002_pagos_orden.sql): orden
  // cronológico, el que necesita la ficha de la pantalla y la "fecha del último pago" del servicio.
  it("listOrderPayments filtra por orden_id y ordena por fecha, created_at", async () => {
    const sql = fakeSql((call) => (/^select \* from pagos_orden/i.test(call.text)
      ? [{ id: "pago-1", orden_id: "orden-1", fecha: "2026-08-05", valor: "100.00", medio_pago: "efectivo", referencia_externa: null, registrado_por: null }]
      : []));
    const ports = new PostgresPorts(sql);
    const rows = await ports.listOrderPayments("orden-1");
    const select = sql.calls.find((call) => /^select \* from pagos_orden/i.test(call.text))!;
    expect(select.text).toMatch(/where orden_id=\?/);
    expect(select.text).toMatch(/order by fecha, created_at/);
    expect(select.values).toEqual(["orden-1"]);
    expect(rows).toEqual([{ id: "pago-1", orderId: "orden-1", date: "2026-08-05", amount: 100, method: "efectivo", externalReference: undefined, registeredBy: undefined }]);
  });
});

// H3 (docs/plan-rendimiento.md, Fase 3): filtros y paginación por cursor. `uuid(n)` produce ids con
// forma válida de UUID v4 (versión "4", variante "8") — decodeCursor los valida con esa forma estricta,
// así que un fixture con ids como "1"/"2" rompería la propia prueba al decodificar el cursor que ella
// misma generó.
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("PostgresPorts.listVisibleRequisitions con query — filtros y paginación por cursor (H3)", () => {
  const row = (n: number, overrides: Record<string, unknown> = {}) => ({ id: uuid(n), consecutivo: `REQ-2026-000${n}`, tipo: "compra", sociedad_id: "soc-1", obra_id: "work-1", solicitante_id: "user-1", canal: "web", estado: "enviada", created_at: `2026-09-0${n}T10:00:00.000Z`, ...overrides });
  // .at(-1), no .find(): varias pruebas de este describe reutilizan el mismo `ports`/`sql` para varias
  // llamadas consecutivas (p.ej. la de visibilidad por rol) — `calls` acumula TODAS, así que hay que
  // pedir la última, no la primera.
  const selectOf = (sql: ReturnType<typeof fakeSql>) => sql.calls.filter((call) => /^select r\.\* from requisiciones/i.test(call.text)).at(-1);

  it("sin query, el SELECT no lleva límite ni fragmentos de filtro — comportamiento intacto", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [row(1)] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] });
    const select = selectOf(sql)!;
    expect(select.text).not.toMatch(/limit/i);
    expect(select.text).not.toMatch(/estado::text/);
  });

  it("aplica el filtro de estado (any) y de obra en el SELECT principal", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { status: ["enviada", "en_revision"], workId: "work-1" });
    const select = selectOf(sql)!;
    expect(select.text).toMatch(/r\.estado::text = any\(\?\)/);
    expect(select.values).toContainEqual(["enviada", "en_revision"]);
    expect(select.text).toMatch(/r\.obra_id = \?/);
    expect(select.values).toContain("work-1");
  });

  it("aplica from/to como rango inclusivo en ambos extremos sobre created_at", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { from: "2026-09-01", to: "2026-09-05" });
    const select = selectOf(sql)!;
    expect(select.text).toMatch(/r\.created_at >= \?::date/);
    expect(select.text).toMatch(/r\.created_at < \(\?::date \+ 1\)/);
    expect(select.values).toEqual(expect.arrayContaining(["2026-09-01", "2026-09-05"]));
  });

  it("visibilidad por rol: aprobador filtra por r.aprobador_id, solicitante por r.solicitante_id, elevado sin filtro", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    const ports = new PostgresPorts(sql);
    await ports.listVisibleRequisitions({ id: "nelson", roles: ["aprobador"] }, { limit: 10 });
    expect(selectOf(sql)!.text).toMatch(/es_aprobador_de\(r\.id, \?\)/);
    await ports.listVisibleRequisitions({ id: "sol", roles: ["solicitante"] }, { limit: 10 });
    expect(selectOf(sql)!.text).toMatch(/r\.solicitante_id = \?/);
    await ports.listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { limit: 10 });
    expect(selectOf(sql)!.text).not.toMatch(/es_aprobador_de|solicitante_id = \?/);
  });

  it("decodifica el cursor entrante y lo aplica como comparación de tupla (created_at, id) < (cursor)", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    const cursor = encodeCursor("2026-09-01T10:00:00.000Z", uuid(1));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { cursor });
    const select = selectOf(sql)!;
    expect(select.text).toMatch(/\(r\.created_at, r\.id\) < \(\?::timestamptz, \?::uuid\)/);
    expect(select.values).toEqual(expect.arrayContaining(["2026-09-01T10:00:00.000Z", uuid(1)]));
  });

  it("un cursor con forma inválida se rechaza como INVALID_INPUT antes de tocar la base", async () => {
    const sql = fakeSql();
    await expect(new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { cursor: "no-es-base64url-valido!!" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("cursor estable: nextCursor decodifica exactamente al created_at/id de la última fila de la página, cuando hay más", async () => {
    const page = [row(1), row(2), row(3)]; // 3 filas para limit=2 -> hay más
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? page : /^select \* from requisicion_items/i.test(call.text) ? [] : []));
    const result = await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { limit: 2 });
    if (Array.isArray(result)) throw new Error("se esperaba una Page");
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.id)).toEqual([uuid(1), uuid(2)]);
    expect(result.nextCursor).not.toBeNull();
    expect(decodeCursor(result.nextCursor!)).toEqual({ at: new Date(page[1].created_at).toISOString(), id: uuid(2) });
  });

  it("nextCursor es null cuando la página no llena el límite — última página", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [row(1)] : []));
    const result = await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { limit: 10 });
    if (Array.isArray(result)) throw new Error("se esperaba una Page");
    expect(result.rows).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("limit se acota a 200 y usa 100 por defecto cuando no viene (pageLimit)", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    const ports = new PostgresPorts(sql);
    await ports.listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { limit: 5000 });
    expect(selectOf(sql)!.values).toContain(201); // 200 + 1 (hasMore)
    await ports.listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, {});
    expect(selectOf(sql)!.values).toContain(101); // 100 + 1
  });

  // RF-1301 (Reportes, reunión 2026-09-11): filtros nuevos del reporte de requisiciones — etiqueta
  // (columna directa) y aprobador (misma función `public.es_aprobador_de` que ya resuelve la
  // visibilidad por rol, aquí aplicada al aprobador que el REPORTE pide ver, no al actor que consulta).
  it("aplica el filtro de etiqueta en el SELECT principal", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { tagId: "tag-1" });
    const select = selectOf(sql)!;
    expect(select.text).toMatch(/r\.etiqueta_id = \?/);
    expect(select.values).toContain("tag-1");
  });

  it("aplica el filtro de aprobador con public.es_aprobador_de (cabecera O ítem, no un predicado a mano)", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { approverId: "juliana" });
    const select = selectOf(sql)!;
    expect(select.text).toMatch(/es_aprobador_de\(r\.id, \?\)/);
    expect(select.values).toContain("juliana");
  });

  it("el filtro de aprobador del reporte y la visibilidad del actor conviven: cada uno aporta su propio parámetro a es_aprobador_de", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "nelson", roles: ["aprobador"] }, { approverId: "juliana" });
    const select = selectOf(sql)!;
    const matches = select.text.match(/es_aprobador_de\(r\.id, \?\)/g);
    expect(matches).toHaveLength(2);
    expect(select.values.filter((value) => value === "nelson" || value === "juliana")).toEqual(["nelson", "juliana"]);
  });

  it("sin tagId/approverId, el SELECT no lleva ninguno de los dos fragmentos", async () => {
    const sql = fakeSql((call) => (/^select r\.\* from requisiciones/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleRequisitions({ id: "daniel", roles: ["revisor"] }, { workId: "work-1" });
    const select = selectOf(sql)!;
    expect(select.text).not.toMatch(/etiqueta_id|es_aprobador_de/);
  });
});

describe("PostgresPorts.listVisibleOrders con query — filtros, join a requisiciones y paginación (H3)", () => {
  it("aplica el filtro de estado y de obra (vía join a requisiciones), y trae requisicion_consecutivo/requisicion_obra_id", async () => {
    const sql = fakeSql((call) => (/^select o\.\*/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleOrders({ id: "daniel", roles: ["revisor"] }, { status: ["generada"], workId: "work-1" });
    const select = sql.calls.find((call) => /^select o\.\*/i.test(call.text))!;
    expect(select.text).toMatch(/join requisiciones r on r\.id=o\.requisicion_id/);
    expect(select.text).toMatch(/r\.consecutivo as requisicion_consecutivo/);
    expect(select.text).toMatch(/o\.estado_cumplimiento::text = any\(\?\)/);
    expect(select.text).toMatch(/r\.obra_id = \?/);
    expect(select.values).toContainEqual(["generada"]);
  });

  // Revisión (corrección tras QA, docs/plan-rendimiento.md Fase 3): la pantalla de órdenes necesita,
  // en el MISMO SELECT, la fecha requerida de la requisición de origen y sus líneas con precio (para
  // restaurar la columna "Valor" y el filtro por fecha requerida sin volver a descargar TODAS las
  // requisiciones) — ver orderSelectColumns()/orderFromJoins() en postgres-repositories.ts.
  it("trae fecha_requerida (aliada) y un json_agg de las líneas de la orden, unido por orden_items", async () => {
    const sql = fakeSql((call) => (/^select o\.\*/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleOrders({ id: "daniel", roles: ["revisor"] });
    const select = sql.calls.find((call) => /^select o\.\*/i.test(call.text))!;
    expect(select.text).toMatch(/r\.fecha_requerida as requisicion_fecha_requerida/);
    expect(select.text).toMatch(/left join requisicion_items ri on ri\.id=oi\.requisicion_item_id/);
    expect(select.text).toMatch(/coalesce\(json_agg\(json_build_object\(/);
    expect(select.text).toMatch(/filter \(where ri\.id is not null\), '\[\]'\) as lines/);
    // BLOQUEANTE 1 (QA 2026-08-31): el total de la orden NUNCA se calcula en SQL — el
    // json_build_object solo transporta las columnas crudas de requisicion_items, sin ninguna
    // suma/multiplicación. La excepción explícita es `sum(po.valor)` (reunión agosto 2026,
    // `Order.paidAmount`): es una suma DISTINTA —cuánto se ha pagado de la orden, sobre
    // `pagos_orden`— que no toca `valor_base`/`iva`/`cantidad` de `requisicion_items` para nada.
    expect(select.text).not.toMatch(/sum\((?!po\.valor\))|valor_base\s*\*|valor_base\s*\+/);
  });

  it("pagina por fecha_generacion desc, id desc — nextCursor null en la última página", async () => {
    const sql = fakeSql((call) =>
      (/^select o\.\*/i.test(call.text)
        ? [{
            id: uuid(1), consecutivo: "OC-2026-0001", tipo: "OC", requisicion_id: uuid(9), estado_cumplimiento: "generada", estado_administrativo: "pendiente",
            fecha_generacion: "2026-09-01T10:00:00.000Z", requisicion_consecutivo: "REQ-2026-0001", requisicion_obra_id: "work-1",
            // Revisión (corrección tras QA): simula lo que postgres.js entrega ya decodificado para una
            // columna `date` (Date) y un `json_agg` (array de objetos) — order(row) debe parsear ambos.
            requisicion_fecha_requerida: new Date("2026-08-10T00:00:00.000Z"),
            lines: [{ id: "li-1", item_id: null, descripcion_libre: "Cemento gris", cantidad: 10, unidad: "bulto", posible_proveedor_texto: null, link_producto: null, proveedor_final_id: null, valor_base: 1000, iva: 190, estado: "pendiente", motivo_declinacion: null, iva_tasa: 0.19, descuento_tasa: 0 }],
          }]
        : []));
    const result = await new PostgresPorts(sql).listVisibleOrders({ id: "daniel", roles: ["revisor"] }, { limit: 10 });
    if (Array.isArray(result)) throw new Error("se esperaba una Page");
    expect(result.nextCursor).toBeNull();
    expect(result.rows[0]).toMatchObject({
      requisitionConsecutive: "REQ-2026-0001", workId: "work-1", requiredDate: "2026-08-10",
      lines: [{ id: "li-1", description: "Cemento gris", quantity: 10, unit: "bulto", unitBase: 1000, unitIva: 190, ivaRate: 0.19, discountRate: 0 }],
    });
    const select = sql.calls.find((call) => /^select o\.\*/i.test(call.text))!;
    expect(select.text).toMatch(/order by o\.fecha_generacion desc, o\.id desc/);
  });
});

describe("PostgresPorts.listVisibleExpenses con query — filtros y paginación por fecha_orden, no por fecha (H3)", () => {
  it("aplica el filtro de obra y de rango de fechas sobre g.fecha (fecha de PAGO), ignora status (gastos no tiene estado)", async () => {
    const sql = fakeSql((call) => (/^select g\.\* from gastos/i.test(call.text) ? [] : []));
    // "status" no existe en ListQuery para gastos en la práctica (las rutas no lo ofrecen), pero si
    // llegara igual el adaptador no debe reventar: se ignora en vez de fallar.
    await new PostgresPorts(sql).listVisibleExpenses({ id: "daniel", roles: ["revisor"] }, { workId: "work-1", from: "2026-09-01", to: "2026-09-05", status: ["ignorar-me"] });
    const select = sql.calls.find((call) => /^select g\.\* from gastos/i.test(call.text))!;
    expect(select.text).toMatch(/g\.obra_id = \?/);
    expect(select.text).toMatch(/g\.fecha >= \?::date/);
    expect(select.text).toMatch(/g\.fecha < \(\?::date \+ 1\)/);
    expect(select.text).not.toMatch(/estado/);
  });

  it("pagina por fecha_orden (NOT NULL), no por fecha (nullable mientras no se paga)", async () => {
    const sql = fakeSql((call) => (/^select g\.\* from gastos/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleExpenses({ id: "daniel", roles: ["revisor"] }, { limit: 10 });
    const select = sql.calls.find((call) => /^select g\.\* from gastos/i.test(call.text))!;
    expect(select.text).toMatch(/order by g\.fecha_orden desc, g\.id desc/);
  });

  // Centros de costo (2026-09-12): filtro aditivo, mismo patrón que workId — solo aparece en el SELECT
  // cuando la query lo trae, y compara contra la columna del GASTO (instantánea), no contra la obra.
  it("aplica el filtro de centro de costo (g.centro_costo_id) cuando la query lo trae, y lo omite cuando no", async () => {
    const sql = fakeSql((call) => (/^select g\.\* from gastos/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listVisibleExpenses({ id: "daniel", roles: ["revisor"] }, { costCenterId: "centro-1" });
    const select = sql.calls.find((call) => /^select g\.\* from gastos/i.test(call.text))!;
    expect(select.text).toMatch(/g\.centro_costo_id = \?/);
    expect(select.values).toContain("centro-1");

    const sinFiltro = fakeSql((call) => (/^select g\.\* from gastos/i.test(call.text) ? [] : []));
    await new PostgresPorts(sinFiltro).listVisibleExpenses({ id: "daniel", roles: ["revisor"] }, { limit: 10 });
    const selectSinFiltro = sinFiltro.calls.find((call) => /^select g\.\* from gastos/i.test(call.text))!;
    expect(selectSinFiltro.text).not.toMatch(/centro_costo_id/);
  });

  // `periodo` es `date` (columna generada) y postgres.js la entrega como Date: `String(Date)` da
  // "Tue Sep 01 2026 ..." y el antiguo `.slice(0, 7)` producía "Tue Sep", que nunca coincidía con
  // el "YYYY-MM" que comparan el filtro por periodo de la pantalla de gastos y calculateDashboard.
  it("mapea `periodo` (Date de la BD) a 'YYYY-MM' y deja undefined cuando el gasto no está pagado", async () => {
    const row = { id: "g1", obra_id: "work-1", origen: "requisicion", referencia_id: "o1", fecha_orden: new Date(Date.UTC(2026, 8, 3)), fecha: new Date(Date.UTC(2026, 8, 5)), periodo: new Date(Date.UTC(2026, 8, 1)), valor_base: "100", iva: "19", valor_total: "119" };
    const sql = fakeSql((call) => (/^select \* from gastos/i.test(call.text) ? [row, { ...row, id: "g2", fecha: null, periodo: null }] : []));
    const [paid, unpaid] = await new PostgresPorts(sql).listVisibleExpenses({ id: "daniel", roles: ["revisor"] }) as Array<{ period?: string; date?: string }>;
    expect(paid.period).toBe("2026-09");
    expect(paid.date).toBe("2026-09-05");
    expect(unpaid.period).toBeUndefined();
  });
});

// Centros de costo (2026-09-12): `saveExpense` inserta con `on conflict do nothing` — a diferencia de
// aprobador_id/centro_costo_id de requisiciones (arriba, que sobreviven a un REGUARDADO), aquí la única
// oportunidad de fijar el centro es el propio INSERT: no hay UPDATE posterior que lo arregle si falta.
describe("PostgresPorts.saveExpense — centro_costo_id viaja en el INSERT (única oportunidad, on conflict do nothing)", () => {
  it("incluye centro_costo_id en el INSERT cuando el gasto lo trae, y NULL cuando no", async () => {
    const sql = fakeSql(() => []);
    const ports = new PostgresPorts(sql);
    await ports.saveExpense({ id: "gasto-1", workId: "work-1", origin: "requisicion", referenceId: "orden-1", orderDate: "2026-09-12", base: 1000, iva: 190, total: 1190, costCenterId: "centro-1" });
    const insert = sql.calls.find((call) => /^insert into gastos/i.test(call.text))!;
    expect(insert.text).toMatch(/centro_costo_id/);
    expect(insert.values).toContain("centro-1");

    await ports.saveExpense({ id: "gasto-2", workId: "work-1", origin: "requisicion", referenceId: "orden-2", orderDate: "2026-09-12", base: 1000, iva: 190, total: 1190 });
    const segundoInsert = sql.calls.filter((call) => /^insert into gastos/i.test(call.text))[1]!;
    expect(segundoInsert.values).toContain(null);
  });
});

describe("PostgresPorts.listPettyCash con query — filtros y paginación (H3)", () => {
  it("filtra por obra y rango de fechas, sin fragmento de visibilidad (caja menor no tiene visibilidad por actor)", async () => {
    const sql = fakeSql((call) => (/^select c\.\* from caja_menor/i.test(call.text) ? [] : []));
    await new PostgresPorts(sql).listPettyCash({ workId: "work-1", from: "2026-09-01", to: "2026-09-05" });
    const select = sql.calls.find((call) => /^select c\.\* from caja_menor/i.test(call.text))!;
    expect(select.text).toMatch(/c\.obra_id = \?/);
    expect(select.text).toMatch(/c\.fecha >= \?::date/);
    expect(select.text).toMatch(/order by c\.fecha desc, c\.id desc/);
  });
});

describe("PostgresPorts — agregados del dashboard (H3): byStatus, pendingOrders, expenseByWork/Tag/Period", () => {
  it("dashboardByStatus agrupa por estado con la misma visibilidad que listVisibleRequisitions", async () => {
    const sql = fakeSql((call) => (/^select r\.estado, count/i.test(call.text) ? [{ estado: "enviada", total: "2" }, { estado: "aprobada", total: "1" }] : []));
    const byStatus = await new PostgresPorts(sql).dashboardByStatus({ id: "nelson", roles: ["aprobador"] });
    expect(byStatus).toEqual({ enviada: 2, en_revision: 0, en_aprobacion: 0, aprobada: 1, devuelta: 0, declinada: 0 });
    const select = sql.calls.find((call) => /^select r\.estado, count/i.test(call.text))!;
    expect(select.text).toMatch(/es_aprobador_de\(r\.id, \?\)/);
  });

  it("dashboardPendingCount cuenta órdenes generada/no_cumplida con visibilidad por actor", async () => {
    const sql = fakeSql((call) => (/^select count\(\*\) as total from ordenes/i.test(call.text) ? [{ total: "3" }] : []));
    const count = await new PostgresPorts(sql).dashboardPendingCount({ id: "daniel", roles: ["revisor"] });
    expect(count).toBe(3);
    const select = sql.calls.find((call) => /^select count\(\*\) as total from ordenes/i.test(call.text))!;
    expect(select.text).toMatch(/estado_cumplimiento in \('generada', 'no_cumplida'\)/);
  });

  it("dashboardAggregates compara periodo contra (period || '-01')::date, no con to_char en el WHERE", async () => {
    const sql = fakeSql((call) => {
      if (/^select coalesce\(sum/i.test(call.text)) return [{ period_expense: "500", in_process_value: "476" }];
      return [];
    });
    const aggregates = await new PostgresPorts(sql).dashboardAggregates({ id: "daniel", roles: ["revisor"] }, "2026-08");
    expect(aggregates.periodExpense).toBe(500);
    expect(aggregates.inProcessValue).toBe(476);
    const totals = sql.calls.find((call) => /^select coalesce\(sum/i.test(call.text))!;
    expect(totals.values).toContain("2026-08-01");
    expect(totals.text).toMatch(/g\.periodo = \?::date/);
  });
});

// UNA SOLA DEFINICIÓN DE "QUÉ VE UN APROBADOR", y una prueba que lo vigila.
//
// Contexto, porque la prueba sin él no se entiende: el aprobador por ítem (11-sep-2026) amplió esa
// visibilidad de "la cabecera es mía" a "la cabecera es mía O algún ítem es mío". El predicado estaba
// escrito A MANO en trece consultas, se ampliaron once y se escaparon dos —listVisibleOrders y
// listVisibleExpenses—, así que un aprobador por ítem veía su requisición y, al aprobarla, una lista
// de órdenes y de gastos vacías. No lo cazó la suite: lo cazó una prueba de humo contra producción.
//
// El arreglo de fondo no fue parchear las dos, fue quitar las trece copias: ahora todas llaman a
// `public.es_aprobador_de`, que vive en la migración 202609110004 y que el arnés SQL ya comprueba
// contra Postgres real (cabecera, ítem y ajeno). Estas dos pruebas son el cierre: una comprueba las
// dos consultas que se escaparon, la otra impide que vuelva a haber copias.
describe("visibilidad del aprobador: una sola definición", () => {
  const listasDelAprobador: Array<[string, (ports: PostgresPorts, actor: Actor) => Promise<unknown>]> = [
    ["listVisibleRequisitions", (ports, actor) => ports.listVisibleRequisitions(actor)],
    ["listVisibleOrders", (ports, actor) => ports.listVisibleOrders(actor)],
    ["listVisibleExpenses", (ports, actor) => ports.listVisibleExpenses(actor)],
  ];

  it.each(listasDelAprobador)("%s acota por es_aprobador_de, no por un predicado propio", async (_nombre, llamar) => {
    const sql = fakeSql();
    await llamar(new PostgresPorts(sql), { id: "juliana", roles: ["aprobador"] });
    const consultas = sql.calls.filter((call) => /requisiciones/i.test(call.text));
    expect(consultas.length).toBeGreaterThan(0);
    for (const consulta of consultas) {
      expect(consulta.text).toMatch(/es_aprobador_de/);
      expect(consulta.values).toContain("juliana");
    }
  });

  it("no queda ninguna copia a mano del predicado en el repositorio", () => {
    // Lo que falló no fue el criterio, fue tenerlo trece veces: escrito trece veces, la pregunta no es
    // si se olvidará una, es cuál. Esta prueba es barata y habría señalado las dos que se escaparon.
    const fuente = readFileSync(resolve(process.cwd(), "lib/infrastructure/postgres-repositories.ts"), "utf8");
    expect(fuente).not.toMatch(/r\.aprobador_id\s*=\s*\$\{actor\.id\}/);
  });
});
