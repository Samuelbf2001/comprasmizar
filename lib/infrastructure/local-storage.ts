import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimeEnv } from "../security/env";

/**
 * Almacenamiento privado en disco propio, reemplazo de Supabase Storage (migración a autoalojado,
 * 2026-09-10). Expone EXACTAMENTE la misma forma que usaban `SupabaseAttachmentStorage` y
 * `SupabaseSupplierStorage` — `createUploadUrl` / `info` / `createDownloadUrl` — para que la capa de
 * servicio no cambie ni una línea, más `upload()` directo para el copiador de Kapso (que ya tiene los
 * bytes en memoria y no necesita pasar por un URL).
 *
 * Diferencia de fondo con Supabase: allí el navegador subía DIRECTO al bucket y el servidor nunca
 * veía el archivo. Aquí la subida atraviesa `/api/storage/object`, así que el endpoint verifica el
 * MIME real (ver attachment-mime.ts) y el tamaño antes de escribir nada. El "URL firmado" es un token
 * HMAC de vida corta que autoriza UNA ruta y UNA operación: la misma garantía que daba Supabase
 * (quien tiene el token puede escribir/leer ese objeto y nada más), con la llave propia
 * `STORAGE_SIGNING_SECRET`.
 */
export type StorageOperation = "put" | "get";
export interface ObjectInfo { sizeBytes: number; mimeType: string }
export interface BucketStorage {
  createUploadUrl(objectPath: string): Promise<{ url: string }>;
  info(objectPath: string): Promise<ObjectInfo | null>;
  createDownloadUrl(objectPath: string, expiresInSeconds: number): Promise<string>;
  upload(objectPath: string, bytes: Buffer, mimeType: string): Promise<void>;
}

const UPLOAD_URL_TTL_SECONDS = 15 * 60; // Archivos de hasta 10 MB por redes lentas de obra.
/** Subdirectorio hermano de los buckets con el MIME/tamaño REAL observado al escribir. Empieza por
 *  punto para que no pueda colisionar nunca con un bucket (`requisicion-adjuntos`, `proveedor-...`). */
const METADATA_DIR = ".metadatos";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Una ruta de objeto es una lista de segmentos simples separados por "/". Se rechaza cualquier cosa
 * que pueda escapar del bucket (`..`, rutas absolutas, backslash de Windows, segmentos ocultos). La
 * comprobación de contención sobre la ruta ya resuelta (`resolveObjectPath`) es la segunda barrera:
 * esta valida la FORMA, aquella valida el RESULTADO.
 */
export function assertSafeObjectPath(objectPath: string): string {
  const segments = objectPath.split("/");
  const valid = objectPath.length > 0 && objectPath.length <= 512
    && segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");
  if (!valid) throw new Error("STORAGE_PATH_INVALID");
  return objectPath;
}

export function storageRoot(): string { return path.resolve(runtimeEnv().STORAGE_ROOT); }

/** Ruta absoluta del objeto, verificando que quede DENTRO del bucket incluso si la validación de
 *  forma dejara pasar algo inesperado. */
function resolveObjectPath(bucket: string, objectPath: string, kind: "objeto" | "metadatos"): string {
  assertSafeObjectPath(bucket);
  assertSafeObjectPath(objectPath);
  const root = storageRoot();
  const base = kind === "objeto" ? path.join(root, bucket) : path.join(root, METADATA_DIR, bucket);
  const target = kind === "objeto" ? path.resolve(base, objectPath) : path.resolve(base, `${objectPath}.json`);
  if (!target.startsWith(base + path.sep)) throw new Error("STORAGE_PATH_ESCAPE");
  return target;
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function sign(payload: string): string {
  return createHmac("sha256", runtimeEnv().STORAGE_SIGNING_SECRET).update(payload).digest("base64url");
}

/** Token de un solo objeto y una sola operación, con vencimiento. Formato: `v1.<payload>.<firma>`. */
export function createStorageToken(bucket: string, objectPath: string, operation: StorageOperation, expiresInSeconds: number): string {
  assertSafeObjectPath(bucket);
  assertSafeObjectPath(objectPath);
  const payload = base64url(JSON.stringify({ b: bucket, p: objectPath, o: operation, e: Math.floor(Date.now() / 1000) + expiresInSeconds }));
  return `v1.${payload}.${sign(payload)}`;
}

export type VerifiedToken = { bucket: string; objectPath: string; operation: StorageOperation };

/**
 * Devuelve `null` ante CUALQUIER problema (formato, firma, vencimiento, ruta inválida): quien llama
 * responde 403 sin distinguir el motivo, para no convertir el endpoint en un oráculo.
 */
export function verifyStorageToken(token: string, expected: StorageOperation): VerifiedToken | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, payload, signature] = parts;
  const actual = Buffer.from(sign(payload), "utf8"), provided = Buffer.from(signature, "utf8");
  if (actual.length !== provided.length || !timingSafeEqual(actual, provided)) return null;
  let claims: { b?: unknown; p?: unknown; o?: unknown; e?: unknown };
  try { claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as typeof claims; } catch { return null; }
  const { b, p, o, e } = claims;
  if (typeof b !== "string" || typeof p !== "string" || typeof e !== "number") return null;
  if (o !== expected) return null;
  if (e * 1000 <= Date.now()) return null;
  try { assertSafeObjectPath(b); assertSafeObjectPath(p); } catch { return null; }
  // `expected`, no `o`: son iguales por la comprobación de arriba, y así el tipo sale estrecho sin
  // un cast que tape un error futuro.
  return { bucket: b, objectPath: p, operation: expected };
}

