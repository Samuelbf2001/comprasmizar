/**
 * Firmas binarias reales de los tipos que admite la plataforma. Vive en su propio módulo
 * (mismo criterio que `phone.ts`) porque lo usan DOS caminos que no deben importarse entre sí:
 * `kapso-store.ts` (descarga desde Kapso) y `local-storage.ts` (subida del navegador).
 *
 * Autoalojado (2026-09-10): con Supabase Storage el navegador subía DIRECTO al bucket con un URL
 * firmado y el servidor nunca veía los bytes — solo podía confiar en el Content-Type declarado. Al
 * pasar el almacenamiento a disco propio, la subida atraviesa nuestro endpoint, así que ahora el
 * MIME real se verifica en AMBOS caminos. Es una mejora de seguridad que trae la migración, no un
 * efecto colateral: un .exe renombrado a .pdf ya no se puede guardar.
 *
 * AMPLIACIÓN 2026-09-17 (decisión de Ernesto: «si puede ser muchos tipos de archivos, CSV, Excel,
 * etc., PDF, imágenes, lo que sea»). Se añaden PDF (ya estaba), OOXML (.xlsx/.docx/.pptx), XLS
 * legado y texto plano/CSV — SIEMPRE por contenido, nunca por extensión ni por el `Content-Type`
 * que declaró el cliente. Cada familia trae su propia comprobación, del más barato al más caro:
 *
 *   - PDF e imágenes: bytes de cabecera, como siempre.
 *   - OOXML: un .xlsx es un ZIP, y `PK\x03\x04` lo cumple CUALQUIER zip (incluido un .jar o un
 *     .apk). Por eso no basta la cabecera: se recorre el directorio central del zip de verdad y se
 *     exige la entrada `[Content_Types].xml` que ECMA-376 hace obligatoria en todo paquete OPC, y
 *     además la carpeta que distingue la familia (`xl/`, `word/`, `ppt/`).
 *   - XLS legado: un contenedor OLE2 (`D0 CF 11 E0 …`) también puede ser un .doc, un .ppt o un
 *     instalador .msi. Se recorre su directorio y solo se acepta si trae el flujo `Workbook`/`Book`
 *     de Excel, nunca si trae el de Word o PowerPoint.
 *   - CSV y texto plano: NO tienen firma, así que no los reconoce `sniffAttachmentMime` —
 *     deliberadamente, para que el contrato histórico («texto plano => null») siga intacto para
 *     Kapso. Quien quiera admitirlos usa `sniffAttachmentMimeOrPlainText`, que solo los clasifica
 *     como `text/plain` si TODO el contenido es UTF-8 imprimible (sin NUL ni caracteres de
 *     control), y el servidor fija ese `text/plain` al guardar y al servir. De un .csv no se puede
 *     demostrar que no sea un script: la defensa no es adivinar el contenido sino no interpretarlo
 *     nunca (descarga forzada, `nosniff` y `text/plain`, ver app/api/storage/object/route.ts).
 */
