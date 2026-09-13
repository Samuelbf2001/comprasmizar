import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ProcurementService } from "../../../../lib/services";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { createPublicPhotoUploader, type PublicPhotoCandidate } from "../../../../lib/infrastructure/public-photos";
import { isPublicConfigured } from "../../../../lib/security/env";
import { publicFormRateLimiter, publicWorkAggregateRateLimiter, publicWorkRateLimiter } from "../../../../lib/security/rate-limit";

export const runtime = "nodejs";
const publicItemSchema = z.object({
  itemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().finite().positive().max(1_000_000),
  // Texto libre, no una lista cerrada (Ernesto, 11-sep-2026: "las unidades no son un desplegable").
  // El formulario ofrece sugerencias con `<datalist>`, que sugiere sin restringir: un maestro que pide
  // "cuñete" o "rollo" no puede quedarse sin poder escribirlo.
  unit: z.string().trim().min(1).max(20),
  possibleSupplier: z.string().trim().min(1).max(240).optional(),
  productLink: z.string().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "HTTPS URL required").optional(),
}).strict().refine((item) => Boolean(item.itemId || item.description), { message: "itemId or description is required" });

/**
 * Public clients may identify a catalogue item, but never line IDs or quoted amounts.
 *
 * OBRA **O** EMPRESA, exactamente una. Son los dos caminos de entrada al portal, y cada uno sabe una
 * cosa distinta:
 *   - `workId`: el enlace POR OBRA, que trae la obra fija y firmada en el fragmento. La sociedad la
 *     deriva el trigger `requisiciones_0_derivar_sociedad` a partir de la obra. Sigue funcionando
 *     igual que siempre; no se rompe a quien ya tenga uno repartido.
 *   - `societyId`: la ruta general, donde el solicitante elige EMPRESA (reunión 2026-08-31 y
 *     recordatorio de Ernesto el 11-sep-2026). La obra la asigna el revisor, que es quien sabe a qué
 *     contrato cargar el gasto.
 * Se rechaza mandar ambos o ninguno: con los dos, no está claro cuál manda, y el silencio del 202
 * neutro haría ese desacuerdo invisible.
 *
 * `phone` OPCIONAL (Ernesto: "el teléfono no lo hagas obligatorio"). Cuando falta, no hay a quién
 * avisar: la requisición se crea igual y no se encola el acuse. `requiredDate` opcional desde la
 * reunión 2026-08-31, en los tres canales.
 */
export const publicRequisitionSchema = z.object({
  workId: z.string().uuid().optional(), societyId: z.string().uuid().optional(),
  code: z.string().trim().min(4).max(64), type: z.enum(["compra", "pago"]),
  requiredDate: z.string().date().optional(), name: z.string().trim().min(2).max(160),
  phone: z.string().trim().min(7).max(20).optional(),
  observations: z.string().trim().min(1).max(3000).optional(),
  // Hasta 20 ítems (Ernesto: "solo dejas agregar un ítem por form, debe permitir ir agregando más").
  // El tope alto de antes (100) nunca se usó porque la interfaz mandaba uno solo; 20 es el mismo
  // orden de magnitud que el Flow de WhatsApp (8 franjas) y que el CheckboxGroup de aprobación (20),
  // así que una requisición radicada por el portal sigue cabiendo en el resto del ciclo.
  items: z.array(publicItemSchema).min(1).max(20),
}).strict().refine((value) => Boolean(value.workId) !== Boolean(value.societyId), { message: "workId o societyId, exactamente uno" });

export function normalizePublicPhone(phone: string): string { return phone.replace(/[\s()\-]/g, ""); }
const neutral = () => Response.json({ accepted: true }, { status: 202, headers: { "Cache-Control": "no-store" } });
const MAX_PUBLIC_JSON_BYTES = 100_000;
/**
 * ~60 MB (RF portal-fotos-articulo): hasta 20 fotos de 5 MB cada una (ver
 * `lib/infrastructure/public-photos.ts`) más margen para el resto del `multipart/form-data`. Defensa
 * en profundidad, no la única: cada foto se vuelve a validar por separado (MIME real, tamaño) antes de
 * guardarla, así que un cuerpo dentro del tope pero con un archivo inválido no rompe nada — esa foto
 * se descarta y la requisición se crea igual.
 */
