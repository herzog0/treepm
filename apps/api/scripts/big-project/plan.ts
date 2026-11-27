/**
 * Planejamento determinístico de um projeto grande (TREEPM-191): a forma da árvore, as situações, os textos, os eventos,
 * os comentários e as contribuições, tudo a partir de uma semente. Parte pura: nada aqui fala com banco, rede ou disco,
 * e o mesmo `{ n, seed, key, now }` devolve sempre exatamente o mesmo plano (inclusive os ids). Quem grava é `load.ts`.
 *
 * A árvore cresce por ligação preferencial (quem já tem filhos atrai mais filhos), o que dá larguras muito variadas;
 * a profundidade é limitada a 7 e a largura a 60 filhos. Os tickets chegam em ordem de criação, então o pai tem sempre
 * número menor que o dos filhos. Regras do produto respeitadas de propósito: nada concluído com filho aberto (ADR 0034);
 * a raiz de uma ideia e tudo dentro dela ficam em "a fazer" e sem marcador de trabalho pela IA (ADR 0042, 0043).
 */
import { mentionedKeys } from "@treepm/domain";

export type Status = "todo" | "in_progress" | "in_review" | "done" | "cancelled";
export type IdeaStage = "new" | "refining" | "ready" | "discarded";

export const MAX_DEPTH = 7;
export const MAX_WIDTH = 60;
const DAY = 86_400_000;

export interface PlanOptions {
  readonly n: number;
  readonly seed: number;
  readonly key: string;
  /** Instante de referência (os marcadores de trabalho pela IA valem a partir dele). */
  readonly now: number;
  readonly people?: number;
  /** Eventos e comentários do ticket de muito histórico. */
  readonly historyEvents?: number;
  readonly historyComments?: number;
  /**
   * Variedade de ideias para o oráculo de equivalência (TREEPM-254). Desligadas, o plano é byte a byte o das sementes já usadas nas
   * referências: estas opções só mexem depois de tudo o mais ter sido sorteado, com um sorteio próprio (`seed` à parte).
   * `nestedIdeas`: ideia dentro de ideia; `topIdeas`: raiz de ideia no topo do projeto (sem pai); `closedInIdeas`: `cancelled` dentro de
   * ideia (o que as regras permitem: dentro de ideia só `todo` e `cancelled`; `done` não existe ali, ADR 0042).
   */
  readonly nestedIdeas?: boolean;
  readonly topIdeas?: boolean;
  readonly closedInIdeas?: boolean;
}

