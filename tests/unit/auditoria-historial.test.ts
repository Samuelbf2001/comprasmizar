import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../../lib/domain";
import { PostgresAuditLogRepository } from "../../lib/infrastructure/audit-log-repository";
import { AuditLogService, collectRefs, decodeAuditCursor, encodeAuditCursor, type AuditLogQuery, type AuditLogRepository, type AuditLogRow, type AuditNameRefs, type AuditNames } from "../../lib/services/audit-log-service";

// HISTORIAL DE CAMBIOS (ADM-08 / RF-1003, 25-sep-2026). Lo que fija este archivo:
// - la puerta es el permiso `audit:read` (admin_sixteam, admin_mizar y revisor por defecto);
// - la paginación por cursor (fecha con microsegundos + id) no salta ni repite filas;
// - lo que sale está en lenguaje de negocio, sin UUID y sin datos sensibles aunque el evento los traiga;
// - el SQL repite el predicado del índice parcial y traduce cada filtro a un fragmento fijo.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DANIEL = "10000000-0000-4000-8000-000000000002";
const NELSON = "10000000-0000-4000-8000-000000000003";
const JULIANA = "10000000-0000-4000-8000-000000000005";
const SAMUEL = "10000000-0000-4000-8000-000000000009";
const REQ = "50000000-0000-4000-8000-000000000001";
const ORDER = "60000000-0000-4000-8000-000000000001";
const TAG = "70000000-0000-4000-8000-000000000001";
const SUPPLIER = "40000000-0000-4000-8000-000000000001";
const REQUESTER = "80000000-0000-4000-8000-000000000001";

const revisor: Actor = { id: DANIEL, roles: ["revisor", "aprobador"] };
const mizar: Actor = { id: "mizar", roles: ["admin_mizar"] };
const sixteam: Actor = { id: SAMUEL, roles: ["admin_sixteam"] };
const contabilidad: Actor = { id: "contab", roles: ["contabilidad"] };

let seq = 0;
function row(partial: Partial<AuditLogRow> & Pick<AuditLogRow, "entity" | "event">): AuditLogRow {
  seq += 1;
  return { id: String(1000 - seq), entityId: null, origin: "web", actorId: DANIEL, at: `2026-09-25T15:00:${String(59 - seq).padStart(2, "0")}.123456Z`, data: {}, ...partial };
}
const NAMES: Record<keyof AuditNameRefs, Record<string, string>> = {
  users: { [DANIEL]: "Daniel Hernández", [NELSON]: "Nelson Rincón", [JULIANA]: "Juliana Rojas", [SAMUEL]: "Samuel Sixteam" },
  works: {}, tags: { [TAG]: "Materiales" }, items: {}, suppliers: { [SUPPLIER]: "Cementos del Oriente" }, societies: {}, costCenters: {}, cashBoxes: {},
  requisitions: { [REQ]: "REQ-2026-0045" }, orders: { [ORDER]: "OC-2026-0012" }, expenses: {}, requisitionItems: {}, payments: {}, screens: {},
};
function fakeRepository(rows: AuditLogRow[]) {
  const queries: AuditLogQuery[] = [];
  const repository: AuditLogRepository = {
    async listPage(query) { queries.push(query); return rows.slice(0, query.limit + 1); },
    async resolveNames(refs) {
      return Object.fromEntries(Object.entries(refs).map(([kind, ids]) => [kind, new Map((ids as string[]).filter((id) => NAMES[kind as keyof AuditNameRefs][id]).map((id) => [id, NAMES[kind as keyof AuditNameRefs][id]]))])) as unknown as AuditNames;
    },
  };
  return { repository, queries, service: new AuditLogService({ repository }) };
}

