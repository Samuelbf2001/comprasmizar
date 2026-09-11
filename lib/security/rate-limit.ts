type Entry = { count: number; resetAt: number };
/** Process-local limiter deliberately scoped to the single Hostinger VPS in the PRD. */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  private prune(now: number): void { let scanned = 0; for (const [key, entry] of this.entries) { if (entry.resetAt <= now) this.entries.delete(key); if (++scanned >= 64) break; } }
  consume(key: string): boolean { const now = this.now(); this.prune(now); const current = this.entries.get(key); if (!current || current.resetAt <= now) { this.entries.set(key, { count: 1, resetAt: now + this.windowMs }); return true; } if (current.count >= this.limit) return false; current.count++; return true; }
  /** Diagnostic-only count; permits deterministic bounded-pruning tests. */
  size(): number { return this.entries.size; }
  reset(): void { this.entries.clear(); }
}
export const publicFormRateLimiter = new FixedWindowRateLimiter(20, 60_000);
export const publicWorkRateLimiter = new FixedWindowRateLimiter(10, 60_000);
/**
 * Keyed by workId alone (no IP): publicWorkRateLimiter (ip:workId) grants every distinct origin IP its own
 * budget, so an attacker spreading guesses across many IPs/proxies faces no aggregate ceiling per obra. This
 * caps total attempts against one obra regardless of how many IPs are used, closing that evasion gap.
 */
export const publicWorkAggregateRateLimiter = new FixedWindowRateLimiter(30, 60_000);
export const mcpRateLimiter = new FixedWindowRateLimiter(120, 60_000);
/**
 * Autoalojado (2026-09-10): con Supabase Auth, el freno de fuerza bruta contra el login lo ponía
 * Supabase. Al traer la autenticación a casa hay que ponerlo aquí, o el formulario queda abierto a
 * probar contraseñas sin límite.
 *
 * Dos limitadores por el mismo motivo que en el portal público: el de `ip:correo` deja que cada IP
 * distinta estrene presupuesto, así que un atacante repartido entre proxies no encontraría techo. El
 * agregado por correo pone el tope real sobre la CUENTA, sin importar desde dónde se intente.
 * Los números (10 por IP, 20 en total por minuto) dejan holgura para el usuario que se equivoca
 * varias veces seguidas y siguen muy por debajo de lo que sirve para adivinar una contraseña.
 */
export const loginRateLimiter = new FixedWindowRateLimiter(10, 60_000);
export const loginAggregateRateLimiter = new FixedWindowRateLimiter(20, 60_000);
