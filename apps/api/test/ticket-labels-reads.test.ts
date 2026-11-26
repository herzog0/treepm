import { describe, expect, it } from "vitest";
import { labelNameKey } from "@treepm/domain";
import { ProjectQueryService } from "../src/query/project-query.service.js";
import { useHarness } from "./harness.js";
import { recordQueries } from "./query-recorder.js";
import type { RecordedQuery } from "./query-recorder.js";
import { asService } from "./service-door.js";
import { ORG, as } from "./world.js";

// Etiquetas por projeto (ADR 0065, TREEPM-466), etapa A, leituras: `labels: {id,name,color}[]` no resumo da lista, no detalhe e no
// resumo da camada de consulta (project-query: MCP, fila, assistente), cada leitura com UMA consulta agregada às etiquetas. A guarda
// contra N+1 é a contagem de consultas: com 7 e com 47 tickets (todos etiquetados) o número de consultas é o mesmo.
const h = useHarness();
const P = () => h.world().projects.priv;

type Label = { id: string; name: string; color: string };
type Seeded = { ids: Map<number, string>; labels: { alfa: Label; beta: Label; zeta: Label } };

/** Ticket `n`: os ímpares ficam no topo; os pares são filhos do ticket 1 (o detalhe e o `ticket` da consulta crescem com o projeto). */
const parentOf = (n: number): number | null => (n % 2 === 0 ? 1 : null);
/** Etiquetas de `n`: zeta em todos, alfa nos pares, beta nos múltiplos de 3. Na saída, a ordem é a do nome (chave), não a de inserção. */
function expectedNames(n: number): string[] {
  const names = ["zeta", ...(n % 2 === 0 ? ["Alfa"] : []), ...(n % 3 === 0 ? ["beta"] : [])];
  return names.sort((a, b) => labelNameKey(a).localeCompare(labelNameKey(b)));
}

async function label(name: string, color: string): Promise<Label> {
  const r = await h.pool.query<{ id: string }>(
    "insert into project_labels (org_id, project_id, name, name_key, color) values ($1,$2,$3,$4,$5) returning id::text as id",
    [ORG, P(), name, labelNameKey(name), color],
  );
  return { id: r.rows[0]!.id, name, color };
}

/** Acrescenta os tickets `from..to` (pelo papel dono, sem passar pela API) e as etiquetas de cada um. */
async function seedTickets(seeded: Seeded, from: number, to: number): Promise<void> {
  const { people } = h.world();
  for (let n = from; n <= to; n += 1) {
    const parent = parentOf(n);
    const r = await h.pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, description, status, parent_id, created_by_person_id) values ($1,$2,$3,$4,'',$5,$6,$7) returning id",
      [ORG, P(), n, `Ticket ${n}`, "todo", parent === null ? null : seeded.ids.get(parent), people.admin],
    );
    const id = r.rows[0]!.id;
    seeded.ids.set(n, id);
    const own = [seeded.labels.zeta, ...(n % 2 === 0 ? [seeded.labels.alfa] : []), ...(n % 3 === 0 ? [seeded.labels.beta] : [])];
    for (const l of own) {
      await h.pool.query("insert into ticket_labels (org_id, project_id, ticket_id, label_id) values ($1,$2,$3,$4)", [ORG, P(), id, l.id]);
    }
  }
}

async function seed(): Promise<Seeded> {
  const seeded: Seeded = { ids: new Map(), labels: { zeta: await label("zeta", "violet"), alfa: await label("Alfa", "orange"), beta: await label("beta", "cyan") } };
  return seeded;
}

const labelQueries = (queries: readonly RecordedQuery[]): RecordedQuery[] => queries.filter((q) => /ticket_labels/.test(q.text));
const describeQueries = (queries: readonly RecordedQuery[]): string => JSON.stringify(queries.map((q) => [q.text.replace(/\s+/g, " ").slice(0, 100), q.rows]));
const names = (labels: readonly Label[] | undefined): string[] => (labels ?? []).map((l) => l.name);

/** Todas as leituras de uma rodada: as contagens de consultas e o que voltou. */
async function readAll(seeded: Seeded) {
  const root = seeded.ids.get(1)!;
  const query = h.app().get(ProjectQueryService);
  const http = (path: string) => recordQueries(async () => {
    const res = await h.call("GET", path, as("admin"));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  });
  const service = <T>(fn: Parameters<typeof asService<T>>[3]) => recordQueries(() => asService(h.app(), "admin", ORG, fn));
  return {
    list: await http(`/api/projects/${P()}/tickets`),
    detail: await http(`/api/tickets/${root}`),
    queryList: await service((tx, principal) => query.list(tx, principal, P(), { limit: 200 })),
    queryTicket: await service((tx, principal) => query.ticket(tx, principal, P(), 1)),
    queryOverview: await service((tx, principal) => query.overview(tx, principal, P())),
    querySearch: await service((tx, principal) => query.search(tx, principal, P(), "Ticket", { limit: 50 })),
    queryQueue: await service((tx, principal) => query.workQueue(tx, principal, P(), { limit: 50 })),
  };
}

