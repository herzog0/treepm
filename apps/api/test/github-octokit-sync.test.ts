import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { OctokitRepositoryProvider } from "../src/github/octokit-repository-provider.js";
import { ProviderUnavailableError } from "../src/github/ports.js";
import { fakeFetch } from "./github-fake-fetch.js";
import type { Route } from "./github-fake-fetch.js";

// O adaptador real nunca fala com o GitHub nos testes: o `fetch` responde com JSON gravado à mão.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
const credentials = { appId: "5858226", slug: "treepm-dev", clientId: "Iv1.cliente", clientSecret: "segredo-do-cliente", privateKey };

const TOKEN: Route = { status: 201, body: { token: "ghs_instalacaofalsa", expires_at: "2099-01-01T00:00:00Z", permissions: {}, repository_selection: "selected" } };
const nextLink = (path: string, page: number) => `<https://api.github.com${path}?per_page=100&page=${page}>; rel="next", <https://api.github.com${path}?per_page=100&page=99>; rel="last"`;
const branch = (name: string) => ({ name, commit: { sha: "abc", url: "https://api.github.com/x" }, protected: false });
const pull = (number: number, over: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  state: "open",
  merged_at: null,
  html_url: `https://github.com/herzog0/app/pull/${number}`,
  head: { ref: `feat/${number}` },
  updated_at: "2026-11-20T10:00:00Z",
  ...over,
});
const BRANCHES = "GET /repos/herzog0/app/branches";
const PULLS = "GET /repos/herzog0/app/pulls";
const provider = (routes: Record<string, Route | Route[]>) => {
  const fake = fakeFetch({ "POST /app/installations/101/access_tokens": TOKEN, ...routes });
  return { provider: new OctokitRepositoryProvider(credentials, fake.impl), calls: fake.calls, repoCalls: () => fake.calls.filter((c) => c.url.includes("/repos/")) };
};

