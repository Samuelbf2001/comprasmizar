/**
 * IP del cliente para los limitadores de intentos (login, portal público, MCP). No sirve para nada más:
 * no es identidad ni auditoría.
 *
 * Se toma la ÚLTIMA entrada de `X-Forwarded-For`, que es la que añade el único proxy que tenemos delante
 * (Traefik de EasyPanel en el VPS; Caddy en la pila independiente de compose.yaml). Todo lo que haya a
 * su izquierda lo escribió el cliente y puede ser inventado.
 *
 * Antes se leía `X-Real-IP` suponiendo que el proxy la sobrescribía. Caddy sí lo hacía; el Traefik de
 * EasyPanel NO: el 18-sep-2026 se comprobó contra producción que, rotando una `X-Real-IP` falsa, el
 * limitador del portal dejaba de frenar (cada petición volvía a pagar el bcrypt completo). Eso dejaba sin
 * techo la adivinanza de la contraseña del portal y abría la puerta a llenar de bcrypt la CPU de un VPS
 * compartido. El login leía la PRIMERA entrada de `X-Forwarded-For`, igual de falsificable.
 *
 * Supuesto que sostiene esto: exactamente UN proxy entre internet y la app, sin CDN delante. Si algún día
 * se pone Cloudflare u otro proxy, la última entrada pasaría a ser la IP de ese proxy y todos los
 * clientes compartirían un mismo cupo: habría que leer la cabecera propia del CDN.
 *
 * Sin `X-Forwarded-For` (acceso directo, desarrollo sin proxy) se devuelve "direct": no se confía en
 * ninguna otra cabecera que el cliente pueda escribir.
 */
export function clientIpFrom(headers: Headers): string {
  const hops = (headers.get("x-forwarded-for") ?? "").split(",").map((hop) => hop.trim()).filter(Boolean);
  return hops.at(-1) ?? "direct";
}
