import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

// Migration 0033 (ADR 0055): conversations, conversation_participants, conversation_messages.
const ORG = "org_CONV";
const OTHER = "org_CONV_B";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let second: string;
let third: string;
let fourth: string;
let number = 100;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
  await seedOrg(owner, OTHER);
  const person = async (user: string) => (await owner.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1,$2,$2,$3,'member') returning id", [ORG, user, `${user}@x.io`])).rows[0]?.id ?? "";
  second = await person("u2");
  third = await person("u3");
  fourth = await person("u4");
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

const newTicket = async (): Promise<string> =>
  (await owner.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ($1,$2,$3,'T',$4) returning id", [ORG, ids.project, ++number, ids.person])).rows[0]?.id ?? "";

/** Uma principal (e a dona como participante), numa transação própria. */
async function principal(kind: "ticket" | "general", person: string, ticket: string | null = null): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("begin");
    await client.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, root_id) values ($1,$2,$3,$4,$5,$6,$2)", [ORG, id, kind, person, ticket ? ids.project : null, ticket]);
    await client.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, id, person]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return id;
}
const message = async (conversation: string, author: string | null, body = "oi", model: string | null = null): Promise<string> =>
  (await owner.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, author_person_id, body, model) values ($1,$2,$3,$4,$5) returning id", [ORG, conversation, author, body, model])).rows[0]?.id ?? "";

