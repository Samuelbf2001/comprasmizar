import type { KapsoAdapter } from "../services";
import { runtimeEnv } from "../security/env";
import { sharedPostgres } from "./postgres-repositories";
import { asJsonb } from "./jsonb";
import { parametrosDePlantilla } from "./plantillas-whatsapp";
import { META_ERRORES_PLANTILLA_AUSENTE } from "./kapso";
import { destinatarioWhatsApp } from "./phone";

/** Only `sendTemplate` is needed to dispatch; no webhook secret or event store required. */
export type NotificationSendAdapter = Pick<KapsoAdapter, "sendTemplate"> & {
  /**
   * Opcional: entrega la notificación del aprobador como el WhatsApp Flow de aprobación en vez de
   * una plantilla de texto, para que decida sin salir del chat. Solo se usa para el template
   * `pendiente_aprobador` (el único cuya acción cabe en un Flow) y solo cuando el llamador lo
   * inyecta — sin él, o si su Flow no está configurado, esta cola se comporta exactamente como
   * antes. Debe resolver los mismos fallos que `sendTemplate` (el reintento/backoff no cambia).
   *
   * `fallback` es exactamente el envío de plantilla que el despachador habría hecho: se entrega
   * para que la política de "cuándo NO se puede usar el Flow" (requisición con demasiados ítems,
   * ya no está en aprobación) viva en el cableado y no aquí, sin que este módulo tenga que saber
   * qué errores del emisor son recuperables.
   */
  sendApprovalFlow?(input: { to: string; requisitionId: string; approverId?: string; fallback: () => Promise<{ messageId: string }> }): Promise<{ messageId: string }>;
};

/** Template cuya notificación puede entregarse como Flow. Vive aquí, junto al despachador, porque
 * es él quien decide el canal; quien la encola (`sendForApproval`) no sabe nada de Flows. */
const APPROVAL_TEMPLATE = "pendiente_aprobador";
/**
 * Devuelve la requisición sobre la que va la notificación cuando ESTA notificación puede salir como
 * Flow de aprobación; `null` para todo lo demás (y entonces se envía la plantilla de siempre).
 */
function approvalFlowTarget(notification: PendingNotification, adapter: NotificationSendAdapter): string | null {
  if (!adapter.sendApprovalFlow || notification.template !== APPROVAL_TEMPLATE) return null;
  return extractRequisitionId(notification.payload);
}
/**
 * A qué aprobador va esta notificación. Lo escribe el servicio al encolar (una notificación por
 * aprobador con ítems pendientes) y aquí solo se transporta: el emisor lo usa para elegir el contexto
 * con LOS ÍTEMS DE ESA PERSONA. Ausente en las notificaciones de antes de este cambio, y entonces el
 * emisor cae al caso de siempre — un solo aprobador, un solo contexto.
 */
function approvalApproverId(payload: Record<string, unknown>): string | undefined {
  const value = payload.approverId;
  return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
}

export interface PendingNotification {
  id: string;
  /** Destination WhatsApp number, already resolved from `telefono_destino` or `usuarios.telefono`. Empty when neither could be resolved. */
  phone: string;
  template: string;
  payload: Record<string, unknown>;
  /** `notificaciones.intentos` at claim time (attempts already spent). */
  attempts: number;
}

/**
 * Durable-lease contract, same shape as `KapsoProcessingStore` in ./kapso-store.ts: `claimBatch`
 * atomically leases rows so two concurrent dispatch runs never grab the same notification, and a
 * crash mid-send self-heals once the lease (`bloqueada_hasta`) expires — no separate "processing"
 * state exists on `notificaciones`, so the lease deadline itself is the claim marker.
 */
