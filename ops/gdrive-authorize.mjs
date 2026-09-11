#!/usr/bin/env node
// Configuración inicial de Google Drive para los respaldos. SE EJECUTA UNA SOLA VEZ, a mano.
//
// Qué hace: obtiene el token de actualización (refresh token) de una cuenta de Google normal y crea
// la carpeta donde vivirán los respaldos. Imprime las dos variables que hay que guardar en el
// entorno del cron. Ver docs/migracion-autoalojado.md para el paso a paso completo.
//
// Antes de correrlo, en https://console.cloud.google.com:
//   1. Crear un proyecto y habilitar la "Google Drive API".
//   2. Pantalla de consentimiento OAuth: tipo Externo, y añadir tu propia cuenta como usuario de
//      prueba (basta: la app nunca sale de tu cuenta y no necesita verificación de Google).
//   3. Credenciales -> Crear credenciales -> ID de cliente de OAuth -> tipo **App de escritorio**.
//      El tipo importa: es el único que admite el redirect a localhost que usa este guion. El flujo
//      "OOB" que antes se usaba para servidores sin navegador está retirado desde 2022.
//   4. Exportar GDRIVE_CLIENT_ID y GDRIVE_CLIENT_SECRET y ejecutar este archivo.
import { createInterface } from "node:readline/promises";
import { DRIVE_SCOPE, createFolder } from "./gdrive.mjs";

const REDIRECT = "http://localhost";
const required = (name) => { const value = process.env[name]; if (!value) { console.error(`Falta ${name}.`); process.exit(2); } return value; };

const clientId = required("GDRIVE_CLIENT_ID");
const clientSecret = required("GDRIVE_CLIENT_SECRET");
const folderName = process.argv[2] || "Respaldos Mizar";

const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
consent.search = new URLSearchParams({
  client_id: clientId, redirect_uri: REDIRECT, response_type: "code", scope: DRIVE_SCOPE,
  // `offline` es lo que hace que Google entregue un refresh token; `consent` fuerza que lo entregue
  // otra vez aunque ya hayas autorizado antes (sin esto, un segundo intento devuelve solo el token
  // de acceso y el guion parecería roto).
  access_type: "offline", prompt: "consent",
}).toString();

console.log("\n1. Abre este enlace en tu navegador y autoriza:\n");
console.log(consent.toString());
console.log("\n2. Al aceptar te llevará a una página de error de localhost. Es lo esperado: el");
console.log("   navegador no tiene nada escuchando ahí. Copia el valor de `code=` de la barra de");
console.log("   direcciones (termina antes del `&scope=`).\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const code = (await rl.question("3. Pega el code aquí: ")).trim();
rl.close();
if (!code) { console.error("No se recibió ningún code."); process.exit(2); }

const response = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: REDIRECT, grant_type: "authorization_code" }),
});
if (!response.ok) { console.error(`Google rechazó el code (${response.status}): ${await response.text()}`); process.exit(1); }
const tokens = await response.json();
if (!tokens.refresh_token) {
  console.error("Google no devolvió refresh_token. Suele pasar si ya habías autorizado antes:");
  console.error("revoca el acceso en https://myaccount.google.com/permissions y repite.");
  process.exit(1);
}

// La carpeta se crea DESDE la API a propósito: con el alcance `drive.file` la aplicación solo puede
// tocar lo que ella misma creó. Si se apuntara a una carpeta hecha a mano en el navegador, las
// subidas fallarían por permisos y habría que pedir acceso a todo el Drive del usuario.
const folder = await createFolder(tokens.access_token, folderName);

console.log("\nListo. Guarda estas variables en el entorno del cron (ops/backup-daily.sh):\n");
console.log(`GDRIVE_CLIENT_ID=${clientId}`);
console.log("GDRIVE_CLIENT_SECRET=<el mismo que ya tienes>");
console.log(`GDRIVE_REFRESH_TOKEN=${tokens.refresh_token}`);
console.log(`GDRIVE_FOLDER_ID=${folder.id}`);
console.log("\nEl refresh token no vence por tiempo, pero SÍ se invalida si cambias la contraseña de");
console.log("la cuenta de Google o revocas el permiso. Si el respaldo empieza a fallar con 400,");
console.log("vuelve a ejecutar este guion.\n");
