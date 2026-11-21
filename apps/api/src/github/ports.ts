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

/** Tetos de paginação da sincronização (ADR 0032): 1.000 branches e os 500 pull requests criados mais recentemente. */
export const BRANCH_PAGE_CEILING = 10;
export const PULL_PAGE_CEILING = 5;

export type BranchItem = { name: string };

export type PullRequestItem = {
  number: number;
  title: string;
  /** `merged` quando `merged_at` não é nulo; senão `open` ou `closed`. */
  state: "open" | "merged" | "closed";
  url: string;
  /** O branch de origem (`head.ref`). */
  headRef: string;
  updatedAt: string;
};

/**
 * Uma página pedida: `304` (nada mudou desde o ETag enviado) ou o conteúdo novo, com o ETag e se há próxima página.
 * O `304` também carrega `hasNext` (o `link` da resposta, `false` se o GitHub não o mandou): uma página igual pode
 * deixar de ser a última quando entram itens depois dela.
 */
export type SyncPage<T> = { notModified: true; hasNext: boolean } | { notModified: false; etag: string | null; items: T[]; hasNext: boolean };

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
  /**
   * Branches do repositório, em série, uma entrada por página pedida. `etags` é o ETag guardado de cada página
   * (a posição é a página menos um; `null` pede sem condicional). Páginas além das guardadas vêm sem condicional.
   * Para quando uma página não tem próxima (e, em `304`, já passou da última página guardada), ou ao chegar no teto.
   */
  listBranches(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<BranchItem>[]>;
  /** Pull requests (`state=all`, ordem padrão), com as mesmas regras de `listBranches`. */
  listPullRequests(installationId: number, fullName: string, etags: readonly (string | null)[]): Promise<SyncPage<PullRequestItem>[]>;
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
