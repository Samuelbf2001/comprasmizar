import { hmacSha256 } from "../lib/security/crypto";
// `generalLinkToken` ya no se usa aquí: el enlace general dejó de necesitar firma cuando la ruta
// pasó a ser pública (2026-09-11). Sigue existiendo en `lib/security/public-link.ts` porque
// `verifyPublicLinkToken` acepta los enlaces generales ya repartidos.

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
// Sin argumentos se emite la URL PÚBLICA, sin fragmento: desde el 2026-09-11 la ruta abre sola y la
// contraseña es la llave (decisión de Ernesto: «que el enlace no necesite un token, sea ruta
// pública»). El token ya solo sirve para lo que aún tiene sentido firmar: acotar a UNA obra.
const fragment = workId ? new URLSearchParams({ obra: workId, token: hmacSha256(workId, pepper) }) : null;
// Una sola URL (2026-09-11). Antes se emitían dos, una por cada formulario —escritorio y móvil—, y
// había que acertar cuál repartir a quién. Ahora el formulario es uno y es responsive, así que el
// enlace también es uno. `/requisiciones/publica-movil` sigue viva y reenvía en cliente conservando
// el fragmento, para no romper los enlaces ya repartidos, pero ya no se emite.
const target = new URL("/requisiciones/publica", appUrl);
if (fragment) target.hash = fragment.toString();
process.stdout.write(`${target.toString()}\n`);
process.stdout.write(workId
  ? "Enlace POR OBRA: quien lo use solo puede radicar contra esa obra. La contraseña del portal es GLOBAL (una sola para todas) y se fija desde Catalogos -> Acceso publico, no con este script.\n"
  : "URL PUBLICA del portal: no lleva token y no hace falta. Quien la abra escribe la contrasena y elige la obra en el formulario. La contrasena se fija desde Catalogos -> Acceso publico, no con este script.\nPasa un uuid de obra si quieres un enlace acotado a UNA obra.\n");