export interface NotificationDispatchStore {
  /** Atomically leases up to `limit` due, unlocked, pending notifications and resolves their destination phone. */
  claimBatch(limit: number): Promise<PendingNotification[]>;
  /** Terminal success: records the send and appends the outbound `whatsapp_eventos` row in one transaction. */
  markSent(id: string, sent: { messageId: string; phone: string; template: string; payload: Record<string, unknown> }, sentAt: Date): Promise<void>;
  /** Non-terminal failure: stays `pendiente`, records the attempt count/error, and re-arms the lease as the backoff delay. */
  markRetry(id: string, attempts: number, error: string, retryAt: Date): Promise<void>;
  /** Terminal failure: the retry budget is exhausted (or the row can never be sent), so it stops blocking the queue. */
  markFailed(id: string, attempts: number, error: string): Promise<void>;
  /** Fail-closed path: releases the lease without touching `intentos` so the notification is retried later, never lost and never penalized. */
  release(id: string): Promise<void>;
}

export interface DispatchOutcome { claimed: number; sent: number; retried: number; failed: number; deferred: number; }

export interface DispatchOptions {
  /** How many notifications one invocation processes; keep modest so the internal endpoint answers quickly. */
  batchSize?: number;
  /** Attempts allowed (including the first) before a notification is marked `fallido` for good. */
  maxAttempts?: number;
  /** Backoff delay in ms before attempt N+1, given N attempts already spent. */
  backoffMs?: (attempts: number) => number;
  now?: () => Date;
}

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
function defaultBackoffMs(attempts: number): number { return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(attempts - 1, 0), MAX_BACKOFF_MS); }

function isKapsoNotConfigured(error: unknown): boolean { return error instanceof Error && error.message === "KAPSO_NOT_CONFIGURED"; }

/**
 * Espera antes de reintentar una notificación cuya plantilla Meta todavía no reconoce. Larga a
 * propósito: la aprobación de una UTILITY tarda horas, y reintentar cada minuto solo llena
 * `ultimo_error` de ruido sin acercar el envío.
 */
const PLANTILLA_AUSENTE_LEASE_MS = 10 * 60_000;

/**
 * "La plantilla no existe en Meta" NO es un fallo transitorio: es una precondición que aún no se
 * cumple. Gastar intentos contra ella es perder la notificación — con 5 intentos y backoff de 60 s a
 * 30 min, una notificación encolada antes de que Meta apruebe la plantilla muere `fallido` en menos
 * de una hora y hay que reencolarla a mano. Es exactamente lo que le pasó a `requisicion_recibida`.
 *
 * Se distingue por el CÓDIGO DE META, no por el HTTP: un 400 puede ser esto o parámetros mal
 * formados, y lo segundo sí debe agotar intentos y quedar `fallido` para que se vea.
 *
 * A diferencia de `KAPSO_NOT_CONFIGURED`, que libera el lote entero porque sin credenciales no puede
 * salir NINGUNA, aquí se difiere solo esta: las demás plantillas del lote pueden estar aprobadas.
 *
 * La lista de códigos NO está medida — ver META_ERRORES_PLANTILLA_AUSENTE en kapso.ts, que explica
 * por qué no se pudo y qué pasa si se queda corta (la notificación agota intentos y queda `fallido`,
 * que es el comportamiento de antes).
 */
function isPlantillaAusente(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const codigo = Number(error.message.split("_").at(-1));
  return Number.isFinite(codigo) && META_ERRORES_PLANTILLA_AUSENTE.has(codigo);
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "error_desconocido"; }
/**
 * Kapso template parameters are strings; the queued payload is arbitrary JSON.
 *
 * Para una plantilla declarada en `plantillas-whatsapp.ts` se manda SOLO lo que su texto usa. El
 * payload encolado lleva además `requisitionId`, que existe para enlazar la fila de
 * `whatsapp_eventos` con su requisición (`extractRequisitionId`, más abajo) y no tiene nada que
 * hacer dentro del mensaje: `sendKapsoTemplate` pasa este objeto tal cual como `parameters`, así que
 * sin el recorte el UUID interno acabaría en el WhatsApp del maestro o haría que Meta rechazara el
 * envío por un parámetro que la plantilla no declara.
 *
 * Una plantilla no declarada conserva el comportamiento de siempre —el payload entero—, para no
 * cambiar nada de lo que ya funciona ni de lo que alguien añada sin pasar por ese módulo.
 */
