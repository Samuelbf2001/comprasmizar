import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, PERMISSION_CATALOG, canManageSixteamAccounts, hasGatedPermission, hasPermission, resolveActorPermissions } from "../../lib/domain";
import { allowedRoutes, puedeCon } from "../../components/layout/nav-permissions";
import { roleAllowed } from "../../components/layout/app-shell";

// DECISIÓN DEL CLIENTE (Ernesto, 25-sep-2026): «Daniel puede hacer todo». Estas pruebas fijan los
// DEFAULTS (lo que trae una instalación nueva y lo que restaura «Restaurar valores por defecto»), los
// límites que se mantienen y que el menú obedece al permiso y no al nombre del rol.

const ADMIN_DE_NEGOCIO = ["catalog:manage", "society:manage", "requester:manage", "item:manage", "supplier:manage", "user:read", "user:manage", "user:reset_password", "public_access:manage", "audit:read"];

describe("Permisos por defecto del revisor (Daniel)", () => {
  it("trae toda la administración de negocio", () => {
    for (const permiso of ADMIN_DE_NEGOCIO) expect(hasPermission(["revisor"], permiso), permiso).toBe(true);
  });
  it("NO trae la matriz de permisos ni la configuración técnica", () => {
    expect(hasPermission(["revisor", "aprobador"], "config:manage")).toBe(false);
    expect(canManageSixteamAccounts({ id: "daniel", roles: ["revisor", "aprobador"] })).toBe(false);
  });
  it("el MCP no gana la capacidad de aprobar, devolver ni revisar aunque el revisor administre todo", () => {
    const daniel = resolveActorPermissions(["revisor", "aprobador"]);
    for (const permiso of ["requisition:approve", "requisition:return", "requisition:review"]) {
      expect(hasPermission({ id: "daniel", roles: ["revisor", "aprobador"], permissions: daniel }, permiso, "mcp"), permiso).toBe(false);
    }
  });
});

describe("Nada se le quita a nadie", () => {
  it("admin_mizar conserva como permisos lo que tenía por nombre de rol, y no gana administrar usuarios", () => {
    for (const permiso of ["society:manage", "user:read", "user:reset_password", "public_access:manage", "screen:manage", "catalog:manage", "requester:manage", "supplier:manage", "audit:read"]) {
      expect(hasPermission(["admin_mizar"], permiso), permiso).toBe(true);
    }
    expect(hasPermission(["admin_mizar"], "user:manage")).toBe(false);
    expect(hasPermission(["admin_mizar"], "item:manage")).toBe(false);
    expect(hasPermission(["admin_mizar"], "config:manage")).toBe(false);
  });
  it("admin_sixteam lo tiene todo por el comodín; el resto de roles no gana administración", () => {
    for (const permiso of ALL_PERMISSIONS) expect(hasPermission(["admin_sixteam"], permiso)).toBe(true);
    for (const role of ["solicitante", "aprobador", "contabilidad"] as const) {
      for (const permiso of ["user:read", "user:manage", "user:reset_password", "public_access:manage", "audit:read", "society:manage"]) expect(hasPermission([role], permiso), `${role} ${permiso}`).toBe(false);
    }
  });
  it("todo permiso nuevo tiene nombre de negocio en la matriz de Configuración", () => {
    for (const permiso of ["society:manage", "requester:manage", "user:read", "user:manage", "user:reset_password", "public_access:manage", "screen:manage", "audit:read"]) {
      const entry = PERMISSION_CATALOG.find((item) => item.key === permiso);
      expect(entry?.label, permiso).toBeTruthy();
      expect(entry?.label).not.toContain(":");
    }
    for (const lista of Object.values(DEFAULT_ROLE_PERMISSIONS)) for (const permiso of lista) if (permiso !== "*") expect(ALL_PERMISSIONS).toContain(permiso);
  });
});

describe("Módulo catalogos_admin_mizar", () => {
  it("con el módulo apagado solo cuenta lo que admin_mizar trae por sí solo; empresas y usuarios no dependen de él", () => {
    const claudia = { id: "claudia", roles: ["admin_mizar"] as const };
    expect(hasGatedPermission(claudia, "catalog:manage", false)).toBe(false);
    expect(hasGatedPermission(claudia, "catalog:manage", true)).toBe(true);
    expect(hasGatedPermission(claudia, "requester:manage", false)).toBe(false);
    expect(hasGatedPermission(claudia, "society:manage", false)).toBe(true);
    expect(hasGatedPermission({ id: "dual", roles: ["admin_mizar", "revisor"] }, "catalog:manage", false)).toBe(true);
  });
});

describe("Menú por permiso efectivo", () => {
  it("el revisor ve Configuración e Historial de cambios; contabilidad no", () => {
    const revisor = allowedRoutes(roleAllowed.Revisor, puedeCon(DEFAULT_ROLE_PERMISSIONS.revisor));
    expect(revisor).toEqual(expect.arrayContaining(["/configuracion", "/auditoria", "/catalogos"]));
    const contabilidad = allowedRoutes(roleAllowed.Contabilidad, puedeCon(DEFAULT_ROLE_PERMISSIONS.contabilidad));
    expect(contabilidad).not.toContain("/configuracion");
    expect(contabilidad).not.toContain("/auditoria");
    expect(contabilidad).not.toContain("/catalogos");
  });
  it("si Configuración le quita el permiso, la entrada desaparece aunque el rol sea el mismo", () => {
    const sinHistorial = DEFAULT_ROLE_PERMISSIONS.revisor.filter((permiso) => permiso !== "audit:read");
    expect(allowedRoutes(roleAllowed.Revisor, puedeCon(sinHistorial))).not.toContain("/auditoria");
    // Y al revés: un permiso dado a contabilidad le abre la entrada.
    expect(allowedRoutes(roleAllowed.Contabilidad, puedeCon([...DEFAULT_ROLE_PERMISSIONS.contabilidad, "audit:read"]))).toContain("/auditoria");
  });
  it("Administrador Mizar conserva Configuración y Catálogos; Administrador Sixteam lo ve todo", () => {
    expect(allowedRoutes(roleAllowed["Administrador Mizar"], puedeCon(DEFAULT_ROLE_PERMISSIONS.admin_mizar))).toEqual(expect.arrayContaining(["/configuracion", "/catalogos", "/auditoria"]));
    expect(allowedRoutes(roleAllowed["Administrador Sixteam"], puedeCon(["*"]))).toEqual(expect.arrayContaining(["/configuracion", "/catalogos", "/auditoria"]));
  });
});
