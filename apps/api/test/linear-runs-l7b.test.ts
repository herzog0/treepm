import { describe, expect, it } from "vitest";
import { KEY, TEAM_ENG, WORKSPACE, linearImportWorld, linkWithData, useLinearHarness } from "./linear-support.js";
import type { FakeIssue, FakeTeamData } from "./linear-support.js";
import { recordQueries } from "./query-recorder.js";
import { ORG, as } from "./world.js";

// L7: A2 (texto do Linear não vira menção), M1 (custo da trava), M2/M3 (pai que mudou), M4 (repescagem), M5 (endereço) e situação do projeto.
const { h, put } = useLinearHarness();
type Row = Record<string, unknown>;
type RunBody = Record<string, unknown> & { done?: boolean; counts?: Record<string, number | boolean> };
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const post = (path: string, who: Parameters<typeof as>[0] = "admin", body: unknown = {}) => h.call("POST", `/api/projects/${open()}/linear/runs${path}`, as(who), body);
const step = (runId: string) => post(`/${runId}/step`);
const issues = (n: number, over: (i: number) => Partial<FakeIssue> = () => ({})): FakeIssue[] => Array.from({ length: n }, (_, i) => ({ id: `i${i + 1}`, identifier: `ENG-${i + 1}`, ...over(i + 1) }));
const team = (list: FakeIssue[], extra: Partial<FakeTeamData> = {}): Record<string, FakeTeamData> => ({ [TEAM_ENG.id]: { projects: [{ id: "lp1", name: "Alfa" }], issues: list, ...extra } });
const admin = () => h.world().people.admin;

async function begin(data: Record<string, FakeTeamData>, body: unknown = {}): Promise<string> {
  await linkWithData(h, put, open(), data);
  const run = await post("", "admin", body);
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  return run.body.id as string;
}
async function finish(runId: string, max = 80): Promise<RunBody> {
  for (let i = 0; i < max; i += 1) {
    const res = await step(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    if (res.body.done) return res.body;
  }
  throw new Error("não terminou");
}
const byExt = async (): Promise<Map<string, Row>> => new Map((await q("select r.external_id, t.* from ticket_external_refs r join tickets t on t.id = r.ticket_id and t.org_id = r.org_id where r.project_id = $1::uuid", [open()])).map((row) => [row["external_id"] as string, row]));
const manual = async (number: number, title: string, description = "", extra = "") =>
  (await q(`insert into tickets (org_id, project_id, number, title, description, created_by_person_id${extra ? ", " + extra.split("=")[0] : ""}) values ($1,$2::uuid,$3,$4,$5,$6::uuid${extra ? ", " + extra.split("=")[1] : ""}) returning id`, [ORG, open(), number, title, description, admin()]))[0]!["id"] as string;
const nextNumber = (n: number) => h.pool.query("update projects set next_ticket_number = $2 where id = $1::uuid", [open(), n]);

describe("A2: o texto do Linear nunca vira menção a ticket do TreePM", () => {
  it("projeto e time de MESMA chave (ENG), chave de outro projeto da organização e endereço solto: nenhuma relação de saída", async () => {
    await h.pool.query("update projects set key = 'ENG' where id = $1::uuid", [open()]);
    const old5 = await manual(5, "Antigo cinco");
    await nextNumber(100);
    const other = (await q("insert into projects (org_id, name, key, visibility) values ($1,'Operações','OPS','organization') returning id", [ORG]))[0]!["id"] as string;
    await h.pool.query("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2::uuid,3,'Do OPS',$3::uuid)", [ORG, other, admin()]);
    const data = team(issues(4, (i) => (i === 1 ? { description: "ver ENG-5 e ENG-100 e #ENG-101, também OPS-3 e JIRA-9; https://linear.app/acme/issue/ENG-5/titulo" } : {})));
    const runId = await begin(data);
    await finish(runId);
    const rows = await byExt();
    const desc = rows.get("i1")!["description"] as string;
    expect(desc).toContain("ENG\u20115");
    expect(desc).toContain("ENG\u2011100");
    expect(desc).toContain("#ENG\u2011101");
    // só a chave do PRÓPRIO projeto (a única que o detector lê) é tocada: as outras ficam como vieram
    expect(desc).toContain("OPS-3");
    expect(desc).toContain("JIRA-9");
    expect(desc).toContain("/issue/ENG%2D5/titulo");
    expect(await q("select 1 from ticket_relations where kind = 'mentions' and from_ticket_id = $1::uuid", [rows.get("i1")!["id"]])).toHaveLength(0);
    expect(await q("select 1 from ticket_relations where kind = 'mentions' and to_ticket_id = $1::uuid", [old5])).toHaveLength(0);
    // nem a ferramenta de reconstrução das menções (que lê todas as descrições) as cria
    const rebuild = await h.call("POST", `/api/projects/${open()}/tickets/mentions/rebuild`, as("admin"));
    expect(rebuild.status).toBe(200);
    expect(await q("select 1 from ticket_relations where kind = 'mentions'")).toHaveLength(0);
  });

  it("sobrevive à edição: salvar a mesma descrição de volta pela rota de edição não cria relação", async () => {
    await h.pool.query("update projects set key = 'ENG' where id = $1::uuid", [open()]);
    await manual(5, "Antigo cinco");
    await nextNumber(100);
    const runId = await begin(team(issues(2, (i) => (i === 1 ? { description: "ver ENG-5 e #ENG-100, https://linear.app/a/issue/ENG-5/t" } : {}))));
    await finish(runId);
    const row = (await byExt()).get("i1")!;
    const saved = await h.call("PATCH", `/api/tickets/${row["id"]}`, as("admin"), { description: `${row["description"] as string}\n\nmais uma linha` });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const again = await h.call("PATCH", `/api/tickets/${row["id"]}`, as("admin"), { description: row["description"] });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await q("select 1 from ticket_relations where kind = 'mentions' and from_ticket_id = $1::uuid", [row["id"]])).toHaveLength(0);
  });

  it("texto ANTIGO que já cita um número criado pela rodada ganha a ligação na fase `mentions`", async () => {
    await h.pool.query("update projects set key = 'ENG' where id = $1::uuid", [open()]);
    const old = await manual(5, "Antigo", "depende de ENG-101 que ainda não existe");
    await nextNumber(100);
    const runId = await begin(team(issues(4)));
    const last = await finish(runId);
    expect(last["phase"]).toBe("done");
    const rows = await byExt();
    const target = rows.get("i2")!; // número 100 = projeto Alfa, 101 = i1... a ordem é a da rodada
    const links = await q("select to_ticket_id from ticket_relations where kind = 'mentions' and from_ticket_id = $1::uuid", [old]);
    expect(links).toHaveLength(1);
    const cited = (await q("select number from tickets where id = $1::uuid", [links[0]!["to_ticket_id"]]))[0]!["number"];
    expect(cited).toBe(101);
    void target;
  });
});

