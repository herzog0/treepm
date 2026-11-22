import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appPrisma, asTenant, ownerPool, seedOrg } from "./helpers.js";
import type { Ids } from "./helpers.js";
import type { PrismaClient } from "../src/index.js";

const ORG = "org_AW";
let owner: pg.Pool;
let prisma: PrismaClient;
let ids: Ids;
let counter = 900;

beforeAll(async () => {
  owner = ownerPool();
  prisma = appPrisma();
  ids = await seedOrg(owner, ORG);
});
afterAll(async () => {
  await prisma.$disconnect();
  await owner.end();
});

/** Um ticket; `marker` preenche as quatro colunas do marcador (ou parte delas, para testar o check). */
async function ticket(marker: Partial<{ started: string | null; until: string | null; person: string | null; note: string | null }> = {}): Promise<string> {
  const number = ++counter;
  const m = { started: null, until: null, person: null, note: null, ...marker };
  return asTenant(prisma, ORG, async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      insert into tickets (org_id, project_id, number, title, created_by_person_id,
                           agent_work_started_at, agent_work_until, agent_work_person_id, agent_work_note)
      values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${ids.person}::uuid,
              ${m.started}::timestamptz, ${m.until}::timestamptz, ${m.person}::uuid, ${m.note})
      returning id`;
    return rows[0]?.id ?? "";
  });
}

const NOW = "2026-11-22T12:00:00Z";
const LATER = "2026-11-22T13:00:00Z";

describe("tickets.agent_work_* (migration 0019)", () => {
  it("ticket sem marcador: as quatro colunas ficam nulas", async () => {
    const id = await ticket();
    const r = await owner.query("select agent_work_started_at, agent_work_until, agent_work_person_id, agent_work_note from tickets where id = $1", [id]);
    expect(Object.values(r.rows[0])).toEqual([null, null, null, null]);
  });

  it("aceita as quatro juntas, com nota vazia", async () => {
    const id = await ticket({ started: NOW, until: LATER, person: ids.person, note: "" });
    const r = await owner.query("select agent_work_note from tickets where id = $1", [id]);
    expect(r.rows[0].agent_work_note).toBe("");
  });

  it.each([
    ["só o início", { started: NOW }],
    ["só o fim", { until: LATER }],
    ["sem a pessoa", { started: NOW, until: LATER, note: "" }],
    ["sem a nota", { started: NOW, until: LATER, person: "PERSON" }],
    ["só a nota", { note: "oi" }],
  ])("recusa o marcador incompleto: %s", async (_name, marker) => {
    const filled = { ...marker } as Record<string, string>;
    if (filled["person"] === "PERSON") filled["person"] = ids.person;
    await expect(ticket(filled)).rejects.toThrow(/tickets_agent_work_together_check/);
  });

  it("a nota tem no máximo 200 caracteres", async () => {
    await expect(ticket({ started: NOW, until: LATER, person: ids.person, note: "a".repeat(201) })).rejects.toThrow(/tickets_agent_work_note_check/);
    await expect(ticket({ started: NOW, until: LATER, person: ids.person, note: "a".repeat(200) })).resolves.toBeTruthy();
  });

  it("o fim é depois do início", async () => {
    await expect(ticket({ started: LATER, until: NOW, person: ids.person, note: "" })).rejects.toThrow(/tickets_agent_work_window_check/);
  });

  it("a pessoa do marcador precisa existir na organização (referência composta, RESTRICT)", async () => {
    await expect(ticket({ started: NOW, until: LATER, person: "00000000-0000-7000-8000-000000000000", note: "" })).rejects.toThrow(/tickets_org_id_agent_work_person_id_fkey/);
    const id = await ticket({ started: NOW, until: LATER, person: ids.person, note: "" });
    expect(id).toBeTruthy();
    await expect(owner.query("delete from people where org_id = $1 and id = $2", [ORG, ids.person])).rejects.toThrow(/violates foreign key/);
  });

  it.each(["done", "cancelled"])("ticket %s não tem marcador: nasce e é atualizado sem ele, e a combinação é recusada pelo banco", async (status) => {
    const insertWith = async (st: string, withMarker: boolean) => {
      const number = ++counter;
      return asTenant(prisma, ORG, (tx) =>
        withMarker
          ? tx.$executeRaw`insert into tickets (org_id, project_id, number, title, status, created_by_person_id, agent_work_started_at, agent_work_until, agent_work_person_id, agent_work_note)
              values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${st}, ${ids.person}::uuid, ${NOW}::timestamptz, ${LATER}::timestamptz, ${ids.person}::uuid, '')`
          : tx.$executeRaw`insert into tickets (org_id, project_id, number, title, status, created_by_person_id) values (${ORG}, ${ids.project}::uuid, ${number}, 'T', ${st}, ${ids.person}::uuid)`,
      );
    };
    await expect(insertWith(status, true)).rejects.toThrow(/tickets_agent_work_not_finished_check/);
    await expect(insertWith(status, false)).resolves.toBe(1);
    await expect(insertWith("in_progress", true)).resolves.toBe(1);
    // concluir ou cancelar um ticket que ainda tem o marcador, sem limpá-lo na mesma instrução, é recusado
    const id = await ticket({ started: NOW, until: LATER, person: ids.person, note: "" });
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update tickets set status = ${status} where id = ${id}::uuid`)).rejects.toThrow(/tickets_agent_work_not_finished_check/);
    await asTenant(prisma, ORG, (tx) =>
      tx.$executeRaw`update tickets set status = ${status}, agent_work_started_at = null, agent_work_until = null, agent_work_person_id = null, agent_work_note = null where id = ${id}::uuid`,
    );
    expect((await owner.query("select status from tickets where id = $1", [id])).rows[0].status).toBe(status);
  });

  it("o papel da aplicação liga e desliga o marcador (concessão da tabela inteira)", async () => {
    const id = await ticket();
    await asTenant(prisma, ORG, (tx) =>
      tx.$executeRaw`update tickets set agent_work_started_at = ${NOW}::timestamptz, agent_work_until = ${LATER}::timestamptz, agent_work_person_id = ${ids.person}::uuid, agent_work_note = 'x' where id = ${id}::uuid`,
    );
    await asTenant(prisma, ORG, (tx) =>
      tx.$executeRaw`update tickets set agent_work_started_at = null, agent_work_until = null, agent_work_person_id = null, agent_work_note = null where id = ${id}::uuid`,
    );
    const r = await owner.query("select agent_work_until from tickets where id = $1", [id]);
    expect(r.rows[0].agent_work_until).toBeNull();
  });
});

