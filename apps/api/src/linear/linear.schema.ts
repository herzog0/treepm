import { z } from "zod";

/** A chave pessoal do Linear: 1 a 200 caracteres, sem espaços nas pontas (ADR 0060). */
export const connectBodySchema = z
  .object({ apiKey: z.string().min(1).max(200).refine((value) => value === value.trim(), "sem espaços nas pontas") })
  .strict();

/** Ligar o projeto a um time: o id do time e a chave dele (ex.: `ENG`) digitada na confirmação dupla. */
export const linkBodySchema = z
  .object({ teamId: z.string().min(1).max(200), confirmTeamKey: z.string().min(1).max(20) })
  .strict();

export type ConnectionOutput = {
  configured: boolean;
  /** Presente (e `true`) só agindo como outra pessoa: a chave é pessoal, então `connection` vem `null` e a tela mostra a frase própria. */
  actingAs?: true;
  connection: null | { workspace: { id: string; name: string }; hint: string; connectedAt: string };
};

export type TeamOutput = {
  id: string;
  key: string;
  name: string;
  linkedProject: null | { id: string; name: string };
  /** O time já está ligado a um projeto que a pessoa não enxerga (sem nome). */
  linkedElsewhere: boolean;
};

export type ProjectLinearOutput = {
  source: null | {
    workspace: { id: string; name: string };
    team: { id: string; key: string; name: string };
    linkedAt: string;
    linkedBy: { id: string };
  };
  canLink: boolean;
  /** A chave da pessoa é do mesmo workspace e enxerga o time; `null` sem chave ou quando não dá para saber. */
  keyMatches: boolean | null;
};
