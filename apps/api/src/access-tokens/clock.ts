/** Relógio injetável do acesso por token (validade, janelas de 5 minutos e limite de requisições). */
export interface AccessTokenClock {
  /** Milissegundos desde a época. */
  now(): number;
}

export const ACCESS_TOKEN_CLOCK = Symbol("ACCESS_TOKEN_CLOCK");

export const systemClock: AccessTokenClock = { now: () => Date.now() };
