import { z } from "zod";
import { randomUUID } from "node:crypto";
import { colombiaDateParts, DomainError, type Requisition } from "../../../../lib/domain";
import { ProcurementService } from "../../../../lib/services";
import { SUPPLIER_IDENTIFICATION_TYPE_VALUES } from "../../../../lib/http/schemas";
import { createPostgresDependencies } from "../../../../lib/infrastructure/postgres-repositories";
import { createPublicAttachmentUploader, type PublicAttachmentCandidate } from "../../../../lib/infrastructure/public-attachments";
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
 * Se rechaza mandar ambos o ninguno: con los dos, no está claro cuál manda.
 *
 * `phone` OPCIONAL (Ernesto: "el teléfono no lo hagas obligatorio"). Cuando falta, no hay a quién
 * avisar: la requisición se crea igual y no se encola el acuse. `requiredDate` opcional desde la
 * reunión 2026-08-31, en los tres canales.
 */
const publicCommonFields = {
  workId: z.string().uuid().optional(), societyId: z.string().uuid().optional(),
  code: z.string().trim().min(4).max(64),
  phone: z.string().trim().min(7).max(20).optional(),
  observations: z.string().trim().min(1).max(3000).optional(),
};
const publicPurchaseSchema = z.object({
  ...publicCommonFields,
  type: z.literal("compra"),
  requiredDate: z.string().date().optional(), name: z.string().trim().min(2).max(160),
  // Hasta 20 ítems (Ernesto: "solo dejas agregar un ítem por form, debe permitir ir agregando más").
  // El tope alto de antes (100) nunca se usó porque la interfaz mandaba uno solo; 20 es el mismo
  // orden de magnitud que el Flow de WhatsApp (8 franjas) y que el CheckboxGroup de aprobación (20),
  // así que una requisición radicada por el portal sigue cabiendo en el resto del ciclo.
  items: z.array(publicItemSchema).min(1).max(20),
}).strict();
/** RF-108: "concepto corto". El formulario limita el campo al mismo tope. */
export const MAX_PUBLIC_PAYMENT_CONCEPT_LENGTH = 120;
/** Un billón de pesos: cabe de sobra en `numeric(16,2)` (requisicion_items.valor_base) y ningún pago
 *  único de obra se acerca; sirve para cortar basura, no para acotar el negocio. */
export const MAX_PUBLIC_PAYMENT_AMOUNT = 1_000_000_000_000;
/**
 * RF-108 (adenda de pagos, A12): solicitud de pago desde el portal. Quien la radica ES el beneficiario
 * (un profesional o proveedor que cobra), así que no hay un "solicitante" aparte: `beneficiary.name` es
 * también el nombre del solicitante externo, y `phone` (común) el teléfono de los dos. Mismos topes que
 * `beneficiarySchema` (lib/http/schemas.ts) sin el teléfono, que aquí viaja arriba. Sin `items`: el
 * concepto y el monto SON la única línea, y la arma el endpoint (ver `create` más abajo).
 */
const publicPaymentSchema = z.object({
  ...publicCommonFields,
  type: z.literal("pago"),
  beneficiary: z.object({
    identificationType: z.enum(SUPPLIER_IDENTIFICATION_TYPE_VALUES),
    identification: z.string().trim().min(3).max(32),
    name: z.string().trim().min(2).max(160),
  }).strict(),
  amount: z.number().int().positive().max(MAX_PUBLIC_PAYMENT_AMOUNT),
  concept: z.string().trim().min(1).max(MAX_PUBLIC_PAYMENT_CONCEPT_LENGTH),
}).strict();
export const publicRequisitionSchema = z.discriminatedUnion("type", [publicPurchaseSchema, publicPaymentSchema])
  .refine((value) => Boolean(value.workId) !== Boolean(value.societyId), { message: "workId o societyId, exactamente uno", path: ["societyId"] });

export function normalizePublicPhone(phone: string): string { return phone.replace(/[\s()\-]/g, ""); }
const noStore = { "Cache-Control": "no-store" };
/**
 * La respuesta NEUTRA (202) es la defensa anti-enumeración: quien prueba contraseñas o enlaces recibe
 * exactamente lo mismo que quien acierta. Desde la adenda de pagos (S3) se reserva para ESO — límites
 * de abuso, contraseña/enlace — y ya no tapa errores de forma ni de dominio: antes una solicitud de
 * pago mal formada recibía este 202 y se perdía en silencio, que es el peor final posible porque
 * parece que sí se envió.
 */
const neutral = () => Response.json({ accepted: true }, { status: 202, headers: noStore });
/** Mismo contrato que `apiError` (lib/http/api.ts) para un cuerpo que no pasa el esquema. */
const invalidInput = (issues: readonly z.core.$ZodIssue[]) =>
  Response.json({ error: "invalid_input", issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), code: issue.code })) }, { status: 400, headers: noStore });