function toTemplatePayload(template: string, payload: Record<string, unknown>): Record<string, string> {
  const declarados = parametrosDePlantilla(template, payload);
  if (declarados) return declarados;
  return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, value === null || value === undefined ? "" : String(value)]));
}

/**
 * Drains one batch of pending WhatsApp notifications through the Kapso adapter.
 *
 * Scope: only `canal = 'whatsapp'` rows reach here (enforced by the store's claim query) — RF-406/904/905
 * are WhatsApp-template notifications, and Kapso has no other channel to send through. `interno`/`email`
 * rows are left untouched by design; they are not part of this despachador.
 *
 * Two distinct failure modes, handled differently on purpose:
 *  - `KAPSO_NOT_CONFIGURED` (adapter fails closed, no credentials): the notification is released, not
 *    penalized — it must never be lost or marked `fallido` just because the account isn't set up yet.
 *    The rest of the batch is released too and the run stops early: every remaining send would fail
 *    with the exact same error, so there is nothing left to attempt this run.
 *  - Any other error (network, non-2xx, timeout, missing destination): counts as a spent attempt with
 *    bounded exponential backoff; once `maxAttempts` is exhausted the row is marked `fallido` for good
 *    so it stops blocking the queue.
 */
export async function dispatchPendingNotifications(store: NotificationDispatchStore, adapter: NotificationSendAdapter, options: DispatchOptions = {}): Promise<DispatchOutcome> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = options.backoffMs ?? defaultBackoffMs;
  const now = options.now ?? (() => new Date());

  const batch = await store.claimBatch(batchSize);
  const outcome: DispatchOutcome = { claimed: batch.length, sent: 0, retried: 0, failed: 0, deferred: 0 };

  for (let index = 0; index < batch.length; index++) {
    const notification = batch[index];
    if (!notification.phone || !notification.template) {
      await store.markFailed(notification.id, notification.attempts, !notification.phone ? "SIN_TELEFONO_DESTINO" : "SIN_PLANTILLA");
      outcome.failed++;
      continue;
    }
    try {
      const sendAsTemplate = () => adapter.sendTemplate({ to: notification.phone, template: notification.template, payload: toTemplatePayload(notification.template, notification.payload) });
      const approvalRequisitionId = approvalFlowTarget(notification, adapter);
      const { messageId } = approvalRequisitionId
        ? await adapter.sendApprovalFlow!({ to: notification.phone, requisitionId: approvalRequisitionId, approverId: approvalApproverId(notification.payload), fallback: sendAsTemplate })
        : await sendAsTemplate();
      await store.markSent(notification.id, { messageId, phone: notification.phone, template: notification.template, payload: notification.payload }, now());
      outcome.sent++;
    } catch (error) {
      if (isKapsoNotConfigured(error)) {
        for (const remaining of batch.slice(index)) await store.release(remaining.id);
        outcome.deferred += batch.length - index;
        break;
      }
      if (isPlantillaAusente(error)) {
        // `notification.attempts` sin sumar: markRetry fija `intentos` en absoluto, así que pasar el
        // valor que ya traía deja el presupuesto de reintentos intacto. El motivo sí se guarda, para
        // que se vea en la cola por qué no ha salido.
        await store.markRetry(notification.id, notification.attempts, errorMessage(error), new Date(now().getTime() + PLANTILLA_AUSENTE_LEASE_MS));
        outcome.deferred++;
        continue;
      }
      const attempts = notification.attempts + 1;
      if (attempts >= maxAttempts) { await store.markFailed(notification.id, attempts, errorMessage(error)); outcome.failed++; }
      else { await store.markRetry(notification.id, attempts, errorMessage(error), new Date(now().getTime() + backoffMs(attempts))); outcome.retried++; }
    }
  }
  return outcome;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Best-effort link back to the requisition for the `whatsapp_eventos` audit trail; never blocks the send. */
