import type { Instrumentation } from "next";
import { reportServerError } from "./lib/observability/report-error";

/**
 * Errores que Next captura por su cuenta: render de Server Components, Server Actions y route
 * handlers que lanzan sin pasar por `apiError`. Los que sí pasan por `apiError` ya se registran ahí
 * (lib/http/api.ts). Mismo registro para los dos caminos: ver lib/observability/report-error.ts.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  reportServerError(error, { where: context.routeType, path: request.path });
};
