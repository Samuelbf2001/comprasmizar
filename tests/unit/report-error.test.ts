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

  it("con LOG_INGEST_URL/TOKEN copia el error a Better Stack con Bearer, sin la query string ni datos de la fila", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 202 }));
    vi.stubEnv("LOG_INGEST_URL", "https://ingesta.example.test");
    vi.stubEnv("LOG_INGEST_TOKEN", "token-de-prueba");
    try {
      reportServerError(postgresLikeError(), { where: "route", path: "/api/suppliers?q=Juan%20Perez" });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://ingesta.example.test");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-de-prueba");
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ level: "error", event: "error_servidor", path: "/api/suppliers", code: "23505" });
      expect(body.dt).toEqual(expect.any(String));
      expect(String(init.body)).not.toMatch(/Juan|1098765432/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sin LOG_INGEST_URL no sale nada de la máquina, y un fallo de red no rompe nada", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sin red"));
    reportServerError(new Error("x"), { where: "prueba" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.stubEnv("LOG_INGEST_URL", "https://ingesta.example.test");
    vi.stubEnv("LOG_INGEST_TOKEN", "t");
    try {
      expect(() => reportServerError(new Error("x"), { where: "prueba" })).not.toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("registrar nunca lanza, aunque el valor no sea un Error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => reportServerError("texto suelto", { where: "prueba" })).not.toThrow();
    expect(() => reportServerError(null, { where: "prueba" })).not.toThrow();
  });
});
