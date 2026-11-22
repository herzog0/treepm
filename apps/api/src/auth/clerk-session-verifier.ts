import type { SessionVerifier, VerifiableRequest, VerifiedSession } from "./session-verifier.js";

/** Subconjunto de `ClerkClient` de que a verificação precisa (facilita simular o SDK). */
export type ClerkAuthenticator = {
  authenticateRequest(
    request: Request,
    options: { acceptsToken: "session_token"; authorizedParties: string[]; jwtKey?: string },
  ): Promise<{
    isAuthenticated: boolean;
    toAuth(options?: { treatPendingAsSignedOut?: boolean }): {
      userId: string | null | undefined;
      orgId?: string | null | undefined;
      orgRole?: string | null | undefined;
      sessionStatus?: string | null | undefined;
    } | null;
  }>;
};

export type ClerkVerifierOptions = {
  appOrigin: string;
  /** Origens extras (APP_EXTRA_ORIGINS) aceitas como parte autorizada, além de `appOrigin`. */
  extraOrigins?: readonly string[] | undefined;
  jwtKey?: string | undefined;
};

/**
 * Verificação de sessão com o SDK de servidor do Clerk (ADR 0019 e 0022).
 * `authorizedParties` é `[APP_ORIGIN, ...APP_EXTRA_ORIGINS]`; a URL da requisição montada usa só `APP_ORIGIN`. Sessão pendente é devolvida como
 * pendente (e não como deslogada) para o guard responder 403.
 */
export class ClerkSessionVerifier implements SessionVerifier {
  constructor(
    private readonly client: ClerkAuthenticator,
    private readonly options: ClerkVerifierOptions,
  ) {}

  async verify(request: VerifiableRequest): Promise<VerifiedSession | null> {
    try {
      const state = await this.client.authenticateRequest(this.toWebRequest(request), {
        acceptsToken: "session_token",
        authorizedParties: [this.options.appOrigin, ...(this.options.extraOrigins ?? [])],
        ...(this.options.jwtKey ? { jwtKey: this.options.jwtKey } : {}),
      });
      if (!state.isAuthenticated) return null;
      const auth = state.toAuth({ treatPendingAsSignedOut: false });
      if (!auth?.userId) return null;
      return {
        userId: auth.userId,
        orgId: auth.orgId ?? null,
        orgRole: auth.orgRole ?? null,
        sessionStatus: auth.sessionStatus ?? null,
      };
    } catch {
      return null;
    }
  }

  private toWebRequest(request: VerifiableRequest): Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const path = request.originalUrl ?? request.url ?? "/";
    return new Request(new URL(path, this.options.appOrigin), {
      method: request.method ?? "GET",
      headers,
    });
  }
}
