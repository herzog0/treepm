/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto das requisições ao provedor */
import { describe, expect, it } from "vitest";
import { ClaudeChatProvider } from "../src/assistant/claude-chat-provider.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { actAs, createTestPerson } from "./act-as-support.js";
import { seedChatTickets } from "./chat-support.js";
import { as } from "./world.js";

// ADR 0057 + ADR 0056: as ferramentas do assistente das conversas usam o `Principal` da requisição. Agindo como uma pessoa de teste,
// ele consulta só o que ELA enxerga, e "atribuídos a mim" usa o id dela (nunca o do administrador).
const h = useHarness(AI_CONFIG);
type Request = Record<string, any>;
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const final = (message: string) => ({ stop_reason: "end_turn", parsed_output: { message }, model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify({ message }) }] });
const toolTurn = (...uses: unknown[]) => ({ stop_reason: "tool_use", parsed_output: null, model: "claude-opus-5-5", content: uses });
const payload = (content: string): any => JSON.parse(content.split("\n")[1] ?? "null");

describe("assistente das conversas agindo como pessoa de teste", () => {
  const requests: Request[] = [];
  const script = (run: (call: number) => Record<string, unknown>): void => {
    requests.length = 0;
    const stream = (async (params: Request) => {
      requests.push(JSON.parse(JSON.stringify(params)));
      return run(requests.length);
    }) as unknown as ClaudeStreamer;
    h.chat().delegate = new ClaudeChatProvider(stream);
  };
  const results = (): { content: string }[] =>
    (requests.at(-1)!["messages"] as any[]).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b: any) => b.type === "tool_result") : []));

  async function ask(headers: Record<string, string>): Promise<void> {
    const general = await h.call("POST", "/api/conversations/general", as("admin"), undefined, headers);
    expect(general.status).toBe(200);
    const res = await h.call("POST", `/api/conversations/${general.body.id}/messages`, as("admin"), { body: "O que é meu?" }, headers);
    expect(res.status).toBe(201);
  }

  it("só vê o que a pessoa de teste enxerga, e 'atribuídos a mim' usa o id dela", async () => {
    await seedChatTickets(h.pool, h.world());
    const w = h.world();
    const add = async (project: string, number: number, title: string) =>
      (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, description, created_by_person_id) values ('org_A',$1,$2,$3,'',$4) returning id", [project, number, title, w.people.manager])).rows[0]!.id;
    const mine = await add(w.projects.org, 1, "Da Bia");
    const adminsTicket = await add(w.projects.org, 2, "Do administrador");
    await h.pool.query("update projects set next_ticket_number = 3 where id = $1", [w.projects.org]);
    const bia = (await createTestPerson(h, "Bia")).id;
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A',$1,$2)", [mine, bia]);
    await h.pool.query("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A',$1,$2)", [adminsTicket, w.people.admin]);

    // Como Bia: só o projeto aberto, e o filtro "comigo" devolve só o ticket dela.
    script((call) => (call === 1 ? toolTurn(use("a", "list_tickets", { project: "OPEN", assigned_to_me: true }), use("b", "read_ticket", { ticket: "PRIV-3" })) : final("ok")));
    await ask(actAs(bia));
    expect(requests[0]!["messages"].at(-1).content[0].text).toContain('"projects":["OPEN"]');
    const [list, secret] = results();
    expect(payload(list!.content).tickets.map((t: any) => t.label)).toEqual(["OPEN-1"]);
    expect(secret!.content).not.toContain("Ticket do chat"); // PRIV é privado e a Bia não é membro

    // Como o próprio administrador: enxerga PRIV e o "comigo" é o ticket dele.
    script((call) => (call === 1 ? toolTurn(use("a", "list_tickets", { project: "OPEN", assigned_to_me: true })) : final("ok")));
    await ask({});
    expect(requests[0]!["messages"].at(-1).content[0].text).toContain("PRIV");
    expect(payload(results()[0]!.content).tickets.map((t: any) => t.label)).toEqual(["OPEN-2"]);
  });
});
