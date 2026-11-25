/** Token de injeção do cliente do Linear. */
export const LINEAR_CLIENT = Symbol("LINEAR_CLIENT");
/** Token do `fetch` que o cliente usa (só os testes o trocam). */
export const LINEAR_FETCH = Symbol("LINEAR_FETCH");
/** Token da cifra das credenciais; `null` quando a ligação com o Linear está desligada. */
export const CREDENTIAL_CIPHER = Symbol("CREDENTIAL_CIPHER");

export type LinearFailureCode = "linear_key_invalid" | "linear_rate_limited" | "linear_unavailable";

/**
 * Falha ao falar com o Linear: só um código e, no limite, o tempo de espera. A mensagem é fixa por código: a chave, o corpo da
 * resposta e a exceção original nunca entram (ADR 0060).
 */
export class LinearError extends Error {
  constructor(
    readonly code: LinearFailureCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(`Falha ao consultar o Linear: ${code}.`);
    this.name = "LinearError";
  }
}

export type LinearWorkspace = { id: string; name: string; urlKey: string };
export type LinearTeam = { id: string; key: string; name: string };

/** O que o Linear devolve sobre a chave: o workspace a que ela pertence e quem a criou. */
export type LinearIdentity = { workspace: LinearWorkspace; viewer: { id: string } };

/** A porta do Linear desta fatia. A chave é sempre argumento: o cliente não guarda nada entre chamadas. */
export interface LinearClient {
  whoami(apiKey: string): Promise<LinearIdentity>;
  /** Os times que a chave enxerga agora, até o teto de 500. */
  listTeams(apiKey: string): Promise<LinearTeam[]>;
  /** Um time pelo id, sem listar todos; inexistente ou inacessível → `null`. */
  getTeam(apiKey: string, teamId: string): Promise<LinearTeam | null>;
}
