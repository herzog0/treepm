import type { AccessTokenClock } from "./clock.js";

/**
 * Janela deslizante por chave, em MEMÓRIA do processo (ADR 0038): vale para uma máquina só, como a publicação
 * prevê hoje. Com várias máquinas o limite efetivo passa a ser por máquina; a ADR deixa isso em aberto.
 * Guarda no máximo `limit` instantes por chave, em ordem de chegada (só a chamada aceita entra, no fim); a cada chamada
 * descarta só o começo já vencido, então o custo acompanha o que saiu da janela, não o tamanho da cota. Chaves ociosas são
 * varridas de tempos em tempos.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly clock: AccessTokenClock,
    /** Mutável só para os testes (que provam o bloqueio com tetos pequenos). */
    public limit: number,
    private readonly windowMs: number,
  ) {}

  /** Registra uma chamada. `retryAfterMs` vem quando a cota da janela já está cheia (a chamada não conta). */
  hit(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const now = this.clock.now();
    this.sweep(now);
    const recent = this.hits.get(key) ?? [];
    let expired = 0;
    while (expired < recent.length && now - (recent[expired] as number) >= this.windowMs) expired += 1;
    if (expired > 0) recent.splice(0, expired);
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
