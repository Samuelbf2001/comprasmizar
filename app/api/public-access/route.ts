import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson } from "../../../lib/http/api";
import { createPostgresDependencies } from "../../../lib/infrastructure/postgres-repositories";
import { createPublicAccessAdminRepository } from "../../../lib/infrastructure/public-access";
import { PublicAccessAdminService } from "../../../lib/services";

export const runtime = "nodejs";

// La contraseña global del portal público (reunión: "una sola contraseña para todo el mundo") se
// administra aquí. El mínimo de 8 caracteres es la única validación de forma: la fuerza real la da el
// hash bcrypt (extensions.crypt + gen_salt('bf')), calculado EN LA BASE — este archivo jamás ve el hash.
export const publicAccessPasswordSchema = z.object({ code: z.string().min(8, "La contraseña debe tener al menos 8 caracteres") });

function service() {
  // Reutiliza audit/clock de las dependencias Postgres compartidas (mismo AuditRepository que el resto
  // de la app); el repositorio de la contraseña vive aparte porque toca una fila fuera del dominio de
  // requisiciones/órdenes que administran esas dependencias.
  const shared = createPostgresDependencies();
  return new PublicAccessAdminService({ repository: createPublicAccessAdminRepository(), audit: shared.audit, clock: shared.clock });
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
