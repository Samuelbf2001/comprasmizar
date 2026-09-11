import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { createPublicAccessAdminRepository } from "../../../lib/infrastructure/public-access";
import { PublicAccessAdminService } from "../../../lib/services";

export const runtime = "nodejs";

// La contraseña global del portal público (reunión: "una sola contraseña para todo el mundo") se
// administra aquí. El mínimo de 8 caracteres es la única validación de forma: la fuerza real la da el
// hash bcrypt (extensions.crypt + gen_salt('bf', 12)), calculado EN LA BASE — este archivo jamás ve el
// hash. GRAVE (QA Postgres real): `.min(8)` se aplicaba ANTES del trim, así que "        " (8 espacios)
// pasaba esta validación de forma. `.trim()` normaliza el valor antes de medir su longitud —
// PublicAccessAdminService.setPassword repite el mismo trim de forma defensiva, por si algún día se
// invoca sin pasar por esta ruta.
export const publicAccessPasswordSchema = z.object({ code: z.string().trim().min(8, "La contraseña debe tener al menos 8 caracteres") });

function service() {
  // El reloj sale de las dependencias Postgres compartidas, para que la marca de tiempo del evento
  // sea la misma fuente que usa el resto de la app.
  //
  // Ya NO se inyecta un puerto de auditoría aparte: el repositorio escribe la contraseña y su evento
  // en una sola transacción, porque con dos puertos independientes no había forma de que compartieran
  // una — y esa separación fue la que dejó al administrador viendo un 500 con la contraseña ya
  // guardada (ver el comentario de `setPassword` en lib/services/public-access-service.ts).
  const shared = createPostgresDependencies();
  return new PublicAccessAdminService({ repository: createPublicAccessAdminRepository(), clock: shared.clock });
}

/** Nunca expone el hash: solo si hay contraseña fijada y cuándo cambió por última vez. */
export function GET() {
  return authenticatedJson((actor) => service().getStatus(actor));
}

export async function PATCH(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, publicAccessPasswordSchema);
    await service().setPassword(actor, input.code);
    return service().getStatus(actor);
  });
}
