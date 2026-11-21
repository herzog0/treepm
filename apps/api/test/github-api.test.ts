import { describe, expect, it } from "vitest";
import { GITHUB_HEADERS, classifyError, installUrl, parseInstallation, parseRepositories, parseUserInstallations } from "../src/github/github-api.js";
import { ProviderUnavailableError } from "../src/github/ports.js";

// Respostas gravadas à mão a partir da documentação do GitHub (REST, versão 2022-11-28): só os campos que o TreePM lê.
const USER_INSTALLATIONS_PAGE_1 = {
  total_count: 3,
  installations: [
    { id: 101, app_id: 5858226, target_type: "User", account: { login: "herzog0", id: 1, type: "User" }, repository_selection: "selected", suspended_at: null },
    { id: 102, app_id: 5858226, target_type: "Organization", account: { login: "acme", id: 2, type: "Organization" }, repository_selection: "all", suspended_at: null },
  ],
};
const USER_INSTALLATIONS_PAGE_2 = {
  total_count: 3,
  installations: [{ id: 103, app_id: 5858226, target_type: "Organization", account: { slug: "ent", id: 3, name: "Ent" }, repository_selection: "all", suspended_at: null }],
};
const INSTALLATION = {
  id: 101,
  app_id: 5858226,
  account: { login: "herzog0", id: 1, type: "User" },
  repository_selection: "selected",
  suspended_at: null,
  permissions: { contents: "read", metadata: "read", pull_requests: "read" },
};
const REPOSITORIES_PAGE_1 = {
  total_count: 3,
  repositories: [
    { id: 9007199254740, full_name: "herzog0/app", private: true, html_url: "https://github.com/herzog0/app", default_branch: "main", owner: { login: "herzog0" }, description: "ignorado" },
    { id: 12, full_name: "herzog0/site", private: false, html_url: "https://github.com/herzog0/site", default_branch: "trunk" },
  ],
};
const REPOSITORIES_PAGE_2 = {
  total_count: 3,
  repositories: [{ id: 13, full_name: "herzog0/docs", private: false, html_url: "https://github.com/herzog0/docs", default_branch: "main" }],
};

describe("montagem da URL e dos cabeçalhos", () => {
  it("a URL de instalação leva o slug do app e o state codificado", () => {
    expect(installUrl("treepm-dev", "abc.def")).toBe("https://github.com/apps/treepm-dev/installations/new?state=abc.def");
    expect(installUrl("treepm-dev", "a b&c=d")).toBe("https://github.com/apps/treepm-dev/installations/new?state=a%20b%26c%3Dd");
  });

  it("os cabeçalhos são os que o GitHub exige", () => {
    expect(GITHUB_HEADERS).toEqual({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "treepm",
    });
  });
});

describe("tradução das respostas do GitHub", () => {
  it("instalações do usuário: junta as páginas e guarda só id, login e tipo da conta", () => {
    expect(parseUserInstallations([USER_INSTALLATIONS_PAGE_1, USER_INSTALLATIONS_PAGE_2])).toEqual([
      { installationId: 101, accountLogin: "herzog0", accountType: "User" },
      { installationId: 102, accountLogin: "acme", accountType: "Organization" },
      { installationId: 103, accountLogin: "ent", accountType: "Enterprise" },
    ]);
  });

  it("instalação: conta, seleção, suspensão e o app dono", () => {
    expect(parseInstallation(INSTALLATION)).toEqual({
      installationId: 101,
      appId: 5858226,
      accountLogin: "herzog0",
      accountType: "User",
      repositorySelection: "selected",
      suspended: false,
    });
    expect(parseInstallation({ ...INSTALLATION, suspended_at: "2026-11-01T10:00:00Z" }).suspended).toBe(true);
  });

  it("repositórios: junta as páginas e guarda só os cinco campos usados", () => {
    expect(parseRepositories([REPOSITORIES_PAGE_1, REPOSITORIES_PAGE_2])).toEqual([
      { repoId: 9007199254740, fullName: "herzog0/app", private: true, htmlUrl: "https://github.com/herzog0/app", defaultBranch: "main" },
      { repoId: 12, fullName: "herzog0/site", private: false, htmlUrl: "https://github.com/herzog0/site", defaultBranch: "trunk" },
      { repoId: 13, fullName: "herzog0/docs", private: false, htmlUrl: "https://github.com/herzog0/docs", defaultBranch: "main" },
    ]);
  });

  it("resposta fora do formato vira erro do provedor (503), nunca 500", () => {
    const unexpected = [{ ...INSTALLATION, repository_selection: "tudo" }, { id: "x" }, null, "texto", { ...INSTALLATION, account: null }];
    for (const raw of unexpected) expect(() => parseInstallation(raw)).toThrow(ProviderUnavailableError);
    expect(() => parseRepositories([{ repositories: [{ id: 1 }] }])).toThrow(ProviderUnavailableError);
    expect(() => parseRepositories([{ nada: true }])).toThrow(ProviderUnavailableError);
    expect(() => parseUserInstallations([{ installations: [{ id: 1, account: null }] }])).toThrow(ProviderUnavailableError);
  });
});

describe("classificação dos erros do octokit", () => {
  const request = (status: number, data?: unknown) => Object.assign(new Error("HttpError"), { status, response: { status, data } });

  it("código recusado pelo GitHub é código inválido", () => {
    expect(classifyError(request(400, { error: "bad_verification_code" }))).toBe("invalid_code");
    expect(classifyError(request(200, { error: "bad_verification_code" }))).toBe("invalid_code");
    expect(classifyError(Object.assign(new Error("x"), { response: { data: { error: "bad_verification_code" } } }))).toBe("invalid_code");
  });

  it("404 é inexistente; o resto é indisponível", () => {
    expect(classifyError(request(404))).toBe("not_found");
    for (const status of [401, 403, 429, 500, 502, 503]) expect(classifyError(request(status))).toBe("unavailable");
    expect(classifyError(new Error("ECONNRESET"))).toBe("unavailable");
    expect(classifyError("texto")).toBe("unavailable");
    expect(classifyError(null)).toBe("unavailable");
    // credenciais do app erradas na troca do código não são culpa do usuário
    expect(classifyError(request(400, { error: "incorrect_client_credentials" }))).toBe("unavailable");
  });
});