describe("M1: custo por passo não cresce com o tamanho do projeto", () => {
  it("MEDE O NÚMERO DE CONSULTAS: o de cada passo é o mesmo com 10 ou 2.000 tickets, e os passos de criação não varrem description (a fase `mentions` varre descrições POR DESENHO, em lotes)", async () => {
    const measure = async (label: string, ids: string): Promise<Record<string, number>> => {
      const data = team(issues(60, (i) => ({ id: `${ids}${i}`, identifier: `ENG-${i}`, description: `texto ${i}`, ...(i === 3 ? { parent: `${ids}1` } : {}) })), { projects: [{ id: `${ids}p`, name: "P" }] });
      const world = { [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG] } };
      h.linear().use(linearImportWorld(world, data));
      const opened = await post("");
      expect(opened.status, label + JSON.stringify(opened.body)).toBe(201);
      const counts: Record<string, number> = {};
      let before = "projects";
      for (let i = 0; i < 40; i += 1) {
        const { result, queries } = await recordQueries(() => step(opened.body.id));
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        counts[`${label}:${i}`] = queries.length;
        // nos passos de CRIAÇÃO nenhuma consulta procura o texto das descrições (a trava de ADR 0046 virou só a dos pais)
        const scans = queries.filter((query) => /"description"\s+i?like\s/i.test(query.text));
        counts[`${label}:${i}:varreduras:${before === "mentions" ? "mentions" : "criacao"}`] = scans.length;
        before = result.body.phase as string;
        if (result.body.done) break;
      }
      await h.pool.query("delete from external_import_runs where project_id = $1::uuid", [open()]); // só para medir de novo no mesmo projeto
      return counts;
    };
    await linkWithData(h, put, open(), team([]));
    const small = await measure("pequeno", "a");
    // 2.000 tickets comuns, com texto que cita a chave do projeto
    await h.pool.query("insert into tickets (org_id, project_id, number, title, description, created_by_person_id) select $1, $2::uuid, 1000 + g, 'T' || g, 'cita OPEN-' || (90000 + g), $3::uuid from generate_series(1, 2000) g", [ORG, open(), admin()]);
    await nextNumber(5000);
    const big = await measure("grande", "b");
    if (process.env["L7_DEBUG"]) console.log(JSON.stringify({ small, big }));
    for (const key of Object.keys(small)) expect(big[key.replace("pequeno", "grande")], key).toBe(small[key]);
    expect(Object.keys(small).length).toBeGreaterThan(8);
    // nos passos de CRIAÇÃO (projects, issues, hierarchy) nenhuma consulta procura description por trecho
    for (const [key, value] of Object.entries(big)) if (key.endsWith(":varreduras:criacao")) expect(value, key).toBe(0);
  });
});

