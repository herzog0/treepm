/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona corpos brutos de resposta */
import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { seedTree } from "./assistant-tree.js";
import { errorCode, openGeneral, post, seedChatTickets, topic, view } from "./chat-support.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0056, fatia 3: threads de criação nos três estados, com perda de acesso no meio, contra um modelo em memória independente da API.
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type State = "draft" | "waiting" | "created" | "discarded";
type Made = { thread: string; tc: string; state: State; secret: string };
const CREATORS = ["manager", "contributor"] as const satisfies readonly Who[];
const OTHERS: readonly Who[] = ["admin", "reader", "plain", "manager", "contributor"];

describe("threads de criação ao acaso", () => {
  const clock = { t: 1_000_000, now: () => clock.t };
  const h = useHarness(AI_CONFIG, { clock });
  const tick = () => (clock.t += 61_000);
  const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
  const tcCall = (method: string, path: string, who: Who, body?: unknown) => h.call(method, `/api/ticket-conversations/${path}`, as(who), body);
  const flat = (items: any[]): any[] => items.flatMap((n) => [n, ...flat(n.children)]);

  it("estado, cartão, árvore e leitura da thread batem com o modelo, com e sem acesso ao projeto, e ninguém além da dona lê nada", async () => {
    const t = await seedTree(h.pool, h.world());
    const w = h.world();
    const random = rng(20261124);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    h.judge().verdict = (input) => ({ belongs: input.current ? 0.95 : 0.1, choice: Object.fromEntries(input.candidates.map((c, i) => [c.id, i === 0 ? 0.2 : 0.8])) });
    let checked = 0;
    const seen = { draft: 0, waiting: 0, created: 0, lost: 0 };

    for (let round = 0; round < 24; round += 1) {
      const owner = pick(CREATORS);
      const general = await openGeneral(h, owner);
      const revoked = random() < 0.5;
      const made: Made[] = [];
      const make = async (): Promise<Made> => {
        const secret = `SEGREDO-${round}-${made.length}-xyz`;
        tick();
        const res = await h.call("POST", `/api/conversations/${general}/messages`, as(owner), { body: secret, creation: true });
        expect(res.status, JSON.stringify(res.body).slice(0, 200)).toBe(201);
        return { thread: res.body.thread.id, tc: res.body.ticketConversationId, state: "draft", secret };
      };
      // Três rascunhos por rodada, levados a estados diferentes; a cada passo o modelo é conferido.
      for (let n = 0; n < 3; n += 1) {
        const one = await make();
        made.push(one);
        const roll = random();
        if (roll < 0.34) {
          one.state = "draft";
        } else if (roll < 0.67) {
          expect((await tcCall("POST", `${one.tc}/messages`, owner, { message: "Mais detalhes" })).status).toBe(201);
          one.state = "waiting";
        } else {
          await tcCall("POST", `${one.tc}/messages`, owner, { message: "Mais detalhes" });
          const created = await tcCall("POST", `${one.tc}/ticket`, owner, { parentId: t.billing, placedBy: "option" });
          expect(created.status, JSON.stringify(created.body).slice(0, 200)).toBe(201);
          one.state = "created";
        }
        // Só pode haver um aberto pelo pedido direto? Não: o limite é do assistente. Descarta alguns para variar.
        if (one.state !== "created" && random() < 0.3) {
          expect((await tcCall("DELETE", one.tc, owner)).status).toBe(204);
          one.state = "discarded";
        }
      }
      if (revoked) {
        await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [w.people[owner], w.projects.priv]);
        seen.lost += 1;
      }
      const access = !revoked;
      const open = made.filter((m) => m.state === "draft" || m.state === "waiting");
      for (const m of made) if (m.state !== "discarded") seen[m.state === "created" ? "created" : (m.state as "draft" | "waiting")] += 1;

      // A dona: a árvore lista só as abertas com acesso; o cartão na conversa de cima tem o estado e, sem acesso, nada além dele.
      const tree = (await h.call("GET", "/api/conversations", as(owner))).body.items as any[];
      const listed = flat(tree).filter((n) => n.purpose === "creation").map((n) => n.id).sort();
      expect(listed, `árvore da rodada ${round}`).toEqual(access ? open.map((m) => m.thread).sort() : []);
      for (const n of flat(tree).filter((x) => x.purpose === "creation")) expect(n.creation.state).toBe(made.find((m) => m.thread === n.id)!.state);
      const cards = (await view(h, owner, general)).body.messages.items.flatMap((m: any) => (m.thread ? [m.thread] : []));
      for (const m of made) {
        const card = cards.find((c: any) => c.id === m.thread);
        expect(card, `cartão ${m.thread}`).toBeTruthy();
        expect(card.creation.state).toBe(m.state);
        if (m.state === "discarded") continue;
        if (access) {
          expect(card.creation.projectKey).toBe("PRIV");
        } else {
          expect(card.creation).toMatchObject({ projectId: null, projectKey: null, ticket: null });
          expect(card.title).toBeNull();
          expect(JSON.stringify({ ...card, opening: null })).not.toMatch(/PRIV|Rascunho/); // a abertura é a mensagem da própria dona
        }
        const inside = await view(h, owner, m.thread);
        expect(inside.status, `thread ${m.thread} (estado ${m.state}, acesso ${access})`).toBe(access ? 200 : 404);
      }
      // Ninguém além da dona lê a thread, o cartão nem o texto.
      for (const other of OTHERS.filter((p) => p !== owner)) {
        for (const m of made) expect((await view(h, other, m.thread)).status, `${other} em ${m.thread}`).toBe(404);
        const text = JSON.stringify((await h.call("GET", "/api/conversations", as(other))).body);
        for (const m of made) expect(text.includes(m.thread) || text.includes(m.secret)).toBe(false);
      }
      checked += made.length;
      if (revoked) await h.pool.query("insert into project_memberships (org_id, project_id, person_id, role) values ('org_A',$1,$2,$3) on conflict do nothing", [w.projects.priv, w.people[owner], owner]);
      // Limpa para a próxima rodada (o chat geral dura entre rodadas).
      for (const m of made) if (m.state !== "created" && m.state !== "discarded") await tcCall("DELETE", m.tc, owner);
    }
    expect(checked).toBe(72);
    expect(seen.draft).toBeGreaterThan(0);
    expect(seen.waiting).toBeGreaterThan(0);
    expect(seen.created).toBeGreaterThan(0);
    expect(seen.lost).toBeGreaterThan(0);
  }, 600_000);

  it("thread de assunto sob projeto arquivado: a ferramenta não é oferecida e creation: true é recusado", async () => {
    await seedChatTickets(h.pool, h.world());
    const general = await openGeneral(h, "contributor");
    const opened = await topic(h, "contributor", general, "Um assunto");
    expect(opened.body.kind).toBe("topic");
    const inTopic = opened.body.thread.id as string;
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    h.chat().draft_ = () => "Pedido";
    h.chat().calls.length = 0;
    const talked = await post(h, "contributor", inTopic, "Cria um ticket");
    expect([talked.status, talked.body.kind]).toEqual([201, "assistant"]);
    expect(h.chat().calls[0]!.draftTool).toBeNull();
    const refused = await h.call("POST", `/api/conversations/${inTopic}/messages`, as("contributor"), { body: "Um ticket", creation: true });
    expect([refused.status, errorCode(refused)]).toEqual([422, "project_unavailable"]);
    // O chat de um ticket do projeto arquivado nem abre (somente leitura): não há como nascer rascunho ali.
    const ticketId = (await rows("select id from tickets where project_id = $1 limit 1", [h.world().projects.priv]))[0].id;
    expect((await h.call("POST", `/api/tickets/${ticketId}/conversation`, as("manager"))).status).toBe(409);
    expect(await rows("select 1 from conversations where purpose = 'creation'")).toHaveLength(0);
  });
});
