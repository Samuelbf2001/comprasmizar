import { PLAIN_TEXT_MIME_TYPE, sniffAttachmentMimeOrPlainText } from "../../../../lib/infrastructure/attachment-mime";
import { readObject, verifyStorageToken, writeObject } from "../../../../lib/infrastructure/local-storage";
import { ATTACHMENT_MIME_TYPES, MAX_PRIVATE_ATTACHMENT_BYTES, PRIVATE_ATTACHMENT_BUCKET } from "../../../../lib/services/attachment-service";
import { MAX_SUPPLIER_DOCUMENT_BYTES, SUPPLIER_DOCUMENT_BUCKET } from "../../../../lib/services/supplier-service";
import { reportServerError } from "../../../../lib/observability/report-error";

export const runtime = "nodejs";

/**
 * Puerta única del almacenamiento privado propio (migración a autoalojado, 2026-09-10). Sustituye a
 * los URLs firmados que emitía Supabase Storage: mismo modelo de autorización — quien presenta un
 * token válido puede hacer UNA operación sobre UN objeto, hasta que venza — pero servido por
 * nosotros y contra disco propio.
 *
 * El token ES la autorización, igual que antes: lo emite la capa de servicio DESPUÉS de comprobar
 * permisos de negocio (`PrivateAttachmentService` / `SupplierService`), así que este endpoint no
 * vuelve a decidir quién puede ver qué — no tiene contexto para hacerlo mejor y duplicar la regla
 * en dos sitios es cómo se desincronizan.
 *
 * Lo que sí gana esta versión: el servidor ve los bytes. Con Supabase el navegador subía directo al
 * bucket y el Content-Type declarado era un acto de fe. Aquí se husmea la firma binaria real antes
 * de escribir nada.
 */
const RULES: Record<string, { maxBytes: number; mimeTypes: ReadonlySet<string> }> = {
  // La lista blanca es la MISMA tabla que aplica `PrivateAttachmentService.validate` (desde
  // 2026-09-17: PDF, imágenes, Excel, Word, PowerPoint y CSV/texto), importada en vez de repetida —
  // dos listas copiadas son dos listas que acaban divergiendo.
  [PRIVATE_ATTACHMENT_BUCKET]: { maxBytes: MAX_PRIVATE_ATTACHMENT_BYTES, mimeTypes: ATTACHMENT_MIME_TYPES },
  // Los documentos de proveedor no admiten webp: es la misma lista que aplica SupplierService.
  [SUPPLIER_DOCUMENT_BUCKET]: { maxBytes: MAX_SUPPLIER_DOCUMENT_BYTES, mimeTypes: new Set(["application/pdf", "image/jpeg", "image/png"]) },
};

/** Una sola respuesta para todo fallo de autorización: el endpoint no dice si el token es inválido,
 *  venció, o apunta a algo que no existe. */
const denied = () => new Response("No autorizado", { status: 403, headers: { "Cache-Control": "no-store" } });

export async function PUT(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const verified = token ? verifyStorageToken(token, "put") : null;
  if (!verified) return denied();
  const rules = RULES[verified.bucket];
  if (!rules) return denied();

  // Corte barato antes de materializar el cuerpo en memoria. El margen cubre el sobrecoste del
  // multipart (cabeceras de parte y frontera), que no es parte del archivo.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > rules.maxBytes + 8192) return new Response("Archivo demasiado grande", { status: 413, headers: { "Cache-Control": "no-store" } });

  let file: File | null = null;
  try {
    // `fileField` viaja vacío en el contrato que ya usa el cliente (attachment-upload.tsx), así que
    // se toma el primer File del formulario sea cual sea su nombre, en vez de exigir una clave.
    for (const value of (await request.formData()).values()) { if (value instanceof File) { file = value; break; } }
  } catch { return new Response("Cuerpo inválido", { status: 400, headers: { "Cache-Control": "no-store" } }); }
  if (!file) return new Response("Falta el archivo", { status: 400, headers: { "Cache-Control": "no-store" } });

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > rules.maxBytes) return new Response("Archivo demasiado grande", { status: 413, headers: { "Cache-Control": "no-store" } });

  const signature = sniffAttachmentMimeOrPlainText(bytes);
  if (!signature || !rules.mimeTypes.has(signature.mimeType)) return new Response("Tipo de archivo no permitido", { status: 415, headers: { "Cache-Control": "no-store" } });

  try { await writeObject(verified.bucket, verified.objectPath, bytes, signature.mimeType); }
  catch (error) {
    // Reintentar la misma subida (doble clic, reintento del navegador) no debe sobrescribir un
    // soporte ya auditado: se responde 409 y el flujo de confirmación sigue siendo válido.
    if (error instanceof Error && error.message === "STORAGE_OBJECT_EXISTS") return new Response("El objeto ya existe", { status: 409, headers: { "Cache-Control": "no-store" } });
    reportServerError(error, { where: "storage-upload", status: 500 });
    return new Response("No se pudo guardar el archivo", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
  return new Response(null, { status: 201, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token");
  const verified = token ? verifyStorageToken(token, "get") : null;
  if (!verified) return denied();

  const object = await readObject(verified.bucket, verified.objectPath);
  if (!object) return denied();

  // `attachment` + nombre saneado: el objeto se descarga, nunca se interpreta en el origen de la
  // aplicación. Es lo que impide que un PDF con script se ejecute con la sesión del usuario — y, desde
  // que se admiten XLSX y CSV (2026-09-17), lo que impide que una hoja o un texto con HTML dentro se
  // rendericen aquí. Las tres barreras son independientes a propósito:
  //   `attachment`  -> el navegador descarga en vez de mostrar, sea cual sea el tipo;
  //   `nosniff`     -> y no reinterpreta el tipo por su contenido si el Content-Type no le cuadra;
  //   CSP en sandbox -> y si algo lo renderizara igual, no hay origen ni script permitido.
  // El `Content-Type` es SIEMPRE el que decidió el servidor al husmear los bytes (sidecar de
  // local-storage.ts), nunca el que declaró quien subió el archivo.
  const filename = verified.objectPath.slice(verified.objectPath.lastIndexOf("/") + 1);
  return new Response(new Uint8Array(object.bytes), {
    status: 200,
    headers: {
      // `charset` explícito solo para el texto, que es lo único que un navegador podría decodificar
      // con la codificación equivocada (`isPlainText` ya garantizó que es UTF-8 válido).
      "Content-Type": object.info.mimeType === PLAIN_TEXT_MIME_TYPE ? `${PLAIN_TEXT_MIME_TYPE}; charset=utf-8` : object.info.mimeType,
      "Content-Length": String(object.info.sizeBytes),
      "Content-Disposition": `attachment; filename="${filename.replace(/["\\]/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": "private, no-store",
    },
  });
}
