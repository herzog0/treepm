/**
 * Planejamento determinístico das escritas concorrentes (TREEPM-249, parte de concorrência). Parte pura: nada aqui fala com banco
 * ou rede. Dado o plano do projeto grande (`../big-project/plan.ts`), um cenário, um nível de concorrência e uma semente, cada
 * escritor recebe um gerador de operações que devolve sempre a mesma sequência. O executor (`../measure-concurrent-writes.ts`)
 * só traduz cada operação em requisição HTTP.
 *
 * Regras que mantêm a medição honesta, sem esconder defeito:
 *  - cada escritor é dono de folhas próprias (disjuntas) nos cenários comuns, para a espera medida ser a da trava do projeto e do
 *    commit, e não briga por linha; o cenário `branch` faz o contrário de propósito (todos nas mesmas folhas e ancestrais);
 *  - só folhas se movem, e o destino é sempre um ticket "interno" que nunca se move: assim nenhuma sequência fecha ciclo, e um
 *    `ticket_cycle` que aparecesse seria defeito, não azar do sorteio;
 *  - nada aqui escolhe ticket dentro de ideia, concluído com filhos ou com marcador de IA (são recusas legítimas das regras).
 */
import type { BigProjectPlan, PlannedTicket } from "../big-project/plan.js";

export const SCENARIOS = ["edits", "structure", "mixed", "import", "branch", "mcp", "mcp-unlimited"] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type HttpStatus = "todo" | "in_progress" | "done";
export type Op =
  | { readonly kind: "status"; readonly ticket: number; readonly status: HttpStatus }
  | { readonly kind: "title"; readonly ticket: number; readonly title: string }
  | { readonly kind: "priority"; readonly ticket: number; readonly priority: number }
  | { readonly kind: "assignee"; readonly ticket: number; readonly person: number; readonly add: boolean }
  | { readonly kind: "move"; readonly ticket: number; readonly parent: number }
  | { readonly kind: "create"; readonly parent: number | null; readonly title: string }
  /** Remove um ticket que este escritor criou antes (o executor sabe qual); sem nenhum, vira `create`. */
  | { readonly kind: "remove-own" }
  | { readonly kind: "mcp-status"; readonly ticket: number; readonly status: HttpStatus }
  | { readonly kind: "mcp-agent-work"; readonly ticket: number; readonly working: boolean }
  | { readonly kind: "mcp-comment"; readonly ticket: number; readonly body: string }
  | { readonly kind: "mcp-create"; readonly parent: number | null; readonly title: string }
  | { readonly kind: "mcp-queue" };

export type OpKind = Op["kind"];
/** As operações que, quando confirmadas e efetivas, mudam o resumo da lista e portanto a versão do projeto (ADR 0046). */
export const BUMPS_VERSION: ReadonlySet<OpKind> = new Set(["status", "title", "priority", "assignee", "move", "create", "remove-own", "mcp-status", "mcp-agent-work", "mcp-create"]);

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mistura de inteiros estável para derivar a semente de cada escritor sem que um escritor mude o sorteio de outro. */
function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return h >>> 0;
}
const scenarioNumber = (s: Scenario): number => SCENARIOS.indexOf(s) + 1;

export interface Pools {
  /** Folhas livres para editar e mover: `todo`, sem filhos, fora de ideia, sem marcador de IA. */
  readonly leaves: readonly number[];
  /** Pais possíveis: com filhos, fora de ideia, abertos (`todo`/`in_progress`). Nunca se movem. */
  readonly inner: readonly number[];
  /** O ramo mais pesado (raiz de profundidade 1) e as folhas e internos dentro dele. */
  readonly branch: { readonly root: number; readonly leaves: readonly number[]; readonly inner: readonly number[] };
}

/** Quem está dentro de ideia (ou é raiz de ideia): o gerador marca a raiz com `ideaStage`, e tudo abaixo herda. */
export function insideIdea(plan: Pick<BigProjectPlan, "tickets">): boolean[] {
  const flags: boolean[] = [];
  for (const t of plan.tickets) flags[t.index] = t.ideaStage !== null || (t.parent !== null && flags[t.parent] === true);
  return flags;
}

