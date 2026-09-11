import { hmacSha256 } from "../lib/security/crypto";
import { generalLinkToken } from "../lib/security/public-link";

// Reunión (literal del cliente): "yo digo que sea solamente una contraseña para todo el mundo". La
// contraseña que el solicitante escribe en el portal es GLOBAL y se administra desde la plataforma
// (pestaña "Acceso público" en Catálogos, PATCH /api/public-access) — nunca por este script ni por SQL.
//
// El ENLACE también dejó de ser por obra ("debe ser un link general para montar las requisiciones"):
// sin argumentos, este script emite el enlace general, firmado sobre un ámbito constante, y la obra
// se elige dentro del formulario. Pasando un uuid de obra sigue emitiendo el enlace por obra, que
// sirve cuando se quiere que alguien solo pueda radicar contra una obra concreta.
const workId = process.argv[2], pepper = process.env.PUBLIC_FORM_CODE_PEPPER, appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (workId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId)) throw new Error("Use: npx tsx scripts/generate-public-link.ts [obra-uuid]");
if (!pepper || pepper.length < 32) throw new Error("PUBLIC_FORM_CODE_PEPPER no está configurado");
if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL no está configurado");
const fragment = workId
  ? new URLSearchParams({ obra: workId, token: hmacSha256(workId, pepper) })
  : new URLSearchParams({ token: generalLinkToken(pepper) });
for (const path of ["/requisiciones/publica", "/requisiciones/publica-movil"]) {
  const target = new URL(path, appUrl);
  target.hash = fragment.toString();
  process.stdout.write(`${target.toString()}\n`);
}
process.stdout.write(workId
  ? "Enlace POR OBRA. La contraseña del portal es GLOBAL (una sola para todas las obras) y se fija desde Catálogos -> Acceso público, no con este script.\n"
  : "Enlace GENERAL: sirve para todas las obras habilitadas y el solicitante elige la suya en el formulario. La contraseña se fija desde Catálogos -> Acceso público, no con este script.\n");