describe("access_tokens.scope (migration 0019)", () => {
  const insert = (scope?: string) =>
    asTenant(prisma, ORG, async (tx) => {
      const hash = `h${Math.random().toString(36).slice(2)}${Date.now()}`;
      const rows = scope === undefined
        ? await tx.$queryRaw<{ scope: string }[]>`
            insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at)
            values (${ORG}, ${ids.person}::uuid, ${ids.project}::uuid, 'n', 'abcd1234', ${hash}, now() + interval '1 day') returning scope`
        : await tx.$queryRaw<{ scope: string }[]>`
            insert into access_tokens (org_id, person_id, project_id, name, token_prefix, token_hash, expires_at, scope)
            values (${ORG}, ${ids.person}::uuid, ${ids.project}::uuid, 'n', 'abcd1234', ${hash}, now() + interval '1 day', ${scope}) returning scope`;
      return rows[0]?.scope;
    });

  it("o padrão é read; write e read são aceitos; outro valor é recusado", async () => {
    await expect(insert()).resolves.toBe("read");
    await expect(insert("read")).resolves.toBe("read");
    await expect(insert("write")).resolves.toBe("write");
    await expect(insert("admin")).rejects.toThrow(/access_tokens_scope_check/);
  });

  it("um token que já existia antes da migration fica read (o padrão preenche as linhas antigas)", async () => {
    const r = await owner.query("select column_default, is_nullable from information_schema.columns where table_name = 'access_tokens' and column_name = 'scope'");
    expect(r.rows[0]).toMatchObject({ column_default: "'read'::text", is_nullable: "NO" });
  });
});