const MAX_PUBLIC_MULTIPART_BYTES = 60 * 1024 * 1024;
/** `foto_<índice>`: el índice es la posición del artículo en `items`, la MISMA que usa el portal para
 *  mostrar los errores de cada línea (`description-<índice>`, ver public-request.tsx). */
const PHOTO_FIELD_RE = /^foto_(\d+)$/;

export async function POST(request: Request) {
  // Caddy must overwrite X-Real-IP; never parse a client-supplied X-Forwarded-For chain here.
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503 }); const ip = request.headers.get("x-real-ip") ?? "direct"; if (!publicFormRateLimiter.consume(ip)) return neutral();
  // Portal público con foto opcional por artículo: la MISMA petición que radica trae, además del JSON
  // de siempre, un `multipart/form-data` con un campo `payload` (idéntico contrato JSON) y hasta una
  // `foto_<índice>` por artículo. El camino JSON puro (sin fotos) es EXACTAMENTE el de siempre — nada
  // de lo de abajo lo toca cuando `content-type` no es multipart.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const isMultipart = contentType.startsWith("multipart/form-data");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > (isMultipart ? MAX_PUBLIC_MULTIPART_BYTES : MAX_PUBLIC_JSON_BYTES)) return neutral();
  let payload: unknown = null;
  // itemIndex -> archivo. `Map` en vez de arreglo: como mucho una foto por índice, así que una
  // repetida (mismo campo dos veces) no se acumula — gana la primera.
  const photosByIndex = new Map<number, File>();
  if (isMultipart) {
    let form: FormData; try { form = await request.formData(); } catch { return neutral(); }
    let totalPhotoBytes = 0;
    for (const [key, value] of form.entries()) {
      const match = PHOTO_FIELD_RE.exec(key);
      if (!match || !(value instanceof File) || value.size < 1) continue;
      totalPhotoBytes += value.size;
      // Reafirma el tope total incluso si el Content-Length declarado mintió: no se sigue leyendo
      // fotos más allá de lo que el cuerpo dice pesar.
      if (totalPhotoBytes > MAX_PUBLIC_MULTIPART_BYTES) return neutral();
      if (!photosByIndex.has(Number(match[1]))) photosByIndex.set(Number(match[1]), value);
    }
    const raw = form.get("payload");
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_PUBLIC_JSON_BYTES) return neutral();
    try { payload = JSON.parse(raw); } catch { payload = null; }
  } else {
    const raw = await request.text(); if (Buffer.byteLength(raw, "utf8") > MAX_PUBLIC_JSON_BYTES) return neutral();
    try { payload = JSON.parse(raw); } catch { payload = null; }
  }
  // `x-public-link-token` es OPCIONAL desde 2026-09-11: la ruta del portal es pública y la llave es la
  // contraseña. Cuando viene, sigue acotando a la obra que firma.
  const parsed = publicRequisitionSchema.safeParse(payload), linkToken = request.headers.get("x-public-link-token"); if (!parsed.success) return neutral();
  // publicWorkRateLimiter (ip:destino) por sí solo es evadible repartiendo intentos entre muchas IPs; el
  // agregado por destino (sin IP) acota el total de intentos contra ese destino sin importar el origen.
  //
  // El "destino" es la obra cuando se entra por enlace firmado y la EMPRESA cuando se elige en el
  // formulario general. Sin esto, la ruta por empresa se habría quedado sin el limitador agregado —
  // el hueco exacto que el de obra existía para tapar.
  const destino = parsed.data.workId ?? parsed.data.societyId!;
  if (!publicWorkRateLimiter.consume(`${ip}:${destino}`) || !publicWorkAggregateRateLimiter.consume(destino)) return neutral();
  // Teléfono opcional: cuando no viene, queda `undefined` y no hay acuse. Nunca cadena vacía, que
  // acabaría guardada como un teléfono en blanco en `solicitante_telefono_externo`.
  const phone = parsed.data.phone ? normalizePublicPhone(parsed.data.phone) : undefined;
  // Orden deliberado (hallazgo de auditoría adversarial): la verificación criptográfica del enlace
  // (HMAC en memoria) y de la contraseña se evalúa ANTES de cualquier otra consulta a la base. Con un
  // HMAC inválido no se llega a tocar Postgres, así que ese primer filtro es gratis para nosotros y
  // caro de eludir.
  //
  // LA LISTA BLANCA DE TELÉFONOS YA NO BLOQUEA. Decisión de Ernesto (11-sep-2026): la contraseña es
  // la llave, "para ingresar solo una contraseña válida", y el teléfono pasó a ser opcional — una
  // lista blanca de teléfonos no puede autorizar a quien no da ninguno. `obra_solicitantes_autorizados`
  // sigue existiendo y la sigue usando el canal de WhatsApp, donde el número SÍ es la identidad del
  // remitente; aquí no tenía a quién comprobar.
  try {
    const dependencies = createPostgresDependencies();
    // Dos caminos, dos verificaciones. `verify` exige que la OBRA esté abierta; `verifySociety` que la
    // EMPRESA esté activa y que, si viene token, sea el general — un token por obra no puede autorizar
    // una sociedad cualquiera. En ambos, la contraseña se comprueba en la base.
    const autorizado = parsed.data.workId
      ? await dependencies.publicAccess.verify(parsed.data.workId, linkToken, parsed.data.code)
      : await dependencies.publicAccess.verifySociety(parsed.data.societyId!, linkToken, parsed.data.code);
    if (!autorizado) return neutral();
    const service = new ProcurementService(dependencies);
    // `create` devuelve la Requisition completa, CON los ítems ya guardados — internamente, nunca en
    // la respuesta pública (que sigue siendo el 202 neutro de siempre). Es lo único que permite ligar
    // cada `foto_<índice>` al `requisicion_items.id` real que le corresponde: los ids de ítem son
    // internos y jamás los propone el cliente.
    const requisition = await service.create({
      type: parsed.data.type,
      // Exactamente uno de los dos viaja, como exige el esquema. Con obra, la sociedad la deriva el
      // trigger; con empresa, la obra la asigna el revisor en la bandeja.
      ...(parsed.data.workId ? { workId: parsed.data.workId } : { societyId: parsed.data.societyId }),
      requiredDate: parsed.data.requiredDate,
      channel: "publico",
      publicCode: parsed.data.code,
      publicLinkToken: linkToken ?? undefined,
      externalRequester: { name: parsed.data.name, ...(phone ? { phone } : {}) },
      observations: parsed.data.observations,
      items: parsed.data.items.map((item) => ({ ...item, id: randomUUID(), unitBase: 0, unitIva: 0 })),
    }, {});
    // Solo se guardan fotos si la radicación fue válida — llegar aquí ya exigió limitador, contraseña
    // y validación, en ese orden. `requisition.items` conserva el mismo orden que `parsed.data.items`
    // (ver ProcurementService.materializeProposals), así que el índice del campo `foto_<índice>` sigue
    // señalando al mismo artículo. Un índice sin ítem correspondiente (más fotos que artículos, o un
    // índice inventado) se ignora en vez de reventar.
    if (photosByIndex.size) {
      const candidates: PublicPhotoCandidate[] = [];
      for (const [index, file] of photosByIndex) {
        const item = requisition.items[index];
        if (!item) continue;
        candidates.push({ itemId: item.id, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      }
      if (candidates.length) await createPublicPhotoUploader().saveAll(requisition.id, candidates);
    }
    return neutral();
  } catch { return neutral(); }
}
