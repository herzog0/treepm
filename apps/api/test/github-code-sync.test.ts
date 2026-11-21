import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestItem } from "../src/github/ports.js";
import { REPO_APP, REPO_SITE } from "./github-fakes.js";
import { GITHUB_CONFIG, TEST_CONFIG, createTestApp } from "./helpers.js";
import { useHarness } from "./harness.js";
import { WHO, as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(GITHUB_CONFIG);
const outsider = JSON.stringify({ userId: "u_outsider", orgId: "org_B", orgRole: "org:admin", sessionStatus: "active" });
const sessionOf = (who: Who | "outsider") => (who === "outsider" ? outsider : as(who));
const OPEN = () => h.world().projects.org; // chave OPEN, visível à organização
const PRIV = () => h.world().projects.priv; // chave PRIV, privado

async function rows(sql: string, params: unknown[] = []) {
  return (await h.pool.query(sql, params)).rows as Record<string, unknown>[];
}

async function connect(): Promise<void> {
  const admin = (await rows("select id from people where org_id = 'org_A' and clerk_role = 'admin' limit 1"))[0]?.["id"];
  await rows("insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection, connected_by_person_id) values ('org_A', 101, 'herzog0', 'User', 'selected', $1)", [admin]);
}

/** Organização ligada ao GitHub falso e `repos` ligados ao projeto, direto pela API do passo 1. */
async function ready(projectId = OPEN(), repos = [REPO_APP]): Promise<string[]> {
  h.github().scenario();
  await connect();
  const ids: string[] = [];
  for (const repo of repos) {
    const res = await h.call("POST", `/api/projects/${projectId}/repositories`, as("admin"), { repoId: repo.repoId });
    expect(res.status).toBe(201);
    ids.push(res.body.id as string);
  }
  return ids;
}

async function ticket(projectId: string, number: number, over: { title?: string; kind?: "ticket" | "group"; parent?: string } = {}): Promise<string> {
  const admin = (await rows("select id from people where org_id = 'org_A' and clerk_role = 'admin' limit 1"))[0]?.["id"];
  const created = await rows(
    "insert into tickets (org_id, project_id, number, parent_id, parent_kind, kind, title, created_by_person_id) values ('org_A',$1,$2,$3,$4,$5,$6,$7) returning id",
    [projectId, number, over.parent ?? null, over.parent ? "group" : null, over.kind ?? "ticket", over.title ?? `Ticket ${number}`, admin],
  );
  return String(created[0]?.["id"]);
}

const pr = (number: number, over: Partial<PullRequestItem> = {}): PullRequestItem => ({
  number,
  title: `PR ${number}`,
  state: "open",
  url: `https://github.com/herzog0/app/pull/${number}`,
  headRef: `feat/pr-${number}`,
  updatedAt: "2026-11-20T10:00:00Z",
  ...over,
});

const refresh = (who: Who | "outsider", projectId = OPEN()) => h.call("POST", `/api/projects/${projectId}/code/refresh`, sessionOf(who));
const readCode = (who: Who | "outsider", ticketId: string) => h.call("GET", `/api/tickets/${ticketId}/code`, sessionOf(who));
const links = () =>
  rows(
    `select l.id, l.ticket_id, t.number as ticket_number, l.kind, l.ref, l.number, l.title, l.state, l.url, l.provider_updated_at, l.seen_at
       from ticket_code_links l join tickets t on t.id = l.ticket_id order by l.kind, l.ref, t.number, l.number`,
  );
const pages = () => rows("select resource, page, etag, synced_at from repository_sync_pages order by project_repository_id, resource, page");
/** "Passa o tempo": tira a trava de 30 s sem esperar. */
const age = () => h.pool.query("update repository_sync_pages set synced_at = now() - interval '5 minutes'");
const pageCalls = () => h.github().pageRequests.length;

describe("regra de ligação na sincronização", () => {
  it("primeira vez: guarda as páginas e os ETags, liga branch e PR pelos tickets citados, e não registra atividade", async () => {
    const [repositoryId] = await ready();
    const t1 = await ticket(OPEN(), 1);
    const t2 = await ticket(OPEN(), 2);
    await ticket(OPEN(), 3);
    h.github().branches.set("herzog0/app", ["main", "feat/open-1-mapa", "feat/OPEN-2", "outro/OPEN-99", "x/PRIV-1", "sem-chave"]);
    h.github().pulls.set("herzog0/app", [
      pr(7, { title: "OPEN-1 e OPEN-2 juntos", headRef: "sem-numero" }),
      pr(6, { title: "sem chave", headRef: "feat/open-3-so-no-branch", state: "merged", updatedAt: "2026-11-18T10:00:00Z" }),
      pr(5, { title: "XOPEN-1 não vale", headRef: "OPEN-0" }),
    ]);
    const before = (await rows("select count(*)::int as n from activity_events"))[0]?.["n"];

    const res = await refresh("reader");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refreshed: true, syncedAt: expect.any(String), repositories: [{ id: repositoryId, fullName: "herzog0/app", status: "ok" }] });
    expect(Number.isNaN(Date.parse(res.body.syncedAt))).toBe(false);

    const found = await links();
    expect(found.map((l) => [l.kind, l.ref, l.ticket_number, l.number, l.state])).toEqual([
      ["branch", "feat/OPEN-2", 2, null, "active"],
      ["branch", "feat/open-1-mapa", 1, null, "active"],
      ["pull_request", "feat/open-3-so-no-branch", 3, 6, "merged"],
      ["pull_request", "sem-numero", 1, 7, "open"],
      ["pull_request", "sem-numero", 2, 7, "open"],
    ]);
    expect(found.find((l) => l.ref === "feat/open-1-mapa")).toMatchObject({ number: null, title: null, provider_updated_at: null, url: "https://github.com/herzog0/app/tree/feat/open-1-mapa", ticket_id: t1 });
    expect(found.find((l) => l.number === 7 && l.ticket_number === 2)).toMatchObject({ title: "OPEN-1 e OPEN-2 juntos", url: "https://github.com/herzog0/app/pull/7", ticket_id: t2, provider_updated_at: new Date("2026-11-20T10:00:00Z") });

    const stored = await pages();
    expect(stored.map((p) => [p.resource, p.page])).toEqual([["branches", 1], ["pulls", 1]]);
    expect(stored.every((p) => typeof p.etag === "string" && p.etag.length > 0)).toBe(true);
    expect((await rows("select count(*)::int as n from activity_events"))[0]?.["n"]).toBe(before);
  });

  it("chave de outro projeto e ticket inexistente não ligam; o branch com dois tickets gera um vínculo para cada", async () => {
    await ready();
    await ticket(OPEN(), 1);
    await ticket(OPEN(), 2);
    h.github().branches.set("herzog0/app", ["PRIV-1-fora", "open-99-sem-ticket", "open-1-e-open-2"]);
    await refresh("admin");
    expect((await links()).map((l) => [l.ref, l.ticket_number])).toEqual([["open-1-e-open-2", 1], ["open-1-e-open-2", 2]]);
  });

  it("agrupador também recebe vínculo", async () => {
    await ready();
    await ticket(OPEN(), 1, { kind: "group" });
    h.github().branches.set("herzog0/app", ["open-1-epico"]);
    await refresh("admin");
    expect(await links()).toHaveLength(1);
  });

  it("repositório vazio (sem branches nem PRs) grava a página 1 de cada recurso", async () => {
    await ready();
    const res = await refresh("admin");
    expect(res.body.repositories[0].status).toBe("ok");
    expect((await pages()).map((p) => [p.resource, p.page])).toEqual([["branches", 1], ["pulls", 1]]);
    expect(await links()).toEqual([]);
  });
});