describe("leituras trazem as etiquetas do ticket", () => {
  it("lista, detalhe e camada de consulta: `labels` em ordem de nome (chave), `[]` sem etiqueta", async () => {
    const seeded = await seed();
    await seedTickets(seeded, 1, 7);
    const bare = await h.pool.query<{ id: string }>(
      "insert into tickets (org_id, project_id, number, title, description, status, created_by_person_id) values ($1,$2,8,'Sem etiqueta','','todo',$3) returning id",
      [ORG, P(), h.world().people.admin],
    );
    const read = await readAll(seeded);

    const list = read.list.result as { number: number; labels: Label[] }[];
    expect(list).toHaveLength(8);
    for (const t of list) expect(names(t.labels), `lista #${t.number}`).toEqual(t.number === 8 ? [] : expectedNames(t.number));
    const six = list.find((t) => t.number === 6)!;
    expect(six.labels).toEqual([seeded.labels.alfa, seeded.labels.beta, seeded.labels.zeta]);

    expect((read.detail.result as { labels: Label[] }).labels).toEqual([seeded.labels.zeta]);
    const bareDetail = await h.call("GET", `/api/tickets/${bare.rows[0]!.id}`, as("admin"));
    expect(bareDetail.body.labels).toEqual([]);

    const qList = read.queryList.result.tickets;
    for (const t of qList) expect(names(t.labels), `consulta #${t.number}`).toEqual(t.number === 8 ? [] : expectedNames(t.number));
    expect(qList.find((t) => t.number === 6)!.labels).toEqual([seeded.labels.alfa, seeded.labels.beta, seeded.labels.zeta]);
    const qTicket = read.queryTicket.result;
    expect(qTicket.labels).toEqual([seeded.labels.zeta]);
    for (const child of qTicket.children.tickets) expect(names(child.labels), `filho #${child.number}`).toEqual(expectedNames(child.number));
    for (const top of read.queryOverview.result.top.tickets) expect(names(top.labels), `topo #${top.number}`).toEqual(top.number === 8 ? [] : expectedNames(top.number));
    expect(read.querySearch.result.tickets.length).toBeGreaterThan(0);
    for (const found of read.querySearch.result.tickets) expect(names(found.labels), `busca #${found.number}`).toEqual(found.number === 8 ? [] : expectedNames(found.number));
    expect(read.queryQueue.result.tickets.length).toBeGreaterThan(0);
    for (const queued of read.queryQueue.result.tickets) expect(names(queued.labels), `fila #${queued.number}`).toEqual(queued.number === 8 ? [] : expectedNames(queued.number));
  });
});

describe("sem N+1: o número de consultas não cresce com o número de tickets", () => {
  it("lista, detalhe e camada de consulta: mesma contagem com 7 e com 47 tickets, e UMA consulta às etiquetas por leitura", async () => {
    const seeded = await seed();
    await seedTickets(seeded, 1, 7);
    await readAll(seeded); // aquecimento: o que a primeira requisição carrega uma vez só não entra na conta
    const small = await readAll(seeded);
    await seedTickets(seeded, 8, 47);
    const big = await readAll(seeded);

    expect((big.list.result as unknown[]).length).toBe(47);
    expect(big.queryTicket.result.children.tickets.length).toBe(23);
    expect(big.queryOverview.result.top.tickets.length).toBe(24);
    const counts: Record<string, [number, number]> = {};
    for (const key of Object.keys(small) as (keyof typeof small)[]) {
      const before = small[key].queries;
      const after = big[key].queries;
      counts[key] = [before.length, after.length];
      expect(after.length, `${key}: 7 tickets ${describeQueries(before)} / 47 tickets ${describeQueries(after)}`).toBe(before.length);
      expect(labelQueries(after).length, `${key}: uma consulta às etiquetas ${describeQueries(after)}`).toBe(1);
      expect(labelQueries(before).length, `${key}: uma consulta às etiquetas ${describeQueries(before)}`).toBe(1);
    }
    // As contagens medidas (7 → 47), para o relatório.
    console.info(`contagens de consultas (7 → 47 tickets): ${JSON.stringify(counts)}`);
  });
});