describe("AuditLogService — permiso audit:read", () => {
  it("lo tienen por defecto admin_sixteam, admin_mizar y revisor; contabilidad no", async () => {
    const { service } = fakeRepository([]);
    await expect(service.list(revisor, {})).resolves.toEqual({ rows: [], nextCursor: null });
    await expect(service.list(mizar, {})).resolves.toEqual({ rows: [], nextCursor: null });
    await expect(service.list(sixteam, {})).resolves.toEqual({ rows: [], nextCursor: null });
    await expect(service.list(contabilidad, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("obedece la lista efectiva: un revisor al que Configuración le quitó el permiso no entra", async () => {
    const { service, queries } = fakeRepository([]);
    await expect(service.list({ ...revisor, permissions: ["requisition:review"] }, {})).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(queries).toHaveLength(0);
  });
});

describe("AuditLogService — paginación y filtros", () => {
  it("pide limit+1, devuelve limit y arma el cursor con la última fila; el cursor vuelve decodificado", async () => {
    const rows = Array.from({ length: 4 }, () => row({ entity: "requisicion", entityId: REQ, event: "APROBADA", data: { from: "en_aprobacion", to: "aprobada" } }));
    const { service, queries } = fakeRepository(rows);
    const page = await service.list(revisor, { limit: 3 });
    expect(page.rows).toHaveLength(3);
    expect(queries[0]).toMatchObject({ limit: 3 });
    expect(page.nextCursor).toBe(encodeAuditCursor(rows[2].at, rows[2].id));
    await service.list(revisor, { limit: 3, cursor: page.nextCursor!, entity: "requisicion", origin: "web", event: "aprobacion", actorId: DANIEL, from: "2026-09-01", to: "2026-09-30" });
    expect(queries[1]).toMatchObject({ cursor: { at: rows[2].at, id: rows[2].id }, entity: "requisicion", origin: "web", event: "aprobacion", actorId: DANIEL, from: "2026-09-01", to: "2026-09-30" });
  });
  it("sin más filas no hay cursor; limita a 100 y rechaza cursores y rangos inválidos", async () => {
    const { service, queries } = fakeRepository([row({ entity: "requisicion", entityId: REQ, event: "CREADA" })]);
    expect((await service.list(revisor, { limit: 500 })).nextCursor).toBeNull();
    expect(queries[0].limit).toBe(100);
    await expect(service.list(revisor, { cursor: "no-es-un-cursor" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.list(revisor, { cursor: Buffer.from(`2026-09-25T15:00:00.123456Z|${REQ}`).toString("base64url") })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.list(revisor, { from: "2026-09-30", to: "2026-09-01" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(decodeAuditCursor(encodeAuditCursor("2026-09-25T15:00:00.123456Z", "42"))).toEqual({ at: "2026-09-25T15:00:00.123456Z", id: "42" });
  });
});

describe("AuditLogService — lenguaje de negocio, sin UUID ni datos sensibles", () => {
  it("cuenta quién, qué pasó y sobre qué con nombres y consecutivos", async () => {
    const { service } = fakeRepository([
      row({ entity: "requisicion", entityId: REQ, event: "APROBADA", data: { from: "en_aprobacion", to: "aprobada", overrodeApprovers: [{ id: NELSON, name: "Nelson" }] } }),
      row({ entity: "tags", entityId: TAG, event: "ACTUALIZADA", data: { before: { name: "Materiales", approverId: NELSON, approverAssigned: true, active: true }, after: { name: "Materiales", approverId: JULIANA, approverAssigned: true, active: true } } }),
      row({ entity: "orden", entityId: ORDER, event: "PAGO_ANULADO", data: { paymentId: "90000000-0000-4000-8000-000000000001", amount: 150000, method: "transferencia", date: "2026-09-20", reason: "Pago duplicado" } }),
      row({ entity: "requisicion", entityId: REQ, event: "CREADA", actorId: null, data: { channel: "publico" } }),
      row({ entity: "sesion", entityId: NELSON, event: "CLAVE_RESTABLECIDA", actorId: DANIEL, data: { otrasSesionesCerradas: true } }),
      row({ entity: "requisicion", entityId: REQ, event: "APROBADOR_REASIGNADO", data: { previousApproverId: NELSON, approverId: JULIANA } }),
    ]);
    const { rows } = await service.list(revisor, {});
    expect(rows[0]).toMatchObject({ actor: "Daniel Hernández", action: "Aprobó la requisición por encima del aprobador asignado", subject: "REQ-2026-0045", entityLabel: "Requisición", origin: "web", originLabel: "Plataforma web" });
    expect(rows[0].details).toEqual(expect.arrayContaining([{ label: "Estado", before: "En aprobación", after: "Aprobada" }, { label: "Aprobó por encima de", value: "Nelson Rincón" }]));
    expect(rows[1]).toMatchObject({ action: "Cambió el aprobador de Nelson Rincón a Juliana Rojas", subject: "Materiales", entityLabel: "Etiqueta" });
    expect(rows[1].details).toEqual([{ label: "Aprobador", before: "Nelson Rincón", after: "Juliana Rojas" }]);
    expect(rows[2]).toMatchObject({ action: expect.stringMatching(/^Anuló un pago de \$\s150\.000$/), subject: "OC-2026-0012", entityLabel: "Pago" });
    expect(rows[2].details).toEqual(expect.arrayContaining([{ label: "Motivo de la anulación", value: "Pago duplicado" }, { label: "Fecha del pago", value: "20/09/2026" }]));
    expect(rows[3]).toMatchObject({ actor: "Portal público", action: "Radicó una requisición por el portal público", origin: "publico" });
    expect(rows[4]).toMatchObject({ actor: "Daniel Hernández", action: "Restableció la contraseña del usuario", subject: "Nelson Rincón" });
    expect(rows[5]).toMatchObject({ action: "Cambió el aprobador de Nelson Rincón a Juliana Rojas", subject: "REQ-2026-0045" });
    expect(JSON.stringify(rows)).not.toMatch(UUID_RE);
  });

  it("nunca muestra cédula/NIT, datos bancarios, correo, teléfono, contraseña ni hash, aunque el evento los traiga", async () => {
    const secretos = { nit: "900123456", identification: "71111111", email: "pagos@proveedor.test", phone: "+573001112233", address: "Calle 1 # 2-3", password: "clave-secreta-1", password_hash: "$2b$12$abcdefghijk", token_hash: "deadbeef", bankDetails: { cuenta: "0012345678", banco: "Banco X" }, datos_bancarios: { cuenta: "999" } };
    const { service } = fakeRepository([
      row({ entity: "proveedor", entityId: SUPPLIER, event: "ACTUALIZADO", data: { before: { name: "Cementos", active: true, ...secretos }, after: { name: "Cementos del Oriente", active: true, ...secretos, nit: "900999999" } } }),
      row({ entity: "users", entityId: NELSON, event: "CREADA", data: { after: { active: true, roles: ["aprobador"], ...secretos, name: "Nelson" } } }),
      row({ entity: "requesters", entityId: REQUESTER, event: "ACTUALIZADA", data: { before: { active: true, name: "Maestro Pérez", phone: "3001112233" }, after: { active: false, name: "Maestro Pérez", phone: "3001112233" } } }),
      row({ entity: "requisicion", entityId: REQ, event: "CABECERA_EDITADA", data: { requiredDate: "2026-10-01", observations: "Llamar al 3001112233, cédula 71111111" } }),
      row({ entity: "suppliers", entityId: SUPPLIER, event: "CREADA", data: { after: { name: "Cementos", nitConfigured: true, identificationType: "CC", identificationConfigured: true, contactConfigured: true, active: true, ...secretos } } }),
    ]);
    const { rows } = await service.list(sixteam, {});
    const dump = JSON.stringify(rows);
    for (const secreto of ["900123456", "900999999", "71111111", "pagos@proveedor.test", "3001112233", "Calle 1", "clave-secreta-1", "$2b$", "deadbeef", "0012345678", "Banco X", "Maestro Pérez"]) expect(dump).not.toContain(secreto);
    expect(dump).not.toMatch(UUID_RE);
    expect(rows[0]).toMatchObject({ action: "Editó el proveedor", subject: "Cementos del Oriente" });
    expect(rows[0].details).toEqual([{ label: "Nombre", before: "Cementos", after: "Cementos del Oriente" }]);
    expect(rows[1]).toMatchObject({ action: "Dio de alta al usuario", subject: "Nelson Rincón" });
    expect(rows[1].details).toEqual([{ label: "Estado", value: "Activo" }, { label: "Roles", value: "Aprobador" }]);
    expect(rows[2]).toMatchObject({ action: "Quitó la autorización a un solicitante de WhatsApp", subject: null });
    expect(rows[3].details).toEqual([{ label: "Fecha requerida", value: "01/10/2026" }, { label: "Observaciones", value: "Modificadas" }]);
    expect(rows[4].details).toEqual(expect.arrayContaining([{ label: "Tipo de identificación", value: "Cédula de ciudadanía" }, { label: "Identificación registrada", value: "Sí" }]));
  });

  it("un id que ya no se encuentra sale como «no disponible», nunca como UUID", async () => {
    const { service } = fakeRepository([row({ entity: "orden", entityId: "60000000-0000-4000-8000-00000000dead", event: "GENERADA", actorId: "10000000-0000-4000-8000-00000000dead", data: { requisitionId: "50000000-0000-4000-8000-00000000dead", supplierId: SUPPLIER } })]);
    const [entry] = (await service.list(revisor, {})).rows;
    expect(entry).toMatchObject({ actor: "Usuario no disponible", subject: "no disponible", action: "Generó la orden" });
    expect(entry.details).toEqual([{ label: "Requisición", value: "no disponible" }, { label: "Proveedor", value: "Cementos del Oriente" }]);
    expect(JSON.stringify(entry)).not.toMatch(UUID_RE);
  });

  it("los cambios de la matriz de permisos se cuentan por rol con el nombre de negocio del permiso", async () => {
    const { service } = fakeRepository([row({ entity: "configuracion", entityId: "00000000-0000-0000-0000-000000000002", event: "PERMISOS_POR_ROL_ACTUALIZADOS", actorId: SAMUEL, data: { roles: ["admin_sixteam"], antes: {}, despues: { contabilidad: ["order:read", "order:account", "dashboard:read", "payment:register"] } } })]);
    const [entry] = (await service.list(sixteam, {})).rows;
    expect(entry).toMatchObject({ actor: "Samuel Sixteam", action: "Cambió los permisos por rol", subject: "Permisos por rol" });
    expect(entry.details).toHaveLength(1);
    expect(entry.details[0].label).toBe("Contabilidad");
    expect(entry.details[0].value).toContain("Le dio: Registrar y anular pagos");
    expect(entry.details[0].value).toContain("Le quitó:");
  });

  it("collectRefs junta los ids a resolver sin repetirlos (actor, entidad, antes/después y aprobadores saltados)", () => {
    const refs = collectRefs([
      row({ entity: "tags", entityId: TAG, event: "ACTUALIZADA", data: { before: { approverId: NELSON }, after: { approverId: JULIANA } } }),
      row({ entity: "requisicion", entityId: REQ, event: "APROBADA", data: { overrodeApprovers: [{ id: NELSON }] } }),
      row({ entity: "adjunto", entityId: "90000000-0000-4000-8000-000000000009", event: "SOPORTE_DISPONIBLE", data: { parentEntity: "pago_orden", parentId: "90000000-0000-4000-8000-000000000001" } }),
    ]);
    expect(refs.users.sort()).toEqual([DANIEL, JULIANA, NELSON].sort());
    expect(refs.tags).toEqual([TAG]);
    expect(refs.requisitions).toEqual([REQ]);
    expect(refs.payments).toEqual(["90000000-0000-4000-8000-000000000001"]);
  });
});

// ---------------------------------------------------------------------------------------------
// SQL: mismo doble de postgres.js que tests/unit/postgres-repositories.test.ts (plantillas perezosas
// que se aplanan dentro de la plantilla que las recibe).
// ---------------------------------------------------------------------------------------------
interface Call { text: string; values: unknown[] }
interface Fragment { __fragment: true; flatten(): Call; then: Promise<unknown>["then"] }
const isFragment = (value: unknown): value is Fragment => typeof value === "object" && value !== null && (value as { __fragment?: unknown }).__fragment === true;
function fakeSql(onQuery: (call: Call) => unknown = () => []) {
  const calls: Call[] = [];
  const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const flatten = (): Call => {
      let text = strings[0];
      const flat: unknown[] = [];
      values.forEach((value, index) => {
        if (isFragment(value)) { const inner = value.flatten(); text += inner.text; flat.push(...inner.values); } else { text += "?"; flat.push(value); }
        text += strings[index + 1];
      });
      return { text, values: flat };
    };
    const fragment: Fragment = { __fragment: true, flatten, then: (ok, ko) => { const call = flatten(); calls.push(call); return Promise.resolve(onQuery(call)).then(ok, ko); } };
    return fragment;
  }) as unknown as Sql;
  return { sql: tag, calls };
}
const squash = (text: string) => text.replace(/\s+/g, " ");

describe("PostgresAuditLogRepository — SQL del historial", () => {
  it("repite el predicado del índice parcial, oculta ingresos y descargas por defecto y pide limit+1", async () => {
    const { sql, calls } = fakeSql();
    await new PostgresAuditLogRepository(sql).listPage({ limit: 50 });
    const text = squash(calls[0].text);
    expect(text).toContain("where a.evento not in ('INSERT', 'UPDATE', 'DELETE', 'STATE_CHANGE') and a.evento not like 'KAPSO\\_PROCESSING\\_%'");
    expect(text).toContain("and not ((a.entidad = 'sesion' and a.evento like 'SESION\\_%') or a.entidad in ('reporte', 'mcp') or a.evento like '%\\_DESCARGADO')");
    expect(text).toContain("order by a.fecha desc, a.id desc");
    expect(calls[0].values.at(-1)).toBe(51);
  });
  it("cada filtro es un fragmento fijo con sus valores como parámetros; las fechas van en hora de Colombia", async () => {
    const { sql, calls } = fakeSql();
    await new PostgresAuditLogRepository(sql).listPage({ limit: 10, from: "2026-09-01", to: "2026-09-30", actorId: DANIEL, entity: "pago", event: "pago", origin: "publico", cursor: { at: "2026-09-25T15:00:00.123456Z", id: "42" } });
    const text = squash(calls[0].text);
    expect(text).toContain("and a.entidad = 'orden' and a.evento in ('PAGO_REGISTRADO', 'PAGO_ANULADO')");
    expect(text).toContain("and a.origen = 'web' and a.usuario_id is null and a.entidad <> 'sesion'");
    expect(text).toContain("and (a.fecha, a.id) < (?::timestamptz, ?::bigint)");
    expect(text).not.toContain("and not ((a.entidad = 'sesion'");
    expect(calls[0].values).toEqual(["2026-09-01T00:00:00-05:00", "2026-10-01T05:00:00.000Z", DANIEL, ["PAGO_REGISTRADO", "PAGO_ANULADO", "GASTO_ANULADO"], "2026-09-25T15:00:00.123456Z", "42", 11]);
  });
  it("resolveNames solo consulta los tipos con ids válidos", async () => {
    const { sql, calls } = fakeSql((call) => (call.text.includes("from usuarios") ? [{ id: DANIEL, name: "Daniel Hernández" }] : []));
    const empty = { users: [DANIEL, "no-uuid"], works: [], tags: [], items: [], suppliers: [], societies: [], costCenters: [], cashBoxes: [], requisitions: [], orders: [], expenses: [], requisitionItems: [], payments: [], screens: [] };
    const names = await new PostgresAuditLogRepository(sql).resolveNames(empty);
    expect(calls).toHaveLength(1);
    expect(calls[0].values).toEqual([[DANIEL]]);
    expect(names.users.get(DANIEL)).toBe("Daniel Hernández");
  });
});

// ---------------------------------------------------------------------------------------------
// GET /api/audit: validación de filtros y permiso a través de la ruta.
// ---------------------------------------------------------------------------------------------
const routeMocks = vi.hoisted(() => ({ actor: { id: "x", roles: ["revisor"] as string[] } as { id: string; roles: string[]; permissions?: string[] }, queries: [] as unknown[] }));
vi.mock("../../lib/infrastructure/auth", () => ({ requireServerActor: async () => routeMocks.actor }));
vi.mock("../../lib/security/env", async (importOriginal) => ({ ...(await importOriginal<object>()), runtimeEnv: () => ({ DATABASE_URL: "postgres://test" }) }));
vi.mock("../../lib/infrastructure/postgres-repositories", () => ({
  sharedPostgres: () => {
    const tag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const fragment = { __fragment: true, strings, values, then: (ok: (value: unknown) => unknown) => { routeMocks.queries.push(strings.join("?")); return Promise.resolve([]).then(ok); } };
      return fragment;
    });
    return tag;
  },
}));

describe("GET /api/audit", () => {
  beforeEach(() => { routeMocks.actor = { id: DANIEL, roles: ["revisor"] }; routeMocks.queries = []; });
  it("responde { rows, nextCursor } a quien tiene audit:read", async () => {
    const { GET } = await import("../../app/api/audit/route");
    const response = await GET(new Request("https://app.mizar.test/api/audit?entity=requisicion&origin=web&limit=20"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [], nextCursor: null });
  });
  it("403 sin el permiso, sin consultar la base", async () => {
    routeMocks.actor = { id: "contab", roles: ["contabilidad"] };
    const { GET } = await import("../../app/api/audit/route");
    const response = await GET(new Request("https://app.mizar.test/api/audit"));
    expect(response.status).toBe(403);
    expect(routeMocks.queries).toHaveLength(0);
  });
  it("422 con filtros fuera de la lista cerrada (nada de texto libre hacia el SQL)", async () => {
    const { GET } = await import("../../app/api/audit/route");
    for (const query of ["entity=usuarios;drop", "origin=telefono", "event=todo", "from=25-09-2026", "actor=daniel", "limit=1000", "otro=1"]) {
      const response = await GET(new Request(`https://app.mizar.test/api/audit?${query}`));
      expect(response.status, query).toBe(422);
    }
    expect(routeMocks.queries).toHaveLength(0);
  });
});