describe("sincronização condicional", () => {
  async function seeded() {
    await ready();
    await ticket(OPEN(), 1);
    await ticket(OPEN(), 2);
    h.github().branches.set("herzog0/app", ["main", "open-1-a", "open-2-b"]);
    h.github().pulls.set("herzog0/app", [pr(9, { title: "OPEN-1" }), pr(8, { title: "OPEN-2", state: "closed" })]);
    expect((await refresh("admin")).status).toBe(200);
    await age();
    h.github().pageRequests.length = 0;
  }

  it("tudo 304: pede as páginas guardadas com o ETag, só atualiza synced_at e não toca em nenhum vínculo", async () => {
    await seeded();
    const linksBefore = await links();
    const pagesBefore = await pages();
    const res = await refresh("admin");
    expect(res.body.refreshed).toBe(true);
    expect(res.body.repositories[0].status).toBe("ok");
    expect(h.github().pageRequests).toHaveLength(2);
    expect(h.github().pageRequests.every((r) => r.etag !== null)).toBe(true);
    expect(await links()).toEqual(linksBefore);
    const pagesAfter = await pages();
    expect(pagesAfter.map((p) => p.etag)).toEqual(pagesBefore.map((p) => p.etag));
    expect(pagesAfter.every((p, i) => (p.synced_at as Date) > (pagesBefore[i]?.synced_at as Date))).toBe(true);
    expect(new Date(res.body.syncedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("uma página mudou: reconstrói só aquele recurso — vínculo novo, vínculo removido, estado do PR atualizado, o outro recurso intacto", async () => {
    await seeded();
    const before = await links();
    const prLinkBefore = before.find((l) => l.number === 9);
    h.github().branches.set("herzog0/app", ["main", "open-2-b", "open-2-novo"]); // sai open-1-a, entra open-2-novo
    const res = await refresh("admin");
    expect(res.status).toBe(200);
    const after = await links();
    expect(after.filter((l) => l.kind === "branch").map((l) => [l.ref, l.ticket_number])).toEqual([["open-2-b", 2], ["open-2-novo", 2]]);
    // o branch que continua é atualizado no lugar, com o mesmo id, e visto de novo
    const kept = after.find((l) => l.ref === "open-2-b");
    const keptBefore = before.find((l) => l.ref === "open-2-b");
    expect(kept?.id).toBe(keptBefore?.id);
    expect((kept?.seen_at as Date) > (keptBefore?.seen_at as Date)).toBe(true);
    // os PR não foram reconstruídos: continuam exatamente como estavam
    expect(after.filter((l) => l.kind === "pull_request")).toEqual(before.filter((l) => l.kind === "pull_request"));
    expect(after.find((l) => l.number === 9)).toEqual(prLinkBefore);

    // depois, o PR 9 é mesclado e o PR 8 some da lista
    await age();
    h.github().pulls.set("herzog0/app", [pr(9, { title: "OPEN-1", state: "merged", updatedAt: "2026-11-21T08:00:00Z" })]);
    await refresh("admin");
    const final = await links();
    expect(final.filter((l) => l.kind === "pull_request").map((l) => [l.number, l.ticket_number, l.state, l.provider_updated_at])).toEqual([[9, 1, "merged", new Date("2026-11-21T08:00:00Z")]]);
    // os branches ficaram como na reconstrução anterior
    expect(final.filter((l) => l.kind === "branch").map((l) => l.ref)).toEqual(["open-2-b", "open-2-novo"]);
  });

  it("o PR muda de título ou de branch de origem: o vínculo acompanha (e troca de ticket)", async () => {
    await seeded();
    h.github().pulls.set("herzog0/app", [pr(9, { title: "agora cita OPEN-2", headRef: "open-1-origem", updatedAt: "2026-11-21T09:00:00Z" })]);
    await refresh("admin");
    const found = (await links()).filter((l) => l.kind === "pull_request");
    expect(found.map((l) => [l.number, l.ticket_number, l.ref, l.title])).toEqual([
      [9, 1, "open-1-origem", "agora cita OPEN-2"],
      [9, 2, "open-1-origem", "agora cita OPEN-2"],
    ]);
  });

  it("branch apagado no GitHub some do TreePM", async () => {
    await seeded();
    h.github().branches.set("herzog0/app", ["main"]);
    await refresh("admin");
    expect((await links()).filter((l) => l.kind === "branch")).toEqual([]);
  });

  it("página a mais (100 → 101 branches) e página a menos (150 → 50) refazem o recurso e ajustam as páginas guardadas", async () => {
    await ready();
    await ticket(OPEN(), 1);
    const names = (n: number) => Array.from({ length: n }, (_, i) => (i === 0 ? "open-1-primeiro" : `b${i}`));
    h.github().branches.set("herzog0/app", names(100));
    await refresh("admin");
    expect((await pages()).filter((p) => p.resource === "branches")).toHaveLength(1);
    await age();
    h.github().branches.set("herzog0/app", names(150));
    await refresh("admin");
    expect((await pages()).filter((p) => p.resource === "branches").map((p) => p.page)).toEqual([1, 2]);
    await age();
    h.github().pageRequests.length = 0;
    h.github().branches.set("herzog0/app", names(50));
    await refresh("admin");
    expect((await pages()).filter((p) => p.resource === "branches").map((p) => p.page)).toEqual([1]);
    expect((await links()).filter((l) => l.kind === "branch")).toHaveLength(1);
  });

  it("304 depois de um 200 inesperado: o ETag que não vale mais vira dado novo sem erro, e a rodada seguinte volta a ser tudo 304", async () => {
    await seeded();
    const before = await links();
    h.github().ignoreEtags = true;
    const first = await refresh("admin");
    expect(first.status).toBe(200);
    expect(first.body.repositories[0].status).toBe("ok");
    const rebuilt = await links();
    expect(rebuilt.map((l) => l.id)).toEqual(before.map((l) => l.id));
    expect(rebuilt.every((l, i) => (l.seen_at as Date) > (before[i]?.seen_at as Date))).toBe(true);
    h.github().ignoreEtags = false;
    await age();
    const again = await links();
    await refresh("admin");
    expect(await links()).toEqual(again);
  });

  it("teto: 1.001 branches e 501 PRs viram status truncated, com 10 e 5 páginas guardadas; o que passa do teto não liga", async () => {
    await ready();
    await ticket(OPEN(), 1);
    await ticket(OPEN(), 2);
    const branches = Array.from({ length: 1001 }, (_, i) => `b${i}`);
    branches[0] = "open-1-dentro";
    branches[1000] = "open-2-fora-do-teto";
    h.github().branches.set("herzog0/app", branches);
    const prs = Array.from({ length: 501 }, (_, i) => pr(1000 - i, { title: "nada", headRef: `h${i}` }));
    prs[0] = pr(1000, { title: "OPEN-1" });
    prs[500] = pr(500, { title: "OPEN-2" });
    h.github().pulls.set("herzog0/app", prs);
    const res = await refresh("admin");
    expect(res.body.repositories[0].status).toBe("truncated");
    const stored = await pages();
    expect(stored.filter((p) => p.resource === "branches")).toHaveLength(10);
    expect(stored.filter((p) => p.resource === "pulls")).toHaveLength(5);
    expect((await links()).map((l) => [l.kind, l.ticket_number])).toEqual([["branch", 1], ["pull_request", 1]]);
    // a rodada seguinte, tudo 304, continua truncada
    await age();
    const again = await refresh("admin");
    expect(again.body.repositories[0].status).toBe("truncated");
  });

  it("só os PR passam do teto: ainda truncated", async () => {
    await ready();
    h.github().pulls.set("herzog0/app", Array.from({ length: 501 }, (_, i) => pr(1000 - i)));
    expect((await refresh("admin")).body.repositories[0].status).toBe("truncated");
  });

  it("freio: com todos os repositórios sincronizados há menos de 30 s não chama o GitHub e responde refreshed: false", async () => {
    await ready();
    const first = await refresh("admin");
    expect(first.body.refreshed).toBe(true);
    h.github().calls.length = 0;
    h.github().pageRequests.length = 0;
    const second = await refresh("reader");
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ refreshed: false, syncedAt: expect.any(String), repositories: [{ id: first.body.repositories[0].id, fullName: "herzog0/app", status: "ok" }] });
    expect(h.github().calls).toEqual([]);
    expect(pageCalls()).toBe(0);
    await age();
    expect((await refresh("admin")).body.refreshed).toBe(true);
    expect(pageCalls()).toBeGreaterThan(0);
  });

  it("o freio só vale se todos os repositórios foram sincronizados: um que nunca foi força a rodada", async () => {
    await ready(OPEN(), [REPO_APP]);
    await refresh("admin");
    h.github().pageRequests.length = 0;
    const second = await h.call("POST", `/api/projects/${OPEN()}/repositories`, as("admin"), { repoId: REPO_SITE.repoId });
    expect(second.status).toBe(201);
    const res = await refresh("admin");
    expect(res.body.refreshed).toBe(true);
    expect(new Set(h.github().pageRequests.map((r) => r.fullName))).toEqual(new Set(["herzog0/app", "herzog0/site"]));
  });
});

describe("falha de um repositório", () => {
  async function two() {
    const [app, site] = await ready(OPEN(), [REPO_APP, REPO_SITE]);
    await ticket(OPEN(), 1);
    await ticket(OPEN(), 2);
    h.github().branches.set("herzog0/app", ["open-1-a"]);
    h.github().branches.set("herzog0/site", ["open-2-s"]);
    expect((await refresh("admin")).status).toBe(200);
    await age();
    return { app: app as string, site: site as string };
  }

  it("com um indisponível, o outro sincroniza e nada do indisponível é apagado (vínculos, ETags e synced_at ficam)", async () => {
    const ids = await two();
    const siteLinks = (await links()).filter((l) => l.ref === "open-2-s");
    const sitePagesBefore = (await rows("select * from repository_sync_pages where project_repository_id = $1 order by resource, page", [ids.site]));
    h.github().repoErrors.set("herzog0/site", new Error("falha crua"));
    h.github().branches.set("herzog0/site", []);
    h.github().branches.set("herzog0/app", ["open-1-a", "open-1-b"]);
    const res = await refresh("admin");
    expect(res.status).toBe(200);
    expect(res.body.repositories).toEqual([
      { id: ids.app, fullName: "herzog0/app", status: "ok" },
      { id: ids.site, fullName: "herzog0/site", status: "unavailable" },
    ]);
    expect((await links()).map((l) => l.ref)).toEqual(["open-1-a", "open-1-b", "open-2-s"]);
    expect((await links()).filter((l) => l.ref === "open-2-s")).toEqual(siteLinks);
    expect(await rows("select * from repository_sync_pages where project_repository_id = $1 order by resource, page", [ids.site])).toEqual(sitePagesBefore);
    // o mais antigo entre os repositórios é o do indisponível
    expect(new Date(res.body.syncedAt).getTime()).toBe((sitePagesBefore[0]?.["synced_at"] as Date).getTime());
  });

  it.each([
    ["repositórios sumidos ou sem acesso (404/403)", () => h.github().repositories.set(101, [])],
    ["instalação suspensa", () => h.github().scenario({ suspended: true })],
    ["5xx ou limite de requisições nos PRs", () => (h.github().failOn = "listPullRequests")],
    ["5xx nos branches", () => (h.github().failOn = "listBranches")],
  ])("%s: o repositório sai unavailable, nada é gravado nem apagado", async (_name, breakIt) => {
    const ids = await two();
    const before = { links: await links(), pages: await pages() };
    breakIt();
    h.github().branches.set("herzog0/app", ["mudou-open-2"]);
    const res = await refresh("admin");
    expect(res.status).toBe(200);
    expect(res.body.repositories.map((r: { id: string; status: string }) => r.id)).toContain(ids.app);
    const failed = (res.body.repositories as { fullName: string; status: string }[]).filter((r) => r.status === "unavailable").map((r) => r.fullName);
    expect(failed).toContain("herzog0/app");
    expect(await links()).toEqual(before.links);
    expect(await pages()).toEqual(before.pages);
  });

  it("falha nos PRs depois de os branches terem dado certo não grava nem os branches (repositório atômico)", async () => {
    await two();
    h.github().branches.set("herzog0/app", ["open-1-novo"]);
    h.github().failOn = "listPullRequests";
    const before = await links();
    await refresh("admin");
    expect(await links()).toEqual(before);
  });
});

describe("permissões e estados", () => {
  it("quem vê o projeto atualiza (leitor, contribuidor, gestor); quem não vê o projeto privado recebe 404", async () => {
    await ready(PRIV());
    for (const who of ["reader", "contributor", "manager", "admin"] as const) {
      await age();
      const res = await refresh(who, PRIV());
      expect(res.status, who).toBe(200);
      expect(res.body.repositories).toHaveLength(1);
    }
    for (const who of ["plain", "teamAdmin", "outsider"] as const) {
      const res = await refresh(who, PRIV());
      expect(res.status, who).toBe(404);
    }
  });

  it("todo membro vê e atualiza um projeto aberto à organização", async () => {
    await ready();
    for (const who of WHO) {
      await age();
      expect((await refresh(who)).status, who).toBe(200);
    }
  });

  it("projeto inexistente, de outra organização ou com identificador inválido", async () => {
    await ready();
    expect((await refresh("admin", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000")).status).toBe(404);
    expect((await refresh("admin", h.world().other.project)).status).toBe(404);
    expect((await refresh("admin", "nao-e-id")).status).toBe(400);
  });

  it("projeto arquivado: 409 project_archived, sem chamar o GitHub", async () => {
    await ready();
    await h.pool.query("update projects set archived_at = now() where id = $1", [OPEN()]);
    h.github().calls.length = 0;
    const res = await refresh("admin");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("project_archived");
    expect(h.github().calls).toEqual([]);
  });

  it("organização sem instalação: 409 not_connected", async () => {
    const res = await refresh("admin");
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("not_connected");
  });

  it("projeto sem repositório ligado: refreshed false, sem chamar o GitHub", async () => {
    h.github().scenario();
    await connect();
    const res = await refresh("admin");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ refreshed: false, syncedAt: null, repositories: [] });
    expect(h.github().calls).toEqual([]);
  });

  it("sem sessão: 401", async () => {
    await ready();
    const request = (await import("supertest")).default;
    expect((await request(h.app().getHttpServer()).post(`/api/projects/${OPEN()}/code/refresh`)).status).toBe(401);
  });

  it("GitHub desligado: as duas rotas respondem 404 github_disabled", async () => {
    const { app } = await createTestApp([], TEST_CONFIG);
    try {
      const request = (await import("supertest")).default;
      const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
      for (const [method, path] of [["post", `/api/projects/${id}/code/refresh`], ["get", `/api/tickets/${id}/code`], ["post", "/api/projects/xx/code/refresh"], ["get", "/api/tickets/xx/code"]] as const) {
        const res = await request(app.getHttpServer())[method](path).set("x-test-session", as("admin"));
        expect(res.status, path).toBe(404);
        expect(res.body.error.code, path).toBe("github_disabled");
      }
    } finally {
      await app.close();
    }
  });

  it("a sincronização de A não grava nada em B (RLS) e o 404 de B não revela o projeto de A", async () => {
    await ready();
    await ticket(OPEN(), 1);
    h.github().branches.set("herzog0/app", ["open-1-a"]);
    expect((await refresh("outsider")).status).toBe(404);
    expect(await links()).toEqual([]);
  });
});

describe("nada do GitHub em log", () => {
  const spies: ReturnType<typeof vi.spyOn>[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    Logger.overrideLogger(false);
  });

  it("nomes de branch, títulos de PR e a mensagem crua do provedor não aparecem no log, nem na falha de um repositório", async () => {
    const logged: string[] = [];
    const capture = (...args: unknown[]) => void logged.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    Logger.overrideLogger({ log: capture, error: capture, warn: capture, debug: capture, verbose: capture, fatal: capture });
    for (const method of ["log", "info", "warn", "error", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(capture));
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (capture(String(chunk)), true)));
    spies.push(vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (capture(String(chunk)), true)));

    await ready(OPEN(), [REPO_APP, REPO_SITE]);
    await ticket(OPEN(), 1);
    h.github().branches.set("herzog0/app", ["SENTINELA-branch-open-1"]);
    h.github().pulls.set("herzog0/app", [pr(3, { title: "SENTINELA-titulo OPEN-1", headRef: "SENTINELA-origem" })]);
    h.github().repoErrors.set("herzog0/site", new Error("SENTINELA-erro-cru SENTINELA-branch-open-1"));
    const res = await refresh("admin");
    expect(res.body.repositories.map((r: { status: string }) => r.status)).toEqual(["ok", "unavailable"]);
    await age();
    await refresh("admin");
    expect(logged.join("\n")).toContain("unavailable".length > 0 ? "Falha do provedor" : "");
    expect(logged.join("\n")).not.toContain("SENTINELA");
    expect(JSON.stringify(await rows("select * from activity_events"))).not.toContain("SENTINELA");
  });
});

