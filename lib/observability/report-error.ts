/**
 * Registro de errores inesperados y eventos operativos del servidor.
 *
 * Hasta el 18-sep-2026 `apiError` (lib/http/api.ts) convertía cualquier error no previsto en un 500
 * `internal_error` SIN registrarlo en ninguna parte. El log del contenedor de producción estaba vacío
 * tras cinco días en marcha, y el error 500 al descargar adjuntos (QA H1) solo apareció cuando alguien
 * lo reprodujo a mano. Un 500 que no deja rastro no se puede investigar ni vigilar.
 *
 * Qué sale: una línea JSON por evento en stderr/stdout (`docker logs`) y, si están configuradas
 * `LOG_INGEST_URL` y `LOG_INGEST_TOKEN` (una fuente HTTP de Better Stack Telemetry), una copia por
 * HTTPS a ese servicio, que es donde se buscan y desde donde se alerta. Se envía desde la propia app a
 * propósito: un recolector que lea los logs por la API de Docker carga `dockerd`, justo lo que provocó
 * el incidente de CPU del VPS del 14-sep.
 *
 * Qué NO sale, a propósito: el cuerpo de la petición, los parámetros de la consulta SQL (`postgres`
 * los adjunta al error), el `detail` de Postgres, que repite los valores de la fila («Key (email)=(…)
 * already exists»), ni la query string de la ruta. Todos pueden llevar nombres, cédulas o teléfonos.
 */
const MAX_MESSAGE = 500;
const MAX_STACK_LINES = 12;
const INGEST_TIMEOUT_MS = 3_000;

type Level = "error" | "warn";
type ErrorContext = { where: string; status?: number; path?: string };
type EventData = Record<string, string | number | boolean | null | undefined>;

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

/** Copia a Better Stack sin esperar ni fallar: el monitoreo nunca puede tumbar ni frenar una petición. */
function forward(level: Level, entry: EventData): void {
  const url = process.env.LOG_INGEST_URL?.trim(), token = process.env.LOG_INGEST_TOKEN?.trim();
  if (!url || !token) return;
  try {
    void fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...entry, dt: entry.at, level, message: `${entry.event}${entry.message ? `: ${entry.message}` : ""}` }),
      signal: AbortSignal.timeout(INGEST_TIMEOUT_MS),
    }).catch(() => {});
  } catch {
    // Sin red o sin fetch: queda la línea local.
  }
}

/** Evento operativo con datos ya limpios (ids, códigos, tamaños; nunca nombres ni contenido). */
export function logServerEvent(level: Level, event: string, data: EventData = {}): void {
  try {
    const entry = { event, at: new Date().toISOString(), ...data };
    (level === "error" ? console.error : console.warn)(JSON.stringify(entry));
    forward(level, entry);
  } catch {
    // Registrar nunca puede convertir un error en otro.
  }
}

export function reportServerError(error: unknown, context: ErrorContext): void {
  const path = context.path?.split("?")[0];
  logServerEvent("error", "error_servidor", { ...context, path, ...summarizeError(error) });
}
