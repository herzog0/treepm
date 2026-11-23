import type { TicketSummary } from "../api/client.js";
import { makeTicket } from "./fakes.js";

/** Gerador pseudoaleatório com semente (mulberry32): as árvores dos testes de equivalência são reproduzíveis. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomTreeOptions {
  /** Probabilidade de o novo ticket ser filho do anterior (cadeias fundas). */
  readonly chain?: number;
  readonly ideas?: number;
  readonly discardedIdeas?: number;
  readonly done?: number;
}

const STATUSES = ["todo", "in_progress", "in_review", "done", "cancelled"] as const;

/** Árvore de tickets com progresso coerente com a regra do servidor (`done`, `total`, `excluded`, `ideas`), ideias e descartadas. */
export function randomTickets(count: number, seed: number, projectId = "p", options: RandomTreeOptions = {}): TicketSummary[] {
  const random = seeded(seed);
  const { chain = 0.2, ideas = 0.05, discardedIdeas = 0.4, done = 0.2 } = options;
  const parents: (number | null)[] = [];
  const raw: TicketSummary[] = [];
  for (let at = 0; at < count; at += 1) {
    const parent = at === 0 || random() < 0.15 ? null : random() < chain ? at - 1 : Math.floor(random() * at);
    parents.push(parent);
    const parentRaw = parent === null ? null : raw[parent]!;
    let idea: TicketSummary["idea"] = null;
    if (parentRaw?.idea) idea = { root: false, rootId: parentRaw.idea.root ? parentRaw.id : parentRaw.idea.rootId, rootKey: parentRaw.idea.root ? parentRaw.key : parentRaw.idea.rootKey };
    else if (random() < ideas) idea = { root: true, stage: random() < discardedIdeas ? "discarded" : "new" };
    const status = idea ? "todo" : random() < done ? "done" : STATUSES[Math.floor(random() * STATUSES.length)]!;
    raw.push(makeTicket(`t${at}`, projectId, at + 1, `Ticket ${at} ${random() < 0.5 ? "relatório" : "fila"}`, { parentId: parent === null ? null : `t${parent}`, status, idea }));
  }
  // Progresso sobre todos os descendentes (sem as ideias, contadas à parte; os cancelados ficam de fora da base).
  const done$ = new Array<number>(count).fill(0);
  const total = new Array<number>(count).fill(0);
  const excluded = new Array<number>(count).fill(0);
  const ideaCount = new Array<number>(count).fill(0);
  const hasChildren = new Array<boolean>(count).fill(false);
  for (let at = count - 1; at >= 0; at -= 1) {
    const parent = parents[at];
    if (parent === null || parent === undefined) continue;
    hasChildren[parent] = true;
    const ticket = raw[at]!;
    if (ticket.idea?.root === true) ideaCount[parent]! += 1 + ideaCount[at]!;
    else if (!ticket.idea) {
      if (ticket.status === "cancelled") excluded[parent]! += 1 + excluded[at]!;
      else {
        total[parent]! += 1 + total[at]!;
        done$[parent]! += (ticket.status === "done" ? 1 : 0) + done$[at]!;
        excluded[parent]! += excluded[at]!;
      }
      ideaCount[parent]! += ideaCount[at]!;
    }
  }
  return raw.map((ticket, at) => (hasChildren[at] && !ticket.idea ? { ...ticket, progress: { done: done$[at]!, total: total[at]!, excluded: excluded[at]!, ideas: ideaCount[at]! } } : ticket));
}