describe("GET /api/tickets/:id/code", () => {
  async function world() {
    const [repositoryId] = await ready(OPEN(), [REPO_APP]);
    return { repositoryId };
  }

  it("ticket: os vínculos dele, no formato do contrato, sem chamar o GitHub", async () => {
    const { repositoryId } = await world();
    const t1 = await ticket(OPEN(), 1, { title: "Mapa" });
    await ticket(OPEN(), 2);
    h.github().branches.set("herzog0/app", ["open-1-mapa", "open-2-outro"]);
    h.github().pulls.set("herzog0/app", [pr(4, { title: "OPEN-1: mapa", headRef: "origem", state: "merged", updatedAt: "2026-11-19T08:00:00Z" })]);
    await refresh("admin");
    h.github().calls.length = 0;
    const res = await readCode("reader", t1);
    expect(res.status).toBe(200);
    const syncedAt = res.body.syncedAt;
    expect(res.body).toEqual({
      repositories: 1,
      syncedAt: expect.any(String),
      links: [
        {
          id: expect.any(String),
          kind: "branch",
          ticket: { id: t1, key: "OPEN-1", title: "Mapa" },
          repository: { fullName: "herzog0/app", htmlUrl: REPO_APP.htmlUrl },
          ref: "open-1-mapa",
          number: null,
          title: null,
          state: "active",
          url: "https://github.com/herzog0/app/tree/open-1-mapa",
          updatedAt: null,
        },
        {
          id: expect.any(String),
          kind: "pull_request",
          ticket: { id: t1, key: "OPEN-1", title: "Mapa" },
          repository: { fullName: "herzog0/app", htmlUrl: REPO_APP.htmlUrl },
          ref: "origem",
          number: 4,
          title: "OPEN-1: mapa",
          state: "merged",
          url: "https://github.com/herzog0/app/pull/4",
          updatedAt: "2026-11-19T08:00:00.000Z",
        },
      ],
    });
    expect(Number.isNaN(Date.parse(syncedAt))).toBe(false);
    expect(h.github().calls).toEqual([]);
    expect(repositoryId).toBeTruthy();
  });

  it("nunca sincronizado: links vazio, syncedAt nulo; sem repositório ligado: repositories 0", async () => {
    await world();
    const t1 = await ticket(OPEN(), 1);
    expect((await readCode("admin", t1)).body).toEqual({ repositories: 1, syncedAt: null, links: [] });
    await h.pool.query("delete from project_repositories");
    expect((await readCode("admin", t1)).body).toEqual({ repositories: 0, syncedAt: null, links: [] });
  });

  it("syncedAt é o mais antigo entre os repositórios, e nulo se algum nunca sincronizou", async () => {
    await ready(OPEN(), [REPO_APP, REPO_SITE]);
    const t1 = await ticket(OPEN(), 1);
    await refresh("admin");
    await h.pool.query("update repository_sync_pages set synced_at = '2026-01-01T00:00:00Z' where project_repository_id = (select id from project_repositories where full_name = 'herzog0/site')");
    expect((await readCode("admin", t1)).body.syncedAt).toBe("2026-01-01T00:00:00.000Z");
    await h.pool.query("delete from repository_sync_pages where project_repository_id = (select id from project_repositories where full_name = 'herzog0/site')");
    expect((await readCode("admin", t1)).body.syncedAt).toBeNull();
  });

  it("agrupador: os vínculos dele e os de todos os descendentes, em dois níveis; irmãos e primos ficam de fora", async () => {
    await world();
    const g1 = await ticket(OPEN(), 1, { kind: "group", title: "Raiz" });
    const g2 = await ticket(OPEN(), 2, { kind: "group", parent: g1, title: "Meio" });
    await ticket(OPEN(), 3, { parent: g2, title: "Folha" });
    await ticket(OPEN(), 4, { parent: g1, title: "Filha direta" });
    await ticket(OPEN(), 5, { title: "Fora" });
    h.github().branches.set("herzog0/app", ["open-1-raiz", "open-2-meio", "open-3-folha", "open-4-direta", "open-5-fora"]);
    await refresh("admin");
    const grouped = await readCode("admin", g1);
    expect(grouped.body.links.map((l: { ref: string; ticket: { key: string; title: string } }) => [l.ref, l.ticket.key, l.ticket.title])).toEqual([
      ["open-1-raiz", "OPEN-1", "Raiz"],
      ["open-2-meio", "OPEN-2", "Meio"],
      ["open-3-folha", "OPEN-3", "Folha"],
      ["open-4-direta", "OPEN-4", "Filha direta"],
    ]);
    expect((await readCode("admin", g2)).body.links.map((l: { ref: string }) => l.ref)).toEqual(["open-2-meio", "open-3-folha"]);
  });

  it("ordem: PR abertos, branches, mesclados, fechados; dentro de cada grupo o mais recente primeiro (branches por nome)", async () => {
    await world();
    const g = await ticket(OPEN(), 1, { kind: "group" });
    h.github().branches.set("herzog0/app", ["open-1-zeta", "open-1-alfa", "open-1-meio"]);
    h.github().pulls.set("herzog0/app", [
      pr(10, { title: "OPEN-1 mesclado velho", state: "merged", updatedAt: "2026-11-01T00:00:00Z" }),
      pr(11, { title: "OPEN-1 fechado", state: "closed", updatedAt: "2026-11-20T00:00:00Z" }),
      pr(12, { title: "OPEN-1 aberto velho", state: "open", updatedAt: "2026-11-02T00:00:00Z" }),
      pr(13, { title: "OPEN-1 mesclado novo", state: "merged", updatedAt: "2026-11-15T00:00:00Z" }),
      pr(14, { title: "OPEN-1 aberto novo", state: "open", updatedAt: "2026-11-10T00:00:00Z" }),
      pr(15, { title: "OPEN-1 fechado velho", state: "closed", updatedAt: "2026-10-10T00:00:00Z" }),
    ]);
    await refresh("admin");
    const res = await readCode("admin", g);
    expect(res.body.links.map((l: { kind: string; state: string; number: number | null; ref: string }) => (l.kind === "branch" ? `branch:${l.ref}` : `${l.state}:${l.number}`))).toEqual([
      "open:14",
      "open:12",
      "branch:open-1-alfa",
      "branch:open-1-meio",
      "branch:open-1-zeta",
      "merged:13",
      "merged:10",
      "closed:11",
      "closed:15",
    ]);
  });

  it("projeto privado: quem não o vê, a outra organização e um ticket inexistente recebem 404; quem o vê lê", async () => {
    await ready(PRIV());
    const t = await ticket(PRIV(), 1);
    h.github().branches.set("herzog0/app", ["priv-1-a"]);
    await refresh("admin", PRIV());
    for (const who of ["reader", "contributor", "manager", "admin"] as const) expect((await readCode(who, t)).status, who).toBe(200);
    for (const who of ["plain", "teamAdmin", "outsider"] as const) expect((await readCode(who, t)).status, who).toBe(404);
    expect((await readCode("admin", "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000")).status).toBe(404);
    expect((await readCode("admin", "nao-e-id")).status).toBe(400);
  });

  it("projeto arquivado continua legível (é só leitura)", async () => {
    await world();
    const t = await ticket(OPEN(), 1);
    h.github().branches.set("herzog0/app", ["open-1-a"]);
    await refresh("admin");
    await h.pool.query("update projects set archived_at = now() where id = $1", [OPEN()]);
    const res = await readCode("admin", t);
    expect(res.status).toBe(200);
    expect(res.body.links).toHaveLength(1);
  });
});
