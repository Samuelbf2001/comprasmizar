import { createHash, randomUUID } from "node:crypto";
import { asJsonb } from "./jsonb";
import { sharedPostgres } from "./postgres-repositories";
import { createLocalBucketStorage } from "./local-storage";
import { sniffAttachmentMimeOrPlainText } from "./attachment-mime";
import { runtimeEnv } from "../security/env";
import { ATTACHMENT_MIME_TYPES, expectedAttachmentExtensions, filename as sanitizeAttachmentName, IMAGE_MIME_TYPES, PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";

/**
 * Soporte opcional por artículo del portal público (RF portal-fotos-articulo). Nació como UNA FOTO
 * por ítem, calcada del `PhotoPicker` del Flow de WhatsApp; desde el 2026-09-17 admite además los
 * documentos con los que un proveedor cobra de verdad — decisión de Ernesto: «si puede ser muchos
 * tipos de archivos, CSV, Excel, etc., PDF, imágenes, lo que sea».
 *
 * DISEÑO DE SEGURIDAD (por qué este módulo existe y no un endpoint de subida previa):
 *
 * 1. El archivo viaja en la MISMA petición que radica la requisición (multipart, ver
 *    `app/api/public/requisitions/route.ts`) — nunca un endpoint público de "prepara la subida" antes
 *    de que exista una requisición: eso dejaría huérfanos (archivos sin dueño de quien nunca completó
 *    el envío) y sería un vector de abuso de almacenamiento sin ningún límite de negocio detrás.
 * 2. Por eso `saveAll` se llama SOLO después de que `ProcurementService.create` ya validó la
 *    contraseña, los límites y la requisición — nunca antes. Quien llama a este módulo (el endpoint)
 *    es responsable de ese orden; este módulo no vuelve a comprobar nada de eso.
 * 3. Cada archivo se valida por separado con el MISMO criterio que `PrivateAttachmentService.validate`
 *    (lista blanca de MIME, extensión coherente con el MIME, tamaño acotado) — importado de
 *    `attachment-service.ts`, no copiado. A diferencia de esa validación (que confía en los METADATOS
 *    que declaró el navegador porque la subida real llega después, por URL firmada), aquí SÍ tenemos
 *    los bytes en la misma petición: el MIME se decide OLFATEANDO el CONTENIDO real
 *    (`sniffAttachmentMimeOrPlainText`: firma binaria, y para el CSV la comprobación de que todo sea
 *    texto UTF-8 imprimible), nunca confiando en el `Content-Type` que declaró el navegador. Un .exe
 *    renombrado a .pdf, un zip que no es un OOXML o un OLE2 que no es un libro de Excel no pasan.
 * 4. El `tipo` del adjunto sale de lo que resultó SER el archivo, no de lo que dijo el cliente: una
 *    imagen se guarda como `foto` (exactamente como antes) y cualquier documento como `soporte`. Así
 *    "foto" sigue significando foto en la bandeja de quien revisa y en el CHECK de la base.
 * 5. Un archivo inválido (MIME irreconocible, extensión que no coincide, tamaño fuera de rango) se
 *    DESCARTA en silencio — nunca revienta la radicación, que ya existe y no puede quedar a medias
 *    por culpa de un archivo. Mismo espíritu que `createKapsoAttachmentCopier`: el resto de archivos y
 *    la requisición siguen su curso aunque uno falle. El formulario ya filtra en el navegador lo que
 *    no va a pasar aquí, así que este descarte es la red de seguridad, no el camino normal.
 */
export const MAX_PUBLIC_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Mismo orden de magnitud que `items.max(20)` del esquema público: como mucho un archivo por ítem, y
 *  como mucho 20 ítems por requisición — este tope es una defensa adicional, no la única. */
export const MAX_PUBLIC_ATTACHMENTS_PER_REQUEST = 20;
/** Mismo prefijo de ruta que usa `PrivateAttachmentService` para `requisicion_item` (PREFIX en
 *  attachment-service.ts, privado a ese módulo) y que ya usaba `createKapsoAttachmentCopier` en este
 *  mismo archivo hermano — los tres adjuntos de un mismo ítem (WhatsApp, portal, futuro) conviven bajo
 *  la misma carpeta del bucket privado. */
const PUBLIC_ATTACHMENT_PATH_PREFIX = "requisicion-items";

export interface PublicAttachmentCandidate {
  /** `requisicion_items.id` YA creado — lo obtiene el endpoint del `Requisition` que devuelve
   *  `ProcurementService.create` (nunca de lo que mande el cliente: los ids de ítem son internos). */
  itemId: string;
  /** Nombre tal como lo mandó el navegador (`File.name`); se sanea aquí, nunca se usa crudo. */
  name: string;
  bytes: Buffer;
}
export interface PublicAttachmentUploader {
  saveAll(requisitionId: string, candidates: readonly PublicAttachmentCandidate[]): Promise<void>;
}

/** Sniff + validación de tamaño/nombre/extensión. `null` = archivo inválido, se descarta. */
function safeAttachment(candidate: PublicAttachmentCandidate): { name: string; mimeType: string; type: "foto" | "soporte" } | null {
  if (candidate.bytes.byteLength < 1 || candidate.bytes.byteLength > MAX_PUBLIC_ATTACHMENT_BYTES) return null;
  const signature = sniffAttachmentMimeOrPlainText(candidate.bytes);
  if (!signature || !ATTACHMENT_MIME_TYPES.has(signature.mimeType)) return null;
  const type = IMAGE_MIME_TYPES.has(signature.mimeType) ? "foto" : "soporte";
  let name: string;
  try { name = sanitizeAttachmentName(candidate.name || `${type}.${signature.extension}`); } catch { return null; }
  const extension = name.slice(name.lastIndexOf(".") + 1);
  if (!expectedAttachmentExtensions(signature.mimeType).includes(extension)) return null;
  return { name, mimeType: signature.mimeType, type };
}

export function createPublicAttachmentUploader(databaseUrl = runtimeEnv().DATABASE_URL): PublicAttachmentUploader {
  const sql = sharedPostgres(databaseUrl);
  const storage = createLocalBucketStorage(PRIVATE_ATTACHMENT_BUCKET);
  return {
    async saveAll(requisitionId, candidates) {
      // Máximo 1 por ítem: si por lo que sea llegara más de un archivo para el mismo `itemId`, solo se
      // guarda el primero — nunca dos adjuntos del portal para el mismo artículo.
      const seenItems = new Set<string>();
      let saved = 0;
      for (const candidate of candidates) {
        if (saved >= MAX_PUBLIC_ATTACHMENTS_PER_REQUEST) break;
        if (seenItems.has(candidate.itemId)) continue;
        seenItems.add(candidate.itemId);
        const safe = safeAttachment(candidate);
        if (!safe) continue; // archivo inválido: se descarta, nunca revienta la radicación
        try {
          const adjuntoId = randomUUID();
          const path = `${PUBLIC_ATTACHMENT_PATH_PREFIX}/${candidate.itemId}/${adjuntoId}/${safe.name}`;
          const checksum = createHash("sha256").update(candidate.bytes).digest("hex");
          try { await storage.upload(path, candidate.bytes, safe.mimeType); } catch { continue; }
          await sql`insert into adjuntos (id, entidad, entidad_id, storage_bucket, url_storage, tipo, nombre_original, mime_type, tamano_bytes, subido_por, checksum_sha256, fecha) values (${adjuntoId}, 'requisicion_item', ${candidate.itemId}, ${PRIVATE_ATTACHMENT_BUCKET}, ${path}, ${safe.type}, ${safe.name}, ${safe.mimeType}, ${candidate.bytes.byteLength}, null, ${checksum}, now())`;
          await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values ('requisicion_item', ${candidate.itemId}, 'ADJUNTO_PORTAL_DISPONIBLE', 'web', null, now(), ${asJsonb(sql, { requisitionId, sizeBytes: candidate.bytes.byteLength, mimeType: safe.mimeType })})`;
          saved += 1;
        } catch {
          // Nunca deja que un archivo reviente la radicación (que ya existe): se salta y sigue con los demás.
        }
      }
    },
  };
}