describe("organizations.mcp_write_enabled (migration 0019)", () => {
  it("nasce desligada", async () => {
    const r = await owner.query("select mcp_write_enabled from organizations where org_id = $1", [ORG]);
    expect(r.rows[0].mcp_write_enabled).toBe(false);
  });
});

describe("ticket_comments.via (migration 0019)", () => {
  async function comment(via: string | null): Promise<string> {
    const t = await ticket();
    return asTenant(prisma, ORG, async (tx) => {
      const rows = await tx.$queryRaw<{ via: string | null }[]>`
        insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, via)
        values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${ids.person}::uuid, 'oi', ${via}) returning via`;
      return rows[0]?.via ?? "(nulo)";
    });
  }

  it("aceita nulo e mcp; recusa outro valor", async () => {
    await expect(comment(null)).resolves.toBe("(nulo)");
    await expect(comment("mcp")).resolves.toBe("mcp");
    await expect(comment("web")).rejects.toThrow(/ticket_comments_via_check/);
  });

  it("o papel da aplicação não consegue mudar o via depois de gravado", async () => {
    const t = await ticket();
    const id = await asTenant(prisma, ORG, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, via)
        values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${ids.person}::uuid, 'oi', 'mcp') returning id`;
      return rows[0]?.id ?? "";
    });
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_comments set via = null where id = ${id}::uuid`)).rejects.toThrow(/permission denied/);
  });
});

describe("ticket_comments.request_token_id e request_id (migration 0019, idempotência do add_comment)", () => {
  const TOKEN = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0001";
  async function comment(token: string | null, requestId: string | null): Promise<string> {
    const t = await ticket();
    return asTenant(prisma, ORG, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body, request_token_id, request_id)
        values (${ORG}, ${ids.project}::uuid, ${t}::uuid, ${ids.person}::uuid, 'oi', ${token}::uuid, ${requestId}) returning id`;
      return rows[0]?.id ?? "";
    });
  }

  it("comentário comum fica sem as duas colunas", async () => {
    const id = await comment(null, null);
    const r = await owner.query("select request_token_id, request_id from ticket_comments where id = $1", [id]);
    expect(Object.values(r.rows[0])).toEqual([null, null]);
  });

  it("aceita as duas juntas, com 8 a 64 letras, números, - e _", async () => {
    await expect(comment(TOKEN, "abcd-EFG_12")).resolves.toBeTruthy();
    await expect(comment(TOKEN, "a".repeat(8))).resolves.toBeTruthy();
    await expect(comment(TOKEN, "a".repeat(64))).resolves.toBeTruthy();
  });

  it("recusa só uma das duas, texto curto, longo ou com caractere fora do conjunto", async () => {
    for (const [token, id] of [[TOKEN, null], [null, "abcdefgh"], [TOKEN, "a".repeat(7)], [TOKEN, "a".repeat(65)], [TOKEN, "tem espaco"], [TOKEN, "acentuação"]] as const) {
      await expect(comment(token, id), `${token}/${id}`).rejects.toThrow(/ticket_comments_request_check/);
    }
  });

  it("o papel da aplicação não consegue mudar o requestId depois de gravado", async () => {
    const id = await comment(TOKEN, "abcdefgh");
    await expect(asTenant(prisma, ORG, (tx) => tx.$executeRaw`update ticket_comments set request_id = 'zzzzzzzz' where id = ${id}::uuid`)).rejects.toThrow(/permission denied/);
  });
});