export const ATTACHMENT_SIGNATURES: ReadonlyArray<{ mimeType: string; extension: string; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: "application/pdf", extension: "pdf", matches: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "%PDF" },
  { mimeType: "image/jpeg", extension: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/png", extension: "png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/webp", extension: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
  { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx", matches: (b) => ooxmlFolder(b) === "xl" },
  { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extension: "docx", matches: (b) => ooxmlFolder(b) === "word" },
  { mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", extension: "pptx", matches: (b) => ooxmlFolder(b) === "ppt" },
  { mimeType: "application/vnd.ms-excel", extension: "xls", matches: (b) => isLegacyExcel(b) },
];

/** El MIME con el que se guarda y se sirve TODO lo que solo se puede demostrar que es texto. */
export const PLAIN_TEXT_MIME_TYPE = "text/plain";

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL = 0x06054b50;
/** El comentario final de un zip cabe en un u16, así que el EOCD nunca está más atrás que esto. */
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_EOCD_BYTES = 22;
const ZIP_CENTRAL_ENTRY_BYTES = 46;

/**
 * Nombres del directorio CENTRAL del zip (no de las cabeceras locales, que un archivo manipulado
 * puede contradecir). Devuelve `null` ante cualquier cosa que no se pueda recorrer entera: un zip
 * truncado, un zip64 (cuyos punteros no caben en los campos de 32 bits que se leen aquí) o basura
 * con la cabecera correcta. Preferir `null` a "lo que se pudo leer" es lo que impide aceptar un
 * archivo del que no se entendió la estructura.
 */
function zipEntryNames(bytes: Buffer): readonly string[] | null {
  if (bytes.length < ZIP_EOCD_BYTES + 4 || bytes.readUInt32LE(0) !== ZIP_LOCAL_HEADER) return null;
  const floor = Math.max(0, bytes.length - ZIP_EOCD_BYTES - ZIP_MAX_COMMENT_BYTES);
  let end = -1;
  for (let offset = bytes.length - ZIP_EOCD_BYTES; offset >= floor; offset -= 1) {
    if (bytes.readUInt32LE(offset) === ZIP_END_OF_CENTRAL) { end = offset; break; }
  }
  if (end < 0) return null;
  const total = bytes.readUInt16LE(end + 10);
  let cursor = bytes.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let entry = 0; entry < total; entry += 1) {
    if (cursor + ZIP_CENTRAL_ENTRY_BYTES > bytes.length || bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER) return null;
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const start = cursor + ZIP_CENTRAL_ENTRY_BYTES;
    if (start + nameLength > bytes.length) return null;
    names.push(bytes.toString("latin1", start, start + nameLength));
    cursor = start + nameLength + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
  return names;
}

function ooxmlFolder(bytes: Buffer): "xl" | "word" | "ppt" | null {
  const names = zipEntryNames(bytes);
  if (!names || !names.includes("[Content_Types].xml")) return null;
  for (const folder of ["xl", "word", "ppt"] as const) if (names.some((name) => name.startsWith(`${folder}/`))) return folder;
  return null;
}

const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const OLE2_DIRECTORY_ENTRY_BYTES = 128;
/** La DIFAT de la cabecera solo apunta a las primeras 109 sectores de FAT; más allá habría que
 *  seguir la DIFAT extendida, y un libro que la necesite pesa mucho más que el tope de un adjunto. */
const OLE2_HEADER_DIFAT_ENTRIES = 109;
/** Cota dura del recorrido: ningún directorio legítimo de un adjunto ocupa tantos sectores. */
const OLE2_MAX_DIRECTORY_SECTORS = 64;
/** A partir de 0xFFFFFFFC los valores de la FAT son marcas (DIFSECT/FATSECT/ENDOFCHAIN/FREESECT). */
const OLE2_FIRST_RESERVED_SECTOR = 0xfffffffc;

/** Nombres de los flujos de un contenedor OLE2 (CFB), recorriendo la cadena del directorio por la FAT. */
function ole2StreamNames(bytes: Buffer): readonly string[] | null {
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(OLE2_MAGIC)) return null;
  const sectorSize = 1 << bytes.readUInt16LE(30);
  if (sectorSize !== 512 && sectorSize !== 4096) return null;
  const sectorStart = (sector: number) => (sector + 1) * sectorSize;
  const nextInChain = (sector: number): number => {
    const perSector = sectorSize / 4;
    const fatIndex = Math.floor(sector / perSector);
    if (fatIndex >= OLE2_HEADER_DIFAT_ENTRIES) return OLE2_FIRST_RESERVED_SECTOR;
    const fatSector = bytes.readUInt32LE(76 + fatIndex * 4);
    const at = sectorStart(fatSector) + (sector % perSector) * 4;
    return at + 4 <= bytes.length ? bytes.readUInt32LE(at) : OLE2_FIRST_RESERVED_SECTOR;
  };
  const names: string[] = [];
  let sector = bytes.readUInt32LE(48);
  for (let visited = 0; visited < OLE2_MAX_DIRECTORY_SECTORS && sector < OLE2_FIRST_RESERVED_SECTOR; visited += 1) {
    const start = sectorStart(sector);
    if (start + sectorSize > bytes.length) return names.length ? names : null;
    for (let at = start; at + OLE2_DIRECTORY_ENTRY_BYTES <= start + sectorSize; at += OLE2_DIRECTORY_ENTRY_BYTES) {
      // Longitud del nombre EN BYTES, contando el terminador UTF-16 de dos bytes que se descarta.
      const nameBytes = bytes.readUInt16LE(at + 64);
      if (nameBytes < 4 || nameBytes > 64) continue;
      names.push(bytes.toString("utf16le", at, at + nameBytes - 2));
    }
    sector = nextInChain(sector);
  }
  return names;
}

function isLegacyExcel(bytes: Buffer): boolean {
  const names = ole2StreamNames(bytes);
  if (!names) return false;
  if (names.includes("WordDocument") || names.includes("PowerPoint Document")) return false;
  return names.includes("Workbook") || names.includes("Book");
}

/**
 * Texto que se puede servir sin interpretarlo: UTF-8 válido de punta a punta, sin NUL y sin más
 * caracteres de control que los que usa un CSV (tabulador, salto de línea, retorno de carro). Deja
 * fuera todo binario (un PE, un ELF o un zip traen NUL) y acota el trabajo al tamaño ya validado
 * por quien llama.
 */
function isPlainText(bytes: Buffer): boolean {
  if (bytes.length < 1 || bytes.includes(0)) return false;
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return false; }
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Tipo por FIRMA BINARIA. `null` para cualquier cosa sin firma reconocida — incluido el texto
 * plano, a propósito: es el contrato que ya usa `kapso-store.ts` para las fotos de WhatsApp y
 * ampliarlo aquí convertiría cualquier mensaje en un adjunto válido.
 */
export function sniffAttachmentMime(bytes: Buffer): { mimeType: string; extension: string } | null {
  return ATTACHMENT_SIGNATURES.find((signature) => signature.matches(bytes)) ?? null;
}

/** Igual que `sniffAttachmentMime`, más el texto plano (CSV incluido) como ÚLTIMO recurso: solo se
 *  llega aquí cuando ninguna firma casó, así que un PNG nunca se degrada a `text/plain`. */
export function sniffAttachmentMimeOrPlainText(bytes: Buffer): { mimeType: string; extension: string } | null {
  return sniffAttachmentMime(bytes) ?? (isPlainText(bytes) ? { mimeType: PLAIN_TEXT_MIME_TYPE, extension: "txt" } : null);
}
