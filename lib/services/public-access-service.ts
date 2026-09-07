import { DomainError, type Actor } from "../domain";

/** Estado expuesto a la UI de administración: nunca el hash, solo si hay contraseña fijada y cuándo. */
export interface PublicAccessStatus { configured: boolean; updatedAt: string | null; }

/** El hash se calcula EN LA BASE (extensions.crypt + gen_salt); este puerto nunca ve ni transporta el hash. */
export interface PublicAccessAdminRepository {
  getStatus(): Promise<PublicAccessStatus>;
  setPassword(code: string, actorId: string): Promise<void>;
}

export interface PublicAccessAdminAudit { append(event: { entity: string; entityId: string; event: string; actorId?: string; at: Date; origin: "web"; data?: Record<string, unknown> }): Promise<void>; }

export interface PublicAccessAdminServiceDependencies {
  repository: PublicAccessAdminRepository;
  audit: PublicAccessAdminAudit;
  clock: { now(): Date };
}

/** RF-P2 (reunión): fijar la contraseña global del portal es administración de plataforma, mismo criterio
 * de acceso que el resto de catálogos administrativos — nunca solicitante/revisor/aprobador/contabilidad. */
function canManagePublicAccess(actor: Actor): boolean { return actor.roles.includes("admin_mizar") || actor.roles.includes("admin_sixteam"); }

export class PublicAccessAdminService {
  constructor(private readonly deps: PublicAccessAdminServiceDependencies) {}

  async getStatus(actor: Actor): Promise<PublicAccessStatus> {
    if (!canManagePublicAccess(actor)) throw new DomainError("FORBIDDEN", "No puede consultar el acceso público");
    return this.deps.repository.getStatus();
  }

  async setPassword(actor: Actor, code: string): Promise<void> {
    if (!canManagePublicAccess(actor)) throw new DomainError("FORBIDDEN", "No puede administrar el acceso público");
    if (code.length < 8) throw new DomainError("INVALID_INPUT", "La contraseña debe tener al menos 8 caracteres");
    await this.deps.repository.setPassword(code, actor.id);
    // La contraseña NUNCA se audita en claro (ni siquiera hasheada): solo queda registrado que alguien
    // la cambió y quién fue, igual que el resto de eventos sensibles de auditoria_campo_sensible.
    await this.deps.audit.append({ entity: "acceso_publico", entityId: "global", event: "contrasena_actualizada", actorId: actor.id, at: this.deps.clock.now(), origin: "web" });
  }
}
