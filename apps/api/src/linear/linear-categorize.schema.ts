/** A rodada de categorização como a API a devolve (ADR 0060, seção 6). Só contagens e ids: nenhum texto de ticket. */
export type CategorizeView = {
  id: string;
  projectId: string;
  /** A importação concluída sobre a qual a rodada foi aberta. */
  sourceRunId: string | null;
  phase: "categorize" | "done" | "failed";
  /** A rodada terminou (`done` ou `failed`). */
  finished: boolean;
  total: number;
  /** Quantos candidatos já foram decididos, pulados ou deram falha (tudo menos os que faltam). */
  done: number;
  placed: number;
  toCheck: number;
  kept: number;
  skipped: number;
  failed: number;
  /** O provedor de IA limitou: o passo só é tentado depois desta hora. */
  waitUntil: string | null;
  lastErrorCode: string | null;
  /** Passos seguidos que falharam (zera quando um candidato é decidido). */
  errorStreak: number;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type CategorizeOverview = {
  available: boolean;
  reason: null | "assistant_not_configured" | "assistant_consent_required";
  /** Quantos candidatos há no total (a rodada leva no máximo `batchLimit`, os mais antigos primeiro). */
  candidates: number;
  batchLimit: number;
  sourceRunId: string | null;
  run: CategorizeView | null;
  toCheck: number;
};

export type ToCheckItem = { ticketId: string; key: string; title: string; suggestedPath: { id: string; title: string }[] };
