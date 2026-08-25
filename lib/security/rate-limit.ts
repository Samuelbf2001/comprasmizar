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
export const mcpRateLimiter = new FixedWindowRateLimiter(120, 60_000);
