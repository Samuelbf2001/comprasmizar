/**
 * H1 (docs/plan-rendimiento.md): caché en proceso del perfil de `usuarios` (estado, nombre, email,
 * roles) por `userId`, para no repetir la consulta SQL de auth.ts en cada `/api/*` dentro de la
 * misma ventana de 60 s. Deliberadamente NO cachea el resultado de `getClaims()` — verificar el JWT
 * (firma/expiración) corre SIEMPRE, en cada petición; solo el perfil de negocio (que cambia con poca
 * frecuencia: alta/baja, cambio de rol) se reutiliza.
 *
 * `clock` es inyectable para que los tests controlen el paso del tiempo sin `vi.useFakeTimers()`
 * (que también congelaría timers de librerías ajenas al caché, como el pool de `postgres`).
 */
export type ActorProfile = { estado: string; nombre: string; email: string; roles: string[] };
export type Clock = () => number;

const TTL_MS = 60_000;
const MAX_ENTRIES = 500;
const defaultClock: Clock = () => Date.now();

type Entry = { profile: ActorProfile; expiresAt: number };
const store = new Map<string, Entry>();

export function getCachedProfile(userId: string, clock: Clock = defaultClock): ActorProfile | undefined {
  const entry = store.get(userId);
  if (!entry) return undefined;
  if (entry.expiresAt <= clock()) { store.delete(userId); return undefined; }
  return entry.profile;
}

export function setCachedProfile(userId: string, profile: ActorProfile, clock: Clock = defaultClock): void {
  // Evicción del más antiguo (orden de inserción de Map, no LRU): basta para acotar la memoria del
  // proceso sin la complejidad de un LRU real — el tamaño esperado (usuarios activos en 60 s) está
  // muy por debajo de 500 en el uso real de la plataforma.
  if (!store.has(userId) && store.size >= MAX_ENTRIES) {
    const oldestKey = store.keys().next().value;
    if (oldestKey !== undefined) store.delete(oldestKey);
  }
  store.set(userId, { profile, expiresAt: clock() + TTL_MS });
}

/** Sin `userId`: invalida TODO el caché (usado por defecto en tests). Con `userId`: solo esa cuenta —
 *  el caso real, tras crear/editar un usuario en `/api/catalogs` (kind: "users"), para que una
 *  desactivación o un cambio de roles surta efecto de inmediato en vez de esperar el TTL. */
export function invalidateActorCache(userId?: string): void {
  if (userId) store.delete(userId);
  else store.clear();
}
