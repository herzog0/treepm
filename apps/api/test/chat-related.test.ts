/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições ao provedor */
import { describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { CHAT_SYSTEM_PROMPT } from "../src/assistant/prompts.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { openTicket, post, seedChatTickets } from "./chat-support.js";
import { LINEAR_SENTINELS, seedRelated } from "./related-support.js";

// ADR 0061 fatia 3 (TREEPM-478) e ADR 0037 ("as ligações entre tickets"): "relacionado a" vai ao provedor nos dois caminhos do assistente
// (o contexto do chat do ticket e a ferramenta read_ticket), só como chave, título e situação dos tickets; nada da origem no Linear.
type Request = Record<string, any>;
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const final = (message: string) => ({ stop_reason: "end_turn", parsed_output: { message }, model: "claude-opus-5-5", content: [text(JSON.stringify({ message }))] });
const toolTurn = (...uses: unknown[]) => ({ stop_reason: "tool_use", parsed_output: null, model: "claude-opus-5-5", content: uses });
const payload = (content: string): any => JSON.parse(content.split("\n")[1] ?? "null");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("related to (ADR 0061) no assistente", () => {
  const h = useHarness(AI_CONFIG);
  const requests: Request[] = [];

  it("vai no contexto do chat do ticket e no read_ticket, só com chave, título e situação, sem nenhum id ou endereço do Linear", async () => {
    const t = await seedChatTickets(h.pool, h.world());
    const project = h.world().projects.priv;
    await seedRelated(h.pool, "org_A", project, t.ticket, t.child2);
    await seedRelated(h.pool, "org_A", project, t.blocker, t.ticket);
    const relationIds = (await h.pool.query("select id from ticket_relations where kind = 'related'")).rows.map((r) => String(r["id"]));
    expect(relationIds).toHaveLength(2);

    const stream = (async (params: Request) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      return requests.length === 1 ? toolTurn(use("a", "read_ticket", { ticket: "PRIV-3" }), use("b", "read_ticket", { ticket: "PRIV-7" })) : final("ok");
    }) as unknown as ClaudeStreamer;
    h.chat().delegate = new ClaudeChatProvider(stream);

    const conversation = await openTicket(h, "manager", t.ticket);
    expect((await post(h, "manager", conversation, "Com o que este se relaciona?")).status).toBe(201);
    expect(requests).toHaveLength(2);

    // Caminho 1: o contexto do chat do ticket.
    const contextText: string = requests[0]!["messages"].at(-1).content[0].text;
    const context = JSON.parse(contextText.slice(contextText.indexOf("{")));
    expect(context.ticket.related).toEqual([
      { key: "PRIV-5", title: "Filho dois", status: "todo" },
      { key: "PRIV-7", title: "Bloqueado por este", status: "todo" },
    ]);
    expect(context.ticket.dependsOn.map((r: any) => r.key)).toEqual(["PRIV-6"]);
    expect(context.ticket.blocks.map((r: any) => r.key)).toEqual(["PRIV-7"]);

    // Caminho 2: a ferramenta read_ticket (ask-executor), com rótulos neutros como as outras ligações.
    const results = (requests[1]!["messages"] as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : []));
    const three = payload(results[0].content);
    expect(three.relations.related).toEqual({
      tickets: [
        { label: "PRIV-5", title: "Filho dois", excerpt: "", status: "todo", parent: "PRIV-3", idea: null },
        { label: "PRIV-7", title: "Bloqueado por este", excerpt: "", status: "todo", parent: null, idea: null },
      ],
      truncated: false,
    });
    expect(payload(results[1].content).relations.related.tickets.map((r: any) => r.label)).toEqual(["PRIV-3"]);

    // O texto de sistema e a ferramenta explicam o campo.
    expect(CHAT_SYSTEM_PROMPT).toMatch(/related é "relacionado a"/);
    expect(JSON.stringify(requests[0]!["tools"])).toContain("related");

    // Nada do Linear nem id algum vai ao provedor.
    const wire = JSON.stringify(requests.map((r) => [r["system"], r["tools"], r["messages"]]));
    expect(wire).not.toMatch(UUID);
    for (const banned of [...LINEAR_SENTINELS, ...relationIds, "relationId", "issueId", "external"]) expect(wire, banned).not.toContain(banned);
  });
});
