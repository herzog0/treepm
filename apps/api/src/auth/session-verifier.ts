/** Sessão já verificada. `orgRole` mantém o prefixo do Clerk (`org:admin`). */
export type VerifiedSession = {
  userId: string;
  orgId: string | null;
  orgRole: string | null;
  sessionStatus: string | null;
};

/** O que o verificador precisa da requisição HTTP, sem acoplar ao Express. */
export type VerifiableRequest = {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
};

/** Porta de autenticação: devolve a sessão ou `null` (não autenticado). */
export interface SessionVerifier {
  verify(request: VerifiableRequest): Promise<VerifiedSession | null>;
}

export const SESSION_VERIFIER = Symbol("SESSION_VERIFIER");
