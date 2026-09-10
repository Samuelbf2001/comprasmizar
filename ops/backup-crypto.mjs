#!/usr/bin/env node
// Cifrado de respaldos, AES-256-GCM en streaming. Sin dependencias: solo node:crypto.
//
// Por qué existe: el volcado contiene TODO — datos bancarios de proveedores, teléfonos de
// solicitantes, hashes de contraseñas. Subirlo en claro a Google Drive lo pondría al alcance de
// cualquiera que entre a esa cuenta de Drive, y del propio Google. Un respaldo fuera de sitio sin
// cifrar no es una copia de seguridad: es una filtración con calendario.
//
// Formato del archivo: MIZAR1 | salt(16) | iv(12) | ciphertext... | tag(16)
// El tag va al final porque GCM solo lo produce al terminar de cifrar, y así el cifrado sigue siendo
// streaming (nunca se carga el volcado entero en memoria).
//
// Uso:
//   node ops/backup-crypto.mjs cifrar   <entrada> <salida>
//   node ops/backup-crypto.mjs descifrar <entrada> <salida>
// La frase secreta se lee de BACKUP_PASSPHRASE. GUÁRDALA FUERA DEL VPS: si se pierde con el
// servidor, los respaldos cifrados no sirven para nada y el desastre es total en vez de recuperable.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("MIZAR1");
const SALT_BYTES = 16, IV_BYTES = 12, TAG_BYTES = 16;
// Parámetros de scrypt por encima del default de Node (N=16384): encarece un ataque por fuerza bruta
// contra la frase secreta. Se pagan una vez por respaldo, no por bloque.
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

function passphrase() {
  const value = process.env.BACKUP_PASSPHRASE;
  if (!value || value.length < 16) {
    console.error("BACKUP_PASSPHRASE ausente o demasiado corta (mínimo 16 caracteres).");
    process.exit(2);
  }
  return value;
}

const deriveKey = (salt) => scryptSync(passphrase(), salt, 32, SCRYPT);

async function encrypt(input, output) {
  const salt = randomBytes(SALT_BYTES), iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(salt), iv);
  const sink = createWriteStream(output);
  sink.write(Buffer.concat([MAGIC, salt, iv]));
  await pipeline(createReadStream(input), cipher, sink, { end: false });
  // El tag autentica el archivo completo: si un byte cambia en tránsito o en Drive, el descifrado
  // falla en vez de devolver basura que parecería un volcado válido.
  await new Promise((resolve, reject) => sink.end(cipher.getAuthTag(), (error) => (error ? reject(error) : resolve())));
}

async function decrypt(input, output) {
  const size = (await stat(input)).size;
  const headerBytes = MAGIC.length + SALT_BYTES + IV_BYTES;
  if (size < headerBytes + TAG_BYTES) throw new Error("Archivo demasiado corto para ser un respaldo cifrado.");

  const handle = await open(input, "r");
  try {
    const header = Buffer.alloc(headerBytes);
    await handle.read(header, 0, headerBytes, 0);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Cabecera desconocida: esto no lo cifró backup-crypto.mjs.");
    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_BYTES);
    const iv = header.subarray(MAGIC.length + SALT_BYTES);

    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
    decipher.setAuthTag(tag);
    await pipeline(createReadStream(input, { start: headerBytes, end: size - TAG_BYTES - 1 }), decipher, createWriteStream(output));
  } finally { await handle.close(); }
}

const [operation, input, output] = process.argv.slice(2);
if (!["cifrar", "descifrar"].includes(operation) || !input || !output) {
  console.error("Uso: node ops/backup-crypto.mjs cifrar|descifrar <entrada> <salida>");
  process.exit(2);
}
try {
  await (operation === "cifrar" ? encrypt(input, output) : decrypt(input, output));
} catch (error) {
  console.error(`Fallo al ${operation}: ${error.message}`);
  process.exit(1);
}
