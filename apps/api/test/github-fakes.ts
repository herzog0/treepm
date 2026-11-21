import { InvalidCodeError, ProviderUnavailableError } from "../src/github/ports.js";
import type { CodeExchange, InstallationDetails, ProviderRepository, RepositoryProvider } from "../src/github/ports.js";

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
  failOn: "exchangeCode" | "getInstallation" | "listRepositories" | null = null;

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

  reset(): void {
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