/** Abre uma thread sob `parent` (a mensagem de abertura nasce no pai) com os participantes pedidos, na mesma transação. */
async function thread(parent: string, openedBy: string, participants: string[], overrides: { depth?: number; ticket?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  const client = await owner.connect();
  try {
    await client.query("begin");
    const opening = (await client.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ($1,$2,$3,'abre') returning id", [ORG, parent, openedBy])).rows[0]?.id;
    const p = (await client.query<{ depth: number; root_id: string; project_id: string | null; ticket_id: string | null }>("select depth, root_id, project_id, ticket_id from conversations where id = $1", [parent])).rows[0]!;
    await client.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$7,$8,$9)", [ORG, id, openedBy, p.project_id, p.ticket_id, parent, p.root_id, overrides.depth ?? p.depth + 1, opening]);
    for (const person of participants) await client.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, id, person]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return id;
}
const count = async (sql: string, params: unknown[] = []): Promise<number> => (await owner.query(sql, params)).rows[0].n;

describe("conversations", () => {
  it("uma principal por pessoa e ticket; um chat geral por pessoa", async () => {
    const t = await newTicket();
    await principal("ticket", ids.person, t);
    await expect(principal("ticket", ids.person, t)).rejects.toThrow(/conversations_ticket_owner_key/);
    await expect(principal("ticket", second, t)).resolves.toBeTruthy();
    await principal("general", second);
    await expect(principal("general", second)).rejects.toThrow(/conversations_general_owner_key/);
  });

  it("a principal do ticket exige o ticket; o ticket e o projeto vêm juntos", async () => {
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, root_id) values ($1,$2,'ticket',$3,$2)", [ORG, randomUUID(), ids.person])).rejects.toThrow(/conversations_ticket_check/);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, root_id) values ($1,$2,'general',$3,$4,$2)", [ORG, randomUUID(), ids.person, ids.project])).rejects.toThrow(/conversations_ticket_check/);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, root_id) values ($1,$2,'outra',$3,$2)", [ORG, randomUUID(), ids.person])).rejects.toThrow(/conversations_kind_check/);
  });

  it("uma thread tem pai, nível e mensagem de abertura; a principal não tem", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth) values ($1,$2,'thread',$3,$4,$5,$6,$6,1)", [ORG, randomUUID(), ids.person, ids.project, t, p])).rejects.toThrow(/conversations_opening|conversations_shape_check/);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, root_id, depth) values ($1,$2,'ticket',$3,$4,$5,$2,1)", [ORG, randomUUID(), second, ids.project, t])).rejects.toThrow(/conversations_shape_check/);
  });

  it("o nível e a principal da thread seguem os do pai, e o ticket é herdado", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await expect(thread(p, ids.person, [ids.person], { depth: 3 })).rejects.toThrow(/conversations_level/);
    const g = await principal("general", third);
    // Thread do chat geral pode tratar de um ticket; a do ticket não troca de ticket.
    const other = await newTicket();
    const id = randomUUID();
    const opening = await message(p, ids.person);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$6,1,$7)", [ORG, id, ids.person, ids.project, other, p, opening])).rejects.toThrow(/conversations_ticket/);
    expect(g).toBeTruthy();
  });

  it("a mensagem de abertura mora na conversa de cima", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    const stray = await message(await principal("general", ids.person), ids.person);
    await expect(owner.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$6,1,$7)", [ORG, randomUUID(), ids.person, ids.project, t, p, stray])).rejects.toThrow(/conversations_opening/);
  });

  it("a thread do chat geral pode tratar de um ticket, e a de baixo herda o ticket dela", async () => {
    const g = await principal("general", fourth);
    const t = await newTicket();
    const client = await owner.connect();
    const id = randomUUID();
    try {
      await client.query("begin");
      const opening = (await client.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ($1,$2,$3,'abre') returning id", [ORG, g, fourth])).rows[0]?.id;
      await client.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$6,1,$7)", [ORG, id, fourth, ids.project, t, g, opening]);
      await client.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, id, fourth]);
      await client.query("commit");
    } finally {
      client.release();
    }
    const inner = await thread(id, fourth, [fourth]);
    expect((await owner.query("select ticket_id from conversations where id = $1", [inner])).rows[0].ticket_id).toBe(t);
  });

  it("uma mensagem abre no máximo uma thread", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    const opening = await message(p, ids.person);
    const client = await owner.connect();
    try {
      await client.query("begin");
      const insert = () => client.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$6,1,$7)", [ORG, randomUUID(), ids.person, ids.project, t, p, opening]);
      await insert();
      await expect(insert()).rejects.toThrow(/conversations_opening_message_key/);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("o papel da aplicação cria e só altera a atividade e a vez do assistente", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set last_activity_at = now(), turn_started_at = now() where id = ${p}::uuid`);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set owner_person_id = ${second}::uuid where id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversations set parent_id = ${p}::uuid where id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from conversations where id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
  });
});

describe("participantes e a invariante (filha inclui a conversa de cima)", () => {
  it("a principal é só da dona", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await expect(owner.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, p, second])).rejects.toThrow(/conversation_participants_principal/);
  });

  it("a thread sem a dona, ou sem alguém da conversa de cima, não fecha a transação", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await expect(thread(p, ids.person, [second])).rejects.toThrow(/conversations_owner/);
    await expect(thread(p, ids.person, [])).rejects.toThrow(/conversations_owner/);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    // Uma thread dentro de d1 sem `second` esquece alguém da conversa de cima.
    await expect(thread(d1, ids.person, [ids.person])).rejects.toThrow(/conversations_participants/);
    await expect(thread(d1, ids.person, [ids.person, second, third])).resolves.toBeTruthy();
  });

  it("quem entra numa conversa tem de entrar, na mesma transação, nas threads de dentro", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    const d2 = await thread(d1, ids.person, [ids.person, second]);
    const add = async (people: [string, string][]) => {
      const client = await owner.connect();
      try {
        await client.query("begin");
        for (const [conversation, person] of people) await client.query("insert into conversation_participants (org_id, conversation_id, person_id, added_by_person_id) values ($1,$2,$3,$4)", [ORG, conversation, person, ids.person]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    };
    await expect(add([[d1, third]])).rejects.toThrow(/conversation_participants_descendants/);
    await expect(add([[d1, third], [d2, third]])).resolves.toBeUndefined();
    expect(await count("select count(*)::int as n from conversation_participants where person_id = $1 and conversation_id = any($2)", [third, [d1, d2]])).toBe(2);
  });

  it("o papel da aplicação só entra como participante e muda o ponto de leitura; nunca apaga nem muda a pessoa", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversation_participants set last_read_seq = 7 where conversation_id = ${p}::uuid`);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversation_participants set person_id = ${second}::uuid where conversation_id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from conversation_participants where conversation_id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
    await expect(owner.query("update conversation_participants set last_read_seq = -1 where conversation_id = $1", [p])).rejects.toThrow(/conversation_participants_read_check/);
  });
});