export interface PlannedPerson { readonly id: string; readonly clerkUserId: string; readonly name: string; readonly email: string }
export interface PlannedArea { readonly id: string; readonly name: string }
export interface PlannedTicket {
  readonly index: number;
  readonly id: string;
  readonly number: number;
  readonly parent: number | null;
  /** 1 para raiz. */
  readonly depth: number;
  readonly title: string;
  readonly description: string;
  readonly status: Status;
  readonly ideaStage: IdeaStage | null;
  readonly agentWork: { readonly note: string } | null;
  readonly createdBy: number;
  readonly createdAt: number;
  readonly assignees: readonly number[];
}
/** `need` (ADR 0068): o tipo de "depende de", só em `depends_on`; ausente = "para começar" (o gerador não sorteia o tipo). */
export interface PlannedRelation { readonly from: number; readonly to: number; readonly kind: "mentions" | "depends_on"; readonly need?: "start" | "deliver" }
export interface PlannedEvent { readonly id: string; readonly ticket: number; readonly kind: string; readonly actor: number; readonly at: number; readonly payload: Record<string, unknown> }
export interface PlannedComment { readonly id: string; readonly ticket: number; readonly author: number; readonly body: string; readonly at: number; readonly contribution: string | null }
export interface PlannedContribution {
  readonly id: string;
  readonly ticket: number;
  readonly area: number;
  readonly text: string;
  readonly status: "todo" | "in_progress" | "done";
  readonly createdBy: number;
  readonly at: number;
  readonly people: readonly number[];
}
export interface PlanFixtures {
  /** A cadeia de 7 tickets concluídos (da raiz à folha) e a folha funda que reabre os ancestrais. */
  readonly doneChain: readonly number[];
  readonly doneLeaf: number;
  /** Ticket fundo e ticket raso (raiz), os dois com descrição média e três contribuições. */
  readonly deep: number;
  readonly shallow: number;
  /** Ticket de muito histórico. */
  readonly history: number;
  readonly idea: number;
  /** Folha que vai e volta entre dois pais abertos (fora de ideia). */
  readonly move: number;
  readonly moveFrom: number;
  readonly moveTo: number;
}
export interface BigProjectPlan {
  readonly options: Required<PlanOptions>;
  readonly projectId: string;
  readonly people: readonly PlannedPerson[];
  readonly areas: readonly PlannedArea[];
  readonly tickets: readonly PlannedTicket[];
  readonly relations: readonly PlannedRelation[];
  readonly events: readonly PlannedEvent[];
  readonly comments: readonly PlannedComment[];
  readonly contributions: readonly PlannedContribution[];
  readonly fixtures: PlanFixtures;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ["Implementar", "Revisar", "Migrar", "Corrigir", "Documentar", "Otimizar", "Integrar", "Validar", "Refatorar", "Desenhar", "Automatizar", "Medir", "Planejar", "Estudar", "Publicar", "Ajustar", "Separar", "Mapear", "Padronizar", "Conectar"];
const OBJECTS = ["o fluxo de cadastro", "a tela de relatórios", "o cálculo de comissões", "a fila de notificações", "o painel de métricas", "a busca por pedido", "o módulo de estoque", "a exportação em lote", "o histórico de alterações", "as permissões por equipe", "a importação de planilhas", "o login com a conta da empresa", "o armazenamento de arquivos", "a tela de pagamentos", "o cache das consultas", "o envio de e-mails", "a página de ajuda", "o contrato com o fornecedor", "o onboarding do cliente", "a conciliação bancária", "o catálogo de produtos", "a agenda de entregas", "o roteiro de testes", "a trilha de auditoria"];
const QUALIFIERS = ["", "", "", " para o piloto", " no ambiente de homologação", " com dados reais", " antes da virada", " (segunda fase)", " para clientes grandes", " sem janela de manutenção", " no aplicativo móvel", " na região sul"];
const SENTENCES = [
  "O comportamento atual confunde quem usa pela primeira vez e gera pedidos repetidos ao suporte.",
  "Precisamos combinar com a equipe de operações antes de mudar o prazo.",
  "A primeira versão pode ser simples, desde que registre o que foi feito e por quem.",
  "Os números do último trimestre mostram que esse caminho concentra a maior parte dos erros.",
  "Vale começar por um caso real e só depois generalizar.",
  "O critério de pronto é que alguém de fora da equipe consiga repetir o procedimento sem ajuda.",
  "Há uma dependência externa que ainda não tem data confirmada.",
  "Se der certo, o mesmo desenho serve para as outras áreas.",
  "Registrar as decisões aqui evita que a discussão volte na próxima reunião.",
  "O risco principal é perder dados antigos na migração; por isso o plano inclui uma cópia de segurança.",
];
const COMMENTS = ["Conferi e está de acordo com o combinado.", "Falta alinhar com a equipe de dados antes de seguir.", "Subi uma primeira versão para você olhar.", "Pode priorizar? Está travando outra frente.", "Testei no ambiente de homologação e funcionou.", "Mudei o escopo: ficou só a parte do cadastro.", "Obrigado, ajudou bastante.", "Encontrei um caso que não está coberto; anotei na descrição."];
const AREAS = ["Produto", "Design", "Engenharia", "Dados", "Operações", "Comercial", "Financeiro", "Jurídico"];
const FIRST = ["Ana", "Bruno", "Carla", "Diego", "Elisa", "Fábio", "Gabi", "Hugo", "Iara", "João", "Karina", "Lucas", "Marta", "Nuno", "Olga", "Paulo", "Rita", "Sérgio", "Tânia", "Vítor"];
const NOTES = ["Escrevendo os testes", "Implementando a primeira versão", "Revisando o que mudou", "Migrando os dados antigos", "Rodando a medição"];

interface Rng { next: () => number; int: (below: number) => number; pick: <T>(items: readonly T[]) => T; chance: (p: number) => boolean }
function makeRng(seed: number): Rng {
  const next = mulberry32(seed);
  return { next, int: (below) => Math.floor(next() * below), pick: (items) => items[Math.floor(next() * items.length)] as never, chance: (p) => next() < p };
}

/** Identificador no formato de UUID, determinístico; o contador no fim garante que dois nunca coincidem. */
function makeIds(seed: number): (prefix: number) => string {
  const next = mulberry32(seed ^ 0x9e3779b9);
  let counter = 0;
  return (prefix) => {
    const hex = (value: number, width: number) => (value >>> 0).toString(16).padStart(width, "0").slice(-width);
    counter += 1;
    const a = hex(Math.floor(next() * 4294967296), 8);
    const b = hex(Math.floor(next() * 65536), 4);
    const c = `4${hex(Math.floor(next() * 4096), 3)}`;
    const d = `a${hex(prefix & 0xfff, 3)}`;
    return `${a}-${b}-${c}-${d}-${hex(counter, 12)}`;
  };
}

type SizeClass = "empty" | "short" | "medium" | "long" | "huge";
const SIZE_WEIGHTS: readonly [SizeClass, number][] = [["empty", 0.2], ["short", 0.4], ["medium", 0.28], ["long", 0.09], ["huge", 0.03]];

function paragraphs(rng: Rng, count: number): string[] {
  return Array.from({ length: count }, () => Array.from({ length: 2 + rng.int(4) }, () => rng.pick(SENTENCES)).join(" "));
}

function describe(rng: Rng, size: SizeClass, key: string, number: number, withMention: boolean): string {
  if (size === "empty") return "";
  const mention = withMention && number > 1 ? `Ver ${key}-${1 + rng.int(number - 1)}.` : "";
  if (size === "short") return `${rng.pick(SENTENCES)} ${mention}`.trim();
  const parts: string[] = [];
  const blocks = size === "medium" ? 2 + rng.int(3) : size === "long" ? 8 + rng.int(14) : 40 + rng.int(25);
  for (const paragraph of paragraphs(rng, blocks)) {
    parts.push(paragraph);
    if (rng.chance(0.25)) parts.push(`- ${rng.pick(SENTENCES)}\n- ${rng.pick(SENTENCES)}\n- [ ] ${rng.pick(SENTENCES)}`);
    if (rng.chance(0.06)) parts.push(`\`\`\`ts\nconst exemplo = { id: "${key}-1", ativo: true };\n\`\`\``);
    if (rng.chance(0.08)) parts.push(`## ${rng.pick(VERBS)} ${rng.pick(OBJECTS)}`);
  }
  if (mention) parts.splice(1 + rng.int(parts.length), 0, mention);
  return parts.join("\n\n").slice(0, 19_000);
}

function pickSize(rng: Rng): SizeClass {
  let roll = rng.next();
  for (const [size, weight] of SIZE_WEIGHTS) {
    roll -= weight;
    if (roll < 0) return size;
  }
  return "short";
}

const titleOf = (rng: Rng): string => `${rng.pick(VERBS)} ${rng.pick(OBJECTS)}${rng.pick(QUALIFIERS)}`;

export function planBigProject(input: PlanOptions): BigProjectPlan {
  const options: Required<PlanOptions> = { people: 24, historyEvents: 1500, historyComments: 400, nestedIdeas: false, topIdeas: false, closedInIdeas: false, ...input };
  const { n, seed, key, now } = options;
  if (!Number.isInteger(n) || n < 100) throw new Error("O projeto grande precisa de pelo menos 100 tickets.");
  const rng = makeRng(seed);
  const newId = makeIds(seed);
  const start = now - 400 * DAY;

  const people: PlannedPerson[] = Array.from({ length: options.people }, (_, i) => ({
    id: newId(1),
    clerkUserId: i === 0 ? "u_perf_admin" : `u_perf_${i}`,
    name: i === 0 ? "Admin da medição" : `${FIRST[i % FIRST.length]} ${i}`,
    email: i === 0 ? "admin@medicao.test" : `pessoa${i}@medicao.test`,
  }));
  const areas: PlannedArea[] = AREAS.map((name) => ({ id: newId(2), name }));
  const projectId = newId(8);

  // 1. Forma da árvore. Os 13 primeiros tickets são a cadeia concluída (fixture da propagação); não atraem filhos.
  const parent: (number | null)[] = [];
  const depth: number[] = [];
  const childCount: number[] = [];
  const bag: number[] = [];
  const add = (p: number | null, attract: boolean): number => {
    const index = parent.length;
    parent.push(p);
    depth.push(p === null ? 1 : (depth[p] as number) + 1);
    childCount.push(0);
    if (p !== null) {
      childCount[p] = (childCount[p] as number) + 1;
      if (attract) bag.push(p);
    }
    if (attract) bag.push(index);
    return index;
  };
  const doneChain: number[] = [];
  const doneSide = new Set<number>();
  let previous: number | null = null;
  for (let level = 1; level <= MAX_DEPTH; level += 1) {
    const node = add(previous, false);
    doneChain.push(node);
    if (level < MAX_DEPTH) doneSide.add(add(node, false));
    previous = node;
  }
  const fixtureCount = parent.length;
  const rootChance = Math.max(0.004, 6 / n);
  while (parent.length < n) {
    let chosen: number | null = null;
    if (!rng.chance(rootChance)) {
      for (let attempt = 0; attempt < 30 && chosen === null; attempt += 1) {
        const candidate = bag[rng.int(bag.length)];
        if (candidate !== undefined && (depth[candidate] as number) < MAX_DEPTH && (childCount[candidate] as number) < MAX_WIDTH) chosen = candidate;
      }
    }
    add(chosen, true);
  }
  // Raízes mínimas: o laço acima só cria raízes por sorteio; garante pelo menos cinco fora da cadeia.
  const rootsOutside = parent.slice(fixtureCount).filter((p) => p === null).length;
  if (n >= 100 && rootsOutside < 5) throw new Error("Semente sem raízes suficientes; troque a semente.");

  const children = new Map<number, number[]>();
  parent.forEach((p, i) => {
    if (p !== null) children.set(p, [...(children.get(p) ?? []), i]);
  });
  const subtree = (root: number): number[] => {
    const out: number[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const at = stack.pop() as number;
      out.push(at);
      stack.push(...(children.get(at) ?? []));
    }
    return out;
  };
  const isFixture = (i: number): boolean => i < fixtureCount;

  // 2. Ideias: raízes pequenas, sem aninhar; tudo dentro delas fica em "a fazer".
  const status: Status[] = Array.from({ length: n }, () => "todo");
  const ideaStage: (IdeaStage | null)[] = Array.from({ length: n }, () => null);
  const locked = new Set<number>();
  const ideaTarget = Math.max(4, Math.round(n * 0.012));
  const stages: IdeaStage[] = ["new", "new", "refining", "ready", "discarded"];
  for (let tries = 0, made = 0; made < ideaTarget && tries < ideaTarget * 40; tries += 1) {
    const candidate = fixtureCount + rng.int(n - fixtureCount);
    if (locked.has(candidate) || (depth[candidate] as number) < 2) continue;
    const members = subtree(candidate);
    if (members.length > 30 || members.some((m) => locked.has(m))) continue;
    // Nem um ancestral já numa ideia: `locked` cobre só descendentes; confere subindo.
    let up = parent[candidate] ?? null;
    let nested = false;
    while (up !== null) {
      if (ideaStage[up] !== null) nested = true;
      up = parent[up] ?? null;
    }
    if (nested) continue;
    ideaStage[candidate] = stages[made % stages.length] as IdeaStage;
    for (const m of members) locked.add(m);
    made += 1;
  }

  // 3. Situações: ramos inteiros concluídos até chegar a ~15%, o resto espalhado.
  for (const i of doneChain) status[i] = "done";
  for (const i of doneSide) status[i] = "done";
  let doneCount = doneChain.length + doneSide.size;
  const doneTarget = Math.round(n * 0.15);
  const maxBranch = Math.max(6, Math.round(n / 60));
  const marked = new Set<number>();
  for (let tries = 0; doneCount < doneTarget && tries < n * 30; tries += 1) {
    const candidate = fixtureCount + rng.int(n - fixtureCount);
    if (marked.has(candidate) || locked.has(candidate)) continue;
    const members = subtree(candidate);
    if (members.length > maxBranch || members.some((m) => marked.has(m) || locked.has(m)) || doneCount + members.length > doneTarget + 3) continue;
    // Um ancestral concluído já cobre o ramo; o ramo todo é marcado de uma vez, então só conferimos `marked`.
    for (const m of members) {
      marked.add(m);
      status[m] = "done";
    }
    doneCount += members.length;
  }
  for (let i = fixtureCount; i < n; i += 1) {
    if (status[i] === "done" || locked.has(i)) continue;
    const leaf = !children.has(i);
    const roll = rng.next();
    status[i] = leaf ? (roll < 0.62 ? "todo" : roll < 0.84 ? "in_progress" : roll < 0.92 ? "in_review" : "cancelled") : roll < 0.55 ? "todo" : roll < 0.9 ? "in_progress" : "in_review";
  }

  // 4. Marcadores de trabalho pela IA: poucos, só em ticket aberto fora de ideia.
  const agentWork = new Map<number, string>();
  const agentTarget = Math.max(5, Math.round(n * 0.004));
  for (let tries = 0; agentWork.size < agentTarget && tries < n * 10; tries += 1) {
    const candidate = fixtureCount + rng.int(n - fixtureCount);
    if (locked.has(candidate) || status[candidate] === "done" || status[candidate] === "cancelled") continue;
    agentWork.set(candidate, rng.pick(NOTES));
  }

  // 4b. Variedade de ideias (só por opção): sorteio próprio, depois de todo o resto, para não mexer no que as sementes já geravam.
  if (options.nestedIdeas || options.topIdeas || options.closedInIdeas) {
    const extra = makeRng(seed ^ 0x51ed270b);
    const stagesExtra: IdeaStage[] = ["new", "refining", "ready", "discarded"];
    const free = (i: number): boolean => !isFixture(i) && ideaStage[i] === null;
    const makeRoot = (index: number): void => {
      ideaStage[index] = extra.pick(stagesExtra);
      status[index] = "todo";
      agentWork.delete(index);
    };
    const quota = Math.max(2, Math.round(n * 0.004));
    if (options.topIdeas) {
      // Raiz do projeto com subárvore pequena, que nenhuma ideia contém ainda: a ideia vai até o topo.
      const candidates = Array.from({ length: n }, (_, i) => i).filter((i) => free(i) && parent[i] === null && !locked.has(i) && subtree(i).length <= 25 && subtree(i).every((m) => !isFixture(m) && !locked.has(m)));
      for (let made = 0; made < quota && candidates.length > 0; made += 1) {
        const [candidate] = candidates.splice(extra.int(candidates.length), 1) as [number];
        makeRoot(candidate);
        for (const member of subtree(candidate)) {
          locked.add(member);
          if (member !== candidate) {
            status[member] = "todo";
            agentWork.delete(member);
          }
        }
      }
    }
    if (options.nestedIdeas) {
      // Uma raiz nova dentro de uma ideia que já existe (a subárvore já está em `todo`, sem marcador).
      const candidates = Array.from({ length: n }, (_, i) => i).filter((i) => free(i) && locked.has(i) && parent[i] !== null);
      for (let made = 0; made < quota && candidates.length > 0; made += 1) {
        const [candidate] = candidates.splice(extra.int(candidates.length), 1) as [number];
        if (ideaStage[candidate] === null) makeRoot(candidate);
      }
    }
    if (options.closedInIdeas) {
      // Cancelado dentro de ideia: tickets soltos e ramos inteiros, nunca a raiz.
      const inside = Array.from({ length: n }, (_, i) => i).filter((i) => locked.has(i) && ideaStage[i] === null && !isFixture(i));
      for (const index of inside) {
        if (!extra.chance(0.18)) continue;
        for (const member of subtree(index)) {
          if (ideaStage[member] !== null) continue;
          status[member] = "cancelled";
          agentWork.delete(member);
        }
      }
    }
  }

  // 5. Fixtures que dependem das situações.
  const open = (i: number) => status[i] === "todo" || status[i] === "in_progress" || status[i] === "in_review";
  const plain = (i: number) => !isFixture(i) && !locked.has(i);
  let deep = -1;
  for (let i = fixtureCount; i < n; i += 1) if (plain(i) && (deep < 0 || (depth[i] as number) > (depth[deep] as number))) deep = i;
  const shallowCandidates = Array.from({ length: n }, (_, i) => i).filter((i) => !isFixture(i) && !locked.has(i) && parent[i] === null && children.has(i));
  const shallow = shallowCandidates[Math.floor(shallowCandidates.length / 2)] ?? -1;
  const historyCandidates = Array.from({ length: n }, (_, i) => i).filter((i) => plain(i) && open(i) && (depth[i] as number) >= 3 && children.has(i));
  const history = historyCandidates[Math.min(historyCandidates.length - 1, 5)] ?? -1;
  const ideaRoot = ideaStage.findIndex((stage) => stage !== null);
  const moveCandidates = Array.from({ length: n }, (_, i) => i).filter((i) => plain(i) && status[i] === "todo" && !children.has(i) && (depth[i] as number) >= 3 && open(parent[i] as number) && !agentWork.has(i));
  const move = moveCandidates[Math.floor(moveCandidates.length / 3)] ?? -1;
  const moveFrom = parent[move] ?? -1;
  const moveTo = Array.from({ length: n }, (_, i) => i).filter((i) => plain(i) && open(i) && children.has(i) && i !== moveFrom && (depth[i] as number) <= 5 && !agentWork.has(i))[7] ?? -1;
  if ([deep, shallow, history, ideaRoot, move, moveFrom, moveTo].some((i) => i < 0)) throw new Error("Não foi possível escolher as fixtures; troque a semente ou aumente N.");

  // 6. Textos e quem criou. Raso e fundo ganham descrição média; a cadeia concluída e as ideias, descrição curta.
  const descriptions: string[] = [];
  const createdAt: number[] = [];
  const createdBy: number[] = [];
  const titles: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const forced: SizeClass | null = i === deep || i === shallow || i === history ? "medium" : null;
    descriptions.push(describe(rng, forced ?? pickSize(rng), key, i + 1, rng.chance(0.14)));
    titles.push(titleOf(rng));
    createdAt.push(Math.round(start + (i / n) * 395 * DAY + rng.next() * 0.4 * DAY));
    createdBy.push(rng.int(people.length));
  }
  const assignees: number[][] = Array.from({ length: n }, () => {
    if (!rng.chance(0.3)) return [];
    const first = rng.int(people.length);
    return rng.chance(0.25) ? [...new Set([first, rng.int(people.length)])] : [first];
  });

