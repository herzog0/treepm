import { App, Octokit } from "octokit";
import {
  GITHUB_HEADERS,
  classifyError,
  collectPages,
  hasNextLink,
  installUrl,
  parseBranches,
  parseInstallation,
  parsePullRequests,
  parseRepositories,
  parseUserInstallations,
  splitFullName,
} from "./github-api.js";
import { BRANCH_PAGE_CEILING, InvalidCodeError, ProviderUnavailableError, PULL_PAGE_CEILING } from "./ports.js";
import type { BranchItem, CodeExchange, InstallationDetails, ProviderRepository, PullRequestItem, RepositoryProvider, SyncPage } from "./ports.js";

export type GithubAppCredentials = {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** PEM PKCS#1 de várias linhas. */
  privateKey: string;
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 10_000;
const PER_PAGE = 100;
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Adaptador do GitHub com o `octokit` (ADR 0032). O SDK gera o JWT do app e renova os tokens de instalação; nada
 * disso é guardado. Sem repetição automática (um 5xx vira 503 na hora), com prazo por requisição e sem log: nenhum
 * corpo de resposta do GitHub nem credencial passa por aqui para um log.
 */
export class OctokitRepositoryProvider implements RepositoryProvider {
  private readonly app: App;

  constructor(
    private readonly credentials: GithubAppCredentials,
    fetchImpl: FetchLike = fetch,
  ) {
    // O octokit não deixa fixar a versão da API nem o `Accept` por opção: o `fetch` aplica os cabeçalhos da API REST
    // (o endereço de troca do código, em github.com, pede JSON e segue como o SDK mandou) e o prazo da requisição.
    const timed: FetchLike = (input, init) => {
      const headers = new Headers(init?.headers);
      if (new URL(input instanceof Request ? input.url : String(input)).hostname === "api.github.com") {
        headers.set("accept", GITHUB_HEADERS["Accept"] ?? "");
        headers.set("x-github-api-version", GITHUB_HEADERS["X-GitHub-Api-Version"] ?? "");
      }
      return fetchImpl(input, { ...init, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    };
    this.app = new App({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      oauth: { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
      Octokit: Octokit.defaults({
        userAgent: GITHUB_HEADERS["User-Agent"] ?? "treepm",
        request: { fetch: timed },
        retry: { enabled: false },
        throttle: { enabled: false },
        log: silent,
      } as never),
      log: silent,
    });
  }

  installUrl(state: string): string {
    return installUrl(this.credentials.slug, state);
  }

  async exchangeCode(code: string): Promise<CodeExchange> {
    try {
      // O token do usuário vive só neste bloco: não volta, não é guardado nem logado.
      const user = await this.app.oauth.getUserOctokit({ code });
      const profile = await user.request("GET /user");
      const installations = await user.paginate("GET /user/installations", { per_page: PER_PAGE });
      const userLogin = (profile.data as { login?: unknown }).login;
      if (typeof userLogin !== "string" || userLogin.length === 0) throw new ProviderUnavailableError();
      return { userLogin, installations: parseUserInstallations([{ installations }]) };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (classifyError(error) === "invalid_code") throw new InvalidCodeError();
      throw new ProviderUnavailableError();
    }
  }

  async getInstallation(installationId: number): Promise<InstallationDetails | null> {
    try {
      const response = await this.app.octokit.request("GET /app/installations/{installation_id}", { installation_id: installationId });
      return parseInstallation(response.data);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      if (classifyError(error) === "not_found") return null;
      throw new ProviderUnavailableError();
    }
  }

  async listRepositories(installationId: number): Promise<ProviderRepository[]> {
    try {
      const octokit = await this.app.getInstallationOctokit(installationId);
      const repositories = await octokit.paginate("GET /installation/repositories", { per_page: PER_PAGE });
      return parseRepositories([{ repositories }]);
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError();
    }
  }

  listBranches(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<BranchItem>[]> {
    return this.listPages(installationId, fullName, "branches", etags, BRANCH_PAGE_CEILING, parseBranches);
  }

  listPullRequests(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<PullRequestItem>[]> {
    return this.listPages(installationId, fullName, "pulls", etags, PULL_PAGE_CEILING, parsePullRequests);
  }

  /** Páginas em série, com `If-None-Match`; `304` vira `notModified`. Qualquer outra falha vira 503, sem corpo na mensagem. */
  private async listPages<T>(
    installationId: number,
    fullName: string,
    resource: "branches" | "pulls",
    etags: readonly (string | null)[],
    ceiling: number,
    parseItems: (data: unknown) => T[],
  ): Promise<SyncPage<T>[]> {
    try {
      const { owner, repo } = splitFullName(fullName);
      const octokit = await this.app.getInstallationOctokit(installationId);
      return await collectPages<T>(
        async (page, etag): Promise<SyncPage<T>> => {
          try {
            const params = { owner, repo, per_page: PER_PAGE, page, headers: etag ? { "if-none-match": etag } : {} };
            const response =
              resource === "branches"
                ? await octokit.request("GET /repos/{owner}/{repo}/branches", params)
                : await octokit.request("GET /repos/{owner}/{repo}/pulls", { ...params, state: "all" });
            const headers = response.headers as Record<string, string | undefined>;
            return { notModified: false, etag: headers["etag"] ?? null, items: parseItems(response.data), hasNext: hasNextLink(headers["link"]) };
          } catch (error) {
            if (typeof error === "object" && error !== null && (error as { status?: unknown }).status === 304) {
              const headers = (error as { response?: { headers?: Record<string, string | undefined> } }).response?.headers;
              return { notModified: true, hasNext: hasNextLink(headers?.["link"]) };
            }
            throw error;
          }
        },
        etags,
        ceiling,
      );
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError();
    }
  }

  /** Conferência do app (`github:check`): `GET /app` e `GET /app/installations`, autenticado como o app. Só fatos agregados. */
  async describeApp(): Promise<{ slug: string; permissions: Record<string, string>; installationCount: number }> {
    try {
      const app = await this.app.octokit.request("GET /app");
      const installations = await this.app.octokit.paginate("GET /app/installations", { per_page: PER_PAGE });
      const slug = (app.data as { slug?: unknown } | null)?.slug;
      const permissions = (app.data as { permissions?: unknown } | null)?.permissions;
      if (typeof slug !== "string") throw new ProviderUnavailableError();
      const names = typeof permissions === "object" && permissions !== null ? (permissions as Record<string, string>) : {};
      return { slug, permissions: names, installationCount: installations.length };
    } catch (error) {
      if (error instanceof ProviderUnavailableError) throw error;
      throw new ProviderUnavailableError();
    }
  }
}
