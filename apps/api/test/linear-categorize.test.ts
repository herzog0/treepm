import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import { useLinearHarness } from "./linear-support.js";
import { BATCH_LIMIT, CATEGORIZE_CONFIG, LP, categorizeAll, categorizePath, importedProject, runImport, wireFakes } from "./linear-categorize-support.js";
import type { CategorizeView, Row } from "./linear-categorize-support.js";
import { TEAM_ENG } from "./linear-support.js";
import { ORG, as } from "./world.js";

const s = useLinearHarness(CATEGORIZE_CONFIG);
const { h } = s;
const open = () => h.world().projects.org;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const get = (path = "", who: Parameters<typeof as>[0] = "admin") => h.call("GET", categorizePath(open(), path), as(who));
const post = (path = "", who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", categorizePath(open(), path), as(who), body);

/** O pai de cada ticket pelo título. */
const parents = async (): Promise<Record<string, string | null>> => {
  const rows = await q("select t.title, p.title as parent from tickets t left join tickets p on p.id = t.parent_id where t.project_id = $1::uuid", [open()]);
  return Object.fromEntries(rows.map((row) => [row["title"] as string, (row["parent"] as string | null) ?? null]));
};
const idOf = async (title: string): Promise<string> => (await q("select id from tickets where project_id = $1::uuid and title = $2", [open(), title]))[0]?.["id"] as string;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const aiCalls = () => [h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, h.conversation().calls, h.embedder().calls].reduce((sum, calls) => sum + calls.length, 0);

const prepared = async (over: Parameters<typeof importedProject>[2] = {}) => {
  wireFakes(s);
  return importedProject(s, open(), over);
};

describe("categorização do lote importado: o caso completo (8 raízes)", () => {
  it("move os seguros, deixa os em dúvida a conferir e não cria agrupador", async () => {
    await prepared();
    expect((await get()).body).toMatchObject({ available: true, reason: null, candidates: 8, batchLimit: BATCH_LIMIT, run: null, toCheck: 0 });
    const eventsBefore = (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]?.["n"];
    const groupsBefore = (await q("select count(*)::int n from tickets"))[0]?.["n"];

    const view = await categorizeAll(s, open());
    expect(view).toMatchObject({ phase: "done", finished: true, total: 8, done: 8, placed: 4, toCheck: 4, kept: 0, skipped: 0, failed: 0, waitUntil: null, errorStreak: 0 });

    const now = await parents();
    expect(now).toMatchObject({ Alfa: "Billing", Beta: "SSO", Gama: "Docs", "Solta 1": "Docs", "Solta 2": null, "Solta 3": null, "Solta 4": null, "Solta 5": null });
    // Os filhos acompanham os pais; ninguém mais se mexeu.
    expect(now).toMatchObject({ "Alfa um": "Alfa", "Alfa dois": "Alfa", "Beta um": "Beta", "Gama um": "Gama", Invoices: "Billing", Login: "Auth" });
    // O lote nunca cria agrupador nem ticket.
    expect((await q("select count(*)::int n from tickets"))[0]?.["n"]).toBe(groupsBefore);

    // Um evento automático por ticket movido, e só.
    const events = await q("select subject_id, payload from activity_events where kind = 'ticket.updated' and payload->>'source' = 'linear_categorize'");
    expect(events).toHaveLength(4);
    for (const event of events) expect(event["payload"]).toMatchObject({ fields: ["parentId"], automatic: true, source: "linear_categorize", runId: view.id });
    expect((await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]?.["n"]).toBe((eventsBefore as number) + 4);

    // As oito decisões guardadas, por ticket e com a marca da importação.
    const decisions = await q("select t.title, d.conversation_id, d.placed_by, d.chosen_path from placement_decisions d join tickets t on t.id = d.ticket_id order by t.title");
    expect(decisions.map((d) => d["title"])).toEqual(["Alfa", "Beta", "Gama", "Solta 1", "Solta 2", "Solta 3", "Solta 4", "Solta 5"]);
    for (const d of decisions) expect(d).toMatchObject({ conversation_id: null, placed_by: "import" });
    expect(decisions.find((d) => d["title"] === "Beta")?.["chosen_path"]).toEqual([await idOf("Auth"), await idOf("SSO")]);
  });

  it("a lista \"a conferir\": os quatro que não moveram (o que não achou ramo, sem sugestão), com o caminho sugerido; sair dela por conferido ou por mudança de lugar", async () => {
    await prepared();
    await categorizeAll(s, open());
    const list = await get("/to-check");
    expect(list.status).toBe(200);
    const items = list.body.items as { ticketId: string; key: string; title: string; suggestedPath: { id: string; title: string }[] }[];
    expect(items.map((item) => item.title)).toEqual(["Solta 2", "Solta 3", "Solta 4", "Solta 5"]);
    expect(items.find((item) => item.title === "Solta 5")?.suggestedPath).toEqual([]);
    expect(items.find((item) => item.title === "Solta 4")).toMatchObject({ key: expect.stringMatching(/^[A-Z0-9]+-\d+$/), suggestedPath: [{ id: await idOf("Auth"), title: "Auth" }] });
    expect((await get()).body).toMatchObject({ toCheck: 4 });

    // Conferido: sai da lista e não volta.
    expect((await post(`/to-check/${items[0]?.ticketId}/dismiss`)).status).toBe(200);
    // A pessoa move o ticket: também sai.
    expect((await h.call("PATCH", `/api/tickets/${items[1]?.ticketId}`, as("admin"), { parentId: await idOf("Billing") })).status).toBe(200);
    const after = (await get("/to-check")).body.items as { title: string }[];
    expect(after.map((item) => item.title)).toEqual(["Solta 4", "Solta 5"]);
    // Ticket de outro projeto ou inexistente não se descarta.
    expect((await post(`/to-check/${await idOf("Alfa")}/dismiss`)).status).toBe(404);
  });

  it("quem já teve decisão não é candidato de novo: depois da categorização não sobra nada para procurar", async () => {
    await prepared();
    await categorizeAll(s, open());
    expect((await get()).body).toMatchObject({ candidates: 0 });
    const again = await post();
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("linear_nothing_to_categorize");
  });
});

describe("categorização e reimportação", () => {
  it("reimportação sem mudança no Linear não desfaz nada e fica quieta", async () => {
    await prepared();
    await categorizeAll(s, open());
    const before = await parents();
    const eventsBefore = (await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]?.["n"];
    const last = await runImport(s, open());
    expect(last).toMatchObject({ phase: "done", mode: "reimport" });
    expect(last["counts"]).toMatchObject({ issuesCreated: 0, parentsLinked: 0, keptMoved: 0 });
    expect(await parents()).toEqual(before);
    expect((await q("select count(*)::int n from activity_events where kind = 'ticket.updated'"))[0]?.["n"]).toBe(eventsBefore);
  });

  it("o Linear muda o projeto de uma issue-filha: a reimportação continua funcionando", async () => {
    const { data } = await prepared();
    await categorizeAll(s, open());
    (data.issues.find((issue) => issue.id === "a2") as { project: string | null }).project = LP.beta;
    await runImport(s, open());
    expect((await parents())["Alfa dois"]).toBe("Beta");
    expect((await parents())["Alfa"]).toBe("Billing");
  });

  it("o Linear dá um projeto a uma issue que a categorização colocou: a mudança legítima vale (a categorização não a esconde)", async () => {
    const { data } = await prepared();
    await categorizeAll(s, open());
    expect((await parents())["Solta 1"]).toBe("Docs");
    (data.issues.find((issue) => issue.id === "s1") as { project: string | null }).project = LP.beta;
    await runImport(s, open());
    expect((await parents())["Solta 1"]).toBe("Beta");
  });

  it("a reimportação nunca devolve ao destino o que a categorização colocou, mesmo com o Linear mexendo em outro campo", async () => {
    const { data } = await prepared();
    await categorizeAll(s, open());
    (data.issues.find((issue) => issue.id === "s1") as { title: string }).title = "Solta 1";
    (data.issues.find((issue) => issue.id === "s1") as { priority: number }).priority = 2;
    await runImport(s, open());
    expect((await parents())["Solta 1"]).toBe("Docs");
  });

  it("a pessoa move um ticket colocado pela categorização: a reimportação respeita", async () => {
    const { data } = await prepared();
    await categorizeAll(s, open());
    const solta = await idOf("Solta 1");
    expect((await h.call("PATCH", `/api/tickets/${solta}`, as("admin"), { parentId: await idOf("Billing") })).status).toBe(200);
    (data.issues.find((issue) => issue.id === "s1") as { project: string | null }).project = LP.gama;
    const last = await runImport(s, open());
    expect(last["counts"]).toMatchObject({ keptMoved: 1 });
    expect((await parents())["Solta 1"]).toBe("Billing");
  });

  it("a categorização também serve a uma reimportação: só procura o que ela trouxe", async () => {
    const { data } = await prepared();
    await categorizeAll(s, open());
    data.issues.push({ id: "s6", identifier: "ENG-99", title: "Solta 6", description: "Texto da solta 6" });
    await runImport(s, open());
    expect((await get()).body).toMatchObject({ candidates: 1 });
  });
});

describe("a rodada de categorização", () => {
  it("uma aberta por projeto, e não anda junto de uma importação", async () => {
    await prepared();
    const first = await post();
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ phase: "categorize", finished: false, total: 8, done: 0, sourceRunId: expect.any(String) });
    const second = await post();
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("linear_categorize_open");
    // Importação não abre enquanto a categorização está aberta (e vice-versa).
    const importing = await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {});
    expect(importing.status).toBe(409);
    expect(importing.body.error.code).toBe("linear_categorize_open");
    // O estado da importação não mostra a categorização como se fosse uma importação.
    const current = await h.call("GET", `/api/projects/${open()}/linear/runs/current`, as("admin"));
    expect(["first", "reimport"]).toContain(current.body.run.mode);
    expect(current.body.run.phase).toBe("done");
  });

  it("não abre durante uma importação em andamento", async () => {
    wireFakes(s);
    const { data } = await importedProject(s, open());
    const opened = await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {});
    expect(opened.status).toBe(201);
    void data;
    const res = await post();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_import_in_progress");
  });

  it("passo repetido depois do fim não chama a IA de novo nem decide de novo", async () => {
    await prepared();
    const view = await categorizeAll(s, open());
    const calls = aiCalls();
    for (let i = 0; i < 3; i += 1) expect((await post(`/${view.id}/step`)).body).toMatchObject({ phase: "done", total: 8, placed: 4 });
    expect(aiCalls()).toBe(calls);
    expect(await q("select count(*)::int n from placement_decisions")).toEqual([{ n: 8 }]);
  });

  it("dois passos de fato concorrentes: um decide e o outro é recusado; o candidato é decidido uma vez só", async () => {
    await prepared();
    const opened = await post();
    h.judge().onCall = async () => {
      await sleep(150);
    };
    const both = await Promise.all([post(`/${opened.body.id}/step`), post(`/${opened.body.id}/step`)]);
    h.judge().onCall = null;
    expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
    expect(both.find((res) => res.status === 409)?.body.error.code).toBe("linear_step_in_progress");
    expect(both.find((res) => res.status === 200)?.body).toMatchObject({ done: 1, total: 8 });
    expect((await get()).body.run).toMatchObject({ done: 1, total: 8 });
    expect(await q("select count(*)::int n from placement_decisions")).toEqual([{ n: 1 }]);
    expect(await q("select count(*)::int n from external_categorize_items where state <> 'pending'")).toEqual([{ n: 1 }]);
  });

  it("abandonar no meio e abrir de novo não repete quem já teve decisão", async () => {
    await prepared();
    const opened = await post();
    const runId = opened.body.id as string;
    for (let i = 0; i < 3; i += 1) await post(`/${runId}/step`);
    const abandoned = await post(`/${runId}/abandon`);
    expect(abandoned.body).toMatchObject({ phase: "failed", finished: true, done: 3, total: 8 });
    expect((await get()).body).toMatchObject({ candidates: 5 });
    const calls = h.judge().calls.length;
    const view = await categorizeAll(s, open());
    expect(view).toMatchObject({ total: 5, done: 5, phase: "done" });
    expect(view.placed + view.toCheck + view.kept).toBe(5);
    expect(h.judge().calls.length).toBeGreaterThan(calls);
    // Cada ticket tem uma só decisão.
    expect(await q("select count(*)::int n from placement_decisions")).toEqual([{ n: 8 }]);
  });
});

