import type { AccessTokenClock } from "./clock.js";

/**
 * Janela deslizante por chave, em MEMÓRIA do processo (ADR 0038): vale para uma máquina só, como a publicação
 * prevê hoje. Com várias máquinas o limite efetivo passa a ser por máquina; a ADR deixa isso em aberto.
 * Guarda no máximo `limit` instantes por chave; chaves ociosas são varridas de tempos em tempos.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly clock: AccessTokenClock,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Registra uma chamada. `retryAfterMs` vem quando a cota da janela já está cheia (a chamada não conta). */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.clock.now();
    this.sweep(now);
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    const oldest = recent[0];
    if (recent.length >= this.limit && oldest !== undefined) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterMs: Math.max(1, this.windowMs - (now - oldest)) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  /** Esquece tudo (para testes). */
  clear(): void {
    this.hits.clear();
    this.lastSweep = 0;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs) return;
    this.lastSweep = now;
    for (const [key, list] of this.hits) {
      const last = list[list.length - 1];
      if (last === undefined || now - last >= this.windowMs) this.hits.delete(key);
    }
  }
}
