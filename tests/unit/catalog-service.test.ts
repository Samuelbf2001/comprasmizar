import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../lib/domain";
import { CatalogService, canManageCatalog, type CatalogKind, type CatalogRecord, type ServiceDependencies } from "../../lib/services";

const reviewer = { id: "daniel", roles: ["revisor"] as const };
const mizarAdmin = { id: "mizar", roles: ["admin_mizar"] as const };
const sixteam = { id: "sixteam", roles: ["admin_sixteam"] as const };

function deps(options: { feature?: boolean; transactionFeature?: boolean; eligibleApprover?: boolean; failAudit?: boolean; uniqueViolation?: boolean; authUserExists?: boolean; triggerViolation?: "estado" | "rol"; worksWithRequisitions?: Set<string> } = {}) {
  const records = new Map<string, CatalogRecord>(), audits: AuditEvent[] = [];
  const catalog = {
    create: async (kind: CatalogKind, value: Omit<CatalogRecord, "id">) => { if (options.uniqueViolation) throw Object.assign(new Error("duplicate"), { code: "23505" }); // Todos los catálogos generan su id en la base, usuarios incluidos desde que la plataforma crea la
      // cuenta de acceso (antes el alta traía el id de Supabase Auth). La contraseña no forma parte del
      // registro guardado: se descarta aquí igual que el repositorio real, que solo la usa para el hash.
      const id = `id-${records.size + 1}`, campos = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([clave]) => clave !== "password")), created = { ...campos, id } as CatalogRecord; records.set(`${kind}:${id}`, structuredClone(created)); return created; },
    get: async (kind: CatalogKind, id: string) => records.get(`${kind}:${id}`) ? structuredClone(records.get(`${kind}:${id}`)!) : null,
    update: async (kind: CatalogKind, id: string, value: Partial<Omit<CatalogRecord, "id">>) => {
      const prior = records.get(`${kind}:${id}`); if (!prior) throw new Error("CATALOG_NOT_FOUND");
      // Simula los triggers de BD validar_baja_usuario_con_etiquetas_activas / validar_retiro_ultimo_rol_aprobador.
      if (kind === "users" && options.triggerViolation === "estado" && "active" in value) throw Object.assign(new Error("No se puede desactivar un aprobador con etiquetas activas; desactive o reasigne las etiquetas primero"), { code: "23514" });
      if (kind === "users" && options.triggerViolation === "rol" && "roles" in value) throw Object.assign(new Error("No se puede retirar el último rol elegible de un aprobador con etiquetas activas"), { code: "23514" });
      const next = { ...prior, ...value } as CatalogRecord; records.set(`${kind}:${id}`, structuredClone(next)); return next;
    },
    findSupplierDuplicate: async (value: { name: string; nit?: string }, exceptId?: string) => [...records.entries()].find(([key, record]) => key.startsWith("suppliers:") && record.id !== exceptId && (record.name.toLowerCase() === value.name.toLowerCase() || ("nit" in record && Boolean(value.nit) && record.nit === value.nit)))?.[1].id ?? null,
    // Simula telefono_normalizado con el mismo criterio de normalizeCoPhone: un local de 10 dígitos se
    // homologa anteponiendo "57"; cualquier otro largo solo pierde los no-dígitos.
    findRequesterDuplicate: async (phone: string, exceptId?: string) => { const digits = phone.replace(/[^0-9]/g, ""), normalized = digits.length === 10 ? `57${digits}` : digits; return [...records.entries()].find(([key, record]) => key.startsWith("requesters:") && record.id !== exceptId && "phone" in record && (() => { const other = String(record.phone).replace(/[^0-9]/g, ""); return (other.length === 10 ? `57${other}` : other) === normalized; })())?.[1].id ?? null; },
    isEligibleApprover: async () => options.eligibleApprover ?? true,
    // GRAVE 3: simula que una obra ya tiene requisiciones asociadas (para probar que patch() bloquea
    // el cambio de sociedad en ese caso).
    hasRequisitionsForWork: async (workId: string) => options.worksWithRequisitions?.has(workId) ?? false,
  };
  const audit = { append: async (event: AuditEvent) => { if (options.failAudit) throw new Error("audit failed"); audits.push(event); }, list: async () => [] as AuditEvent[] };
  const transaction = async <T>(_lock: string | undefined, work: (repositories: Parameters<ServiceDependencies["transactions"]["transaction"]>[1] extends (repositories: infer R) => Promise<unknown> ? R : never) => Promise<T>) => { const snapshot = structuredClone([...records.entries()]), auditSnapshot = structuredClone(audits); try { return await work({ catalogs: catalog, audit, requisitions: {} as never, orders: {} as never, expenses: {} as never, orderPayments: {} as never, pettyCash: {} as never, consecutives: {} as never, features: { isEnabled: async () => options.transactionFeature ?? options.feature ?? false }, items: {} as never, notifications: {} as never }); } catch (error) { records.clear(); for (const [key, value] of snapshot) records.set(key, value); audits.splice(0, audits.length, ...auditSnapshot); throw error; } };
  const service = new CatalogService({ transactions: { transaction }, audit, features: { isEnabled: async () => options.feature ?? false }, clock: { now: () => new Date("2026-08-24T00:00:00.000Z") } } as unknown as ServiceDependencies);
  return { service, records, audits };
}

