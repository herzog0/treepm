/** Token de injeção do provedor de repositórios. `null` quando a ligação com o GitHub está desligada. */
export const REPOSITORY_PROVIDER = Symbol("REPOSITORY_PROVIDER");

/** Uma instalação do app a que o usuário do token tem acesso (acesso não é posse: ADR 0032). */
export type UserInstallation = {
  installationId: number;
  accountLogin: string;
  accountType: string;
};

export type CodeExchange = {
  /** Login do dono do token, lido de `GET /user`. O token em si nunca sai do adaptador. */
  userLogin: string;
  installations: UserInstallation[];
};

export type InstallationDetails = {
  installationId: number;
  /** O app dono da instalação: tem que ser o deste TreePM. */
  appId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
};

export type ProviderRepository = {
  repoId: number;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
};

/** Porta do provedor de repositórios (ADR 0032). Hoje só o GitHub; o GitLab e o Bitbucket entrariam por ela. */
export interface RepositoryProvider {
  /** A URL de instalação do app, levando o `state`. */
  installUrl(state: string): string;
  /** Troca o `code` por um token do usuário usado só dentro da chamada. */
  exchangeCode(code: string): Promise<CodeExchange>;
  /** `null` quando a instalação não existe. */
  getInstallation(installationId: number): Promise<InstallationDetails | null>;
  /** Todos os repositórios da instalação, seguindo a paginação. */
  listRepositories(installationId: number): Promise<ProviderRepository[]>;
}

/** Rede, 5xx, limite de requisições ou resposta fora do formato: vira 503 `github_unavailable`. */
export class ProviderUnavailableError extends Error {
  constructor(message = "O GitHub não respondeu como esperado.") {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

/** O GitHub recusou o código da autorização (vencido, já usado ou inválido). */
export class InvalidCodeError extends Error {
  constructor() {
    super("O GitHub recusou o código de autorização.");
    this.name = "InvalidCodeError";
  }
}