function extractRequisitionId(payload: Record<string, unknown>): string | null {
  const value = payload.requisitionId;
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

/**
 * Postgres-backed store. `claimBatch` is one atomic statement: `for update skip locked` picks rows no
 * other concurrent run already holds, then the same statement stamps `bloqueada_hasta` as the lease
 * deadline — the same durable-lease shape `kapso-store.ts` uses (there: `estado='processing'` plus a
 * staleness check on `updated_at`; here: a single expiry timestamp, since `estado_envio` has no
 * "processing" value to spend). A crash between claim and completion simply leaves the lease to expire,
 * after which the row becomes claimable again — nothing is lost, nothing double-sends.
 */
export function createPostgresNotificationDispatchStore(databaseUrl = runtimeEnv().DATABASE_URL, leaseMs = 120_000): NotificationDispatchStore {
  const sql = sharedPostgres(databaseUrl);
  return {
    claimBatch: async (limit) => {
      const rows = await sql<{ id: string; telefono: string | null; plantilla: string | null; payload: Record<string, unknown>; intentos: number }[]>`
        with candidatos as (
          select id from notificaciones
          where canal = 'whatsapp' and estado_envio = 'pendiente'
            and (bloqueada_hasta is null or bloqueada_hasta <= now())
          order by fecha asc
          limit ${limit}
          for update skip locked
        ), reclamadas as (
          update notificaciones n
          set bloqueada_hasta = now() + (${leaseMs} * interval '1 millisecond')
          from candidatos c
          where n.id = c.id
          returning n.id, n.usuario_id, n.telefono_destino, n.plantilla, n.payload, n.intentos
        )
        select r.id, coalesce(nullif(btrim(r.telefono_destino), ''), u.telefono) as telefono, r.plantilla, r.payload, r.intentos
        from reclamadas r
        left join usuarios u on u.id = r.usuario_id`;
      // El teléfono se canoniza AL SALIR DE LA BASE: así el mismo valor se usa para enviar y para
      // guardar en whatsapp_eventos, y lo registrado es lo que de verdad se envió. `usuarios.telefono`
      // guarda el número local y sin esto salía sin indicativo — Meta lo descartaba en silencio.
      return rows.map((row) => ({ id: row.id, phone: destinatarioWhatsApp((row.telefono ?? "").trim()), template: row.plantilla ?? "", payload: row.payload ?? {}, attempts: row.intentos }));
    },
    markSent: async (id, sent, sentAt) => {
      await sql.begin(async (tx) => {
        // `kapso_message_id` es la ÚNICA forma de traer luego el acuse de entrega hasta esta fila
        // (ver lib/infrastructure/whatsapp-delivery-status.ts). Sin él, la cola se quedaría diciendo
        // `enviado` para un mensaje que Meta descartó — el mismo engaño que este trabajo viene a
        // arreglar, una capa más arriba. La fila de `whatsapp_eventos` de abajo ya guardaba el wamid;
        // lo que faltaba era dejarlo también aquí.
        await tx`update notificaciones set estado_envio='enviado', enviado_at=${sentAt}, ultimo_error=null, bloqueada_hasta=null, kapso_message_id=${sent.messageId} where id=${id}`;
        await tx`insert into whatsapp_eventos (direccion, telefono, requisicion_id, tipo, payload_json, estado_entrega, kapso_message_id, fecha)
          values ('salida', ${sent.phone}, ${extractRequisitionId(sent.payload)}, 'plantilla', ${asJsonb(tx, { template: sent.template, payload: sent.payload })}, 'enviado', ${sent.messageId}, ${sentAt})
          on conflict (kapso_message_id) where kapso_message_id is not null do nothing`;
      });
    },
    markRetry: async (id, attempts, error, retryAt) => { await sql`update notificaciones set estado_envio='pendiente', intentos=${attempts}, ultimo_error=${error.slice(0, 500)}, bloqueada_hasta=${retryAt} where id=${id}`; },
    markFailed: async (id, attempts, error) => { await sql`update notificaciones set estado_envio='fallido', intentos=${attempts}, ultimo_error=${error.slice(0, 500)}, bloqueada_hasta=null where id=${id}`; },
    release: async (id) => { await sql`update notificaciones set bloqueada_hasta=null where id=${id}`; },
  };
}