/** Escribe objeto + metadatos. `flag: "wx"` da la semántica `upsert: false` de Supabase de forma
 *  atómica: si el objeto ya existe, falla en vez de sobrescribir un soporte ya auditado. */
export async function writeObject(bucket: string, objectPath: string, bytes: Buffer, mimeType: string): Promise<void> {
  const target = resolveObjectPath(bucket, objectPath, "objeto");
  const metadata = resolveObjectPath(bucket, objectPath, "metadatos");
  await mkdir(path.dirname(target), { recursive: true });
  await mkdir(path.dirname(metadata), { recursive: true });
  try { await writeFile(target, bytes, { flag: "wx" }); }
  catch (error) { throw (error as NodeJS.ErrnoException).code === "EEXIST" ? new Error("STORAGE_OBJECT_EXISTS") : error; }
  await writeFile(metadata, JSON.stringify({ mimeType, sizeBytes: bytes.byteLength, writtenAt: new Date().toISOString() }), "utf8");
}

export async function readObject(bucket: string, objectPath: string): Promise<{ bytes: Buffer; info: ObjectInfo } | null> {
  const target = resolveObjectPath(bucket, objectPath, "objeto");
  const info = await readObjectInfo(bucket, objectPath);
  if (!info) return null;
  try { return { bytes: await readFile(target), info }; } catch { return null; }
}

/**
 * MIME y tamaño REALES del archivo en disco, no los que declaró el cliente: el MIME sale del sidecar
 * que escribió el endpoint tras husmear los bytes, y el tamaño del `stat` del propio archivo. Es lo
 * que permite que `PrivateAttachmentService.confirm` siga siendo una verificación de verdad y no un
 * eco de lo que dijo el navegador.
 */
export async function readObjectInfo(bucket: string, objectPath: string): Promise<ObjectInfo | null> {
  const target = resolveObjectPath(bucket, objectPath, "objeto");
  const metadata = resolveObjectPath(bucket, objectPath, "metadatos");
  let sizeBytes: number;
  try { const stats = await stat(target); if (!stats.isFile()) return null; sizeBytes = stats.size; } catch { return null; }
  try {
    const parsed = JSON.parse(await readFile(metadata, "utf8")) as { mimeType?: unknown };
    return typeof parsed.mimeType === "string" && parsed.mimeType ? { sizeBytes, mimeType: parsed.mimeType } : null;
  } catch { return null; }
}

/**
 * URL relativo a propósito: lo consume el navegador del propio origen (ver
 * components/screens/attachment-upload.tsx), así que no hace falta configurar una URL pública
 * absoluta ni mantenerla sincronizada con el dominio.
 */
export function createLocalBucketStorage(bucket: string): BucketStorage {
  assertSafeObjectPath(bucket);
  return {
    async createUploadUrl(objectPath) { return { url: `/api/storage/object?token=${createStorageToken(bucket, objectPath, "put", UPLOAD_URL_TTL_SECONDS)}` }; },
    async info(objectPath) { return readObjectInfo(bucket, objectPath); },
    async createDownloadUrl(objectPath, expiresInSeconds) { return `/api/storage/object?token=${createStorageToken(bucket, objectPath, "get", expiresInSeconds)}`; },
    async upload(objectPath, bytes, mimeType) { await writeObject(bucket, objectPath, bytes, mimeType); },
  };
}