export function buildPools(plan: Pick<BigProjectPlan, "tickets">): Pools {
  const tickets = plan.tickets;
  const idea = insideIdea(plan);
  const children = new Map<number, number[]>();
  for (const t of tickets) if (t.parent !== null) (children.get(t.parent) ?? children.set(t.parent, []).get(t.parent)!).push(t.index);
  const open = (t: PlannedTicket): boolean => t.status === "todo" || t.status === "in_progress";
  const leaves = tickets.filter((t) => !children.has(t.index) && t.status === "todo" && !idea[t.index] && t.agentWork === null).map((t) => t.index);
  const inner = tickets.filter((t) => children.has(t.index) && !idea[t.index] && open(t) && t.agentWork === null).map((t) => t.index);
  // Tamanho da subárvore, de baixo para cima (o pai tem sempre índice menor que o dos filhos).
  const size: number[] = tickets.map(() => 1);
  for (let i = tickets.length - 1; i >= 0; i -= 1) {
    const p = (tickets[i] as PlannedTicket).parent;
    if (p !== null) size[p] = (size[p] as number) + (size[i] as number);
  }
  const roots = tickets.filter((t) => t.parent === null && !idea[t.index] && t.status !== "done");
  const best = roots.reduce<PlannedTicket | null>((acc, t) => (acc === null || (size[t.index] as number) > (size[acc.index] as number) ? t : acc), null);
  if (best === null) throw new Error("projeto sem raiz utilizável");
  const inBranch = (index: number): boolean => {
    for (let cursor: number | null = index; cursor !== null; cursor = (tickets[cursor] as PlannedTicket).parent) if (cursor === best.index) return true;
    return false;
  };
  return {
    leaves,
    inner,
    branch: { root: best.index, leaves: leaves.filter(inBranch), inner: inner.filter((i) => inBranch(i)) },
  };
}

export interface WriterContext {
  readonly plan: Pick<BigProjectPlan, "tickets" | "people">;
  readonly pools: Pools;
  readonly scenario: Scenario;
  readonly writer: number;
  readonly writers: number;
  readonly seed: number;
}

export interface Weights { readonly [kind: string]: number }
/** Mistura de cada cenário (pesos relativos). */
export const MIXES: Record<Scenario, Weights> = {
  edits: { status: 50, title: 20, priority: 20, assignee: 10 },
  structure: { move: 40, create: 40, "remove-own": 20 },
  mixed: { status: 40, title: 15, priority: 10, assignee: 5, create: 20, move: 10 },
  import: { status: 40, title: 15, priority: 10, assignee: 5, create: 20, move: 10 },
  branch: { status: 50, move: 25, create: 25 },
  mcp: { "mcp-status": 30, "mcp-agent-work": 15, "mcp-comment": 20, "mcp-create": 20, "mcp-queue": 15 },
  "mcp-unlimited": { "mcp-status": 30, "mcp-agent-work": 15, "mcp-comment": 20, "mcp-create": 20, "mcp-queue": 15 },
};

/** Folhas do escritor: fatias disjuntas e intercaladas; no cenário `branch` todos usam as folhas do mesmo ramo. */
export function writerLeaves(ctx: Pick<WriterContext, "pools" | "scenario" | "writer" | "writers">): readonly number[] {
  if (ctx.scenario === "branch") return ctx.pools.branch.leaves;
  return ctx.pools.leaves.filter((_, i) => i % ctx.writers === ctx.writer);
}
export function writerParents(ctx: Pick<WriterContext, "pools" | "scenario">): readonly number[] {
  return ctx.scenario === "branch" ? ctx.pools.branch.inner : ctx.pools.inner;
}

