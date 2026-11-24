import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { openGeneral, openTicket, post, seedChatTickets, view } from "./chat-support.js";
import { as } from "./world.js";

type Node = { id: string | null; kind: string; label?: string | null; children: Node[] };
const flat = (nodes: Node[]): Node[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

// TREEPM-392: o nó de thread de GET /api/conversations traz o começo da mensagem que abriu a thread (o mesmo texto de trail[].label);
// os demais nós trazem null. É da própria thread, que a pessoa já lê: a regra de visibilidade não muda.
describe("GET /api/conversations: label das threads", () => {
  const h = useHarness(AI_CONFIG);
  const tree = async (who: "manager" | "reader" | "contributor") => (await h.call("GET", "/api/conversations", as(who))).body.items as Node[];

  it("a thread traz o começo da mensagem de abertura (80 caracteres); os outros nós, null", async () => {
    const w = h.world();
    const t = await seedChatTickets(h.pool, w);
    const main = await openTicket(h, "manager", t.ticket);
    const opening = `Alice, olha isto ${"x".repeat(120)}`;
    const thread = await post(h, "manager", main, opening, [w.people.reader]);
    await openGeneral(h, "manager");
    const nodes = flat(await tree("manager"));
    const node = nodes.find((n) => n.id === thread.body.thread.id)!;
    expect(node.label).toBe(opening.slice(0, 80));
    for (const other of nodes.filter((n) => n.kind !== "thread")) expect(other.label ?? null, other.kind).toBeNull();
    // O mesmo texto que a trilha de uma conversa de dentro já traz para esta thread.
    const inner = await post(h, "reader", thread.body.thread.id, "Mais dentro", [w.people.contributor]);
    const seen = await view(h, "manager", inner.body.thread.id);
    expect(seen.body.conversation.trail.find((entry: { id: string }) => entry.id === thread.body.thread.id).label).toBe(node.label);
  });

  it("privacidade: a pessoa que só participa da thread de baixo não recebe o label de nada acima", async () => {
    const w = h.world();
    const t = await seedChatTickets(h.pool, w);
    const main = await openTicket(h, "manager", t.ticket);
    const top = await post(h, "manager", main, "SEGREDO-ABERTURA-DE-CIMA", [w.people.reader]);
    const below = await post(h, "reader", top.body.thread.id, "Abertura da de baixo", [w.people.contributor]);
    const nodes = flat(await tree("contributor"));
    expect(nodes.find((n) => n.id === below.body.thread.id)?.label).toBe("Abertura da de baixo");
    expect(JSON.stringify(nodes)).not.toContain("SEGREDO-ABERTURA-DE-CIMA");
    expect(nodes.map((n) => n.id)).not.toContain(top.body.thread.id);
  });
});