describe("M2/M3: o pai mudou entre os passos", () => {
  /** Roda passos até a fase `until` ser a próxima; devolve o id da rodada. */
  async function until(runId: string, phase: string): Promise<void> {
    for (let i = 0; i < 30; i += 1) {
      const current = (await q("select phase from external_import_runs where id = $1::uuid", [runId]))[0]!["phase"];
      if (current === phase) return;
      const res = await step(runId);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    throw new Error("fase não chegou");
  }
  const events = (id: string) => q("select payload from activity_events where kind = 'ticket.updated' and subject_id = $1", [id]);

  it("o destino foi concluído entre os passos: os filhos novos o reabrem, com evento automático", async () => {
    const dest = await manual(500, "Destino");
    const runId = await begin(team(issues(3)), { destinationTicketId: dest });
    await until(runId, "issues");
    await h.pool.query("update tickets set status = 'done' where id = $1::uuid", [dest]);
    await step(runId);
    expect((await q("select status from tickets where id = $1::uuid", [dest]))[0]!["status"]).toBe("todo");
    expect((await events(dest)).some((e) => (e["payload"] as { automatic?: boolean }).automatic === true)).toBe(true);
  });

  it("o ticket do projeto do Linear foi concluído entre os passos: reabre (com evento) ao ganhar filho aberto", async () => {
    const runId = await begin(team(issues(3, () => ({ project: "lp1" }))));
    await until(runId, "issues");
    const p = (await byExt()).get("lp1")!["id"] as string;
    await h.pool.query("update tickets set status = 'done' where id = $1::uuid", [p]);
    const res = await step(runId);
    expect(res.body.counts.reopened).toBe(1);
    expect((await q("select status from tickets where id = $1::uuid", [p]))[0]!["status"]).toBe("todo");
    expect((await events(p)).length).toBe(1);
    expect((await q("select applied_snapshot->>'status' s from ticket_external_refs where ticket_id = $1::uuid", [p]))[0]!["s"]).toBe("todo");
  });

  it("o ticket do projeto virou ideia: os filhos a fazer nascem nela; os outros vão ao destino e contam movedOutOfIdea", async () => {
    const runId = await begin(team(issues(4, (i) => ({ project: "lp1", state: i === 2 ? "started" : i === 3 ? "completed" : "unstarted" }))));
    await until(runId, "issues");
    const p = (await byExt()).get("lp1")!["id"] as string;
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1::uuid", [p]);
    const res = await step(runId);
    expect(res.body.counts.movedOutOfIdea).toBe(2);
    const rows = await byExt();
    expect(rows.get("i1")!["parent_id"]).toBe(p);
    expect(rows.get("i4")!["parent_id"]).toBe(p);
    expect(rows.get("i2")!["parent_id"]).toBeNull();
    expect(rows.get("i3")!["parent_id"]).toBeNull();
    expect(rows.get("i1")!["status"]).toBe("todo");
  });

  it("hierarquia: pai concluído por quem usa o TreePM entre os passos reabre com evento; pai que virou ideia só recebe filho a fazer", async () => {
    const runId = await begin(team(issues(5, (i) => ({ parent: i === 2 ? "i1" : i === 3 ? "i1" : i === 5 ? "i4" : null, state: i === 3 ? "started" : "unstarted" }))));
    await until(runId, "hierarchy");
    const rows = await byExt();
    const [i1, i4] = [rows.get("i1")!["id"] as string, rows.get("i4")!["id"] as string];
    await h.pool.query("update tickets set status = 'done' where id = $1::uuid", [i4]);
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1::uuid", [i1]);
    const res = await step(runId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await byExt();
    expect(after.get("i4")!["status"]).toBe("todo");
    expect((await events(i4)).length).toBe(1);
    expect(after.get("i5")!["parent_id"]).toBe(i4);
    expect(after.get("i2")!["parent_id"]).toBe(i1); // a fazer: entra na ideia
    expect(after.get("i3")!["parent_id"]).not.toBe(i1); // em andamento: não entra
    expect(res.body.counts.movedOutOfIdea).toBe(1);
  });

  it("concluído que a rodada criou, com cadeia de concluídos e filho aberto: reabre cada um UMA vez (reopened conta certo)", async () => {
    const data = team(issues(3, (i) => ({ parent: i === 2 ? "i1" : i === 3 ? "i2" : null, state: i === 3 ? "unstarted" : "completed" })));
    const runId = await begin(data);
    const last = await finish(runId);
    const rows = await byExt();
    expect([rows.get("i1")!["status"], rows.get("i2")!["status"], rows.get("i3")!["status"]]).toEqual(["todo", "todo", "todo"]);
    expect(last.counts!.reopened).toBe(2);
  });
});

describe("M4: issue criada durante a rodada (repescagem)", () => {
  it("volta ao começo ao esgotar o cursor e só muda de fase numa página inteira de conhecidas", async () => {
    const list = issues(60);
    let issuePages = 0;
    const asks: (string | null)[] = [];
    const data = team(list, {
      onIssuesPage: (ask) => {
        issuePages += 1;
        asks.push(ask.after);
        if (issuePages === 2) list.unshift({ id: "nova", identifier: "ENG-61", title: "Criada no meio" }); // mais nova: entra no começo da lista
      },
    });
    const runId = await begin(data);
    const last = await finish(runId);
    const rows = await byExt();
    expect(rows.has("nova")).toBe(true);
    expect(last.counts!.issuesCreated).toBe(61);
    // 1ª leitura: null, "50"; repescagem: null (com a nova), "50" (tudo conhecido) e para
    expect(asks).toEqual([null, "50", null, "50"]);
    expect((await q("select count(*)::int n from ticket_external_refs where project_id = $1::uuid and kind = 'issue'", [open()]))[0]!["n"]).toBe(61);
  });

  it("sem novidade a repescagem custa uma página e não mexe nas contagens", async () => {
    const asks: (string | null)[] = [];
    const runId = await begin(team(issues(60), { onIssuesPage: (ask) => asks.push(ask.after) }));
    const last = await finish(runId);
    expect(asks).toEqual([null, "50", null]);
    expect(last.counts).toMatchObject({ issuesSeen: 60, issuesCreated: 60, issuesExisting: 0 });
  });
});

describe("M5: endereço de origem só do Linear e curto", () => {
  it("na entrada: http, outro domínio, javascript: e mais de 500 caracteres viram nulos; o ticket não perde a chave", async () => {
    const data = team(
      issues(5, (i) => ({ url: ["https://linear.app/acme/issue/ENG-1/a", "http://linear.app/x", "https://evil.test/linear.app/", "javascript:alert(1)", `https://linear.app/${"a".repeat(500)}`][i - 1]! })),
      { projects: [{ id: "lp1", name: "Alfa", url: "https://evil.test/p" }] },
    );
    const runId = await begin(data);
    await finish(runId);
    const rows = await q("select external_id, external_url from ticket_external_refs where project_id = $1::uuid order by external_id", [open()]);
    expect(Object.fromEntries(rows.map((r) => [r["external_id"], r["external_url"]]))).toEqual({
      i1: "https://linear.app/acme/issue/ENG-1/a",
      i2: null,
      i3: null,
      i4: null,
      i5: null,
      lp1: null,
    });
    const detail = await h.call("GET", `/api/tickets/${(await byExt()).get("i2")!["id"]}`, as("admin"));
    expect(detail.body.externalSource).toEqual({ provider: "linear", key: "ENG-2", url: null });
  });

  it("na saída: um endereço ruim que já esteja no banco não sai", async () => {
    const runId = await begin(team(issues(1)));
    await finish(runId);
    const id = (await byExt()).get("i1")!["id"];
    await h.pool.query("update ticket_external_refs set external_url = 'javascript:alert(1)' where ticket_id = $1::uuid", [id]);
    expect((await h.call("GET", `/api/tickets/${id}`, as("admin"))).body.externalSource).toEqual({ provider: "linear", key: "ENG-1", url: null });
  });
});

describe("situação do projeto do Linear", () => {
  it("completed → concluído (e a fazer se tem filho aberto), canceled → cancelado, started → em andamento, o resto a fazer", async () => {
    const data = team(issues(2, (i) => ({ project: "pc", state: i === 1 ? "unstarted" : "completed" })), {
      projects: [
        { id: "pc", name: "Concluído com filho aberto", status: "completed" },
        { id: "pd", name: "Concluído vazio", status: "completed" },
        { id: "px", name: "Cancelado", status: "canceled" },
        { id: "ps", name: "Em andamento", status: "started" },
        { id: "pb", name: "Backlog", status: "backlog" },
        { id: "pz", name: "Pausado", status: "paused" },
      ],
    });
    const runId = await begin(data);
    await finish(runId);
    const rows = await byExt();
    expect(Object.fromEntries(["pc", "pd", "px", "ps", "pb", "pz"].map((id) => [id, rows.get(id)!["status"]]))).toEqual({ pc: "todo", pd: "done", px: "cancelled", ps: "in_progress", pb: "todo", pz: "todo" });
  });
});