describe("OctokitRepositoryProvider.listBranches (sem rede)", () => {
  it("primeira vez: pede a página 1 sem condicional, com os cabeçalhos da API e o token de instalação, e segue o link next", async () => {
    const { provider: p, repoCalls } = provider({
      [BRANCHES]: [
        { body: [branch("main"), branch("feat/treepm-1")], etag: 'W/"p1"', link: nextLink("/repos/herzog0/app/branches", 2) },
        { body: [branch("dev")], etag: 'W/"p2"' },
      ],
    });
    const pages = await p.listBranches(101, "herzog0/app", []);
    expect(pages).toEqual([
      { notModified: false, etag: 'W/"p1"', items: [{ name: "main" }, { name: "feat/treepm-1" }], hasNext: true },
      { notModified: false, etag: 'W/"p2"', items: [{ name: "dev" }], hasNext: false },
    ]);
    const calls = repoCalls();
    expect(calls.map((c) => new URL(c.url).search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
    for (const call of calls) {
      expect(call.headers["if-none-match"]).toBeUndefined();
      expect(call.headers["authorization"]).toContain("ghs_instalacaofalsa");
      expect(call.headers["user-agent"]).toContain("treepm");
      expect(call.headers["x-github-api-version"]).toBe("2022-11-28");
      expect(call.headers["accept"]).toContain("application/vnd.github+json");
    }
  });

  it("com ETags guardados: manda If-None-Match por página, 304 vira notModified e a última página guardada em 304 encerra sem pedir mais", async () => {
    const { provider: p, repoCalls } = provider({ [BRANCHES]: [{ status: 304, etag: 'W/"p1"' }, { status: 304, etag: 'W/"p2"' }] });
    const pages = await p.listBranches(101, "herzog0/app", ['W/"p1"', 'W/"p2"']);
    expect(pages).toEqual([{ notModified: true, hasNext: false }, { notModified: true, hasNext: false }]);
    const calls = repoCalls();
    expect(calls.map((c) => c.headers["if-none-match"])).toEqual(['W/"p1"', 'W/"p2"']);
    expect(calls.map((c) => new URL(c.url).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("304 na última página guardada, mas com link next: continua e pede a página seguinte sem condicional", async () => {
    const { provider: p, repoCalls } = provider({
      [BRANCHES]: [{ status: 304, link: nextLink("/repos/herzog0/app/branches", 2) }, { body: [branch("novo")], etag: 'W/"p2"' }],
    });
    const pages = await p.listBranches(101, "herzog0/app", ['W/"p1"']);
    expect(pages).toEqual([{ notModified: true, hasNext: true }, { notModified: false, etag: 'W/"p2"', items: [{ name: "novo" }], hasNext: false }]);
    expect(repoCalls().map((c) => c.headers["if-none-match"])).toEqual(['W/"p1"', undefined]);
  });

  it("200 inesperado com ETag guardado é dado novo, sem erro; página a mais sai sem condicional", async () => {
    const { provider: p, repoCalls } = provider({
      [BRANCHES]: [
        { body: [branch("a")], etag: 'W/"novo"', link: nextLink("/repos/herzog0/app/branches", 2) },
        { body: [branch("b")], etag: 'W/"b"' },
      ],
    });
    const pages = await p.listBranches(101, "herzog0/app", ['W/"velho"']);
    expect(pages.map((x) => x.notModified)).toEqual([false, false]);
    expect(repoCalls().map((c) => c.headers["if-none-match"])).toEqual(['W/"velho"', undefined]);
  });

  it("ETag nulo guardado pede sem condicional", async () => {
    const { provider: p, repoCalls } = provider({ [BRANCHES]: { body: [], etag: 'W/"x"' } });
    await p.listBranches(101, "herzog0/app", [null]);
    expect(repoCalls()[0]?.headers["if-none-match"]).toBeUndefined();
  });

  it("para no teto de 10 páginas mesmo com link next, e a última página diz que há mais", async () => {
    const { provider: p, repoCalls } = provider({ [BRANCHES]: { body: [branch("x")], etag: 'W/"e"', link: nextLink("/repos/herzog0/app/branches", 99) } });
    const pages = await p.listBranches(101, "herzog0/app", []);
    expect(pages).toHaveLength(10);
    expect(repoCalls()).toHaveLength(10);
    expect(pages[9]).toMatchObject({ notModified: false, hasNext: true });
  });

  it("repositório sumido (404), 5xx e rede viram ProviderUnavailableError, sem corpo na mensagem", async () => {
    for (const status of [404, 403, 500, 502]) {
      const { provider: p } = provider({ [BRANCHES]: { status, body: { message: "segredo-no-corpo" } } });
      const error = await p.listBranches(101, "herzog0/app", []).catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(ProviderUnavailableError);
      expect(String((error as Error).message)).not.toContain("segredo-no-corpo");
    }
    const network = await new OctokitRepositoryProvider(credentials, () => Promise.reject(new Error("ECONNRESET segredo-de-rede"))).listBranches(101, "herzog0/app", []).catch((e: unknown) => e);
    expect(network).toBeInstanceOf(ProviderUnavailableError);
    expect(String((network as Error).message)).not.toContain("segredo-de-rede");
  });

  it("limite de requisições (403/429 com x-ratelimit) e resposta fora do formato viram ProviderUnavailableError", async () => {
    for (const body of [{ message: "API rate limit exceeded" }, [{ nome: "sem name" }], { name: "objeto" }]) {
      const { provider: p } = provider({ [BRANCHES]: { status: Array.isArray(body) || "name" in body ? 200 : 429, body } });
      await expect(p.listBranches(101, "herzog0/app", [])).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  it("nome de repositório fora do formato dono/nome não chega à rede", async () => {
    const { provider: p, repoCalls } = provider({});
    for (const name of ["semBarra", "a/b/c", "/b", "a/", ""]) {
      await expect(p.listBranches(101, name, []), name).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
    expect(repoCalls()).toHaveLength(0);
  });

  it("nada do GitHub (nome de branch, corpo) vai para o log", async () => {
    const spies = (["log", "warn", "error", "debug", "verbose"] as const).map((level) => vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { provider: p } = provider({ [BRANCHES]: { body: [branch("SENTINELA-branch-4c1")], etag: 'W/"x"' } });
      await p.listBranches(101, "herzog0/app", []);
      const { provider: failing } = provider({ [BRANCHES]: { status: 500, body: { message: "SENTINELA-corpo-9d2" } } });
      await failing.listBranches(101, "herzog0/app", []).catch(() => undefined);
      const logged = JSON.stringify([...spies, out, err, warn].map((spy) => spy.mock.calls));
      expect(logged).not.toContain("SENTINELA");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("OctokitRepositoryProvider.listPullRequests (sem rede)", () => {
  it("pede state=all com per_page=100 e a ordem padrão (sem sort), e traduz aberto, fechado e mesclado", async () => {
    const { provider: p, repoCalls } = provider({
      [PULLS]: {
        body: [
          pull(1),
          pull(2, { state: "closed", merged_at: null }),
          pull(3, { state: "closed", merged_at: "2026-11-19T09:00:00Z" }),
          pull(4, { state: "open", merged_at: "2026-11-19T09:00:00Z" }),
        ],
        etag: 'W/"pr1"',
      },
    });
    const pages = await p.listPullRequests(101, "herzog0/app", []);
    expect(pages).toEqual([
      {
        notModified: false,
        etag: 'W/"pr1"',
        hasNext: false,
        items: [
          { number: 1, title: "PR 1", state: "open", url: "https://github.com/herzog0/app/pull/1", headRef: "feat/1", updatedAt: "2026-11-20T10:00:00Z" },
          { number: 2, title: "PR 2", state: "closed", url: "https://github.com/herzog0/app/pull/2", headRef: "feat/2", updatedAt: "2026-11-20T10:00:00Z" },
          { number: 3, title: "PR 3", state: "merged", url: "https://github.com/herzog0/app/pull/3", headRef: "feat/3", updatedAt: "2026-11-20T10:00:00Z" },
          { number: 4, title: "PR 4", state: "merged", url: "https://github.com/herzog0/app/pull/4", headRef: "feat/4", updatedAt: "2026-11-20T10:00:00Z" },
        ],
      },
    ]);
    const url = new URL(repoCalls()[0]?.url ?? "");
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.has("sort")).toBe(false);
    expect(url.searchParams.has("direction")).toBe(false);
  });

  it("304 e If-None-Match por página, como nos branches", async () => {
    const { provider: p, repoCalls } = provider({ [PULLS]: [{ status: 304 }, { body: [pull(9)], etag: 'W/"n2"' }] });
    const pages = await p.listPullRequests(101, "herzog0/app", ['W/"a"', 'W/"b"']);
    expect(pages).toEqual([{ notModified: true, hasNext: false }, { notModified: false, etag: 'W/"n2"', hasNext: false, items: [expect.objectContaining({ number: 9 })] }]);
    expect(repoCalls().map((c) => c.headers["if-none-match"])).toEqual(['W/"a"', 'W/"b"']);
  });

  it("para no teto de 5 páginas", async () => {
    const { provider: p, repoCalls } = provider({ [PULLS]: { body: [pull(1)], etag: 'W/"e"', link: nextLink("/repos/herzog0/app/pulls", 99) } });
    const pages = await p.listPullRequests(101, "herzog0/app", []);
    expect(pages).toHaveLength(5);
    expect(repoCalls()).toHaveLength(5);
    expect(pages[4]).toMatchObject({ hasNext: true });
  });

  it("resposta sem número, título ou branch de origem vira ProviderUnavailableError; falha de rede também", async () => {
    for (const body of [[{ ...pull(1), number: undefined }], [{ ...pull(1), head: {} }], [{ ...pull(1), updated_at: 5 }]]) {
      const { provider: p } = provider({ [PULLS]: { body } });
      await expect(p.listPullRequests(101, "herzog0/app", [])).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
    const { provider: p } = provider({ [PULLS]: { status: 502, body: { message: "x" } } });
    await expect(p.listPullRequests(101, "herzog0/app", [])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
