import { verificarCodigoPublico } from "../../../../lib/infrastructure/public-access";
import { isPublicConfigured } from "../../../../lib/security/env";
import { publicFormRateLimiter } from "../../../../lib/security/rate-limit";
import { clientIpFrom } from "../../../../lib/security/client-ip";

export const runtime = "nodejs";

/**
 * ¿Es esta la contraseña del portal? Sí o no, y nada más.
 *
 * POR QUÉ EXISTE, que importa más que lo que hace. La compuerta del portal comprobaba la contraseña
 * SOLO en el cliente, y lo único que miraba era que tuviera cuatro caracteres. Con eso dejaba pasar
 * cualquier cosa: quien se equivocaba de contraseña rellenaba los dos pasos enteros, pulsaba enviar
 * y leía «La estamos validando» — porque el endpoint de radicación responde 202 neutro incluso
 * cuando rechaza, y esa neutralidad es deliberada y no se toca. Resultado: la requisición no
 * existía, nadie la recibía y quien la mandó se quedaba esperando. Ernesto lo vio en producción el
 * 11-sep-2026, con el síntoma desplazado («No hay obras habilitadas») que además señalaba al sitio
 * equivocado. Fallar en la puerta, y decirlo, es mucho mejor que fallar en silencio al final.
 *
 * ES UN ORÁCULO DE LA CONTRASEÑA, y hay que decirlo sin adornos porque es una concesión real: quien
 * tenga una lista de candidatas puede probarlas aquí y saber cuál acierta. Antes de este endpoint NO
 * había ninguna forma de averiguarlo —el 202 del endpoint de radicación no distingue el acierto del
 * error, y el oráculo que sí existía (`POST /api/public/works`) se ha borrado en este mismo cambio—,
 * así que esto no "aprovecha" un agujero que ya estuviera abierto: lo abre. Se acepta a sabiendas
 * porque la alternativa medida es peor, y lo que lo hace tolerable es lo que lo acota:
 *
 *   - `publicFormRateLimiter`, 20/min por IP, aplicado ANTES de tocar la base y COMPARTIDO con el
 *     endpoint de radicación: probar aquí gasta los mismos intentos que radicar. Su limitación real:
 *     vive en la memoria del proceso, así que se reinicia en cada despliegue y no se comparte entre
 *     réplicas.
 *   - La comparación la hace Postgres con `verificar_codigo_publico` (bcrypt, coste 12): el hash
 *     nunca sale de la base y cada intento cuesta de verdad.
 *
 * Si esto deja de parecer aceptable, lo que hay que cambiar no es este endpoint sino la contraseña:
 * una compartida por todo el portal es lo que obliga a elegir entre avisar al usuario y no decirle
 * nada a quien tantea.
 *
 * La respuesta es un 200 con `{ ok }` en los dos casos —no un 401— para que un proxy o un registro
 * intermedio no conviertan el resultado en algo más visible de lo que ya es. Sin base de datos o con
 * cuerpo ilegible responde `ok:false`: ante la duda, no se pasa.
 */
export async function POST(request: Request) {
  if (!isPublicConfigured()) return Response.json({ error: "service_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const denegado = Response.json({ ok: false }, { headers: { "Cache-Control": "no-store" } });
  const ip = clientIpFrom(request.headers);
  if (!publicFormRateLimiter.consume(ip)) return denegado;
  let code = "";
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 4_000) return denegado;
    const cuerpo = JSON.parse(raw) as { code?: unknown };
    code = typeof cuerpo.code === "string" ? cuerpo.code.trim() : "";
  } catch { return denegado; }
  // Los mismos límites que el esquema de radicación (4..64). Una cadena fuera de ese rango no puede
  // ser la contraseña, así que se rechaza sin gastar un bcrypt.
  if (code.length < 4 || code.length > 64) return denegado;
  try { return Response.json({ ok: await verificarCodigoPublico(code) }, { headers: { "Cache-Control": "no-store" } }); } catch { return denegado; }
}