  const tickets: PlannedTicket[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    id: newId(3),
    number: i + 1,
    parent: parent[i] ?? null,
    depth: depth[i] as number,
    title: titles[i] as string,
    description: descriptions[i] as string,
    status: status[i] as Status,
    ideaStage: ideaStage[i] ?? null,
    agentWork: agentWork.has(i) ? { note: agentWork.get(i) as string } : null,
    createdBy: createdBy[i] as number,
    createdAt: createdAt[i] as number,
    assignees: assignees[i] as number[],
  }));

  // 7. Ligações: "menciona" pela mesma regra do produto; "depende de" só para ticket mais antigo (nunca há ciclo).
  const relations: PlannedRelation[] = [];
  const keyPrefix = `${key.toUpperCase()}-`;
  for (const ticket of tickets) {
    const seen = new Set<number>();
    for (const found of mentionedKeys(ticket.description)) {
      if (!found.toUpperCase().startsWith(keyPrefix)) continue;
      const target = Number(found.slice(keyPrefix.length)) - 1;
      if (Number.isInteger(target) && target >= 0 && target < n && target !== ticket.index && !seen.has(target)) {
        seen.add(target);
        relations.push({ from: ticket.index, to: target, kind: "mentions" });
      }
    }
    if (ticket.index > 10 && rng.chance(0.04)) {
      const target = rng.int(ticket.index);
      if (!seen.has(target)) relations.push({ from: ticket.index, to: target, kind: "depends_on" });
    }
  }

  // 8. Contribuições por área (parte dos tickets; as três fixtures sempre) e comentários.
  const contributions: PlannedContribution[] = [];
  const withContributions = new Set<number>([deep, shallow, history]);
  for (let i = 0; i < n; i += 1) if (rng.chance(0.07)) withContributions.add(i);
  for (const i of [...withContributions].sort((a, b) => a - b)) {
    const count = i === deep || i === shallow || i === history ? 3 : 1 + rng.int(3);
    const areaOrder = [...areas.keys()].sort(() => rng.next() - 0.5).slice(0, count);
    for (const area of areaOrder) {
      const contributionStatus = rng.pick(["todo", "in_progress", "done"] as const);
      contributions.push({
        id: newId(4),
        ticket: i,
        area,
        text: describe(rng, rng.pick(["short", "medium", "medium", "long"] as const), key, i + 1, false),
        status: contributionStatus,
        createdBy: rng.int(people.length),
        at: (createdAt[i] as number) + Math.round(rng.next() * 3 * DAY),
        people: rng.chance(0.5) ? [rng.int(people.length)] : [],
      });
    }
  }
  const comments: PlannedComment[] = [];
  const contributionsOf = new Map<number, PlannedContribution[]>();
  for (const c of contributions) contributionsOf.set(c.ticket, [...(contributionsOf.get(c.ticket) ?? []), c]);
  const commentOn = (i: number, at: number, long: boolean): void => {
    const own = contributionsOf.get(i) ?? [];
    comments.push({
      id: newId(5),
      ticket: i,
      author: rng.int(people.length),
      body: long ? `${rng.pick(COMMENTS)} ${paragraphs(rng, 1 + rng.int(2)).join("\n\n")}` : rng.pick(COMMENTS),
      at,
      contribution: own.length > 0 && rng.chance(0.3) ? (rng.pick(own) as PlannedContribution).id : null,
    });
  };
  for (let i = 0; i < n; i += 1) {
    if (!rng.chance(0.09) && i !== deep && i !== shallow) continue;
    const count = 1 + rng.int(4);
    for (let c = 0; c < count; c += 1) commentOn(i, (createdAt[i] as number) + Math.round((c + 1) * rng.next() * 6 * DAY), rng.chance(0.2));
  }
  const historySpan = Math.max(DAY, now - (createdAt[history] as number) - 2 * DAY);
  for (let c = 0; c < options.historyComments; c += 1) commentOn(history, (createdAt[history] as number) + Math.round(((c + 1) / (options.historyComments + 1)) * historySpan), c % 7 === 0);

  // 9. Eventos de histórico (formatos que a leitura da atividade reconhece): criação em todos, edições em parte.
  const events: PlannedEvent[] = [];
  const keyOf = (i: number) => `${key}-${i + 1}`;
  const NEXT_STATUS: Record<string, Status> = { todo: "in_progress", in_progress: "in_review", in_review: "done", done: "todo" };
  for (const ticket of tickets) {
    events.push({ id: newId(6), ticket: ticket.index, kind: "ticket.created", actor: ticket.createdBy, at: ticket.createdAt, payload: { key: keyOf(ticket.index) } });
    if (!rng.chance(0.35)) continue;
    const edits = 1 + rng.int(4);
    let at = ticket.createdAt;
    let current: Status = "todo";
    for (let e = 0; e < edits; e += 1) {
      at += Math.round((0.1 + rng.next() * 8) * DAY);
      const roll = rng.next();
      const actor = rng.int(people.length);
      if (roll < 0.5) {
        const to: Status = NEXT_STATUS[current] as Status;
        events.push({ id: newId(6), ticket: ticket.index, kind: "ticket.updated", actor, at, payload: { key: keyOf(ticket.index), fields: ["status"], status: { from: current, to } } });
        current = to;
      } else if (roll < 0.7) events.push({ id: newId(6), ticket: ticket.index, kind: "ticket.updated", actor, at, payload: { key: keyOf(ticket.index), fields: ["title"], title: { from: titleOf(rng), to: ticket.title } } });
      else if (roll < 0.85) events.push({ id: newId(6), ticket: ticket.index, kind: "ticket.updated", actor, at, payload: { key: keyOf(ticket.index), fields: ["description"] } });
      else events.push({ id: newId(6), ticket: ticket.index, kind: "ticket.assignee_added", actor, at, payload: { personId: (people[rng.int(people.length)] as PlannedPerson).id } });
    }
  }
  const historyArea = (contributionsOf.get(history) ?? [])[0] as PlannedContribution;
  let at = createdAt[history] as number;
  let current: Status = "todo";
  for (let e = 0; e < options.historyEvents; e += 1) {
    at += Math.round((historySpan / options.historyEvents) * (0.5 + rng.next()));
    const actor = rng.int(people.length);
    const base = { key: keyOf(history) };
    const roll = e % 6;
    if (roll === 0 || roll === 3) {
      const to: Status = NEXT_STATUS[current] as Status;
      events.push({ id: newId(6), ticket: history, kind: "ticket.updated", actor, at, payload: { ...base, fields: ["status"], status: { from: current, to } } });
      current = to;
    } else if (roll === 1) events.push({ id: newId(6), ticket: history, kind: "ticket.updated", actor, at, payload: { ...base, fields: ["title", "description"], title: { from: titleOf(rng), to: titleOf(rng) } } });
    else if (roll === 2) events.push({ id: newId(6), ticket: history, kind: e % 12 === 2 ? "ticket.assignee_added" : "ticket.assignee_removed", actor, at, payload: { personId: (people[rng.int(people.length)] as PlannedPerson).id } });
    else if (roll === 4) events.push({ id: newId(6), ticket: history, kind: "ticket.contribution_updated", actor, at, payload: { contributionId: historyArea.id, areaId: (areas[historyArea.area] as PlannedArea).id, fields: ["text", "status"], status: { from: "todo", to: "in_progress" } } });
    else events.push({ id: newId(6), ticket: history, kind: "ticket.contribution_person_added", actor, at, payload: { contributionId: historyArea.id, areaId: (areas[historyArea.area] as PlannedArea).id, personId: (people[rng.int(people.length)] as PlannedPerson).id } });
  }

  return {
    options,
    projectId,
    people,
    areas,
    tickets,
    relations,
    events,
    comments,
    contributions,
    fixtures: { doneChain, doneLeaf: doneChain[doneChain.length - 1] as number, deep, shallow, history, idea: ideaRoot, move, moveFrom, moveTo },
  };
}
