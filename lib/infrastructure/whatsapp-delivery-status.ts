import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";

/**
 * Acuses de entrega de WhatsApp: qué pasó DESPUÉS de que Kapso aceptara el mensaje.
 *
 * POR QUÉ EXISTE. Hasta ahora `whatsapp_eventos.estado_entrega = 'enviado'` significaba solo "Kapso
 * nos dijo 200". Eso nos hizo creer durante horas que los avisos salían mientras Meta los
 * descartaba: la plataforma decía `enviado`, el teléfono no recibía nada, y no había forma de
 * distinguir "llegó" de "se perdió" sin entrar a Kapso a mirar. Un estado que miente en la dirección
 * optimista es peor que no tener estado.
 *
 * Los cuatro eventos (`whatsapp.message.sent|delivered|read|failed`) cierran ese hueco.
 *
 * DOS PROPIEDADES DE LA ENTREGA QUE MANDAN SOBRE EL DISEÑO, según la documentación de Kapso:
 * "Deliveries are at-least-once and are not guaranteed to arrive in order". O sea:
 *  - el mismo acuse puede llegar dos veces → aplicar dos veces tiene que dar lo mismo;
 *  - `sent` puede llegar DESPUÉS de `delivered` → el estado avanza, nunca retrocede.
 */

/** Lo que el enum `estado_envio` admite. No hay `leido`: `read` se guarda como `entregado`. */
export type EstadoEntrega = "enviado" | "entregado" | "fallido";

export interface AcuseEntrega {
  wamid: string;
  estado: EstadoEntrega;
  /** Solo en `failed`: el código y título que da Meta, p. ej. "131047 · Re-engagement message". */
  motivo?: string;
}

/**
 * Orden de avance. Es el espejo de `public.rango_estado_entrega` (migración 202609110003), que es
 * quien decide de verdad: aquí solo se calcula el rango del acuse que ENTRA, para pasarlo como
 * parámetro. La comparación la hace la base con su propia función, para que no haya dos definiciones
 * que puedan divergir.
 *
 * `fallido` vale 3 y es el tope, no una excepción sin rango: una vez que Meta dice que se perdió,
 * ningún acuse más flojo puede escribir encima. La primera versión lo dejaba fuera y caía en un
 * `else 0`, de modo que un `sent` rezagado lo pisaba y la fila volvía a decir "enviado" — con Kapso
 * entregando at-least-once y sin orden, eso no es un caso raro sino una secuencia normal.
 *
 * `read` se homologa a `entregado` y no a un estado propio: el enum no lo tiene, y para lo que la
 * plataforma necesita —saber si el aviso llegó— "leído" y "entregado" responden lo mismo. Añadir un
 * valor al enum obligaría a una migración y a revisar cada lectura del campo, a cambio de un matiz
 * que nadie ha pedido.
 */
const RANGO: Record<string, number> = { pendiente: 0, enviado: 1, entregado: 2, fallido: 3 };

const ESTADO_POR_STATUS: Record<string, EstadoEntrega> = {
  sent: "enviado",
  delivered: "entregado",
  read: "entregado",
  failed: "fallido",
};

function comoObjeto(valor: unknown): Record<string, unknown> | null {
  return valor && typeof valor === "object" ? (valor as Record<string, unknown>) : null;
}

/**
 * Traduce un evento de estado a un acuse, o `null` si el payload no es uno.
 *
 * La detección es deliberadamente estrecha. Un mensaje ENTRANTE también trae `message.kapso` con un
 * `status` dentro, así que mirar solo eso confundiría una cosa con otra: por eso se exige además que
 * `direction` sea `outbound` cuando venga informada. Y en el webhook esta rama va DESPUÉS de las de
 * Flow y de la del router, de modo que cualquier cosa que sí sepamos atender ya se atendió antes.
 */
export function leerAcuseEntrega(payload: unknown): AcuseEntrega | null {
  const raiz = comoObjeto(payload);
  const message = comoObjeto(raiz?.message);
  if (!message) return null;
  const wamid = typeof message.id === "string" ? message.id.trim() : "";
  if (!wamid) return null;

  const kapso = comoObjeto(message.kapso);
  if (!kapso) return null;
  if (typeof kapso.direction === "string" && kapso.direction !== "outbound") return null;
  const status = typeof kapso.status === "string" ? kapso.status : "";
  const estado = ESTADO_POR_STATUS[status];
  if (!estado) return null;

  return estado === "fallido" ? { wamid, estado, motivo: primerMotivo(kapso) } : { wamid, estado };
}

