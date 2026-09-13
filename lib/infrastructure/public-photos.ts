import { createHash, randomUUID } from "node:crypto";
import { asJsonb } from "./jsonb";
import { sharedPostgres } from "./postgres-repositories";
import { createLocalBucketStorage } from "./local-storage";
import { sniffAttachmentMime } from "./attachment-mime";
import { runtimeEnv } from "../security/env";
import { expectedAttachmentExtensions, filename as sanitizeAttachmentName, IMAGE_MIME_TYPES, PRIVATE_ATTACHMENT_BUCKET } from "../services/attachment-service";

/**
 * Foto opcional por artículo del portal público (RF portal-fotos-articulo), calcada del `PhotoPicker`
 * del Flow de WhatsApp: como allá, es UNA foto por ítem, nunca un documento.
 *
 * DISEÑO DE SEGURIDAD (por qué este módulo existe y no un endpoint de subida previa):
 *
 * 1. La foto viaja en la MISMA petición que radica la requisición (multipart, ver
 *    `app/api/public/requisitions/route.ts`) — nunca un endpoint público de "prepara la subida" antes
 *    de que exista una requisición: eso dejaría huérfanos (archivos sin dueño de quien nunca completó
 *    el envío) y sería un vector de abuso de almacenamiento sin ningún límite de negocio detrás.
 * 2. Por eso `saveAll` se llama SOLO después de que `ProcurementService.create` ya validó la
 *    contraseña, los límites y la requisición — nunca antes. Quien llama a este módulo (el endpoint)
 *    es responsable de ese orden; este módulo no vuelve a comprobar nada de eso.
 * 3. Cada foto se valida por separado con el MISMO criterio que `PrivateAttachmentService.validate`
 *    (imagen jpeg/png/webp, extensión coherente con el MIME, tamaño acotado) — importado de
 *    `attachment-service.ts`, no copiado. A diferencia de esa validación (que confía en los METADATOS
 *    que declaró el navegador porque la subida real llega después, por URL firmada), aquí SÍ tenemos
 *    los bytes en la misma petición: el MIME se decide OLFATEANDO la firma binaria real
 *    (`sniffAttachmentMime`, igual que `kapso-store.ts` con las fotos que llegan por WhatsApp), nunca
 *    confiando en el `Content-Type` que declaró el navegador.
 * 4. Una foto inválida (MIME irreconocible, extensión que no coincide, tamaño fuera de rango) se
 *    DESCARTA en silencio — nunca revienta la radicación, que ya existe y no puede quedar a medias
 *    por culpa de un archivo. Mismo espíritu que `createKapsoAttachmentCopier`: el resto de fotos y la
 *    requisición siguen su curso aunque una falle.
 */
export const MAX_PUBLIC_PHOTO_BYTES = 5 * 1024 * 1024;
/** Mismo orden de magnitud que `items.max(20)` del esquema público: como mucho una foto por ítem, y
 *  como mucho 20 ítems por requisición — este tope es una defensa adicional, no la única. */
export const MAX_PUBLIC_PHOTOS_PER_REQUEST = 20;
/** Mismo prefijo de ruta que usa `PrivateAttachmentService` para `requisicion_item` (PREFIX en
 *  attachment-service.ts, privado a ese módulo) y que ya usaba `createKapsoAttachmentCopier` en este
 *  mismo archivo hermano — las tres fotos de un mismo ítem (WhatsApp, portal, futuro) conviven bajo la
 *  misma carpeta del bucket privado. */
const PUBLIC_PHOTO_PATH_PREFIX = "requisicion-items";

export interface PublicPhotoCandidate {
  /** `requisicion_items.id` YA creado — lo obtiene el endpoint del `Requisition` que devuelve
   *  `ProcurementService.create` (nunca de lo que mande el cliente: los ids de ítem son internos). */
  itemId: string;
  /** Nombre tal como lo mandó el navegador (`File.name`); se sanea aquí, nunca se usa crudo. */
  name: string;
  bytes: Buffer;
}
export interface PublicPhotoUploader {
  saveAll(requisitionId: string, candidates: readonly PublicPhotoCandidate[]): Promise<void>;
}

/** Sniff + validación de tamaño/nombre/extensión. `null` = foto inválida, se descarta. */
function safePhoto(candidate: PublicPhotoCandidate): { name: string; mimeType: string } | null {
  if (candidate.bytes.byteLength < 1 || candidate.bytes.byteLength > MAX_PUBLIC_PHOTO_BYTES) return null;
  const signature = sniffAttachmentMime(candidate.bytes);
  if (!signature || !IMAGE_MIME_TYPES.has(signature.mimeType)) return null;
  let name: string;
  try { name = sanitizeAttachmentName(candidate.name || `foto.${signature.extension}`); } catch { return null; }
  const extension = name.slice(name.lastIndexOf(".") + 1);
  if (!expectedAttachmentExtensions(signature.mimeType).includes(extension)) return null;
  return { name, mimeType: signature.mimeType };
}

export function createPublicPhotoUploader(databaseUrl = runtimeEnv().DATABASE_URL): PublicPhotoUploader {
  const sql = sharedPostgres(databaseUrl);
  const storage = createLocalBucketStorage(PRIVATE_ATTACHMENT_BUCKET);
  return {
    async saveAll(requisitionId, candidates) {
      // Máximo 1 por ítem: si por lo que sea llegara más de una foto para el mismo `itemId`, solo se
      // guarda la primera — nunca dos adjuntos "foto" para el mismo artículo del portal.
      const seenItems = new Set<string>();
      let saved = 0;
      for (const candidate of candidates) {
        if (saved >= MAX_PUBLIC_PHOTOS_PER_REQUEST) break;
        if (seenItems.has(candidate.itemId)) continue;
        seenItems.add(candidate.itemId);
        const safe = safePhoto(candidate);
        if (!safe) continue; // foto inválida: se descarta, nunca revienta la radicación
        try {
          const adjuntoId = randomUUID();
          const path = `${PUBLIC_PHOTO_PATH_PREFIX}/${candidate.itemId}/${adjuntoId}/${safe.name}`;
          const checksum = createHash("sha256").update(candidate.bytes).digest("hex");
          try { await storage.upload(path, candidate.bytes, safe.mimeType); } catch { continue; }
          await sql`insert into adjuntos (id, entidad, entidad_id, storage_bucket, url_storage, tipo, nombre_original, mime_type, tamano_bytes, subido_por, checksum_sha256, fecha) values (${adjuntoId}, 'requisicion_item', ${candidate.itemId}, ${PRIVATE_ATTACHMENT_BUCKET}, ${path}, 'foto', ${safe.name}, ${safe.mimeType}, ${candidate.bytes.byteLength}, null, ${checksum}, now())`;
          await sql`insert into auditoria (entidad, entidad_id, evento, origen, usuario_id, fecha, datos_json) values ('requisicion_item', ${candidate.itemId}, 'ADJUNTO_PORTAL_DISPONIBLE', 'web', null, now(), ${asJsonb(sql, { requisitionId, sizeBytes: candidate.bytes.byteLength, mimeType: safe.mimeType })})`;
          saved += 1;
        } catch {
          // Nunca deja que una foto reviente la radicación (que ya existe): se salta y sigue con las demás.
        }
      }
    },
  };
}
