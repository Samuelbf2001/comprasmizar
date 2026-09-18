import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError } from "../../lib/http/api";
import { DomainError } from "../../lib/domain";
import { reportServerError, summarizeError } from "../../lib/observability/report-error";

afterEach(() => vi.restoreAllMocks());

/** Un error como los que lanza `postgres`: con la consulta, sus parámetros y el `detail` de la fila. */
function postgresLikeError(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint \"proveedores_identificacion_key\""), {
    name: "PostgresError",
    code: "23505",
    constraint_name: "proveedores_identificacion_key",
    table_name: "proveedores",
    detail: "Key (identificacion)=(1098765432) already exists.",
    query: "insert into proveedores (razon_social, identificacion) values ($1, $2)",
    parameters: ["Juan Pérez", "1098765432"],
  });
}

describe("registro de errores del servidor", () => {
  it("un 500 de la API ya no desaparece: deja una línea JSON en stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = apiError(new Error("se cayó algo"));
    expect(response.status).toBe(500);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0][0]));
    expect(line).toMatchObject({ event: "error_servidor", where: "api", status: 500, message: "se cayó algo" });
  });

  it("los errores previstos (dominio, validación) no ensucian el registro", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(apiError(new DomainError("NOT_FOUND", "no existe")).status).toBe(404);
    expect(apiError(new DomainError("FORBIDDEN", "no")).status).toBe(403);
    expect(apiError(new Error("UNAUTHENTICATED")).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it("de un error de Postgres guarda la restricción y el SQLSTATE, nunca los valores de la fila", () => {
    const summary = summarizeError(postgresLikeError());
    expect(summary).toMatchObject({ code: "23505", constraint: "proveedores_identificacion_key", table: "proveedores" });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("1098765432");
    expect(serialized).not.toContain("Juan Pérez");
  });

  it("registrar nunca lanza, aunque el valor no sea un Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportServerError("texto suelto", { where: "prueba" })).not.toThrow();
    expect(() => reportServerError(null, { where: "prueba" })).not.toThrow();
  });
});