const badRequest = (error: string, message: string) => Response.json({ error, message }, { status: 400, headers: noStore });
const tooLarge = () => Response.json({ error: "payload_too_large", message: "El envío excede el tamaño permitido" }, { status: 413, headers: noStore });
/** Infraestructura caída: se dice (el portal ofrece reintentar) sin exponer el detalle. */
const unavailable = () => Response.json({ error: "service_unavailable" }, { status: 503, headers: noStore });
/**
 * Un error de dominio DESPUÉS de verificar contraseña y enlace se responde con su código y mensaje —
 * misma tabla que `apiError`—. Que sea visible no abre ningún oráculo nuevo: aquí solo se llega con
 * la contraseña correcta, y `POST /api/public/access` ya lo dice en la puerta.
 *
 * `PUBLIC_ACCESS_DENIED` lanzado por el SERVICIO no es un intento fallido de acceso (ese ya se
 * respondió neutro arriba) sino una inconsistencia interna —la ruta autorizó y el servicio no—, así
 * que se trata como infraestructura: 503 en vez de un 202 que fingiría que se radicó.
 */
function failure(error: unknown): Response {
  if (error instanceof DomainError) {
    if (error.code === "PUBLIC_ACCESS_DENIED") return unavailable();
    const status = error.code === "FORBIDDEN" ? 403 : error.code === "CONFLICT" ? 409 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 422;
    return Response.json({ error: error.code.toLowerCase(), message: error.message }, { status, headers: noStore });
  }
  return unavailable();
}
const MAX_PUBLIC_JSON_BYTES = 100_000;
/**
 * ~60 MB: tope AGREGADO del cuerpo multipart, distinto del tope POR ARCHIVO (10 MB, ver
 * `MAX_PUBLIC_ATTACHMENT_BYTES` en `lib/infrastructure/public-attachments.ts`). Son dos límites con
 * dos trabajos: el de archivo es lo que se le promete a quien sube uno, y este acota lo que un
 * anónimo puede hacernos leer de una sola vez — por eso no es 20 × 10 MB. Defensa en profundidad, no
 * la única: cada archivo se vuelve a validar por separado (MIME real, tamaño) antes de guardarlo, así
 * que un cuerpo dentro del tope pero con un archivo inválido no rompe nada — ese archivo se descarta
 * y la requisición se crea igual.
 */
const MAX_PUBLIC_MULTIPART_BYTES = 60 * 1024 * 1024;
/** `foto_<índice>`: el índice es la posición del artículo en `items`, la MISMA que usa el portal para
 *  mostrar los errores de cada línea (`description-<índice>`, ver public-request.tsx). En una solicitud
 *  de pago solo existe el índice 0: la factura o cuenta de cobro va ligada al único concepto.
 *
 *  El nombre del campo se queda en `foto_` aunque desde 2026-09-17 transporte también PDF, Excel y CSV:
 *  es el contrato de red que ya hablan el portal y este endpoint, y renombrarlo no cambiaría ni una
 *  validación. Qué ES cada archivo lo decide el servidor mirando los bytes, nunca el nombre del campo. */
const PHOTO_FIELD_RE = /^foto_(\d+)$/;

