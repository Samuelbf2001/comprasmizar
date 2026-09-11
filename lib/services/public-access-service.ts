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

/**
 * Id de la fila singleton de `acceso_publico`. Lo fija un CHECK de la migración
 * 202609070002_acceso_publico_global.sql (`constraint acceso_publico_singleton check (id = ...)`),
 * así que no puede ser otro.
 *
 * Aquí se repite en vez de importarse de `lib/infrastructure/public-access.ts` para no invertir las
 * capas: los servicios declaran contratos y la infraestructura los implementa, no al revés.
 *
 * ANTES DECÍA `"global"`, y eso rompía el endpoint entero: `auditoria.entidad_id` es de tipo `uuid`
 * (202608240001_core_compras.sql) y `AuditRepository.append` lo inserta directo, así que Postgres
 * lanzaba 22P02 `invalid input syntax for type uuid: "global"`. El resultado para quien fijaba la
 * contraseña del portal era el peor posible: `setPassword` ya había COMMITEADO el update —no hay
 * transacción envolviendo ambos pasos—, la auditoría reventaba después, y la API devolvía 500
 * `internal_error`. La contraseña quedaba bien guardada y la pantalla decía que había fallado.
 *
 * Efecto colateral que nadie vio: como siempre falló, el evento `CONTRASENA_ACTUALIZADA` NUNCA se
 * escribió. El rastro no se perdió del todo —el trigger `acceso_publico_auditoria` sí registra el
 * cambio de fila, con el hash redactado— pero el evento de aplicación, con su actor, no existía.
 */
const ACCESO_PUBLICO_ID = "00000000-0000-0000-0000-000000000001";

export class PublicAccessAdminService {
  constructor(private readonly deps: PublicAccessAdminServiceDependencies) {}

  async getStatus(actor: Actor): Promise<PublicAccessStatus> {
    if (!canManagePublicAccess(actor)) throw new DomainError("FORBIDDEN", "No puede consultar el acceso público");
    return this.deps.repository.getStatus();
  }

  async setPassword(actor: Actor, code: string): Promise<void> {
    if (!canManagePublicAccess(actor)) throw new DomainError("FORBIDDEN", "No puede administrar el acceso público");
    // QA Postgres real (GRAVE): el mínimo se exigía sobre `code.length` SIN trim — ocho espacios en
    // blanco pasaban como contraseña "válida" (8 caracteres, cero entropía). Se recorta primero y se
    // valida la longitud DESPUÉS, y se persiste el valor ya recortado (mismo criterio en el esquema de
    // la ruta, app/api/public-access/route.ts, que hace su propio trim antes de llegar aquí — este
    // trim es defensivo por si algún día se llama al servicio sin pasar por esa ruta).
    const trimmed = code.trim();
    if (trimmed.length < 8) throw new DomainError("INVALID_INPUT", "La contraseña debe tener al menos 8 caracteres");
    await this.deps.repository.setPassword(trimmed, actor.id);
    // GRAVE (QA Postgres real): este comentario decía "la contraseña nunca se audita en claro, ni
    // siquiera hasheada" — false. El hash SÍ podía terminar en `auditoria` a través del trigger
    // genérico `escribir_auditoria` cuando el hash vivía dentro de `configuracion.valor` (columna no
    // redactada por nombre). Desde 202609070002_acceso_publico_global.sql el hash vive en su propia
    // tabla (`acceso_publico.public_code_hash`), cuya columna SÍ está en la lista de campos sensibles
    // de `auditoria_campo_sensible` — por eso el trigger de esa tabla la redacta como
    // `{redactado:true}`. Lo que sigue siendo cierto, y lo único que este evento manual añade aparte
    // de esa redacción automática, es que el código en claro nunca viaja como argumento de este
    // evento de auditoría de aplicación.
    await this.deps.audit.append({ entity: "acceso_publico", entityId: ACCESO_PUBLICO_ID, event: "contrasena_actualizada", actorId: actor.id, at: this.deps.clock.now(), origin: "web" });
  }
}
