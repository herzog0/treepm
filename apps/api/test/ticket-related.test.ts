import { describe, expect, it } from "vitest";
import { useLinearHarness } from "./linear-support.js";
import { seedRelated } from "./related-support.js";
import { ORG, as } from "./world.js";

// "Relacionado a" (ADR 0061, fatia 3; TREEPM-478), correções R2 item 5: a rota de remoção e o teto da página do ticket.
const { h } = useLinearHarness();
type Row = Record<string, unknown>;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const open = () => h.world().projects.org;
const ticket = async (title: string): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${open()}/tickets`, as("admin"), { title });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as Row)["id"] as string;
};

describe("DELETE /api/tickets/:id/related/:ticketId", () => {
  it("o par é ordenado pelo id canônico do ticket: id em maiúsculas (dos dois lados) remove do mesmo jeito", async () => {
    const results: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const [x, y] = [await ticket(`x${i}`), await ticket(`y${i}`)];
      await seedRelated(h.pool, ORG, open(), x, y);
      const one = await h.call("DELETE", `/api/tickets/${x.toUpperCase()}/related/${y}`, as("admin"));
      await seedRelated(h.pool, ORG, open(), x, y);
      const two = await h.call("DELETE", `/api/tickets/${y.toUpperCase()}/related/${x.toUpperCase()}`, as("admin"));
      results.push(`${one.status}/${two.status}`);
    }
    expect(results).toEqual(Array.from({ length: 6 }, () => "204/204"));
    expect(await q("select count(*)::int n from ticket_relations where kind = 'related'")).toEqual([{ n: 0 }]);
  });
});

describe("página do ticket", () => {
  it("`related` tem teto de 200, como o MCP (os de menor número primeiro)", async () => {
    const hub = await ticket("hub");
    const others: string[] = [];
    for (let i = 0; i < 205; i += 1) others.push(await ticket(`t${i}`));
    for (const other of others) {
      const [from, to] = hub < other ? [hub, other] : [other, hub];
      await q("insert into ticket_relations (org_id, project_id, from_ticket_id, to_ticket_id, kind) values ($1, $2, $3, $4, 'related')", [ORG, open(), from, to]);
    }
    const res = await h.call("GET", `/api/tickets/${hub}`, as("admin"));
    expect(res.status).toBe(200);
    const related = (res.body as Row)["related"] as Row[];
    expect(related).toHaveLength(200);
    const numbers = related.map((link) => Number(String(link["key"]).split("-")[1]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    const all = (await q("select number from tickets where id = any($1::uuid[]) order by number", [others])).map((row) => row["number"] as number);
    expect(numbers).toEqual(all.slice(0, 200));
  }, 120_000);
});