export async function POST(request: Request) {
  // Caddy must overwrite X-Real-IP; never parse a client-supplied X-Forwarded-For chain here.
  if (!isPublicConfigured()) return unavailable(); const ip = request.headers.get("x-real-ip") ?? "direct"; if (!publicFormRateLimiter.consume(ip)) return neutral();
  // Portal público con soporte opcional por artículo: la MISMA petición que radica trae, además del
  // JSON de siempre, un `multipart/form-data` con un campo `payload` (idéntico contrato JSON) y hasta
  // una `foto_<índice>` por artículo. El camino JSON puro (sin archivos) es EXACTAMENTE el de siempre —
  // nada de lo de abajo lo toca cuando `content-type` no es multipart.
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  const isMultipart = contentType.startsWith("multipart/form-data");
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > (isMultipart ? MAX_PUBLIC_MULTIPART_BYTES : MAX_PUBLIC_JSON_BYTES)) return tooLarge();
  let payload: unknown = null;
  // itemIndex -> archivo. `Map` en vez de arreglo: como mucho una foto por índice, así que una
  // repetida (mismo campo dos veces) no se acumula — gana la primera.
  const photosByIndex = new Map<number, File>();
  if (isMultipart) {
    let form: FormData; try { form = await request.formData(); } catch { return badRequest("invalid_multipart", "El formulario multipart no se pudo leer"); }
    let totalPhotoBytes = 0;
    for (const [key, value] of form.entries()) {
      const match = PHOTO_FIELD_RE.exec(key);
      if (!match || !(value instanceof File) || value.size < 1) continue;
      totalPhotoBytes += value.size;
      // Reafirma el tope total incluso si el Content-Length declarado mintió: no se sigue leyendo
      // fotos más allá de lo que el cuerpo dice pesar.
      if (totalPhotoBytes > MAX_PUBLIC_MULTIPART_BYTES) return tooLarge();
      if (!photosByIndex.has(Number(match[1]))) photosByIndex.set(Number(match[1]), value);
    }
    const raw = form.get("payload");
    if (typeof raw !== "string") return badRequest("invalid_input", "Falta el campo payload");
    if (Buffer.byteLength(raw, "utf8") > MAX_PUBLIC_JSON_BYTES) return tooLarge();
    try { payload = JSON.parse(raw); } catch { return badRequest("invalid_json", "El cuerpo no es JSON válido"); }
  } else {
    const raw = await request.text(); if (Buffer.byteLength(raw, "utf8") > MAX_PUBLIC_JSON_BYTES) return tooLarge();
    try { payload = JSON.parse(raw); } catch { return badRequest("invalid_json", "El cuerpo no es JSON válido"); }
  }
  // `x-public-link-token` es OPCIONAL desde 2026-09-11: la ruta del portal es pública y la llave es la
  // contraseña. Cuando viene, sigue acotando a la obra que firma.
  const parsed = publicRequisitionSchema.safeParse(payload), linkToken = request.headers.get("x-public-link-token"); if (!parsed.success) return invalidInput(parsed.error.issues);
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
  let dependencies: ReturnType<typeof createPostgresDependencies>;
  try {
    dependencies = createPostgresDependencies();
    // Dos caminos, dos verificaciones. `verify` exige que la OBRA esté abierta; `verifySociety` que la
    // EMPRESA esté activa y que, si viene token, sea el general — un token por obra no puede autorizar
    // una sociedad cualquiera. En ambos, la contraseña se comprueba en la base.
    const autorizado = parsed.data.workId
      ? await dependencies.publicAccess.verify(parsed.data.workId, linkToken, parsed.data.code)
      : await dependencies.publicAccess.verifySociety(parsed.data.societyId!, linkToken, parsed.data.code);
    if (!autorizado) return neutral();
  } catch { return unavailable(); }
  // Obra O empresa, exactamente una, como exige el esquema. Con obra, la sociedad la deriva el
  // trigger; con empresa, la obra la asigna el revisor en la bandeja.
  const destination = parsed.data.workId ? { workId: parsed.data.workId } : { societyId: parsed.data.societyId };
  const common = { channel: "publico" as const, publicCode: parsed.data.code, publicLinkToken: linkToken ?? undefined, observations: parsed.data.observations };
  // `create` devuelve la Requisition completa, CON los ítems ya guardados — internamente, nunca en
  // la respuesta pública (que sigue siendo el 202 neutro de siempre). Es lo único que permite ligar
  // cada `foto_<índice>` al `requisicion_items.id` real que le corresponde: los ids de ítem son
  // internos y jamás los propone el cliente.
  let requisition: Requisition;
  try {
    const service = new ProcurementService(dependencies);
    requisition = parsed.data.type === "pago"
      // RF-108: una sola línea de concepto (cantidad 1, valor = monto), como arma el formulario interno
      // (`unit: "servicio"`), y el beneficiario por identificación: `create` lo enlaza al proveedor
      // existente o lo crea `pendingNormalization` en la misma transacción (RF-606). El portal no pide
      // la fecha del gasto: es real y por defecto hoy en Colombia (PRD D6), no la del reloj del servidor.
      ? await service.create({
        type: "pago", ...destination, ...common,
        requiredDate: colombiaDateParts(new Date()).day,
        externalRequester: { name: parsed.data.beneficiary.name, ...(phone ? { phone } : {}) },
        beneficiary: { ...parsed.data.beneficiary, ...(phone ? { phone } : {}) },
        items: [{ id: randomUUID(), description: parsed.data.concept, quantity: 1, unit: "servicio", unitBase: parsed.data.amount, unitIva: 0 }],
      }, {})
      : await service.create({
        type: "compra", ...destination, ...common,
        requiredDate: parsed.data.requiredDate,
        externalRequester: { name: parsed.data.name, ...(phone ? { phone } : {}) },
        items: parsed.data.items.map((item) => ({ ...item, id: randomUUID(), unitBase: 0, unitIva: 0 })),
      }, {});
  } catch (error) { return failure(error); }
  // Solo se guardan archivos si la radicación fue válida — llegar aquí ya exigió limitador, contraseña
  // y validación, en ese orden. `requisition.items` conserva el mismo orden que `parsed.data.items`
  // (ver ProcurementService.materializeProposals), así que el índice del campo `foto_<índice>` sigue
  // señalando al mismo artículo. Un índice sin ítem correspondiente (más archivos que artículos, o un
  // índice inventado) se ignora en vez de reventar.
  //
  // Y nunca convierte la respuesta en error: la requisición YA existe, y un fallo aquí que devolviera
  // 503 haría que la persona la volviera a mandar por duplicado. `saveAll` ya descarta el archivo
  // inválido por su cuenta; esto cubre lo que pase antes de llegar a él (leer los bytes, abrir el almacén).
  if (photosByIndex.size) {
    try {
      const candidates: PublicAttachmentCandidate[] = [];
      for (const [index, file] of photosByIndex) {
        const item = requisition.items[index];
        if (!item) continue;
        candidates.push({ itemId: item.id, name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
      }
      if (candidates.length) await createPublicAttachmentUploader().saveAll(requisition.id, candidates);
    } catch { /* la requisición ya quedó radicada; el archivo es lo único que se pierde */ }
  }
  return neutral();
}
