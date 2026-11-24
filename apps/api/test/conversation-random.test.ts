import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { useHarness } from "./harness.js";
import { openGeneral, openTicket, post } from "./chat-support.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0055, regra 3: árvores de conversas geradas ao acaso (semente fixa), com um modelo em memória escrito aqui, independente do
// código da API. Para cada pessoa, o que as rotas devolvem tem de ser EXATAMENTE o que a regra permite, e a invariante (filha inclui
// os participantes da conversa de cima) vale depois de cada operação.
const PEOPLE = ["manager", "reader", "contributor", "target", "admin"] as const satisfies readonly (Who | "target")[];
/** Quem pode ser marcado ao acaso: `plain` não enxerga o projeto do ticket. */
const ALL = [...PEOPLE, "plain"] as const satisfies readonly (Who | "target")[];
/** A quem o teste tira o acesso ao projeto no meio da árvore. */
const REVOCABLE = ["reader", "contributor"] as const;
const TREES = 400;

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type P = (typeof ALL)[number];
/** `ticket`: a conversa trata do ticket da árvore (a principal do ticket e tudo abaixo; no chat geral, só as threads abertas com `ticketId`). */
type Model = { id: string; parent: string | null; depth: number; owner: P; members: Set<P>; ticket: boolean };

describe("árvores de conversas ao acaso", () => {
  const clock = { t: 1_000_000, now: () => clock.t };
  const h = useHarness(AI_CONFIG, { clock });
  const tick = () => (clock.t += 61_000);

  it(`${TREES} árvores (ticket e chat geral, thread com ticketId, perda de acesso, limite de níveis): o que cada pessoa lê é exatamente o que o modelo permite, metadados inclusive`, async () => {
    const world = h.world();
    const who = (key: string): string => world.people[key as keyof typeof world.people];
    const random = rng(20261124);
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
    const invariant = async () => expect((await h.pool.query("select c.id from conversations c join conversation_participants up on up.conversation_id = c.parent_id where not exists (select 1 from conversation_participants me where me.conversation_id = c.id and me.person_id = up.person_id)")).rows).toEqual([]);
    let number = 500;
    let comparisons = 0;
    let refusedDepth = 0;
    let refusedMention = 0;
    let refusedInheritance = 0;

    for (let tree = 0; tree < TREES; tree += 1) {
      const ticket = (await h.pool.query<{ id: string }>("insert into tickets (org_id, project_id, number, title, created_by_person_id) values ('org_A',$1,$2,'T',$3) returning id", [world.projects.priv, ++number, world.people.manager])).rows[0]!.id;
      const revoked = new Map<P, Record<string, unknown>>();
      const access = (p: P): boolean => p !== "plain" && !revoked.has(p);
      const ownerKey = pick(PEOPLE);
      const isGeneral = tree % 4 === 1;
      const deep = tree % 20 === 3;
      tick();
      if (isGeneral) {
        // O chat geral é um só por pessoa e dura entre árvores: cada árvore recomeça de um chat geral vazio.
        const client = await h.pool.connect();
        try {
          await client.query("begin");
          await client.query("set constraints all deferred");
          const old = "select id from conversations where root_id in (select id from conversations where kind = 'general' and owner_person_id = $1)";
          await client.query(`delete from conversation_participants where conversation_id in (${old})`, [who(ownerKey)]);
          await client.query(`delete from conversation_messages where conversation_id in (${old})`, [who(ownerKey)]);
          await client.query("delete from conversations where root_id in (select id from conversations where kind = 'general' and owner_person_id = $1)", [who(ownerKey)]);
          await client.query("commit");
        } finally {
          client.release();
        }
      }
      const main = isGeneral ? await openGeneral(h, ownerKey) : await openTicket(h, ownerKey, ticket);
      const nodes = new Map<string, Model>([[main, { id: main, parent: null, depth: 0, owner: ownerKey, members: new Set([ownerKey]), ticket: !isGeneral }]]);
      const visible = (person: P, node: Model): boolean => node.members.has(person) && (!node.ticket || access(person));
      const descendants = (id: string): string[] => [...nodes.values()].filter((n) => n.parent === id).flatMap((n) => [n.id, ...descendants(n.id)]);
      /** O nível visível de quem abre: quantas conversas acima ela lê, em sequência. */
      const level = (person: P, node: Model): number => {
        let count = 0;
        for (let up = node.parent; up !== null && visible(person, nodes.get(up) as Model); up = nodes.get(up)!.parent) count += 1;
        return count;
      };
      const steps = deep ? 13 : 3 + Math.floor(random() * 4);
      const revokeAt = random() < 0.3 && !deep ? Math.floor(steps / 2) : -1;
      for (let step = 0; step < steps; step += 1) {
        tick();
        if (step === revokeAt) {
          const person = pick(REVOCABLE);
          const row = (await h.pool.query("select * from project_memberships where person_id = $1 and project_id = $2", [who(person), world.projects.priv])).rows[0];
          if (row) {
            revoked.set(person, row);
            await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [who(person), world.projects.priv]);
          }
        }
        const target = deep ? ([...nodes.values()].sort((a, b) => b.depth - a.depth)[0] as Model) : pick([...nodes.values()]);
        const able = [...target.members].filter((m) => visible(m, target));
        if (able.length === 0) continue;
        const actor = deep && random() < 0.5 ? (target.owner && able.includes(target.owner) ? target.owner : (able[0] as P)) : pick(able);
        if (deep || random() < 0.7 || target.depth === 0) {
          const others = ALL.filter((p) => p !== actor);
          const mentioned = deep ? [pick(PEOPLE.filter((p) => p !== actor))] : [...new Set([pick(others), ...(random() < 0.4 ? [pick(others)] : [])])];
          const useTicketId = !target.ticket && random() < 0.5;
          const subject = target.ticket || useTicketId;
          const res = await post(h, actor, target.id, `t${tree}s${step}`, mentioned.map(who), useTicketId ? ticket : undefined);
          let expected = 201;
          let code: string | undefined;
          if (level(actor, target) >= 10 && !deep) { expected = 422; code = "max_depth"; }
          else if (level(actor, target) >= 10) { expected = 422; code = "max_depth"; }
          else if (useTicketId && !access(actor)) { expected = 404; code = "not_found"; }
          else if (subject && mentioned.some((m) => !access(m))) { expected = 422; code = "mention_not_allowed"; }
          else if (useTicketId && [...target.members].some((m) => !access(m))) { expected = 422; code = "participant_cannot_view_ticket"; }
          expect(res.status, `abrir (${tree}/${step}) ${JSON.stringify(res.body).slice(0, 200)}`).toBe(expected);
          if (code) {
            expect(res.body.error.code).toBe(code);
            if (code === "max_depth") refusedDepth += 1; else if (code === "mention_not_allowed") refusedMention += 1; else if (code === "participant_cannot_view_ticket") refusedInheritance += 1;
          } else {
            nodes.set(res.body.thread.id, { id: res.body.thread.id, parent: target.id, depth: target.depth + 1, owner: actor, members: new Set([...target.members, actor, ...mentioned]), ticket: subject });
          }
        } else {
          const threads = [...nodes.values()].filter((n) => n.parent !== null);
          if (threads.length === 0) continue;
          const thread = pick(threads);
          const outsiders = ALL.filter((p) => !thread.members.has(p));
          const stranger = outsiders.length > 0 ? pick(outsiders) : undefined;
          const intruder = pick([...thread.members].filter((p) => p !== thread.owner).concat(thread.owner));
          const asker = random() < 0.5 ? thread.owner : intruder;
          if (stranger === undefined || !visible(asker, thread)) continue;
          const res = await h.call("POST", `/api/conversations/${thread.id}/participants`, as(asker), { personIds: [who(stranger)] });
          if (asker !== thread.owner) { expect(res.status).toBe(403); continue; }
          const needsAccess = [thread.id, ...descendants(thread.id)].some((id) => nodes.get(id)?.ticket);
          if (needsAccess && !access(stranger)) { expect(res.status, "incluir sem acesso").toBe(422); continue; }
          expect(res.status).toBe(201);
          for (const id of [thread.id, ...descendants(thread.id)]) nodes.get(id)?.members.add(stranger);
        }
        await invariant();
      }

      // Modelo × rotas, para cada pessoa.
      const all = [...nodes.values()];
      for (const person of ALL) {
        const seeIds = new Set(all.filter((n) => visible(person, n)).map((n) => n.id));
        const hidden = all.filter((n) => !seeIds.has(n.id)).map((n) => n.id);
        const res = await h.call("GET", "/api/conversations", as(person));
        expect(res.status).toBe(200);
        type Node = { id: string | null; kind: string; ticket: { id: string } | null; children: Node[]; participantCount: number; unread: number };
        const seen: Node[] = [];
        const walk = (list: Node[]) => list.forEach((n) => { seen.push(n); walk(n.children); });
        walk(res.body.items);
        const got = new Set(seen.map((n) => n.id).filter((id): id is string => id !== null && nodes.has(id)));
        expect([...got].sort(), `árvore ${tree} de ${person}`).toEqual([...seeIds].sort());
        for (const id of hidden) expect(JSON.stringify(res.body)).not.toContain(id);
        // Metadados: contagens e não lidas só do que a regra permite.
        for (const n of seen) {
          const model = n.id ? nodes.get(n.id) : undefined;
          if (!model) continue;
          expect(n.participantCount, `participantes de ${model.id} para ${person}`).toBe(model.members.size);
          if (model.parent !== null) expect(n.unread, `não lidas de ${model.id} para ${person}`).toBe(model.owner === person ? 0 : 1);
          else expect(n.unread).toBe(0);
        }
        const childrenOf = new Map<string, string[]>();
        const index = (list: Node[]) => list.forEach((n) => { if (n.id) childrenOf.set(n.id, n.children.flatMap((c) => (c.id ? [c.id] : []))); index(n.children); });
        index(res.body.items);
        for (const id of seeIds) {
          const node = nodes.get(id) as Model;
          if (node.parent !== null && seeIds.has(node.parent)) expect(childrenOf.get(node.parent), `${person} filho ${id}`).toContain(id);
        }
        // A leitura do ticket: 404 sem acesso; com acesso, só cartões visíveis.
        const byTicket = await h.call("GET", `/api/tickets/${ticket}/conversation`, as(person));
        expect(byTicket.status, `ticket de ${person}`).toBe(access(person) ? 200 : 404);
        if (byTicket.status === 200) {
          for (const id of hidden) expect(JSON.stringify(byTicket.body), `${person} ticket vê ${id}`).not.toContain(id);
          const cards = [...(byTicket.body.threads as { id: string }[]), ...(byTicket.body.messages.items as { thread: { id: string } | null }[]).flatMap((m) => (m.thread ? [m.thread] : []))];
          for (const card of cards) expect(seeIds.has(card.id) && nodes.get(card.id)?.ticket === true).toBe(true);
        }
        for (const node of all) {
          const view = await h.call("GET", `/api/conversations/${node.id}`, as(person));
          if (!seeIds.has(node.id)) {
            expect(view.status, `${person} em ${node.id}`).toBe(404);
            continue;
          }
          expect(view.status).toBe(200);
          const trail = (view.body.conversation.trail as { id: string }[]).map((t) => t.id);
          const expected: string[] = [];
          for (let up = node.parent; up !== null && visible(person, nodes.get(up) as Model); up = nodes.get(up)!.parent) expected.unshift(up);
          expect(trail, `trilha de ${person} em ${node.id}`).toEqual(expected);
          expect(view.body.conversation.canOpenThread, `canOpenThread de ${person} em ${node.id}`).toBe(level(person, node) < 10);
          const text = JSON.stringify(view.body);
          for (const id of hidden) expect(text.includes(id), `${person} vê ${id} na conversa ${node.id}`).toBe(false);
          // Cartões (na lista de threads e em messages[].thread): só filhas visíveis desta conversa, com contagens da regra.
          const direct = all.filter((n) => n.parent === node.id && seeIds.has(n.id)).map((n) => n.id).sort();
          const cardList = view.body.threads as { id: string; participantCount: number; replyCount: number; startedByMe: boolean }[];
          expect(cardList.map((c) => c.id).sort(), `cartões de ${person} em ${node.id} (árvore ${tree}, geral=${isGeneral}, fundo=${deep}) ${JSON.stringify(cardList.filter((c) => !direct.includes(c.id)).map((c) => ({ id: c.id, model: nodes.get(c.id) ? { parent: nodes.get(c.id)!.parent, members: [...nodes.get(c.id)!.members], ticket: nodes.get(c.id)!.ticket } : null })))}`).toEqual(direct);
          for (const card of cardList) {
            const model = nodes.get(card.id) as Model;
            // A mensagem que abre uma thread filha mora nesta conversa: conta nas respostas dela (a de abertura dela própria não).
            expect([card.participantCount, card.replyCount, card.startedByMe]).toEqual([model.members.size, all.filter((n) => n.parent === model.id).length, model.owner === person]);
          }
          const inMessages = (view.body.messages.items as { thread: { id: string } | null }[]).flatMap((m) => (m.thread ? [m.thread.id] : [])).sort();
          expect(inMessages, `cartões nas mensagens de ${person} em ${node.id}`).toEqual(direct);
          comparisons += 1;
        }
      }
      for (const [person, row] of revoked) {
        void person;
        await h.pool.query("insert into project_memberships select * from json_populate_record(null::project_memberships, $1::json)", [JSON.stringify(row)]);
      }
    }
    expect(comparisons).toBeGreaterThan(TREES * 5);
    expect(refusedDepth).toBeGreaterThan(0);
    expect(refusedMention).toBeGreaterThan(0);
    expect(refusedInheritance).toBeGreaterThan(0);
  }, 3_000_000);
});