describe("o passo pula e adia sem chamar a IA", () => {
  it("candidato que a pessoa moveu entre a abertura e o passo é pulado, sem IA", async () => {
    await prepared();
    const opened = await post();
    const alfa = await idOf("Alfa");
    expect((await h.call("PATCH", `/api/tickets/${alfa}`, as("admin"), { parentId: await idOf("Docs") })).status).toBe(200);
    const calls = aiCalls();
    // O primeiro candidato da fila é o Alfa (menor número).
    const res = await post(`/${opened.body.id}/step`);
    expect(res.body).toMatchObject({ skipped: 1, done: 1 });
    expect(aiCalls()).toBe(calls);
    expect((await parents())["Alfa"]).toBe("Docs");
    expect((await q("select 1 from placement_decisions where ticket_id = $1::uuid", [alfa])).length).toBe(0);
  });

  it("candidato concluído, cancelado, em ideia ou que sumiu do Linear não é candidato (contagem exata, nada engolido)", async () => {
    await prepared();
    await q("update tickets set status = 'done' where project_id = $1::uuid and title = 'Solta 1'", [open()]);
    await q("update tickets set status = 'cancelled' where project_id = $1::uuid and title = 'Solta 2'", [open()]);
    await q("update tickets set idea_stage = 'new' where project_id = $1::uuid and title = 'Solta 3'", [open()]);
    await q("update ticket_external_refs set missing_since = now() where ticket_id = (select id from tickets where project_id = $1::uuid and title = 'Solta 4')", [open()]);
    expect((await get()).body).toMatchObject({ candidates: 4 });
    const view = await categorizeAll(s, open());
    expect(view).toMatchObject({ total: 4, done: 4, skipped: 0, phase: "done" });
    const decided = (await q("select t.title from placement_decisions d join tickets t on t.id = d.ticket_id order by t.title")).map((r) => r["title"]);
    expect(decided).toEqual(["Alfa", "Beta", "Gama", "Solta 5"]);
  });

  it("o alvo apagado entre a decisão e a gravação vira \"a conferir\"", async () => {
    await prepared();
    const billing = await idOf("Billing");
    const invoices = await idOf("Invoices");
    let fired = false;
    h.judge().onCall = async () => {
      if (fired) return;
      fired = true;
      // O primeiro candidato é o Alfa e o juiz o leva a Billing: o alvo some durante a chamada.
      await h.pool.query("delete from tickets where org_id = 'org_A' and id = $1::uuid", [invoices]);
      await h.pool.query("delete from tickets where org_id = 'org_A' and id = $1::uuid", [billing]);
    };
    const opened = await post();
    const res = await post(`/${opened.body.id}/step`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ placed: 0, toCheck: 1, done: 1 });
    expect((await parents())["Alfa"]).toBeNull();
    expect((await get("/to-check")).body.items).toHaveLength(1);
  });
});

