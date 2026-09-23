// Un 403 por ORIGEN (`assertSameOrigin`, lib/http/api.ts → `{"error":"origin_forbidden"}`) no tiene
// nada que ver con el rol: es configuración (APP_ORIGIN) o una petición desde otra dirección. El texto
// genérico del 403 mandaba al usuario a pedir que le revisaran el rol (ensayo del 23-sep-2026).
import { describe, expect, it } from "vitest";
import { describeApiError } from "../../lib/http/friendly-error";

describe("describeApiError distingue el 403 por origen del 403 por permiso", () => {
  it("origin_forbidden habla de verificar el origen, no del rol", () => {
    const friendly = describeApiError(403, { error: "origin_forbidden", message: "Origen de solicitud no permitido" });
    expect(friendly.message).toBe("No pudimos verificar el origen de la solicitud.");
    expect(friendly.solution).toContain("Recarga la página");
    expect(friendly.solution).toContain("no de tu rol");
    expect(`${friendly.title} ${friendly.message}`).not.toMatch(/Tu rol o el estado de tu cuenta/);
    expect(friendly.status).toBe(403);
  });

  it("un 403 de permiso sigue con el mensaje de rol de siempre", () => {
    expect(describeApiError(403, { error: "forbidden" }).message).toBe("Tu rol o el estado de tu cuenta no permiten esta acción.");
    expect(describeApiError(403, { error: "not_assigned_approver" }).message).toBe("Esta requisición está asignada a otro aprobador.");
  });
});
