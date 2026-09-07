import { hmacSha256 } from "../lib/security/crypto";

// Reunión (literal del cliente): "yo digo que sea solamente una contraseña para todo el mundo". El
// enlace SIGUE siendo por obra (obra + token HMAC en el fragmento `#`) pero la contraseña que el
// solicitante escribe en el portal ya NO es por obra: es GLOBAL, la misma para todas las obras
// habilitadas. Este script solo genera el enlace; la contraseña se administra desde la plataforma
// (pestaña "Acceso público" en Catálogos, PATCH /api/public-access) — nunca por este script ni por SQL.
const workId = process.argv[2], pepper = process.env.PUBLIC_FORM_CODE_PEPPER, appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (!workId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId)) throw new Error("Use: npx tsx scripts/generate-public-link.ts <obra-uuid>");
if (!pepper || pepper.length < 32) throw new Error("PUBLIC_FORM_CODE_PEPPER no está configurado");
if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL no está configurado");
const target = new URL("/requisiciones/publica", appUrl);
target.hash = new URLSearchParams({ obra: workId, token: hmacSha256(workId, pepper) }).toString();
process.stdout.write(`${target.toString()}\n`);
process.stdout.write("Recuerda: la contraseña del portal es GLOBAL (una sola para todas las obras), no de esta obra en particular. Se fija/rota desde la plataforma (Catálogos -> Acceso público), no con este script.\n");
