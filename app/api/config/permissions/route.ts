import { z } from "zod";
import { assertSameOrigin, authenticatedJson, parseJson } from "../../../../lib/http/api";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { createRolePermissionsRepository } from "../../../../lib/infrastructure/role-permissions";
import { RolePermissionsService } from "../../../../lib/services";

export const runtime = "nodejs";

// DECISIÓN DE ERNESTO (2026-09-17): los permisos por rol se editan desde Configuración. La forma se
// valida aquí solo como "objeto de listas de texto"; QUÉ roles y QUÉ permisos son válidos —y el
// candado que impide dejar a Administrador Sixteam sin «Configurar la plataforma»— lo decide el
// dominio (`assertValidPermissionOverrides`), que es quien conoce el catálogo. Duplicar ese catálogo
// en un esquema zod sería la forma segura de que un día divergiera del real.
export const rolePermissionsSchema = z.object({ overrides: z.record(z.string(), z.array(z.string())) });

function service() {
  const shared = createPostgresDependencies();
  return new RolePermissionsService({ repository: createRolePermissionsRepository(), clock: shared.clock });
}

export function GET() {
  return authenticatedJson((actor) => service().getSettings(actor));
}

export async function PUT(request: Request) {
  return authenticatedJson(async (actor) => {
    assertSameOrigin(request);
    const input = await parseJson(request, rolePermissionsSchema);
    return service().save(actor, input.overrides);
  });
}
