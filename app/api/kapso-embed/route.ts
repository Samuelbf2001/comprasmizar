import { NextResponse } from "next/server";
import { getAuthSnapshot } from "../../auth-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KAPSO_HOST_SUFFIX = ".kapso.ai";
const ROLES_PERMITIDOS = new Set(["Revisor", "Administrador Mizar", "Administrador Sixteam"]);

// La URL del inbox embebido de Kapso es una credencial portadora: quien la tenga
// abre las conversaciones de la línea sin ningún login (verificado contra el
// servicio real). Por eso NUNCA viaja como NEXT_PUBLIC_* en el bundle público:
// vive solo en el servidor y se entrega únicamente a una sesión autenticada con
// rol autorizado, justo antes de montar el iframe.
function embedUrlValida(): string | null {
  const raw = process.env.KAPSO_EMBED_URL || "";
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const permitido = host === "kapso.ai" || host.endsWith(KAPSO_HOST_SUFFIX);
    return url.protocol === "https:" && permitido ? url.toString() : null;
  } catch {
    return null;
  }
}

export async function GET() {
  const snapshot = await getAuthSnapshot();
  // En demo no se entrega contenido externo real: la pantalla muestra su estado
  // de conexión pendiente, igual que cuando la variable no está configurada.
  if (!snapshot.authenticated || snapshot.demoMode) {
    return NextResponse.json({ estado: "no_disponible" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!ROLES_PERMITIDOS.has(snapshot.role)) {
    return NextResponse.json({ estado: "no_disponible" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const url = embedUrlValida();
  if (!url) {
    return NextResponse.json({ estado: "no_configurado" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ url }, { headers: { "Cache-Control": "no-store" } });
}