/** O gerador de operações de um escritor: estado só no próprio fechamento; mesma entrada, mesma sequência. */
export function createWriterPlan(ctx: WriterContext): () => Op {
  const rng = mulberry32(mix(ctx.seed, scenarioNumber(ctx.scenario), ctx.writers, ctx.writer));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const leaves = writerLeaves(ctx);
  const parents = writerParents(ctx);
  if (leaves.length === 0 || parents.length === 0) throw new Error(`escritor ${ctx.writer}: sem folhas ou sem pais (projeto pequeno demais para ${ctx.writers} escritores)`);
  const mix_ = MIXES[ctx.scenario];
  const kinds = Object.keys(mix_);
  const total = kinds.reduce((sum, k) => sum + (mix_[k] as number), 0);
  const shared = ctx.scenario === "branch";
  const status = new Map<number, HttpStatus>();
  const parentOf = new Map<number, number>(); // onde o escritor sabe que a folha está (só vale nas folhas próprias)
  const working = new Map<number, boolean>();
  const assigned = new Set<string>(ctx.plan.tickets.flatMap((t) => t.assignees.map((person) => `${t.index}:${person}`)));
  const priorityOf = new Map<number, number>();
  const people = ctx.plan.people.length;
  let n = 0;
  const tag = `c${ctx.writers}w${ctx.writer}`;
  const titleOf = (): string => `Medição ${tag} #${n}`;
  const nextStatus = (leaf: number): HttpStatus => {
    const now = status.get(leaf) ?? "todo";
    const value: HttpStatus = shared ? pick((["todo", "in_progress", "done"] as const).filter((s) => s !== now)) : now === "todo" ? "in_progress" : "todo";
    status.set(leaf, value);
    return value;
  };
  return (): Op => {
    n += 1;
    let roll = rng() * total;
    let kind = kinds[kinds.length - 1] as string;
    for (const k of kinds) {
      roll -= mix_[k] as number;
      if (roll < 0) {
        kind = k;
        break;
      }
    }
    const leaf = pick(leaves);
    switch (kind) {
      case "status": return { kind: "status", ticket: leaf, status: nextStatus(leaf) };
      case "title": return { kind: "title", ticket: leaf, title: titleOf() };
      case "priority": {
        // Nunca o valor que o ticket já tem (0 no início): escrita sem efeito não mexe na versão e estragaria a conferência.
        let value = ((n * 7 + ctx.writer) % 198) + 1;
        if (value === priorityOf.get(leaf)) value = (value % 198) + 1;
        priorityOf.set(leaf, value);
        return { kind: "priority", ticket: leaf, priority: value };
      }
      case "assignee": {
        const person = Math.floor(rng() * people);
        const id = `${leaf}:${person}`;
        const add = !assigned.has(id);
        if (add) assigned.add(id);
        else assigned.delete(id);
        return { kind: "assignee", ticket: leaf, person, add };
      }
      case "move": {
        const current = parentOf.get(leaf) ?? (ctx.plan.tickets[leaf] as PlannedTicket).parent;
        const options = parents.filter((p) => p !== current);
        const parent = pick(options);
        if (!shared) parentOf.set(leaf, parent);
        return { kind: "move", ticket: leaf, parent };
      }
      case "create": return { kind: "create", parent: pick(parents), title: titleOf() };
      case "remove-own": return { kind: "remove-own" };
      case "mcp-status": return { kind: "mcp-status", ticket: leaf, status: nextStatus(leaf) };
      case "mcp-agent-work": {
        const on = !(working.get(leaf) ?? false);
        working.set(leaf, on);
        return { kind: "mcp-agent-work", ticket: leaf, working: on };
      }
      case "mcp-comment": return { kind: "mcp-comment", ticket: leaf, body: `Comentário de medição ${tag} #${n}` };
      case "mcp-create": return { kind: "mcp-create", parent: pick(parents), title: titleOf() };
      default: return { kind: "mcp-queue" };
    }
  };
}

/** 500 itens em 25 grupos de 1 pai + 19 filhos (o máximo que a importação aceita), com título único por rodada. */
export function importItems(tag: string): { title: string; description: string; children: { title: string }[] }[] {
  return Array.from({ length: 25 }, (_, g) => ({
    title: `Importação ${tag} grupo ${g + 1}`,
    description: `Grupo ${g + 1} da importação de medição (${tag}).`,
    children: Array.from({ length: 19 }, (__, c) => ({ title: `Importação ${tag} ${g + 1}.${c + 1}` })),
  }));
}
