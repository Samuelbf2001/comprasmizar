/**
 * Firmas binarias reales de los cuatro tipos que admite la plataforma. Vive en su propio módulo
 * (mismo criterio que `phone.ts`) porque lo usan DOS caminos que no deben importarse entre sí:
 * `kapso-store.ts` (descarga desde Kapso) y `local-storage.ts` (subida del navegador).
 *
 * Autoalojado (2026-09-10): con Supabase Storage el navegador subía DIRECTO al bucket con un URL
 * firmado y el servidor nunca veía los bytes — solo podía confiar en el Content-Type declarado. Al
 * pasar el almacenamiento a disco propio, la subida atraviesa nuestro endpoint, así que ahora el
 * MIME real se verifica en AMBOS caminos. Es una mejora de seguridad que trae la migración, no un
 * efecto colateral: un .exe renombrado a .pdf ya no se puede guardar.
 */
export const ATTACHMENT_SIGNATURES: ReadonlyArray<{ mimeType: string; extension: string; matches: (bytes: Buffer) => boolean }> = [
  { mimeType: "application/pdf", extension: "pdf", matches: (b) => b.length >= 4 && b.subarray(0, 4).toString("latin1") === "%PDF" },
  { mimeType: "image/jpeg", extension: "jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mimeType: "image/png", extension: "png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mimeType: "image/webp", extension: "webp", matches: (b) => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/**
 * Misma lista blanca de cuatro tipos que aplica `PrivateAttachmentService.validate`
 * (attachment-service.ts) — reutilizada, no redefinida, vía sus `MAX_PRIVATE_ATTACHMENT_BYTES`/
 * `PRIVATE_ATTACHMENT_BUCKET` exportados.
 */
export function sniffAttachmentMime(bytes: Buffer): { mimeType: string; extension: string } | null {
  return ATTACHMENT_SIGNATURES.find((signature) => signature.matches(bytes)) ?? null;
}