describe("CatalogService", () => {
  it("does not expose the management view to operational or requester roles", () => { expect(canManageCatalog({ id: "sol", roles: ["solicitante"] }, "suppliers", true)).toBe(false); expect(canManageCatalog({ id: "approver", roles: ["aprobador"] }, "works", true)).toBe(false); expect(canManageCatalog(mizarAdmin, "items", true)).toBe(false); expect(canManageCatalog(mizarAdmin, "suppliers", false)).toBe(false); });
  it("honors the strongest role and rechecks Mizar feature in the write transaction", async () => { const service = deps({ feature: true, transactionFeature: false }).service; await expect(service.create("works", { name: "Bloqueada", societyId: "soc", active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FEATURE_DISABLED" }); const dualSix = { id: "dual-six", roles: ["admin_mizar", "admin_sixteam"] as const }, dualReviewer = { id: "dual-reviewer", roles: ["admin_mizar", "revisor"] as const }; const disabled = deps(); await expect(disabled.service.create("works", { name: "Permitida Sixteam", societyId: "soc", active: true }, dualSix)).resolves.toMatchObject({ name: "Permitida Sixteam" }); await expect(disabled.service.create("items", { name: "Permitido Daniel", unit: "und", active: true }, dualReviewer)).resolves.toMatchObject({ name: "Permitido Daniel" }); await expect(disabled.service.create("suppliers", { name: "Permitido proveedor", active: true }, dualReviewer)).resolves.toMatchObject({ name: "Permitido proveedor" }); });
  it("keeps item master ownership with reviewer/Sixteam even after Mizar self-service", async () => { const enabled = deps({ feature: true }); await expect(enabled.service.create("items", { name: "Cemento", unit: "bulto", active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" }); await expect(enabled.service.create("items", { name: "Cemento", unit: "bulto", active: true }, reviewer)).resolves.toMatchObject({ name: "Cemento", active: true }); await expect(enabled.service.create("items", { name: "Arena", unit: "m3", active: true }, sixteam)).resolves.toMatchObject({ name: "Arena" }); });
  it("permits only gated Mizar self-service and prevents reasonable supplier duplicates", async () => { const disabled = deps(); await expect(disabled.service.create("works", { name: "Obra Norte", societyId: "soc-1", active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FEATURE_DISABLED" }); const enabled = deps({ feature: true }); await expect(enabled.service.create("works", { name: "Obra Norte", societyId: "soc-1", active: true }, mizarAdmin)).resolves.toMatchObject({ name: "Obra Norte" }); await enabled.service.create("suppliers", { name: "Arenera Mizar", nit: "900-123", active: true }, mizarAdmin); await expect(enabled.service.create("suppliers", { name: "Arenera Mizar", phone: "+573001234567", active: true }, mizarAdmin)).rejects.toMatchObject({ code: "CONFLICT" }); await expect(enabled.service.create("works", { name: "No permitido", societyId: "soc-2", active: true }, reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" }); });
  it("translates database unique constraints into catalog conflicts", async () => { const race = deps({ uniqueViolation: true }); await expect(race.service.create("suppliers", { name: "Arenera concurrente", nit: "900999", active: true }, reviewer)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/proveedor/i) }); await expect(race.service.create("works", { name: "Obra duplicada", societyId: "soc", active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/catálogo/i) }); });
  it("requires an active eligible approver for active tags", async () => { const invalid = deps({ eligibleApprover: false }).service; await expect(invalid.create("tags", { name: "Sin aprobador", active: true }, sixteam)).rejects.toMatchObject({ code: "INVALID_INPUT" }); await expect(invalid.create("tags", { name: "Aprobador inactivo", approverId: "approver", active: true }, sixteam)).rejects.toMatchObject({ code: "INVALID_INPUT" }); const fixture = deps(), tag = await fixture.service.create("tags", { name: "Temporal", active: false }, sixteam); await expect(fixture.service.patch("tags", tag.id, { active: true }, sixteam)).rejects.toMatchObject({ code: "INVALID_INPUT" }); });
  it("deactivates reversibly and audits redacted before/after inside the UoW", async () => { const fixture = deps(), supplier = await fixture.service.create("suppliers", { name: "Proveedor Seguro", nit: "900123", phone: "+573001234567", email: "contacto@example.test", active: true }, reviewer); const patched = await fixture.service.patch("suppliers", supplier.id, { active: false }, reviewer); expect(patched).toMatchObject({ active: false }); expect(fixture.audits.at(-1)).toMatchObject({ event: "actualizada", data: { before: { nitConfigured: true, contactConfigured: true, active: true }, after: { active: false } } }); expect(JSON.stringify(fixture.audits)).not.toContain("300123"); expect(JSON.stringify(fixture.audits)).not.toContain("example.test"); const failing = deps({ failAudit: true }); await expect(failing.service.create("suppliers", { name: "Debe revertirse", active: true }, reviewer)).rejects.toThrow("audit failed"); expect(failing.records.size).toBe(0); });
  it("clears optional data durably and permits clearing an approver only while inactive", async () => { const fixture = deps(), supplier = await fixture.service.create("suppliers", { name: "Proveedor editable", nit: "900123", phone: "+573001234567", email: "contacto@example.test", address: "Calle 1", active: true }, reviewer); await fixture.service.patch("suppliers", supplier.id, { nit: null, phone: null, email: null, address: null }, reviewer); const reloadedSupplier = fixture.records.get(`suppliers:${supplier.id}`) as Extract<CatalogRecord, { nit?: string | null }>; expect(reloadedSupplier).toMatchObject({ nit: null, phone: null, email: null, address: null }); const item = await fixture.service.create("items", { name: "Ítem editable", unit: "und", specification: "detalle", category: "obra", active: true }, reviewer); await fixture.service.patch("items", item.id, { specification: null, category: null }, reviewer); expect(fixture.records.get(`items:${item.id}`)).toMatchObject({ specification: null, category: null }); const tag = await fixture.service.create("tags", { name: "Tag editable", approverId: "eligible", active: true }, sixteam); await expect(fixture.service.patch("tags", tag.id, { approverId: null }, sixteam)).rejects.toMatchObject({ code: "INVALID_INPUT" }); await expect(fixture.service.patch("tags", tag.id, { approverId: null, active: false }, sixteam)).resolves.toMatchObject({ approverId: null, active: false }); });

  // RF-002: sociedades — solo admin_sixteam y admin_mizar, sin depender del autoservicio de catálogos.
  it("permite administrar sociedades a admin_sixteam y admin_mizar, y bloquea a los demás roles", async () => {
    expect(canManageCatalog(mizarAdmin, "societies", false)).toBe(true);
    expect(canManageCatalog(sixteam, "societies", false)).toBe(true);
    expect(canManageCatalog(reviewer, "societies", true)).toBe(false);
    const disabledFeature = deps({ feature: false });
    await expect(disabledFeature.service.create("societies", { name: "Sociedad Norte", nit: "900-1", active: true }, mizarAdmin)).resolves.toMatchObject({ name: "Sociedad Norte" });
    await expect(disabledFeature.service.create("societies", { name: "Otra", active: true }, reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(disabledFeature.service.create("societies", { name: "Otra", active: true }, { id: "solicitante", roles: ["solicitante"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("traduce el choque de nombre/NIT de sociedades a un conflicto claro", async () => { const race = deps({ uniqueViolation: true }); await expect(race.service.create("societies", { name: "Sociedad duplicada", active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/sociedad/i) }); });

  // RF-004: usuarios — exclusivo de admin_sixteam; nunca crea la cuenta en auth.users.
  it("bloquea por completo a admin_mizar en usuarios, incluido el intento de crear otro admin_sixteam", async () => {
    expect(canManageCatalog(mizarAdmin, "users", true)).toBe(false);
    const fixture = deps();
    await expect(fixture.service.create("users", { password: "clave-inicial-123", name: "Usuario común", email: "comun@example.test", roles: ["solicitante"], active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Requisito de seguridad explícito: ni siquiera intentando asignarse el rol admin_sixteam.
    await expect(fixture.service.create("users", { password: "clave-inicial-123", name: "Intento admin", email: "intento@example.test", roles: ["admin_sixteam"], active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fixture.records.size).toBe(0);
  });
  // Alta de usuarios (2026-09-11): la plataforma dejó de exigir una cuenta preexistente y ahora la
  // CREA. Lo que esta prueba fija no es el insert (eso vive en el repositorio y lo cubre el arnés
  // contra Postgres real), sino el contrato del servicio: la contraseña entra y NO vuelve a salir.
  it("crea la cuenta de acceso y nunca devuelve ni registra la contraseña", async () => {
    const fixture = deps();
    const creado = await fixture.service.create("users", { password: "clave-inicial-123", name: "Nueva Persona", email: "nueva@example.test", roles: ["solicitante"], active: true }, sixteam);
    expect(creado.id).toBeTruthy();
    expect(creado).not.toHaveProperty("password");
    // Ni en el registro devuelto, ni en la auditoría, ni en el estado que queda guardado.
    expect(JSON.stringify(fixture.audits)).not.toContain("clave-inicial-123");
    expect(JSON.stringify([...fixture.records.values()])).not.toContain("clave-inicial-123");
  });
  it("audita usuarios sin nombre/correo/teléfono (PII) pero sí con roles y estado", async () => {
    const fixture = deps(), user = await fixture.service.create("users", { password: "clave-inicial-123", name: "Ana Pérez", email: "ana.perez@example.test", phone: "+573001112233", roles: ["revisor", "aprobador"], active: true }, sixteam);
    expect(fixture.audits.at(-1)).toMatchObject({ event: "creada", data: { after: { active: true, roles: ["aprobador", "revisor"] } } });
    const dump = JSON.stringify(fixture.audits);
    expect(dump).not.toContain("Ana Pérez"); expect(dump).not.toContain("ana.perez@example.test"); expect(dump).not.toContain("3001112233");
    const patched = await fixture.service.patch("users", user.id, { roles: ["contabilidad"], active: false }, sixteam);
    expect(patched).toMatchObject({ roles: ["contabilidad"], active: false });
    expect(fixture.audits.at(-1)).toMatchObject({ event: "actualizada", data: { before: { active: true, roles: ["aprobador", "revisor"] }, after: { active: false, roles: ["contabilidad"] } } });
  });
  it("traduce a mensajes claros los triggers que protegen a un aprobador con etiquetas activas", async () => {
    const withActiveTags = deps({ triggerViolation: "estado" }), approver = await withActiveTags.service.create("users", { password: "clave-inicial-123", name: "Aprobador", email: "aprobador@example.test", roles: ["aprobador"], active: true }, sixteam);
    await expect(withActiveTags.service.patch("users", approver.id, { active: false }, sixteam)).rejects.toMatchObject({ code: "APPROVER_HAS_ACTIVE_TAGS" });
    const withLastRole = deps({ triggerViolation: "rol" }), approver2 = await withLastRole.service.create("users", { password: "clave-inicial-123", name: "Aprobador 2", email: "aprobador2@example.test", roles: ["aprobador"], active: true }, sixteam);
    await expect(withLastRole.service.patch("users", approver2.id, { roles: ["contabilidad"] }, sixteam)).rejects.toMatchObject({ code: "LAST_APPROVER_ROLE" });
  });
  it("traduce el correo duplicado de usuarios a un conflicto claro", async () => { const race = deps({ uniqueViolation: true }); await expect(race.service.create("users", { password: "clave-inicial-123", name: "Duplicado", email: "duplicado@example.test", roles: ["solicitante"], active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/usuario/i) }); });

  // GRAVE 3 (QA Postgres real): mover una obra de sociedad deja sus requisiciones inservibles (23514
  // contra Postgres real). Se bloquea aquí, en el servicio de catálogos, en vez de reventar en la BD.
  it("bloquea cambiar la sociedad de una obra que ya tiene requisiciones, pero permite otros cambios y el cambio de sociedad sin requisiciones", async () => {
    const withReqs = deps({ feature: true, worksWithRequisitions: new Set(["work-1"]) });
    const work = await withReqs.service.create("works", { name: "Obra Norte", societyId: "soc-1", active: true }, mizarAdmin);
    // El fake genera el id de la primera obra creada como "id-1", pero el chequeo de este test debe
    // correr sobre un id conocido de antemano: se reasigna manualmente en `records` a "work-1" antes
    // de patchear, para no acoplar el test al contador interno del fake.
    withReqs.records.delete(`works:${work.id}`);
    withReqs.records.set("works:work-1", { ...work, id: "work-1" });
    await expect(withReqs.service.patch("works", "work-1", { societyId: "soc-2" }, mizarAdmin)).rejects.toMatchObject({ code: "WORK_HAS_REQUISITIONS" });
    // Cambiar OTRO campo (no societyId) de esa misma obra sigue permitido.
    await expect(withReqs.service.patch("works", "work-1", { active: false }, mizarAdmin)).resolves.toMatchObject({ active: false });
    // Reasignar la MISMA sociedad (no-op) tampoco se bloquea.
    await expect(withReqs.service.patch("works", "work-1", { societyId: "soc-1" }, mizarAdmin)).resolves.toMatchObject({ societyId: "soc-1" });

    const withoutReqs = deps({ feature: true });
    const freeWork = await withoutReqs.service.create("works", { name: "Obra Sur", societyId: "soc-1", active: true }, mizarAdmin);
    await expect(withoutReqs.service.patch("works", freeWork.id, { societyId: "soc-2" }, mizarAdmin)).resolves.toMatchObject({ societyId: "soc-2" });
  });

  // HUECO 1 (reunión 2026-08-31, QA): lista blanca global de solicitantes autorizados por WhatsApp —
  // mismo andamiaje de catálogos que el resto, pero con permisos calcados de las RLS de la tabla
  // (lectura: revisor o admin_sixteam o admin_mizar+feature; escritura: admin_sixteam o admin_mizar+feature).
  describe("HUECO 1: pestaña de solicitantes autorizados (WhatsApp)", () => {
    it("bloquea la escritura a revisor y aprobador aunque puedan operar compras, y respeta el autoservicio de Mizar", async () => {
      expect(canManageCatalog(reviewer, "requesters", true)).toBe(false);
      expect(canManageCatalog({ id: "approver", roles: ["aprobador"] }, "requesters", true)).toBe(false);
      expect(canManageCatalog(mizarAdmin, "requesters", false)).toBe(false);
      expect(canManageCatalog(mizarAdmin, "requesters", true)).toBe(true);
      expect(canManageCatalog(sixteam, "requesters", false)).toBe(true);
      const disabledFeature = deps({ feature: false });
      await expect(disabledFeature.service.create("requesters", { name: "Maestro de obra", phone: "+573001112233", active: true }, reviewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(disabledFeature.service.create("requesters", { name: "Maestro de obra", phone: "+573001112233", active: true }, mizarAdmin)).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
      const enabledFeature = deps({ feature: true });
      await expect(enabledFeature.service.create("requesters", { name: "Maestro de obra", phone: "+573001112233", active: true }, mizarAdmin)).resolves.toMatchObject({ name: "Maestro de obra", active: true });
    });
    it("trata las tres formas del mismo teléfono colombiano como el mismo solicitante (sin duplicar)", async () => {
      const fixture = deps();
      await fixture.service.create("requesters", { name: "Maestro de obra", phone: "3001112233", active: true }, sixteam);
      await expect(fixture.service.create("requesters", { name: "Otro nombre", phone: "+57 300 111 2233", active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/teléfono/i) });
      await expect(fixture.service.create("requesters", { name: "Otro nombre", phone: "573001112233", active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(fixture.records.size).toBe(1);
    });
    it("traduce el choque de teléfono de una condición de carrera (23505) a un mensaje claro", async () => {
      const race = deps({ uniqueViolation: true });
      await expect(race.service.create("requesters", { name: "Concurrente", phone: "+573009998877", active: true }, sixteam)).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringMatching(/teléfono/i) });
    });
    it("desactiva de forma reversible (baja lógica, no borrado) y audita sin exponer nombre ni teléfono (PII)", async () => {
      const fixture = deps(), requester = await fixture.service.create("requesters", { name: "Maestro Pérez", phone: "+573001112233", active: true }, sixteam);
      const patched = await fixture.service.patch("requesters", requester.id, { active: false }, sixteam);
      expect(patched).toMatchObject({ active: false, name: "Maestro Pérez", phone: "+573001112233" });
      expect(fixture.audits.at(-1)).toMatchObject({ event: "actualizada", data: { before: { active: true }, after: { active: false } } });
      const dump = JSON.stringify(fixture.audits);
      expect(dump).not.toContain("Maestro Pérez");
      expect(dump).not.toContain("3001112233");
    });
  });
});
