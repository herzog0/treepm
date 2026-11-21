import { z } from "zod";
import { ProviderUnavailableError } from "./ports.js";
import type { BranchItem, InstallationDetails, ProviderRepository, PullRequestItem, SyncPage, UserInstallation } from "./ports.js";

/** Cabeçalhos que o GitHub exige em toda requisição (o `User-Agent` é obrigatório). */
export const GITHUB_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "treepm",
};

/** A URL de instalação do app; o `state` volta na Callback URL. */
export function installUrl(slug: string, state: string): string {
  return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
}

// Só os campos que o TreePM usa; o resto da resposta do GitHub é ignorado.
const account = z
  .object({ login: z.string().min(1).optional(), slug: z.string().min(1).optional(), type: z.string().min(1).optional() })
  .transform((value, ctx) => {
    const login = value.login ?? value.slug;
    if (!login) {
      ctx.addIssue({ code: "custom", message: "conta sem login" });
      return z.NEVER;
    }
    // Contas de empresa (enterprise) vêm com `slug` e sem `type`.
    return { login, type: value.type ?? "Enterprise" };
  });
const userInstallation = z.object({ id: z.number().int().positive(), account });
const userInstallationsPage = z.object({ installations: z.array(userInstallation) });
const installation = z.object({
  id: z.number().int().positive(),
  app_id: z.number().int().positive(),
  account,
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().nullable(),
});
const repository = z.object({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  private: z.boolean(),
  html_url: z.string().min(1),
  default_branch: z.string().min(1),
});
const repositoriesPage = z.object({ repositories: z.array(repository) });

function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  // Nada do corpo do GitHub vai para a mensagem: ela pode parar em log.
  if (!result.success) throw new ProviderUnavailableError("O GitHub devolveu uma resposta fora do formato esperado.");
  return result.data;
}

/** Páginas de `GET /user/installations` → as instalações a que o usuário tem acesso. */
export function parseUserInstallations(pages: unknown[]): UserInstallation[] {
  return pages.flatMap((page) =>
    parse(userInstallationsPage, page).installations.map((item) => ({
      installationId: item.id,
      accountLogin: item.account.login,
      accountType: item.account.type,
    })),
  );
}

/** `GET /app/installations/{id}` → conta, seleção, suspensão e o app dono. */
export function parseInstallation(data: unknown): InstallationDetails {
  const item = parse(installation, data);
  return {
    installationId: item.id,
    appId: item.app_id,
    accountLogin: item.account.login,
    accountType: item.account.type,
    repositorySelection: item.repository_selection,
    suspended: item.suspended_at !== null,
  };
}

/** Páginas de `GET /installation/repositories` → os cinco campos que o TreePM guarda. */
export function parseRepositories(pages: unknown[]): ProviderRepository[] {
  return pages.flatMap((page) =>
    parse(repositoriesPage, page).repositories.map((item) => ({
      repoId: item.id,
      fullName: item.full_name,
      private: item.private,
      htmlUrl: item.html_url,
      defaultBranch: item.default_branch,
    })),
  );
}

/**
 * Classifica um erro do octokit sem ler nada além do status e do código `error` do corpo. Só o código recusado
 * pelo GitHub (`bad_verification_code`) é culpa de quem chamou; credenciais do app erradas e o resto são indisponibilidade.
 */
export function classifyError(error: unknown): "invalid_code" | "not_found" | "unavailable" {
  if (typeof error !== "object" || error === null) return "unavailable";
  const { status, response } = error as { status?: unknown; response?: { status?: unknown; data?: unknown } };
  const data = response?.data;
  const code = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
  if (code === "bad_verification_code") return "invalid_code";
  const httpStatus = typeof status === "number" ? status : response?.status;
  if (httpStatus === 404) return "not_found";
  return "unavailable";
}

const branchesPage = z.array(z.object({ name: z.string().min(1) }));
const pullsPage = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.enum(["open", "closed"]),
    merged_at: z.string().nullable(),
    html_url: z.string().min(1),
    head: z.object({ ref: z.string().min(1) }),
    updated_at: z.string().min(1),
  }),
);

/** `GET /repos/{owner}/{repo}/branches` → só os nomes. */
export function parseBranches(data: unknown): BranchItem[] {
  return parse(branchesPage, data).map((item) => ({ name: item.name }));
}

/** `GET /repos/{owner}/{repo}/pulls` → os campos que o TreePM guarda; "mesclado" é `merged_at` não nulo. */
export function parsePullRequests(data: unknown): PullRequestItem[] {
  return parse(pullsPage, data).map((item) => ({
    number: item.number,
    title: item.title,
    state: item.merged_at !== null ? "merged" : item.state,
    url: item.html_url,
    headRef: item.head.ref,
    updatedAt: item.updated_at,
  }));
}

/** `dono/nome` → as partes; qualquer outro formato é recusado antes de chegar à rede. */
export function splitFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split("/");
  const [owner, repo] = parts;
  if (parts.length !== 2 || !owner || !repo) throw new ProviderUnavailableError("Nome de repositório fora do formato dono/nome.");
  return { owner, repo };
}

/** O cabeçalho `link` do GitHub traz `rel="next"` quando há próxima página. */
export function hasNextLink(link: string | null | undefined): boolean {
  return typeof link === "string" && /<[^>]*>\s*;\s*rel="next"/i.test(link);
}

/**
 * Pede as páginas em série, da 1 até o teto. `etags[n - 1]` é o ETag guardado da página n. Para quando uma página
 * não tem próxima, ao chegar no teto, ou quando a última página guardada responde `304` sem `link` para uma próxima.
 * Um `304` com `link` para a próxima continua: entraram itens depois da última página guardada.
 */
export async function collectPages<T>(
  fetchPage: (page: number, etag: string | null) => Promise<SyncPage<T>>,
  etags: readonly (string | null)[],
  ceiling: number,
): Promise<SyncPage<T>[]> {
  const pages: SyncPage<T>[] = [];
  for (let page = 1; page <= ceiling; page += 1) {
    const result = await fetchPage(page, etags[page - 1] ?? null);
    pages.push(result);
    if (!(result.notModified ? page < etags.length || result.hasNext : result.hasNext)) break;
  }
  return pages;
}
