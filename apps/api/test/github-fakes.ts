import { createHash } from "node:crypto";
import { collectPages } from "../src/github/github-api.js";
import { BRANCH_PAGE_CEILING, InvalidCodeError, ProviderUnavailableError, PULL_PAGE_CEILING } from "../src/github/ports.js";
import type { BranchItem, CodeExchange, InstallationDetails, ProviderRepository, PullRequestItem, RepositoryProvider, SyncPage } from "../src/github/ports.js";

/** O GitHub App de desenvolvimento do ADR 0032 (identificador usado nos testes). */
export const APP_ID = 5858226;

export const REPO_APP: ProviderRepository = { repoId: 501, fullName: "herzog0/app", private: true, htmlUrl: "https://github.com/herzog0/app", defaultBranch: "main" };
export const REPO_SITE: ProviderRepository = { repoId: 502, fullName: "herzog0/site", private: false, htmlUrl: "https://github.com/herzog0/site", defaultBranch: "trunk" };

/** Provedor falso e determinístico: nenhuma chamada sai da máquina. */
export class FakeRepositoryProvider implements RepositoryProvider {
  readonly calls: string[] = [];
  /** `code` → resultado da troca; código desconhecido é recusado pelo GitHub. */
  readonly codes = new Map<string, CodeExchange>();
  readonly installations = new Map<number, InstallationDetails>();
  readonly repositories = new Map<number, ProviderRepository[]>();
  /** Qualquer chamada falha como falha de rede/5xx. */
  fail = false;
  /** O erro lançado quando `fail` está ligado (padrão: `ProviderUnavailableError`). */
  failWith: Error | null = null;
  /** Falha só nesta operação. */
  failOn: "exchangeCode" | "getInstallation" | "listRepositories" | "listBranches" | "listPullRequests" | null = null;
  /** Nomes de branch por repositório (`dono/nome`), na ordem em que o GitHub os devolveria. */
  readonly branches = new Map<string, string[]>();
  /** Pull requests por repositório (`dono/nome`), do criado mais recentemente para o mais antigo. */
  readonly pulls = new Map<string, PullRequestItem[]>();
  /** Erro lançado nas listas de um repositório (`dono/nome`), sem afetar os outros. */
  readonly repoErrors = new Map<string, Error>();
  /** Cada página pedida ao "GitHub", na ordem, com o ETag condicional enviado. */
  readonly pageRequests: { resource: "branches" | "pulls"; fullName: string; page: number; etag: string | null }[] = [];
  /** Itens por página do falso (o real usa 100). */
  pageSize = 100;
  /** Sempre responde 200, como se o ETag guardado não valesse mais (token de instalação novo). */
  ignoreEtags = false;

  installUrl(state: string): string {
    this.calls.push("installUrl");
    return `https://github.com/apps/treepm-dev/installations/new?state=${encodeURIComponent(state)}`;
  }

  exchangeCode(code: string): Promise<CodeExchange> {
    this.calls.push(`exchangeCode:${code}`);
    if (this.fail || this.failOn === "exchangeCode") return Promise.reject(this.failWith ?? new ProviderUnavailableError());
    const found = this.codes.get(code);
    return found ? Promise.resolve(found) : Promise.reject(new InvalidCodeError());
  }

  getInstallation(installationId: number): Promise<InstallationDetails | null> {
    this.calls.push(`getInstallation:${installationId}`);
    if (this.fail || this.failOn === "getInstallation") return Promise.reject(this.failWith ?? new ProviderUnavailableError());
    return Promise.resolve(this.installations.get(installationId) ?? null);
  }

  listRepositories(installationId: number): Promise<ProviderRepository[]> {
    this.calls.push(`listRepositories:${installationId}`);
    if (this.fail || this.failOn === "listRepositories") return Promise.reject(this.failWith ?? new ProviderUnavailableError());
    return Promise.resolve(this.repositories.get(installationId) ?? []);
  }

  listBranches(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<BranchItem>[]> {
    this.calls.push(`listBranches:${installationId}:${fullName}`);
    return this.pages("branches", installationId, fullName, etags, BRANCH_PAGE_CEILING, "listBranches", () => (this.branches.get(fullName) ?? []).map((name) => ({ name })));
  }

  listPullRequests(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<PullRequestItem>[]> {
    this.calls.push(`listPullRequests:${installationId}:${fullName}`);
    return this.pages("pulls", installationId, fullName, etags, PULL_PAGE_CEILING, "listPullRequests", () => this.pulls.get(fullName) ?? []);
  }

  private pages<T>(
    resource: "branches" | "pulls",
    installationId: number,
    fullName: string,
    etags: readonly (string | null)[],
    ceiling: number,
    operation: "listBranches" | "listPullRequests",
    items: () => T[],
  ): Promise<SyncPage<T>[]> {
    if (this.fail || this.failOn === operation) return Promise.reject(this.failWith ?? new ProviderUnavailableError());
    const failure = this.repoErrors.get(fullName);
    if (failure) return Promise.reject(failure);
    // Instalação suspensa ou repositório fora da instalação (apagado, transferido, sem acesso): o GitHub responde 403/404.
    if (this.installations.get(installationId)?.suspended) return Promise.reject(new ProviderUnavailableError());
    if (!this.repositories.get(installationId)?.some((item) => item.fullName === fullName)) return Promise.reject(new ProviderUnavailableError());
    const all = items();
    return collectPages<T>(
      (page, etag): Promise<SyncPage<T>> => {
        this.pageRequests.push({ resource, fullName, page, etag });
        const slice = all.slice((page - 1) * this.pageSize, page * this.pageSize);
        const current = `W/"${createHash("md5").update(JSON.stringify([resource, page, slice])).digest("hex").slice(0, 10)}"`;
        const hasNext = page * this.pageSize < all.length;
        if (!this.ignoreEtags && etag !== null && etag === current) return Promise.resolve({ notModified: true, hasNext });
        return Promise.resolve({ notModified: false, etag: current, items: slice, hasNext });
      },
      etags,
      ceiling,
    );
  }

  reset(): void {
    this.branches.clear();
    this.pulls.clear();
    this.repoErrors.clear();
    this.pageRequests.length = 0;
    this.pageSize = 100;
    this.ignoreEtags = false;
    this.calls.length = 0;
    this.codes.clear();
    this.installations.clear();
    this.repositories.clear();
    this.fail = false;
    this.failWith = null;
    this.failOn = null;
  }

  /** O cenário feliz: o usuário `herzog0` instalou o app na conta pessoal dele; o código `good-code` o autentica. */
  scenario(over: { userLogin?: string; installationId?: number; accountLogin?: string; accountType?: string; appId?: number; suspended?: boolean } = {}): void {
    const installationId = over.installationId ?? 101;
    const accountLogin = over.accountLogin ?? "herzog0";
    const accountType = over.accountType ?? "User";
    this.codes.set("good-code", {
      userLogin: over.userLogin ?? "herzog0",
      installations: [{ installationId, accountLogin, accountType }],
    });
    this.installations.set(installationId, {
      installationId,
      appId: over.appId ?? APP_ID,
      accountLogin,
      accountType,
      repositorySelection: "selected",
      suspended: over.suspended ?? false,
    });
    this.repositories.set(installationId, [REPO_APP, REPO_SITE]);
  }
}
