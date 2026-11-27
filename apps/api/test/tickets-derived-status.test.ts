import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

/** ADR 0068, seção 2: a situação de um ticket com filhos (sem contar ideias) é calculada a partir deles e gravada na mesma transação. */
const h = useHarness();
type Body = Record<string, unknown>;
const P = () => h.world().projects.priv;
const made = async (body: Body = {}): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};
const patch = (id: string, body: Body) => h.call("PATCH", `/api/tickets/${id}`, as("admin"), body);
const ok = async (id: string, body: Body) => {
  const res = await patch(id, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res;
};
const status = async (id: string) => (await h.call("GET", `/api/tickets/${id}`, as("admin"))).body.status as string;
const version = async () => BigInt((await h.pool.query("select tickets_version from projects where id = $1", [P()])).rows[0].tickets_version);
const autoEvents = async (subject: string) =>
  (await h.pool.query("select payload from activity_events where kind = 'ticket.updated' and subject_id = $1 and payload->>'automatic' = 'true' order by occurred_at, id", [subject])).rows.map((row) => row.payload);

describe("a situação do pai sai dos filhos", () => {
  it("segue a tabela da ADR: a fazer, em andamento, concluído, cancelado", async () => {
    const p = await made();
    const a = await made({ parentId: p });
    const b = await made({ parentId: p });
    expect(await status(p)).toBe("todo");
    await ok(a, { status: "in_review" });
    expect(await status(p)).toBe("in_progress");
    await ok(a, { status: "done" });
    expect(await status(p)).toBe("in_progress");
    await ok(b, { status: "cancelled" });
    expect(await status(p)).toBe("done");
    await ok(a, { status: "cancelled" });
    expect(await status(p)).toBe("cancelled");
    await ok(a, { status: "todo" });
    expect(await status(p)).toBe("todo");
  });

  it("sobe pelos ancestrais até a raiz, com um evento automático por ticket que mudou", async () => {
    const a = await made();
    const b = await made({ parentId: a });
    const c = await made({ parentId: b });
    const res = await ok(c, { status: "done" });
    expect(await status(b)).toBe("done");
    expect(await status(a)).toBe("done");
    expect(res.body.status).toBe("done");
    const [event] = await autoEvents(a);
    expect(event).toMatchObject({ fields: ["status"], status: { from: "todo", to: "done" }, automatic: true });
    expect(event.causedBy).toMatch(/-\d+$/);
  });

  it("muda a versão do projeto quando um ancestral muda", async () => {
    const p = await made();
    const kid = await made({ parentId: p });
    const before = await version();
    await ok(kid, { status: "in_progress" });
    expect(await version()).toBeGreaterThan(before);
  });
});

describe("mudar à mão a situação de um pai é recusado", () => {
  it("409 status_is_derived, e nada muda", async () => {
    const p = await made();
    await made({ parentId: p });
    const res = await patch(p, { status: "done" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("status_is_derived");
    expect(await status(p)).toBe("todo");
  });

  it("mandar a mesma situação que o pai já tem não é mudança: 200", async () => {
    const p = await made();
    await made({ parentId: p });
    expect((await patch(p, { status: "todo", title: "Outro" })).status).toBe(200);
  });
});

describe("ganhar e perder filhos", () => {
  it("o primeiro filho torna a situação calculada na hora: o pai concluído com um filho novo a fazer fica a fazer", async () => {
    const p = await made();
    await ok(p, { status: "done" });
    const kid = await made({ parentId: p });
    expect(await status(p)).toBe("todo");
    expect((await autoEvents(p)).at(-1)).toMatchObject({ status: { from: "done", to: "todo" }, automatic: true });
    await ok(kid, { status: "done" });
    expect(await status(p)).toBe("done");
  });

  it("perder o último filho guarda a última situação, e ela volta a ser marcada à mão", async () => {
    const p = await made();
    const kid = await made({ parentId: p });
    await ok(kid, { status: "in_progress" });
    expect((await h.call("DELETE", `/api/tickets/${kid}`, as("admin"))).status).toBe(204);
    expect(await status(p)).toBe("in_progress");
    expect((await patch(p, { status: "done" })).status).toBe(200);
  });

  it("remover um filho refaz o pai com os que ficaram", async () => {
    const p = await made();
    const a = await made({ parentId: p });
    const b = await made({ parentId: p });
    await ok(a, { status: "done" });
    expect(await status(p)).toBe("in_progress");
    expect((await h.call("DELETE", `/api/tickets/${b}`, as("admin"))).status).toBe(204);
    expect(await status(p)).toBe("done");
  });

  it("mover refaz o pai antigo e o novo, até a raiz", async () => {
    const from = await made();
    const stay = await made({ parentId: from });
    const go = await made({ parentId: from });
    await ok(stay, { status: "done" });
    await ok(go, { status: "in_progress" });
    const top = await made();
    const to = await made({ parentId: top });
    await made({ parentId: to });
    expect(await status(from)).toBe("in_progress");
    await ok(go, { parentId: to });
    expect(await status(from)).toBe("done");
    expect(await status(to)).toBe("in_progress");
    expect(await status(top)).toBe("in_progress");
  });

  it("o mesmo PATCH que muda pai e situação usa a situação final no pai novo", async () => {
    const to = await made();
    await made({ parentId: to, status: "done" });
    const t = await made();
    await ok(t, { parentId: to, status: "done" });
    expect(await status(to)).toBe("done");
  });
});

describe("efeitos de concluir por cálculo", () => {
  it("o pai concluído pela conta perde o marcador de trabalho pela IA, como na conclusão à mão", async () => {
    const p = await made();
    const kid = await made({ parentId: p });
    await h.pool.query("update tickets set agent_work_started_at = now(), agent_work_until = now() + interval '1 hour', agent_work_person_id = $2, agent_work_note = 'x' where id = $1", [p, h.world().people.admin]);
    await ok(kid, { status: "done" });
    const row = (await h.pool.query("select status, agent_work_until from tickets where id = $1", [p])).rows[0];
    expect(row).toEqual({ status: "done", agent_work_until: null });
  });
});

describe("importação por lista", () => {
  it("item com filhos ignora a situação que veio e nasce com a dos filhos; o pai existente é refeito", async () => {
    const dest = await made();
    await ok(dest, { status: "done" });
    const res = await h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), {
      parentId: dest,
      items: [{ title: "pai", status: "done", children: [{ title: "a", status: "in_review" }, { title: "b", status: "cancelled" }] }, { title: "c", status: "cancelled" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.map((row: { status: string }) => row.status)).toEqual(["in_progress", "in_review", "cancelled", "cancelled"]);
    expect(await status(dest)).toBe("in_progress");
  });
});

describe("ideias", () => {
  it("filho que é ideia não conta; aceitar a ideia faz ela contar", async () => {
    const p = await made();
    const done = await made({ parentId: p });
    await ok(done, { status: "done" });
    const idea = await made({ parentId: p, idea: true });
    expect(await status(p)).toBe("done");
    expect((await h.call("POST", `/api/tickets/${idea}/idea/accept`, as("admin"))).status).toBe(200);
    expect(await status(p)).toBe("in_progress");
  });

  it("aceitar refaz os pais de dentro da ideia, parados até então", async () => {
    const root = await made({ idea: true });
    const inner = await made({ parentId: root });
    await h.pool.query("insert into tickets (org_id, project_id, number, parent_id, status, title, created_by_person_id) values ('org_A', $1, 9001, $2, 'cancelled', 'cancelado', $3)", [P(), inner, h.world().people.admin]);
    expect(await status(inner)).toBe("todo");
    expect((await h.call("POST", `/api/tickets/${root}/idea/accept`, as("admin"))).status).toBe(200);
    expect(await status(inner)).toBe("cancelled");
    expect(await status(root)).toBe("cancelled");
  });

  it("transformar o único filho em ideia: o pai guarda a última situação e volta a ser marcado à mão", async () => {
    const p = await made();
    const kid = await made({ parentId: p });
    expect((await h.call("POST", `/api/tickets/${kid}/idea`, as("admin"))).status).toBe(200);
    expect(await status(p)).toBe("todo");
    expect((await patch(p, { status: "in_progress" })).status).toBe(200);
  });
});

describe("corrida entre irmãos (a mudança só de situação não pega a trava de estrutura)", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("os filhos são lidos depois de travar o pai: a mudança de um irmão confirmada durante a espera entra na conta", async () => {
    const p = await made();
    const a = await made({ parentId: p });
    const b = await made({ parentId: p });
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from tickets where id = $1 for update", [p]);
      const pending = patch(a, { status: "done" }).then((r) => r);
      await wait(300);
      await client.query("update tickets set status = 'done' where id = $1", [b]);
      await client.query("commit");
      expect((await pending).status).toBe(200);
    } finally {
      client.release();
    }
    expect(await status(p)).toBe("done");
  });

  it("irmãos concluídos ao mesmo tempo, em vários níveis: nenhum 409, e a árvore termina concluída", async () => {
    const top = await made();
    const mids = [await made({ parentId: top }), await made({ parentId: top })];
    const leaves: string[] = [];
    for (const mid of mids) for (let i = 0; i < 3; i++) leaves.push(await made({ parentId: mid }));
    const results = await Promise.all(leaves.map((leaf) => patch(leaf, { status: "done" })));
    expect(results.map((r) => r.status)).toEqual(leaves.map(() => 200));
    for (const mid of mids) expect(await status(mid)).toBe("done");
    expect(await status(top)).toBe("done");
  });
});
