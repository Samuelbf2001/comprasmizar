#!/usr/bin/env node
// Cliente mínimo de Google Drive para los respaldos. Sin dependencias: solo node:crypto y fetch.
//
// Por qué a mano y no con googleapis: este script corre en el VPS dentro de un cron. Cada
// dependencia npm es superficie que hay que actualizar y que puede romperse justo el día que el
// respaldo importa. Lo que se necesita de Drive son tres llamadas HTTP.
//
// AUTENTICACIÓN — dos caminos, porque Google trata a las cuentas de servicio de forma distinta según
// el tipo de cuenta de destino:
//
//   1. Token de actualización de una cuenta Google normal (GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET /
//      GDRIVE_REFRESH_TOKEN). Es el camino que funciona con una cuenta Gmail corriente. Los archivos
//      quedan en el Drive de esa persona y consumen su cuota (15 GB gratis).
//   2. Cuenta de servicio (GDRIVE_SERVICE_ACCOUNT_JSON con la ruta al JSON de la llave), SOLO válida
//      contra una Unidad compartida de Google Workspace. Una cuenta de servicio NO tiene cuota
//      propia: si se apunta a una carpeta de "Mi unidad" compartida con ella, la subida falla con
//      "Service Accounts do not have storage quota". Es la trampa clásica; de ahí que el camino 1 sea
//      el predeterminado.
//
// Alcance `drive.file`: acceso únicamente a lo que esta aplicación crea. Por eso la carpeta de
// respaldos la crea ops/gdrive-authorize.mjs a través de la API — así queda dentro del alcance sin
// pedir permiso sobre todo el Drive del usuario.
import { createSign } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHUNK_BYTES = 8 * 1024 * 1024; // Trozos de 8 MB: reanudables si se corta la conexión del VPS.

const required = (name) => { const value = process.env[name]; if (!value) throw new Error(`Falta la variable ${name}`); return value; };

async function tokenFromRefresh() {
  const body = new URLSearchParams({
    client_id: required("GDRIVE_CLIENT_ID"), client_secret: required("GDRIVE_CLIENT_SECRET"),
    refresh_token: required("GDRIVE_REFRESH_TOKEN"), grant_type: "refresh_token",
  });
  const response = await fetch(TOKEN_URL, { method: "POST", body });
  if (!response.ok) throw new Error(`No se pudo renovar el token (${response.status}): ${await response.text()}`);
  return (await response.json()).access_token;
}

async function tokenFromServiceAccount() {
  const credentials = JSON.parse(await (await open(required("GDRIVE_SERVICE_ACCOUNT_JSON"), "r")).readFile("utf8"));
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credentials.client_email, scope: DRIVE_SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key, "base64url")}`;
  const response = await fetch(TOKEN_URL, { method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  if (!response.ok) throw new Error(`La cuenta de servicio no obtuvo token (${response.status}): ${await response.text()}`);
  return (await response.json()).access_token;
}

export async function accessToken() {
  return process.env.GDRIVE_REFRESH_TOKEN ? tokenFromRefresh() : tokenFromServiceAccount();
}

async function driveJson(token, path, init = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`Drive respondió ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export async function createFolder(token, name, parentId) {
  const metadata = { name, mimeType: "application/vnd.google-apps.folder", ...(parentId ? { parents: [parentId] } : {}) };
  return driveJson(token, "files?supportsAllDrives=true", { method: "POST", body: JSON.stringify(metadata) });
}

/**
 * Subida reanudable por trozos. Se hace así y no de un golpe por dos razones: no carga en memoria un
 * volcado que puede pesar cientos de MB, y si la conexión del VPS se cae a mitad, Google conserva lo
 * ya recibido y responde 308 con el rango que tiene — el bucle continúa desde ahí en vez de empezar
 * de cero.
 */
export async function uploadFile(token, localPath, name, folderId) {
  const total = (await stat(localPath)).size;
  const session = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [folderId] }),
  });
  if (!session.ok) throw new Error(`No se pudo abrir la sesión de subida (${session.status}): ${await session.text()}`);
  const location = session.headers.get("location");
  if (!location) throw new Error("Google no devolvió URL de sesión de subida.");

  const handle = await open(localPath, "r");
  try {
    let offset = 0;
    while (offset < total) {
      const length = Math.min(CHUNK_BYTES, total - offset);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, offset);
      const response = await fetch(location, {
        method: "PUT",
        headers: { "Content-Length": String(length), "Content-Range": `bytes ${offset}-${offset + length - 1}/${total}` },
        body: new Uint8Array(chunk),
      });
      if (response.status === 308) {
        // Google confirma hasta dónde recibió. Se continúa desde ahí, que puede no coincidir con lo
        // que creíamos haber enviado si el trozo se cortó a medias.
        const range = response.headers.get("range");
        offset = range ? Number(range.split("-")[1]) + 1 : offset + length;
        continue;
      }
      if (!response.ok) throw new Error(`Fallo al subir el trozo en ${offset} (${response.status}): ${await response.text()}`);
      return response.json();
    }
    throw new Error("La subida terminó sin que Google confirmara el archivo.");
  } finally { await handle.close(); }
}

export async function listBackups(token, folderId) {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const result = await driveJson(token, `files?q=${query}&fields=files(id,name,size,createdTime)&orderBy=createdTime desc&pageSize=1000&supportsAllDrives=true`);
  return result.files ?? [];
}

export async function deleteFile(token, fileId) {
  await driveJson(token, `files/${fileId}?supportsAllDrives=true`, { method: "DELETE" });
}

export async function downloadFile(token, fileId, destination) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`No se pudo descargar (${response.status}): ${await response.text()}`);
  const handle = await open(destination, "w");
  try { for await (const chunk of response.body) await handle.write(chunk); } finally { await handle.close(); }
}

// ---- CLI -------------------------------------------------------------------------------------
// Solo actúa si se invoca directamente; importado como módulo no hace nada (lo usa backup-daily.sh
// y el guion de restauración).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  const folder = () => required("GDRIVE_FOLDER_ID");
  try {
    const token = await accessToken();
    if (command === "subir") {
      const [localPath, name] = args;
      if (!localPath || !name) throw new Error("Uso: gdrive.mjs subir <archivo> <nombre-en-drive>");
      const file = await uploadFile(token, localPath, name, folder());
      console.log(`subido ${name} (id ${file.id})`);
    } else if (command === "listar") {
      for (const file of await listBackups(token, folder())) console.log(`${file.createdTime}  ${String(file.size ?? 0).padStart(12)}  ${file.name}  ${file.id}`);
    } else if (command === "purgar") {
      const days = Number(args[0] || 35);
      if (!Number.isFinite(days) || days < 1) throw new Error("Uso: gdrive.mjs purgar <días>");
      const cutoff = Date.now() - days * 86_400_000;
      let removed = 0;
      for (const file of await listBackups(token, folder())) {
        if (Date.parse(file.createdTime) < cutoff) { await deleteFile(token, file.id); removed++; console.log(`purgado ${file.name}`); }
      }
      console.log(`purgados ${removed} respaldos con más de ${days} días`);
    } else if (command === "bajar") {
      const [fileId, destination] = args;
      if (!fileId || !destination) throw new Error("Uso: gdrive.mjs bajar <fileId> <destino>");
      await downloadFile(token, fileId, destination);
      console.log(`descargado en ${destination}`);
    } else {
      console.error("Comandos: subir | listar | purgar | bajar");
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
