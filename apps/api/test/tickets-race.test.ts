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
async function race(owner: string[], api: () => Promise<{ status: number; body: { error?: { code: string; message: string; details?: unknown } } }>) {
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

const childInsert = (parent: string, number: number, status = "todo") =>
  `insert into tickets (org_id, project_id, number, parent_id, status, title, created_by_person_id)
   values ('org_A', '${P()}', ${number}, '${parent}', '${status}', 'filho', '${h.world().people.admin}')`;

describe("corrida na regra do pai: sem 500 e sem vazar o banco", () => {
  const noLeak = (res: { body: { error?: { message: string } } }) => {
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/violates|constraint|foreign key|tickets_org_id/i);
  };

  it("criar sob um pai removido por outra transação: 404, sem vazar o banco", async () => {
    const g = await make({});
    const res = await race([`delete from tickets where id = '${g}'`], () =>
      h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "x", parentId: g }),
    );
    expect(res.status).toBe(404);
    noLeak(res);
  });

  it("mover para um pai removido por outra transação: 404", async () => {
    const g = await make({});
    const t = await make({});
    const res = await race([`delete from tickets where id = '${g}'`], () => h.call("PATCH", `/api/tickets/${t}`, as("admin"), { parentId: g }));
    expect(res.status).toBe(404);
    noLeak(res);
  });

  it("importar sob um pai removido por outra transação: 404", async () => {
    const g = await make({});
    const res = await race([`delete from tickets where id = '${g}'`], () =>
      h.call("POST", `/api/projects/${P()}/tickets/import`, as("admin"), { parentId: g, items: [{ title: "x" }] }),
    );
    expect(res.status).toBe(404);
    noLeak(res);
  });

  it("remover um ticket que ganhou filho: 409 ticket_has_children", async () => {
    const g = await make({});
    const res = await race([childInsert(g, 901)], () => h.call("DELETE", `/api/tickets/${g}`, as("admin")));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("ticket_has_children");
    noLeak(res);
  });
});

describe("concluir × criar filho aberto, ao mesmo tempo", () => {
  it("o filho aberto é criado (e ainda não confirmado) quando o pai é concluído: a conclusão espera e é recusada", async () => {
    const parent = await make({});
    const res = await race([childInsert(parent, 902)], () => h.call("PATCH", `/api/tickets/${parent}`, as("admin"), { status: "done" }));
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("ticket_has_open_children");
    expect(res.body.error?.details).toEqual({ openChildCount: 1 });
    expect((await h.call("GET", `/api/tickets/${parent}`, as("admin"))).body.status).toBe("todo");
  });

  it("o pai é concluído primeiro (transação aberta): o filho aberto criado depois entra e o pai é reaberto (ADR 0034, J1b)", async () => {
    const parent = await make({});
    const client = await h.pool.connect();
    try {
      await client.query("begin");
      await client.query(`select id from tickets where id = '${parent}' for update`);
      await client.query(`update tickets set status = 'done' where id = '${parent}'`);
      const pending = h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "filho", parentId: parent }).then((r) => r);
      await wait(400);
      await client.query("commit");
      const res = await pending;
      expect(res.status).toBe(201);
    } finally {
      client.release();
    }
    expect((await h.call("GET", `/api/tickets/${parent}`, as("admin"))).body.status).toBe("todo");
  });
});