describe("provedor de IA", () => {
  it("fora do ar: o candidato é tentado de novo e, na segunda falha, vira failed; a rodada segue até o fim", async () => {
    await prepared();
    const opened = await post();
    const step = () => post(`/${opened.body.id}/step`);
    h.judge().fail = true;
    const first = await step();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ done: 0, failed: 0, errorStreak: 1, finished: false, lastErrorCode: "assistant_unavailable" });
    expect((await step()).body).toMatchObject({ done: 1, failed: 1, errorStreak: 0 });
    h.judge().fail = false;
    let last = (await step()).body as CategorizeView;
    for (let i = 0; i < 20 && !last.finished; i += 1) {
      const res = await step();
      expect(res.status).toBe(200);
      last = res.body as CategorizeView;
    }
    expect(last).toMatchObject({ finished: true, phase: "done", total: 8, failed: 1 });
    expect(last.placed + last.toCheck + last.kept).toBe(7);
  });

  it("limite de taxa com prazo vira espera, sem contar falha, e nada é chamado durante ela", async () => {
    await prepared();
    const opened = await post();
    h.judge().verdict = () => {
      throw new AssistantUnavailableError("rate_limited", 30);
    };
    const res = await post(`/${opened.body.id}/step`);
    expect(res.status).toBe(200);
    expect(res.body.waitUntil).toBeTruthy();
    expect(new Date(res.body.waitUntil as string).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(res.body).toMatchObject({ done: 0, failed: 0 });
    const calls = aiCalls();
    expect((await post(`/${opened.body.id}/step`)).body.waitUntil).toBeTruthy();
    expect(aiCalls()).toBe(calls);
  });
});

