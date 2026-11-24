import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { errorCode, openTicket, post, seedChatTickets } from "./chat-support.js";
import { as } from "./world.js";

// ADR 0058: a pessoa marcada no texto de uma mensagem tem de estar em `mentions`; descrição de ticket não leva menção de pessoa.
const h = useHarness(AI_CONFIG);
const p = () => h.world().people;
const priv = () => h.world().projects.priv;
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const count = async (table: string) => (await rows(`select count(*)::int as n from ${table}`))[0].n as number;

describe("mensagem de conversa com elo de pessoa (mention_mismatch)", () => {
  it("recusa (422) o texto com elo cujo id não está em mentions, sem gravar nada", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const body = `Oi ${personLink(p().reader, "Alice")}, tudo bem?`;
    for (const mentions of [undefined, [], [p().contributor]]) {
      const res = await post(h, "manager", main, body, mentions);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(errorCode(res)).toBe("mention_mismatch");
    }
    expect(await count("conversation_messages")).toBe(0);
    expect(h.chat().calls).toHaveLength(0);
  });

  it("aceita o texto com o elo quando o id está em mentions: abre a thread, sem chamar o assistente", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const res = await post(h, "manager", main, `Oi ${personLink(p().reader, "Alice")}`, [p().reader]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.kind).toBe("thread");
    expect(h.chat().calls).toHaveLength(0);
  });

  it("vale também para a resposta numa thread", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const opened = await post(h, "manager", main, "abre", [p().reader]);
    const thread = opened.body.thread.id as string;
    expect(errorCode(await post(h, "manager", thread, `Oi ${personLink(p().contributor, "Bob")}`))).toBe("mention_mismatch");
    expect((await post(h, "manager", thread, `Oi ${personLink(p().contributor, "Bob")}`, [p().contributor])).status).toBe(201);
  });

  it("elo entre crases ou em bloco de código também conta (varredura crua): recusa sem chamar o provedor, também com topic: true", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const link = personLink(p().contributor, "Bob");
    for (const body of [`isto: \`${link}\``, `\`\`\`\n${link}\n\`\`\``, link.replace("person:", "PERSON:"), link.replace("(person:", "( person:")]) {
      for (const extra of [{}, { topic: true }]) {
        const res = await h.call("POST", `/api/conversations/${main}/messages`, as("manager"), { body, ...extra });
        expect(res.status, JSON.stringify(res.body)).toBe(422);
        expect(errorCode(res)).toBe("mention_mismatch");
      }
    }
    expect(await count("conversation_messages")).toBe(0);
    expect(h.chat().calls).toHaveLength(0);
  });
});

describe("a prévia e o rótulo na lista de conversas", () => {
  it("trocam o elo de pessoa por @Nome, e o corte não parte um elo no meio", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const main = await openTicket(h, "manager", t.ticket);
    const link = personLink(p().reader, "Alice");
    const body = `${"x".repeat(60)} ${link} fim`;
    const opened = await post(h, "manager", main, body, [p().reader]);
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const list = await h.call("GET", "/api/conversations", as("manager"));
    const text = JSON.stringify(list.body);
    expect(text).not.toContain("person:");
    expect(text).toContain("@Alice");
  });
});

describe("descrição de ticket com elo de pessoa (person_mention_not_allowed)", () => {
  const withLink = `Veja com ${personLink("11111111-1111-4111-8111-111111111111", "Alice")}.`;

  it("recusa (422) ao criar e ao editar, sem gravar", async () => {
    const created = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: withLink });
    expect(created.status, JSON.stringify(created.body)).toBe(422);
    expect(errorCode(created)).toBe("person_mention_not_allowed");
    expect(await count("tickets")).toBe(0);

    const ok = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: "limpo" });
    expect(ok.status).toBe(201);
    const edited = await h.call("PATCH", `/api/tickets/${ok.body.id}`, as("admin"), { description: withLink });
    expect(edited.status, JSON.stringify(edited.body)).toBe(422);
    expect(errorCode(edited)).toBe("person_mention_not_allowed");
    expect((await rows("select description from tickets where id = $1", [ok.body.id]))[0].description).toBe("limpo");
  });

  it("aceita a chave com # e o texto @Nome simples", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: "Veja #PRIV-1 com @Alice." });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

describe("as outras portas do texto que vai à IA ou ao MCP (person_mention_not_allowed)", () => {
  const link = personLink("11111111-1111-4111-8111-111111111111", "Alice");
  const sneaky = ["`" + link + "`", "> ```\n> " + link + "\n> ```", "- ```\n  " + link + "\n  ```", link.replace("person:", "PERSON:")];

  it("recusa no título, na criação e na edição, em qualquer disfarce", async () => {
    const ok = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: "limpo" });
    for (const text of sneaky) {
      const created = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: text });
      expect(errorCode(created), text).toBe("person_mention_not_allowed");
      expect(created.status).toBe(422);
      expect(errorCode(await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: text }))).toBe("person_mention_not_allowed");
      expect(errorCode(await h.call("PATCH", `/api/tickets/${ok.body.id}`, as("admin"), { description: text }))).toBe("person_mention_not_allowed");
      expect(errorCode(await h.call("PATCH", `/api/tickets/${ok.body.id}`, as("admin"), { title: text }))).toBe("person_mention_not_allowed");
    }
  });

  it("recusa na importação (cada item, também filho) sem gravar", async () => {
    const res = await h.call("POST", `/api/projects/${priv()}/tickets/import`, as("admin"), { items: [{ title: "A", children: [{ title: "B", description: sneaky[0] }] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(errorCode(res)).toBe("person_mention_not_allowed");
    expect(await count("tickets")).toBe(0);
  });

  it("recusa o pedido e o texto do rascunho da descrição, sem chamar o provedor", async () => {
    const ok = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T", description: "limpo" });
    for (const body of [{ request: sneaky[0], description: "" }, { request: "melhore", description: sneaky[1] }]) {
      const res = await h.call("POST", `/api/tickets/${ok.body.id}/description/draft`, as("admin"), body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(errorCode(res)).toBe("person_mention_not_allowed");
    }
  });

  it("recusa a mensagem e o rascunho da conversa de novo ticket, não só a criação no fim", async () => {
    await seedTree(h.pool, h.world());
    const refused = await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: sneaky[0] });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(errorCode(refused)).toBe("person_mention_not_allowed");
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero corrigir o login" })).body.id as string;
    expect(errorCode(await h.call("POST", `/api/ticket-conversations/${id}/messages`, as("contributor"), { message: sneaky[2] }))).toBe("person_mention_not_allowed");
    for (const draft of [{ title: sneaky[0], description: "" }, { title: "T", description: sneaky[3] }, { title: "T", description: "", children: [{ title: "F", description: sneaky[1] }] }]) {
      const res = await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), draft);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(errorCode(res)).toBe("person_mention_not_allowed");
    }
  });
});