/** ¿Este payload es un acuse? Azúcar para el webhook, que solo necesita decidir la rama. */
export function esAcuseEntrega(payload: unknown): boolean {
  return leerAcuseEntrega(payload) !== null;
}

/**
 * Primer error de `message.kapso.statuses[].errors[]`, como "131047 · Re-engagement message".
 *
 * Se guarda el código junto al título a propósito: el título es legible pero ambiguo entre versiones
 * de la API, y el código es lo que sirve para buscar en la documentación de Meta cuando alguien
 * pregunte por qué no llegó un aviso. El `message` largo del error se descarta: puede traer el
 * teléfono, y esto acaba en una columna que se lee sin pensar.
 */
function primerMotivo(kapso: Record<string, unknown>): string | undefined {
  const statuses = Array.isArray(kapso.statuses) ? kapso.statuses : [];
  for (const entrada of statuses) {
    const errores = comoObjeto(entrada)?.errors;
    if (!Array.isArray(errores)) continue;
    for (const error of errores) {
      const e = comoObjeto(error);
      if (!e) continue;
      const code = typeof e.code === "number" || typeof e.code === "string" ? String(e.code) : "";
      const title = typeof e.title === "string" ? e.title.trim() : "";
      const texto = [code, title].filter(Boolean).join(" · ");
      if (texto) return texto.slice(0, 200);
    }
  }
  return undefined;
}

export interface RegistroAcuses {
  /** `false` cuando el wamid no corresponde a ningún envío nuestro, o cuando el estado no avanza. */
  aplicar(acuse: AcuseEntrega): Promise<boolean>;
}

export function createPostgresRegistroAcuses(databaseUrl = runtimeEnv().DATABASE_URL): RegistroAcuses {
  const sql = sharedPostgres(databaseUrl);
  return {
    async aplicar({ wamid, estado, motivo }) {
      // AVANCE MONOTÓNICO en la misma consulta, no leyendo y luego escribiendo: dos acuses del mismo
      // mensaje pueden llegar a la vez, y un `sent` tardío no puede pisar un `delivered` ya guardado.
      // `fallido` es la excepción y siempre se aplica — si Meta dice que se perdió, eso manda sobre
      // cualquier optimismo anterior.
      const rango = RANGO[estado] ?? 0;
      const filas = await sql<{ id: string }[]>`
        update whatsapp_eventos
           set estado_entrega = ${estado},
               motivo_fallo = ${motivo ?? null}
         where kapso_message_id = ${wamid}
           and direccion = 'salida'
           and (${estado} = 'fallido'
                or coalesce(public.rango_estado_entrega(estado_entrega), 0) < ${rango})
        returning id`;
      if (filas.length === 0) return false;

      // La cola de notificaciones lleva su propio estado y es LO QUE MIRA quien pregunta "¿se avisó?".
      // Sin esto seguiría diciendo `enviado` para un mensaje que Meta descartó: el mismo engaño, una
      // capa más arriba.
      //
      // OJO — ESTO NO SURTE EFECTO TODAVÍA. La correlación va por `notificaciones.kapso_message_id`,
      // columna que crea la migración 202609110003, pero quien tiene que RELLENARLA es `markSent`
      // (lib/infrastructure/notification-dispatcher.ts), que hoy solo guarda el wamid en
      // `whatsapp_eventos`. Ese archivo estaba tomado por otra sesión cuando se escribió esto, así
      // que falta una línea suya:
      //
      //     update notificaciones set ..., kapso_message_id=${sent.messageId} where id=${id}
      //
      // Hasta que exista, este UPDATE no encuentra filas y la cola se queda como estaba. La parte de
      // `whatsapp_eventos` —la de arriba— sí funciona desde el primer acuse.
      if (estado === "entregado" || estado === "fallido") {
        await sql`
          update notificaciones
             set estado_envio = ${estado},
                 ultimo_error = ${estado === "fallido" ? (motivo ?? "Meta descartó el mensaje") : null}
           where kapso_message_id = ${wamid}
             and estado_envio <> ${estado}
             and estado_envio <> 'pendiente'`;
      }
      return true;
    },
  };
}

/** Acuses fallidos de las últimas 24 h. Lo expone `/api/health` para verlo sin entrar a la base. */
export async function contarFallidos24h(databaseUrl = runtimeEnv().DATABASE_URL): Promise<number> {
  const sql = sharedPostgres(databaseUrl);
  const filas = await sql<{ total: string }[]>`
    select count(*)::text as total from whatsapp_eventos
     where direccion = 'salida' and estado_entrega = 'fallido' and fecha > now() - interval '24 hours'`;
  return Number(filas[0]?.total ?? 0);
}