describe("aceite", () => {
  it("sem aceite: o passo responde 403, a rodada fica aberta e a IA não é chamada", async () => {
    await prepared();
    const opened = await post();
    expect(opened.status).toBe(201);
    await h.pool.query("delete from organization_consents where org_id = $1 and kind = 'assistant'", [ORG]);
    const res = await post(`/${opened.body.id}/step`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("assistant_consent_required");
    expect(aiCalls()).toBe(0);
    expect((await get()).body).toMatchObject({ available: false, reason: "assistant_consent_required", run: { phase: "categorize", done: 0 } });
    // O portão vem antes de qualquer outra conferência: sem aceite nem uma segunda rodada se abre.
    expect((await post("")).status).toBe(403);
  });

  it("sem aceite não abre a rodada", async () => {
    await prepared();
    await h.pool.query("delete from organization_consents where org_id = $1 and kind = 'assistant'", [ORG]);
    const res = await post();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("assistant_consent_required");
    expect(aiCalls()).toBe(0);
    expect(await q("select 1 from external_import_runs where mode = 'categorize'")).toHaveLength(0);
  });
});

describe("guardas", () => {
  it("quem não pode importar no projeto não vê, não abre nem dá passo (e o 404 de outra organização)", async () => {
    await prepared();
    expect((await get("", "reader")).status).toBe(403);
    expect((await post("", "reader")).status).toBe(403);
    expect((await post("", "plain")).status).toBe(403);
    const opened = await post();
    expect((await post(`/${opened.body.id}/step`, "reader")).status).toBe(403);
    expect((await h.call("POST", categorizePath(open(), `/${opened.body.id}/step`), as("admin", "org_B"))).status).toBe(404);
    expect((await h.call("GET", categorizePath(open(), "/to-check"), as("reader"))).status).toBe(403);
    expect(aiCalls()).toBe(0);
  });

  it("\"entrar como\" outra pessoa é recusado nas seis rotas, sem gravar nada", async () => {
    await prepared();
    const opened = await post();
    const runId = opened.body.id as string;
    const before = await q("select (select count(*)::int from external_categorize_items where state <> 'pending') n, (select count(*)::int from placement_decisions) d, (select phase from external_import_runs where id = $1::uuid) phase", [runId]);
    const act = { "x-treepm-act-as": h.world().people.contributor };
    const routes: [string, string][] = [
      ["GET", categorizePath(open())],
      ["POST", categorizePath(open())],
      ["POST", categorizePath(open(), `/${runId}/step`)],
      ["POST", categorizePath(open(), `/${runId}/abandon`)],
      ["GET", categorizePath(open(), "/to-check")],
      ["POST", categorizePath(open(), `/to-check/${await idOf("Alfa")}/dismiss`)],
    ];
    for (const [method, path] of routes) expect((await h.call(method, path, as("admin"), {}, act)).status, `${method} ${path}`).toBe(403);
    expect(await q("select (select count(*)::int from external_categorize_items where state <> 'pending') n, (select count(*)::int from placement_decisions) d, (select phase from external_import_runs where id = $1::uuid) phase", [runId])).toEqual(before);
    expect(aiCalls()).toBe(0);
  });

  it("projeto arquivado: nada abre nem anda", async () => {
    await prepared();
    const opened = await post();
    await h.pool.query("update projects set archived_at = now() where id = $1::uuid", [open()]);
    expect((await post(`/${opened.body.id}/step`)).body.error.code).toBe("project_archived");
    expect((await post("", "admin")).status).toBe(409);
    expect(aiCalls()).toBe(0);
  });

  it("projeto sem importação concluída: nada para categorizar", async () => {
    wireFakes(s);
    const res = await post();
    expect(res.status).toBe(409);
    expect((await get()).body).toMatchObject({ candidates: 0, sourceRunId: null });
  });
});

describe("candidatos sem janela de rodada (M1)", () => {
  it("nunca categorizou e a reimportação não trouxe nada: continuam os 8", async () => {
    await prepared();
    await runImport(s, open());
    expect((await get()).body).toMatchObject({ candidates: 8 });
    expect(await categorizeAll(s, open())).toMatchObject({ total: 8, done: 8, phase: "done" });
  });

  it("abandonou no meio e reimportou: voltam os que faltam, sem repetir quem teve decisão", async () => {
    await prepared();
    const opened = await post();
    for (let i = 0; i < 3; i += 1) await post(`/${opened.body.id}/step`);
    await post(`/${opened.body.id}/abandon`);
    await runImport(s, open());
    expect((await get()).body).toMatchObject({ candidates: 5 });
    expect(await categorizeAll(s, open())).toMatchObject({ total: 5, done: 5 });
  });

  it("todos falharam: voltam todos, mesmo depois de reimportações", async () => {
    await prepared();
    h.judge().fail = true;
    const opened = await post();
    let view = opened.body as CategorizeView;
    for (let i = 0; i < 20 && !view.finished; i += 1) view = (await post(`/${opened.body.id}/step`)).body as CategorizeView;
    expect(view).toMatchObject({ finished: true, failed: 8 });
    h.judge().fail = false;
    expect((await get()).body).toMatchObject({ candidates: 8 });
    await runImport(s, open());
    await runImport(s, open());
    expect((await get()).body).toMatchObject({ candidates: 8 });
    expect(await categorizeAll(s, open())).toMatchObject({ total: 8, done: 8, failed: 0, phase: "done" });
  });

  it("a reimportação trouxe 1 nova: continuam os 8 e entra a nova (9)", async () => {
    const { data } = await prepared();
    data.issues.push({ id: "s6", identifier: "ENG-99", title: "Solta 6", description: "Texto da solta 6" });
    await runImport(s, open());
    expect((await get()).body).toMatchObject({ candidates: 9 });
  });

  it("só entra a raiz do que veio do Linear: filho de ticket do Linear e ticket movido por pessoa ficam de fora; sob ticket nativo entra", async () => {
    await prepared({ destinationTitle: "Docs" });
    expect((await get()).body).toMatchObject({ candidates: 8 });
    expect((await parents())["Alfa"]).toBe("Docs");
    // A pessoa move a Solta 2 para outro lugar: não é mais candidata.
    expect((await h.call("PATCH", `/api/tickets/${await idOf("Solta 2")}`, as("admin"), { parentId: await idOf("Billing") })).status).toBe(200);
    expect((await get()).body).toMatchObject({ candidates: 7 });
  });
});

describe("\"sem lugar\" não é \"já no lugar\" (M3)", () => {
  it("o que cai na raiz fica a conferir sem sugestão; \"já no lugar\" só quando o melhor lugar é o pai atual e ele não é a raiz", async () => {
    await prepared({ destinationTitle: "Docs" });
    const view = await categorizeAll(s, open());
    const state = async (title: string) => (await q("select i.state, i.suggested_path from external_categorize_items i join tickets t on t.id = i.ticket_id where t.title = $1", [title]))[0];
    expect(await state("Solta 5")).toMatchObject({ state: "to_check", suggested_path: [] });
    expect(await state("Solta 1")).toMatchObject({ state: "kept" });
    expect(view.kept).toBeGreaterThan(0);
    expect(view.placed + view.toCheck + view.kept).toBe(8);
  });
});

describe("a importação não enxerga a categorização (M4)", () => {
  it("lastImportedAt ignora a rodada de categorização", async () => {
    await prepared();
    const importedAt = async () => ((await h.call("GET", "/api/linear/teams", as("admin"))).body as { id: string; lastImportedAt: string | null }[]).find((team) => team.id === TEAM_ENG.id)?.lastImportedAt;
    const before = await importedAt();
    expect(before).toEqual(expect.any(String));
    await sleep(20);
    await categorizeAll(s, open());
    expect(await importedAt()).toBe(before);
  });

  it("passo e abandono da importação com o id de uma categorização: 404, sem gravar nada nela", async () => {
    await prepared();
    const opened = await post();
    const snapshot = async () => q("select phase, updated_at, finished_at, last_error_code, error_streak from external_import_runs where id = $1::uuid", [opened.body.id]);
    const before = await snapshot();
    expect((await h.call("POST", `/api/projects/${open()}/linear/runs/${opened.body.id}/step`, as("admin"))).status).toBe(404);
    expect((await h.call("POST", `/api/projects/${open()}/linear/runs/${opened.body.id}/abandon`, as("admin"))).status).toBe(404);
    expect(await snapshot()).toEqual(before);
    expect(before[0]).toMatchObject({ phase: "categorize" });
  });

  it("abrir importação com a categorização aberta: 409 linear_categorize_open", async () => {
    await prepared();
    await post();
    const res = await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_categorize_open");
  });
});

describe("erro inesperado no passo (M2)", () => {
  it("qualquer erro conta tentativa e não trava: na segunda falha o candidato vira failed e a rodada segue", async () => {
    await prepared();
    const opened = await post();
    const step = () => post(`/${opened.body.id}/step`);
    h.judge().verdict = () => {
      throw new Error("explodiu");
    };
    const first = await step();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ done: 0, failed: 0, errorStreak: 1, lastErrorCode: "step_failed" });
    expect((await q("select attempts from external_categorize_items where state = 'pending' order by position limit 1"))[0]).toMatchObject({ attempts: 1 });
    expect(JSON.stringify(first.body)).not.toContain("explodiu");
    expect((await step()).body).toMatchObject({ done: 1, failed: 1, errorStreak: 0 });
    h.judge().verdict = null;
    wireFakes(s);
    let last = (await step()).body as CategorizeView;
    for (let i = 0; i < 20 && !last.finished; i += 1) last = (await step()).body as CategorizeView;
    expect(last).toMatchObject({ finished: true, total: 8, failed: 1 });
    // A rodada terminou: a importação não fica bloqueada para sempre.
    expect((await h.call("POST", `/api/projects/${open()}/linear/runs`, as("admin"), {})).status).toBe(201);
  });

  it("falha simultânea do mesmo candidato conta uma vez só", async () => {
    await prepared();
    const opened = await post();
    h.judge().verdict = () => {
      throw new Error("explodiu");
    };
    h.judge().onCall = async () => {
      await sleep(100);
    };
    const both = await Promise.all([post(`/${opened.body.id}/step`), post(`/${opened.body.id}/step`)]);
    expect(both.map((res) => res.status).sort()).toEqual([200, 409]);
    expect((await q("select max(attempts)::int a from external_categorize_items"))[0]).toMatchObject({ a: 1 });
    expect((await get()).body.run).toMatchObject({ errorStreak: 1 });
  });
});

