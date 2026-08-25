import { hmacSha256 } from "../lib/security/crypto";

const workId = process.argv[2], pepper = process.env.PUBLIC_FORM_CODE_PEPPER, appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (!workId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workId)) throw new Error("Use: npx tsx scripts/generate-public-link.ts <obra-uuid>");
if (!pepper || pepper.length < 32) throw new Error("PUBLIC_FORM_CODE_PEPPER no está configurado");
if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL no está configurado");
const target = new URL("/requisiciones/publica", appUrl);
target.hash = new URLSearchParams({ obra: workId, token: hmacSha256(workId, pepper) }).toString();
process.stdout.write(`${target.toString()}\n`);
