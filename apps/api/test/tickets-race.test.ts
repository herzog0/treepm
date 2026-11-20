import { describe, expect, it } from "vitest";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

const h = useHarness();
const P = () => h.world().projects.priv;
const make = async (body: Record<string, unknown>): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "Nó", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Corrida real entre duas transações: o dono abre uma transação, muda o banco e a segura; a requisição da API passa
 * pelas conferências (que enxergam o estado antigo), bate no bloqueio da chave estrangeira e só falha depois do
 * `commit` do dono.
 */
async function race(owner: string[], api: () => Promise<{ status: number; body: { error?: { code: string; message: string } } }>) {
  const client = await h.pool.connect();
  try {
    await client.query("begin");
    for (const sql of owner) await client.query(sql);
    const pending = api().then((r) => r); // `.then` dispara o pedido agora (o supertest é preguiçoso)
    await wait(400);
    await client.query("commit");
    return await pending;
  } finally {
    client.release();
  }
}

const becomeTicket = (id: string) => `update tickets set kind = 'ticket' where id = '${id}'`;

describe("corrida na regra do pai: 409 em vez de 500, sem vazar o banco", () => {
  const noLeak = (res: { body: { error?: { message: string } } }) => {
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/violates|constraint|foreign key|tickets_org_id/i);
  };

  it("criar sob um agrupador que virou ticket: 409 parent_not_group", async () => {
    const g = await make({ kind: "group" });
    const res = await race([becomeTicket(g)], () => h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "x", parentId: g }));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("parent_not_group");
    noLeak(res);
  });

  it("mover para um agrupador que virou ticket: 409 parent_not_group", async () => {
    const g = await make({ kind: "group" });
    const t = await make({});
    const res = await race([becomeTicket(g)], () => h.call("PATCH", `/api/tickets/${t}`, as("admin"), { parentId: g }));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("parent_not_group");
    noLeak(res);
  });

  it("importar sob um agrupador que virou ticket: 409 parent_not_group", async () => {
    const g = await make({ kind: "group" });
    const res = await race([becomeTicket(g)], () =>
      h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { parentId: g, items: [{ title: "x" }] }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("parent_not_group");
    noLeak(res);
  });

  it("transformar em ticket um agrupador que ganhou filho: 409 ticket_has_children", async () => {
    const g = await make({ kind: "group" });
    const insert = `insert into tickets (org_id, project_id, number, parent_id, parent_kind, title, created_by_person_id)
      values ('org_A', '${P()}', 900, '${g}', 'group', 'filho', '${h.world().people.admin}')`;
    const res = await race([insert], () => h.call("PATCH", `/api/tickets/${g}`, as("admin"), { kind: "ticket" }));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("ticket_has_children");
    noLeak(res);
    expect((await h.call("GET", `/api/tickets/${g}`, as("admin"))).body.kind).toBe("group");
  });

  it("remover um agrupador que ganhou filho: 409 ticket_has_children", async () => {
    const g = await make({ kind: "group" });
    const insert = `insert into tickets (org_id, project_id, number, parent_id, parent_kind, title, created_by_person_id)
      values ('org_A', '${P()}', 901, '${g}', 'group', 'filho', '${h.world().people.admin}')`;
    const res = await race([insert], () => h.call("DELETE", `/api/tickets/${g}`, as("admin")));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("ticket_has_children");
  });
});