describe("teto e espera", () => {
  it("no máximo 200 candidatos por rodada, os mais antigos primeiro; o resto fica para a seguinte", async () => {
    wireFakes(s);
    const data = linearBulk(205);
    await importedProject(s, open(), { data });
    const overview = (await get()).body;
    expect(overview).toMatchObject({ candidates: 205, batchLimit: BATCH_LIMIT });
    const opened = await post();
    expect(opened.body).toMatchObject({ total: BATCH_LIMIT });
    const listed = (await q("select t.title from external_categorize_items i join tickets t on t.id = i.ticket_id where i.run_id = $1::uuid order by t.number", [opened.body.id])).map((row) => row["title"]);
    expect(listed).toHaveLength(BATCH_LIMIT);
    expect(listed).not.toContain("Bulk 205");
    await post(`/${opened.body.id}/abandon`);
    // Quem não entrou na lista continua candidato; abandonada, a rodada devolve os pendentes.
    expect((await get()).body).toMatchObject({ candidates: 205 });
  });

  it("depois de 10 esperas seguidas no mesmo candidato ele vira failed", async () => {
    await prepared();
    const opened = await post();
    h.judge().verdict = () => {
      throw new AssistantUnavailableError("rate_limited", 30);
    };
    for (let i = 1; i <= 9; i += 1) {
      const res = await post(`/${opened.body.id}/step`);
      expect(res.body, `espera ${i}`).toMatchObject({ failed: 0, done: 0 });
      expect(res.body.waitUntil).toBeTruthy();
      await q("update external_import_runs set wait_until = null where id = $1::uuid", [opened.body.id]);
    }
    const tenth = await post(`/${opened.body.id}/step`);
    expect(tenth.body).toMatchObject({ failed: 1, done: 1, waitUntil: null });
  });
});

describe("eventos ligados à rodada (B1)", () => {
  it("a reabertura de ancestral concluído causada pelo movimento sai com a origem e a rodada", async () => {
    await prepared();
    await q("update tickets set status = 'done' where project_id = $1::uuid and title in ('Billing', 'Invoices')", [open()]);
    const view = await categorizeAll(s, open());
    expect((await parents())["Alfa"]).toBe("Billing");
    const reopened = await q("select payload from activity_events where kind = 'ticket.updated' and payload->'status'->>'from' = 'done' and payload->>'automatic' = 'true'");
    expect(reopened).toHaveLength(1);
    expect(reopened[0]?.["payload"]).toMatchObject({ fields: ["status"], automatic: true, source: "linear_categorize", runId: view.id });
  });
});

/** Um time do Linear com `count` issues soltas (para o teto do lote). */
function linearBulk(count: number) {
  return { projects: [], issues: Array.from({ length: count }, (_, index) => ({ id: `x${index + 1}`, identifier: `ENG-${index + 1}`, title: `Bulk ${index + 1}`, description: `Texto ${index + 1}` })) };
}