describe("conversation_messages", () => {
  it("a conversa com o assistente: pessoa (da dona), assistente (com modelo)", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await message(p, ids.person, "pergunta");
    await message(p, null, "resposta", "claude-opus-5-5");
  });

  it("quem escreve participa da conversa; o assistente não fala numa thread", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await expect(message(p, second)).rejects.toThrow(/conversation_messages_author/);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    await expect(message(d1, third)).rejects.toThrow(/conversation_messages_author/);
    await expect(message(d1, null, "x", "m")).rejects.toThrow(/conversation_messages_author/);
    await expect(message(d1, second, "oi")).resolves.toBeTruthy();
  });

  it("tamanho: pessoa até 4.000, assistente até 8.000, nunca vazio; modelo só no assistente", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await message(p, ids.person, "a".repeat(4000));
    await expect(message(p, ids.person, "a".repeat(4001))).rejects.toThrow(/conversation_messages_body_check/);
    await message(p, null, "a".repeat(8000), "m");
    await expect(message(p, null, "a".repeat(8001), "m")).rejects.toThrow(/conversation_messages_body_check/);
    await expect(message(p, ids.person, "")).rejects.toThrow(/conversation_messages_body_check/);
    await expect(message(p, ids.person, "x", "claude")).rejects.toThrow(/conversation_messages_model_check/);
  });

  it("seq só cresce, inclusive entre duas mensagens da mesma transação, e não pode ser escolhido", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    const rows = await asTenant(prisma, ORG, async (tx) => {
      await tx.$executeRaw`insert into conversation_messages (org_id, conversation_id, author_person_id, body) values (${ORG}, ${p}::uuid, ${ids.person}::uuid, 'a')`;
      await tx.$executeRaw`insert into conversation_messages (org_id, conversation_id, body, model) values (${ORG}, ${p}::uuid, 'b', 'm')`;
      return tx.$queryRaw<{ seq: bigint; created_at: Date }[]>`select seq, created_at from conversation_messages where conversation_id = ${p}::uuid order by seq`;
    });
    expect(rows[1]!.seq > rows[0]!.seq).toBe(true);
    expect(rows[1]!.created_at.getTime()).toBe(rows[0]!.created_at.getTime());
    await expect(owner.query("insert into conversation_messages (org_id, seq, conversation_id, author_person_id, body) values ($1,1,$2,$3,'x')", [ORG, p, ids.person])).rejects.toThrow(/non-DEFAULT/);
  });

  it("o papel da aplicação lê e insere; só apaga mensagem de conversa principal, nunca a de thread nem a de abertura; nunca edita", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await message(p, ids.person, "pergunta");
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update conversation_messages set body = 'editada' where conversation_id = ${p}::uuid`)).rejects.toThrow(/permission denied/);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    await message(d1, second, "resposta");
    // A de abertura mora na principal: a chave da thread impede apagar (no fim da transação).
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from conversation_messages where conversation_id = ${p}::uuid`)).rejects.toThrow(/ForeignKeyConstraintViolation|conversations_opening_message_fkey/);
    expect(await asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from conversation_messages where conversation_id = ${d1}::uuid`)).toBe(0);
    expect(await asTenant(prisma, ORG, (tx) => tx.$executeRaw`delete from conversation_messages where conversation_id = ${p}::uuid and body = 'pergunta'`)).toBe(1);
    expect(await count("select count(*)::int as n from conversation_messages where conversation_id = $1", [d1])).toBe(1);
  });

  it("remover o ticket leva conversas, threads, mensagens (inclusive as de abertura) e participantes", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await message(p, ids.person);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    await message(d1, second);
    await thread(d1, ids.person, [ids.person, second]);
    await owner.query("delete from tickets where id = $1", [t]);
    expect(await count("select count(*)::int as n from conversations where ticket_id = $1", [t])).toBe(0);
    expect(await count("select count(*)::int as n from conversation_messages where conversation_id = any($1)", [[p, d1]])).toBe(0);
    expect(await count("select count(*)::int as n from conversation_participants where conversation_id = any($1)", [[p, d1]])).toBe(0);
  });

  it("a pessoa que escreveu não se apaga (a autoria sobrevive)", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    const d1 = await thread(p, ids.person, [ids.person, second]);
    await message(d1, second, "dela");
    await expect(owner.query("delete from people where id = $1", [second])).rejects.toThrow(/conversation_messages_author_fkey/);
  });
});

describe("isolamento por organização", () => {
  it("outra organização não vê nada, nem escreve", async () => {
    const t = await newTicket();
    const p = await principal("ticket", ids.person, t);
    await message(p, ids.person);
    for (const table of ["conversations", "conversation_participants", "conversation_messages"]) {
      const n = await asTenant(prisma, OTHER, (tx) => tx.$queryRawUnsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`));
      expect(n[0]?.n, table).toBe(0);
    }
    const id = randomUUID();
    await expect(asTenant(prisma, OTHER, (tx) => tx.$executeRaw`insert into conversations (org_id, id, kind, owner_person_id, root_id) values (${ORG}, ${id}::uuid, 'general', ${ids.person}::uuid, ${id}::uuid)`)).rejects.toThrow(/row-level security/);
  });
});

