/**
 * Traduce errores de red y de la API (ver `apiError()` en lib/http/api.ts) a mensajes que
 * un usuario puede entender y accionar. Ningún componente cliente debe mostrar
 * `response.status`, un código tipo "forbidden"/"internal_error" ni un mensaje de dominio
 * que exponga nombres internos (p. ej. "Permiso denegado: aprobar_orden_compra") — ese es
 * el trabajo de este módulo.
 */

export type FriendlyErrorAction =
  | { kind: "retry" }
  | { kind: "link"; label: string; href: string };

export type FriendlyError = {
  /** Título corto para un panel de error a pantalla completa. */
  title: string;
  /** Qué pasó, en lenguaje llano. */
  message: string;
  /** Qué puede hacer el usuario al respecto. */
  solution: string;
  /** `null` = no hubo respuesta del servidor (falla de red). */
  status: number | null;
  action?: FriendlyErrorAction;
};

const LOGIN_ACTION: FriendlyErrorAction = { kind: "link", label: "Iniciar sesión", href: "/login" };

const NETWORK_ERROR: FriendlyError = {
  title: "No pudimos conectar con el servidor",
  message: "Parece que no hay conexión o el servicio no respondió.",
  solution: "Revisa tu conexión a internet e inténtalo de nuevo en unos segundos.",
  status: null,
};

function errorCode(body: unknown): string | undefined {
  return body && typeof body === "object" && "error" in body && typeof (body as { error?: unknown }).error === "string"
    ? (body as { error: string }).error
    : undefined;
}

/** Mensajes del servidor que sí son seguros de mostrar tal cual: validaciones de negocio en
 *  español pensadas para el usuario (ver DomainError en lib/domain/*), nunca detalles técnicos. */
function serverMessageOr(body: unknown, fallback: string): string {
  const message = body && typeof body === "object" && "message" in body ? (body as { message?: unknown }).message : undefined;
  return typeof message === "string" && message.trim() ? message : fallback;
}

export function describeApiError(status: number, body?: unknown): FriendlyError {
  if (status === 400)
    return {
      title: "Hay datos inválidos en el formulario",
      message: "Algunos campos no tienen un valor válido o falta información.",
      solution: "Revisa los campos del formulario y vuelve a enviarlo.",
      status,
    };
  if (status === 401)
    return {
      title: "Tu sesión expiró",
      message: "Necesitas iniciar sesión de nuevo para continuar.",
      solution: "Vuelve a iniciar sesión desde la pantalla de acceso.",
      status,
      action: LOGIN_ACTION,
    };
  if (status === 403) {
    const code = errorCode(body);
    if (code === "not_assigned_approver")
      return {
        title: "No tienes permiso para esto",
        message: "Esta requisición está asignada a otro aprobador.",
        solution: "Pide al aprobador asignado que la gestione, o solicita reasignación a un administrador de Mizar.",
        status,
      };
    return {
      title: "No tienes permiso para esto",
      message: "Tu rol o el estado de tu cuenta no permiten esta acción.",
      solution: "Si crees que deberías tener acceso, pide a un administrador de Mizar que revise tu rol. Si tu rol cambió hace poco, cierra sesión y vuelve a entrar.",
      status,
    };
  }
  if (status === 404)
    return {
      title: "No lo encontramos",
      message: serverMessageOr(body, "El registro que buscas no existe o fue eliminado."),
      solution: "Verifica el enlace o vuelve al listado anterior.",
      status,
    };
  if (status === 409)
    return {
      title: "Ese dato ya cambió",
      message: serverMessageOr(body, "El registro ya existe o alguien más lo modificó."),
      solution: "Actualiza la página para ver la información más reciente y vuelve a intentar.",
      status,
    };
  if (status === 413)
    return {
      title: "El archivo es muy grande",
      message: "El archivo supera el tamaño máximo permitido.",
      solution: "Usa un archivo más liviano o comprímelo antes de subirlo.",
      status,
    };
  if (status === 422)
    return {
      title: "No pudimos completar la operación",
      message: serverMessageOr(body, "La operación no cumple una regla del negocio."),
      solution: "Revisa los datos ingresados. Si el mensaje no es claro, contacta a soporte.",
      status,
    };
  if (status === 429)
    return {
      title: "Demasiadas solicitudes",
      message: "Se hicieron muchas solicitudes en poco tiempo.",
      solution: "Espera unos segundos y vuelve a intentar.",
      status,
    };
  if (status >= 500)
    return {
      title: "Algo falló en el servidor",
      message: "No fue un problema con tus datos; ocurrió un error interno.",
      solution: "Intenta de nuevo en unos minutos. Si el problema continúa, contacta a soporte.",
      status,
    };
  return {
    title: "No fue posible completar la operación",
    message: serverMessageOr(body, "Ocurrió un error inesperado."),
    solution: "Intenta de nuevo. Si el problema persiste, contacta a soporte.",
    status,
  };
}

export function describeNetworkError(): FriendlyError {
  return NETWORK_ERROR;
}

export class FriendlyApiError extends Error {
  readonly friendly: FriendlyError;
  constructor(friendly: FriendlyError) {
    super(`${friendly.message} ${friendly.solution}`);
    this.name = "FriendlyApiError";
    this.friendly = friendly;
  }
}

export function isFriendlyApiError(error: unknown): error is FriendlyApiError {
  return error instanceof FriendlyApiError;
}

/** Extrae un mensaje amigable de cualquier `error` capturado en un `catch`, para los
 *  paneles que solo muestran una línea de texto (p. ej. `setFeedback(error.message)`). */
export function friendlyErrorText(error: unknown, fallback: string): string {
  if (error instanceof FriendlyApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/**
 * `fetch` + parseo JSON + traducción de errores, en un solo paso. Lanza `FriendlyApiError`
 * (nunca el error crudo de red ni el body técnico) cuando la respuesta no es `ok` o cuando
 * `fetch` mismo falla (sin conexión, DNS, CORS, etc.).
 */
export async function apiRequest<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin", ...init });
  } catch {
    throw new FriendlyApiError(describeNetworkError());
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new FriendlyApiError(describeApiError(response.status, body));
  return body as T;
}
