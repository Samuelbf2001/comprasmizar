/**
 * Registro de errores inesperados del servidor.
 *
 * Hasta el 18-sep-2026 `apiError` (lib/http/api.ts) convertía cualquier error no previsto en un 500
 * `internal_error` SIN registrarlo en ninguna parte. El log del contenedor de producción estaba vacío
 * tras cinco días en marcha, y el error 500 al descargar adjuntos (QA H1) solo apareció cuando alguien
 * lo reprodujo a mano. Un 500 que no deja rastro no se puede investigar ni vigilar.
 *
 * Qué sale: una línea JSON por error en stderr (`docker logs`, y de ahí al monitoreo), con campos de
 * una lista blanca. Qué NO sale, a propósito: el cuerpo de la petición, los parámetros de la consulta
 * SQL (`postgres` los adjunta al error) y el `detail` de Postgres, que repite los valores de la fila
 * («Key (email)=(…) already exists»). Todos pueden llevar nombres, cédulas o teléfonos.
 */
const MAX_MESSAGE = 500;
const MAX_STACK_LINES = 12;

type ErrorContext = { where: string; status?: number };

function field(error: unknown, name: string): string | undefined {
  if (typeof error !== "object" || error === null || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

export function summarizeError(error: unknown): Record<string, string | undefined> {
  const isError = error instanceof Error;
  return {
    name: isError ? error.name : typeof error,
    message: (isError ? error.message : String(error)).slice(0, MAX_MESSAGE),
    // SQLSTATE y metadatos de esquema de Postgres: dicen QUÉ restricción falló sin repetir los valores.
    code: field(error, "code"),
    constraint: field(error, "constraint_name"),
    table: field(error, "table_name"),
    digest: field(error, "digest"),
    stack: isError ? error.stack?.split("\n").slice(1, MAX_STACK_LINES + 1).map((line) => line.trim()).join(" | ") : undefined,
  };
}

export function reportServerError(error: unknown, context: ErrorContext): void {
  try {
    console.error(JSON.stringify({ event: "error_servidor", at: new Date().toISOString(), ...context, ...summarizeError(error) }));
  } catch {
    // Registrar nunca puede convertir un error en otro.
  }
}