describe("ticket_assignees: índice por pessoa (a lista de conversas)", () => {
  it("existe o índice (org_id, person_id, ticket_id)", async () => {
    const r = await owner.query("select 1 from pg_indexes where tablename = 'ticket_assignees' and indexname = 'ticket_assignees_org_id_person_id_ticket_id_idx'");
    expect(r.rowCount).toBe(1);
  });
});

describe("Revisão 1: teto técnico de 40 níveis", () => {
  it("o banco aceita até o nível 40 e recusa o 41", async () => {
    const t = await newTicket();
    let current = await principal("ticket", ids.person, t);
    for (let level = 1; level <= 40; level += 1) current = await thread(current, ids.person, [ids.person]);
    expect((await owner.query("select depth from conversations where id = $1", [current])).rows[0].depth).toBe(40);
    await expect(thread(current, ids.person, [ids.person])).rejects.toThrow(/conversations_depth_check/);
  });
});

describe("Revisão 1: a invariante sob concorrência (duas transações de verdade)", () => {
  const violations = async () => (await owner.query("select c.id from conversations c join conversation_participants up on up.conversation_id = c.parent_id where not exists (select 1 from conversation_participants me where me.conversation_id = c.id and me.person_id = up.person_id)")).rows;

  /** A abre uma thread sob `under` e fica aberta; B inclui `person` em `into` ao mesmo tempo; depois A fecha e B tenta fechar. */
  async function race(under: string, into: string, person: string) {
    const a = await owner.connect();
    const b = await owner.connect();
    const outcome: string[] = [];
    try {
      await a.query("begin");
      await b.query("begin");
      const opening = (await a.query<{ id: string }>("insert into conversation_messages (org_id, conversation_id, author_person_id, body) values ($1,$2,$3,'abre') returning id", [ORG, under, ids.person])).rows[0]?.id;
      const p = (await a.query<{ depth: number; root_id: string; project_id: string; ticket_id: string }>("select depth, root_id, project_id, ticket_id from conversations where id = $1", [under])).rows[0]!;
      const child = randomUUID();
      await a.query("insert into conversations (org_id, id, kind, owner_person_id, project_id, ticket_id, parent_id, root_id, depth, opening_message_id) values ($1,$2,'thread',$3,$4,$5,$6,$7,$8,$9)", [ORG, child, ids.person, p.project_id, p.ticket_id, under, p.root_id, p.depth + 1, opening]);
      const members = (await a.query<{ person_id: string }>("select person_id from conversation_participants where conversation_id = $1", [under])).rows.map((r) => r.person_id);
      for (const m of new Set([ids.person, ...members])) await a.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, child, m]);
      // B tenta entrar na conversa ao mesmo tempo: com a raiz travada, espera A terminar.
      const bInsert = b.query("insert into conversation_participants (org_id, conversation_id, person_id) values ($1,$2,$3)", [ORG, into, person]).then(() => "b-inserted", (e: Error) => `b-failed:${e.message}`);
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");
      outcome.push(await bInsert);
      await b.query("commit").then(() => outcome.push("b-committed"), (e: Error) => outcome.push(`b-commit-failed:${e.message}`));
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
    return outcome;
  }

  it("mesmo ramo: abrir thread e incluir pessoa na mesma conversa nunca deixam a invariante quebrada", async () => {
    const t = await newTicket();
    const d1 = await thread(await principal("ticket", ids.person, t), ids.person, [ids.person, second]);
    const outcome = await race(d1, d1, third);
    expect(outcome.join()).toMatch(/b-commit-failed|b-failed/);
    expect(await violations()).toEqual([]);
  });

  it("ramos diferentes da mesma árvore: também serializados pela raiz", async () => {
    const t = await newTicket();
    const main = await principal("ticket", ids.person, t);
    const d1 = await thread(main, ids.person, [ids.person, second]);
    const d2 = await thread(main, ids.person, [ids.person, second]);
    await race(d1, d2, third);
    expect(await violations()).toEqual([]);
  });
});
