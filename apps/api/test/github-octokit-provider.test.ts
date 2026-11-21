import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OctokitRepositoryProvider } from "../src/github/octokit-repository-provider.js";
import { InvalidCodeError, ProviderUnavailableError } from "../src/github/ports.js";

// O adaptador real nunca fala com o GitHub nos testes: o `fetch` abaixo responde com JSON gravado à mão.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
const credentials = { appId: "5858226", slug: "treepm-dev", clientId: "Iv1.cliente", clientSecret: "segredo-do-cliente", privateKey };

type Call = { method: string; url: string; headers: Record<string, string> };
type Route = { status?: number; body: unknown; link?: string };

function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: Call[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => (headers[key] = value));
    calls.push({ method, url, headers });
    const path = url.replace("https://api.github.com", "").replace("https://github.com", "");
    const key = `${method} ${path.split("?")[0]}`;
    const entry = routes[key];
    if (!entry) return Promise.reject(new Error(`rota não prevista no teste: ${key}`));
    const route = Array.isArray(entry) ? (entry.shift() ?? entry[0]) : entry;
    if (!route) return Promise.reject(new Error("sem resposta"));
    const headers2: Record<string, string> = { "content-type": "application/json; charset=utf-8", date: new Date().toUTCString() };
    if (route.link) headers2["link"] = route.link;
    const response = new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: headers2 });
    // `Response.url` é vazio em respostas sintéticas; o octokit usa a URL para normalizar a paginação.
    Object.defineProperty(response, "url", { value: url });
    return Promise.resolve(response);
  };
  return { impl: impl as typeof fetch, calls };
}

describe("OctokitRepositoryProvider (sem rede)", () => {
  it("monta a URL de instalação com o slug e o state", () => {
    const provider = new OctokitRepositoryProvider(credentials, fakeFetch({}).impl);
    expect(provider.installUrl("a.b")).toBe("https://github.com/apps/treepm-dev/installations/new?state=a.b");
  });

  it("troca o código, lê o login e as instalações, e manda os cabeçalhos exigidos", async () => {
    const { impl, calls } = fakeFetch({
      "POST /login/oauth/access_token": { body: { access_token: "ghu_tokenfalso", token_type: "bearer", scope: "", expires_in: 28800, refresh_token: "ghr_falso", refresh_token_expires_in: 15552000 } },
      "GET /user": { body: { login: "herzog0", id: 1 } },
      "GET /user/installations": { body: { total_count: 1, installations: [{ id: 101, account: { login: "herzog0", type: "User" } }] } },
    });
    const exchange = await new OctokitRepositoryProvider(credentials, impl).exchangeCode("codigo-de-uso-unico");
    expect(exchange).toEqual({ userLogin: "herzog0", installations: [{ installationId: 101, accountLogin: "herzog0", accountType: "User" }] });
    expect(JSON.stringify(exchange)).not.toContain("ghu_");
    const api = calls.filter((call) => call.url.startsWith("https://api.github.com"));
    expect(api.length).toBe(2);
    for (const call of api) {
      expect(call.headers["user-agent"]).toContain("treepm");
      expect(call.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(call.headers["accept"]).toContain("application/vnd.github+json");
    }
  });

  it("código recusado vira InvalidCodeError", async () => {
    const { impl } = fakeFetch({ "POST /login/oauth/access_token": { body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } } });
    await expect(new OctokitRepositoryProvider(credentials, impl).exchangeCode("velho")).rejects.toBeInstanceOf(InvalidCodeError);
  });

  it("5xx, rede e resposta inesperada viram ProviderUnavailableError, sem corpo na mensagem", async () => {
    const { impl } = fakeFetch({ "POST /login/oauth/access_token": { status: 502, body: { message: "segredo-no-corpo" } } });
    const error = await new OctokitRepositoryProvider(credentials, impl).exchangeCode("x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(String((error as Error).message)).not.toContain("segredo-no-corpo");
    const network = await new OctokitRepositoryProvider(credentials, () => Promise.reject(new Error("ECONNRESET segredo-de-rede"))).exchangeCode("x").catch((e: unknown) => e);
    expect(network).toBeInstanceOf(ProviderUnavailableError);
    expect(String((network as Error).message)).not.toContain("segredo-de-rede");
  });

  it("lê a instalação como o app (JWT) e devolve null quando ela não existe", async () => {
    const { impl, calls } = fakeFetch({
      "GET /app/installations/101": { body: { id: 101, app_id: 5858226, account: { login: "herzog0", type: "User" }, repository_selection: "selected", suspended_at: null } },
      "GET /app/installations/999": { status: 404, body: { message: "Not Found" } },
    });
    const provider = new OctokitRepositoryProvider(credentials, impl);
    expect(await provider.getInstallation(101)).toEqual({ installationId: 101, appId: 5858226, accountLogin: "herzog0", accountType: "User", repositorySelection: "selected", suspended: false });
    expect(await provider.getInstallation(999)).toBeNull();
    expect(calls[0]?.headers["authorization"]).toMatch(/^bearer ey/i);
  });

  it("lista os repositórios com o token de instalação, seguindo a paginação", async () => {
    const repo = (id: number) => ({ id, full_name: `herzog0/r${id}`, private: false, html_url: `https://github.com/herzog0/r${id}`, default_branch: "main" });
    const { impl, calls } = fakeFetch({
      "POST /app/installations/101/access_tokens": { status: 201, body: { token: "ghs_instalacaofalsa", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "selected" } },
      "GET /installation/repositories": [
        { body: { total_count: 2, repositories: [repo(1)] }, link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' },
        { body: { total_count: 2, repositories: [repo(2)] } },
      ],
    });
    const repositories = await new OctokitRepositoryProvider(credentials, impl).listRepositories(101);
    expect(repositories.map((r) => r.repoId)).toEqual([1, 2]);
    expect(calls.some((c) => c.url.includes("/installation/repositories") && c.headers["authorization"]?.includes("ghs_instalacaofalsa"))).toBe(true);
  });

  it("describeApp devolve só slug, permissões e quantidade de instalações, autenticado como o app", async () => {
    const { impl, calls } = fakeFetch({
      "GET /app": { body: { id: 5858226, slug: "treepm-dev", name: "TreePM (dev)", owner: { login: "herzog0" }, permissions: { contents: "read", metadata: "read" } } },
      "GET /app/installations": { body: [{ id: 101 }, { id: 102 }] },
    });
    const facts = await new OctokitRepositoryProvider(credentials, impl).describeApp();
    expect(facts).toEqual({ slug: "treepm-dev", permissions: { contents: "read", metadata: "read" }, installationCount: 2 });
    expect(calls.every((call) => /^bearer ey/i.test(call.headers["authorization"] ?? ""))).toBe(true);
  });
});
