/**
 * Parte pura da ferramenta de reconstrução (ADR 0030): ordem de inserção e de remoção, classificação do
 * resultado nos três grupos, retomada, tentativas em 503, comparação de árvores, argumentos da linha de comando
 * e números do relatório. Nada aqui fala com rede, banco ou disco.
 */

// ---- tipos -----------------------------------------------------------------------------------------------------

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Tipo do nó (ADR 0031). Gabarito antigo não tem o campo: `resolveKinds` o preenche. */
export type NodeKind = "ticket" | "group";

export type GabaritoTicket = {
  id: string;
  number: number;
  kind: NodeKind;
  key: string;
  title: string;
  /** Descrição inteira (a rota de lista só devolve um trecho). */
  description: string;
  /** `null` para agrupador (não tem situação própria). */
  status: TicketStatus | null;
  parentId: string | null;
  assigneeIds: string[];
  depth: number;
};

export type Gabarito = {
  exportedAt: string;
  project: { id: string; key: string; name: string };
  tickets: GabaritoTicket[];
};

export type PlacementGroup = "same_parent" | "deeper" | "elsewhere";
export const GROUPS: readonly PlacementGroup[] = ["same_parent", "deeper", "elsewhere"];

export const STEPS = ["open", "draft", "placement", "ticket"] as const;
export type Step = (typeof STEPS)[number];

export type JudgmentRecord = {
  /** Título do nó atual; `null` na raiz. */
  current: string | null;
  /** Id do nó atual (`null` na raiz). Ausente em execuções antigas ou quando o juiz não conseguiu resolvê-lo. */
  currentId?: string | null;
  /** Ids dos candidatos, na ordem em que foram oferecidos. Ausente em execuções antigas. */
  candidateIds?: string[];
  /** Probabilidade do `Choice` por id do candidato. Ausente em execuções antigas. */
  choiceById?: Record<string, number>;
  candidateCount: number;
  belongs: number;
  /** Noul da pergunta do escopo, quando a procura foi feita com escopo. */
  scopeFit?: number;
  /** Probabilidade por título do candidato. */
  choice: Record<string, number>;
};

/** O que a verificação de afinidade fez numa procura (ADR 0031): os pares julgados e o que saiu. Os ids são os do gabarito. */
export type AffinityRecord = {
  pairs: { ticketOldId: string; title: string; noul: number }[];
  proposal: { title: string; ticketOldIds: string[] } | null;
  skipped: string | null;
};

export type PathNode = { id: string; title: string };
export type AlternativeRecord = { parentNewId: string | null; parentOldId: string | null; path: PathNode[] };

export type RunRecord = {
  oldId: string;
  oldNumber: number;
  title: string;
  newId: string;
  newKey: string;
  conversationId: string;
  /** O ticket já existia quando a execução foi retomada: não há dados da procura. */
  resumed: boolean;
  expectedParentOldId: string | null;
  chosenParentNewId: string | null;
  /** Id do gabarito correspondente ao pai escolhido (`null` na raiz ou sem correspondência). */
  chosenParentOldId: string | null;
  group: PlacementGroup;
  uncertain: boolean;
  stoppedEarly: { reason: string; level: number; parentId: string | null } | null;
  destinationPath: PathNode[];
  alternatives: AlternativeRecord[];
  judgments: JudgmentRecord[];
  claude: { draftTitle: string | null; ready: boolean; message: string };
  timingsMs: Record<Step, number>;
  attempts: Record<Step, number>;
  /** Afinidade desta procura; ausente em execução antiga. */
  affinity?: AffinityRecord;
  /** `leave-one-out --flat`: a procura rodou na árvore achatada (a ferramenta nunca confirma a proposta). */
  flat?: true;
  /** `leave-one-out --scope-check`: as duas procuras com escopo. `null`: não coube fazer (sem outro agrupador no nível). Ausente: sem `--scope-check` ou ticket na raiz. */
  scopeChecks?: { original: ScopeCheckRecord | null; other: ScopeCheckRecord | null };
};

/** Marca gravada logo depois de abrir a conversa; guarda a resposta do Claude, que depois o rascunho do gabarito apaga. */
export type StartedMark = { oldId: string; conversationId: string; claude?: RunRecord["claude"] };

// ---- árvore ----------------------------------------------------------------------------------------------------

/** Recalcula a profundidade de cada ticket pela cadeia de pais. */
export function computeDepths<T extends { id: string; parentId: string | null }>(tickets: readonly T[]): (T & { depth: number })[] {
  const parents = new Map(tickets.map((x) => [x.id, x.parentId]));
  const depthOf = (id: string): number => {
    let depth = 0;
    let cursor = parents.get(id) ?? null;
    while (cursor !== null) {
      if (!parents.has(cursor)) throw new Error(`Pai ${cursor} do ticket ${id} não está na lista.`);
      depth += 1;
      if (depth > parents.size) throw new Error(`Ciclo de pais a partir de ${id}.`);
      cursor = parents.get(cursor) ?? null;
    }
    return depth;
  };
  return tickets.map((x) => {
    if (x.parentId !== null && !parents.has(x.parentId)) throw new Error(`Pai ${x.parentId} do ticket ${x.id} não está na lista.`);
    return { ...x, depth: depthOf(x.id) };
  });
}

/** Profundidade 0 primeiro, depois 1, e assim por diante; dentro da profundidade, pelo número original. */
export function insertionOrder(tickets: readonly GabaritoTicket[]): GabaritoTicket[] {
  return [...tickets].sort((a, b) => a.depth - b.depth || a.number - b.number);
}

/** Ids na ordem de remoção: os mais fundos primeiro, para nunca remover um pai antes dos filhos. */
export function removalOrder(tickets: readonly { id: string; parentId: string | null }[]): string[] {
  return computeDepths(tickets)
    .map((x, index) => ({ id: x.id, depth: x.depth, index }))
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
    .map((x) => x.id);
}

/**
 * Compara o destino da procura com o pai esperado, na árvore RECONSTRUÍDA (não na do gabarito):
 * `same_parent` é o ticket novo que corresponde ao pai esperado; `deeper` é um caminho que passa por ele sem
 * terminar nele; o resto é `elsewhere`. Ticket de raiz no gabarito só pode ser `same_parent` ou `elsewhere`.
 */
export function classifyPlacement(input: {
  expectedParentOldId: string | null;
  chosenNewParentId: string | null;
  /** Caminho do destino da procura, com ids novos, da raiz até o pai escolhido. */
  destinationPath: readonly PathNode[];
  newToOld: ReadonlyMap<string, string>;
}): PlacementGroup {
  const { expectedParentOldId: expected, chosenNewParentId: chosen, destinationPath, newToOld } = input;
  if (expected === null) return chosen === null ? "same_parent" : "elsewhere";
  if (chosen === null) return "elsewhere";
  if (newToOld.get(chosen) === expected) return "same_parent";
  const expectedNewIds = new Set([...newToOld].filter(([, old]) => old === expected).map(([id]) => id));
  const passesThrough = destinationPath.slice(0, -1).some((node) => expectedNewIds.has(node.id));
  return passesThrough ? "deeper" : "elsewhere";
}

export type LiveTicket = { id: string; title: string; parentId: string | null; status: string | null; kind?: string };

/** Diferenças entre o gabarito e o projeto vivo (ids, títulos, pais e situações). Vazio = confere. */
export function compareTrees(gabarito: readonly GabaritoTicket[], live: readonly LiveTicket[]): string[] {
  const problems: string[] = [];
  const liveById = new Map(live.map((x) => [x.id, x]));
  const knownIds = new Set(gabarito.map((x) => x.id));
  for (const expected of gabarito) {
    const found = liveById.get(expected.id);
    if (!found) {
      problems.push(`${expected.id}: falta no projeto`);
      continue;
    }
    if (found.title !== expected.title) problems.push(`${expected.id}: título diferente`);
    if (found.parentId !== expected.parentId) problems.push(`${expected.id}: pai diferente`);
    // Gabarito antigo guarda `null` para agrupador, que não tinha situação; hoje todo ticket tem (ADR 0034).
    if (expected.status !== null && found.status !== expected.status) problems.push(`${expected.id}: situação diferente`);
    if (found.kind !== undefined && found.kind !== expected.kind) problems.push(`${expected.id}: tipo diferente`);
  }
  for (const extra of live) if (!knownIds.has(extra.id)) problems.push(`${extra.id}: a mais no projeto`);
  return problems;
}

export type ImportItem = { title: string; description?: string; status?: TicketStatus; children?: ImportItem[] };

/**
 * Árvore aninhada para a rota de importação (irmãos por número) e os ids do gabarito na mesma pré-ordem em que a
 * rota devolve os tickets criados.
 */
export function buildImportTree(tickets: readonly GabaritoTicket[]): { items: ImportItem[]; order: string[] } {
  const byParent = new Map<string | null, GabaritoTicket[]>();
  for (const ticket of [...tickets].sort((a, b) => a.number - b.number)) {
    const siblings = byParent.get(ticket.parentId) ?? [];
    siblings.push(ticket);
    byParent.set(ticket.parentId, siblings);
  }
  const order: string[] = [];
  const build = (parentId: string | null): ImportItem[] =>
    (byParent.get(parentId) ?? []).map((ticket) => {
      order.push(ticket.id);
      const item: ImportItem = { title: ticket.title, description: ticket.description };
      if (ticket.status !== null) item.status = ticket.status;
      const children = build(ticket.id);
      if (children.length > 0) item.children = children;
      return item;
    });
  return { items: build(null), order };
}

/**
 * Preenche o tipo de cada nó (ADR 0034): o tipo deixou de existir na API; aqui "group" é só o rótulo de quem tem
 * filhos no gabarito. Um `kind` declarado em gabarito antigo é ignorado.
 */
export function resolveKinds<T extends { id: string; parentId: string | null; kind?: NodeKind | undefined }>(
  tickets: readonly T[],
): (T & { kind: NodeKind })[] {
  const parents = new Set(tickets.map((x) => x.parentId).filter((id): id is string => id !== null));
  return tickets.map((x) => ({ ...x, kind: parents.has(x.id) ? "group" : "ticket" }));
}

/**
 * Ordem do `rebuild` (ADR 0031): os agrupadores são criados direto, do mais raso ao mais fundo, sem passar pela
 * procura; só os tickets passam pela conversa e pela procura, na ordem de inserção.
 */
export function rebuildOrder(tickets: readonly GabaritoTicket[]): { groups: GabaritoTicket[]; tickets: GabaritoTicket[] } {
  const ordered = insertionOrder(tickets);
  return { groups: ordered.filter((x) => x.kind === "group"), tickets: ordered.filter((x) => x.kind === "ticket") };
}

/** Agrupadores ainda não criados (os que não estão no mapa antigo → novo), na ordem recebida. */
export function pendingGroups(groups: readonly GabaritoTicket[], created: ReadonlyMap<string, string>): GabaritoTicket[] {
  return groups.filter((group) => !created.has(group.id));
}

// ---- retomada --------------------------------------------------------------------------------------------------

export type ResumeState = {
  done: Set<string>;
  startedConversation: Map<string, string>;
  startedMarks: Map<string, StartedMark>;
  newToOld: Map<string, string>;
};

export function resumeState(records: readonly RunRecord[], started: readonly StartedMark[]): ResumeState {
  const done = new Set(records.map((r) => r.oldId));
  const startedConversation = new Map<string, string>();
  const startedMarks = new Map<string, StartedMark>();
  for (const mark of started) {
    if (done.has(mark.oldId)) continue;
    startedConversation.set(mark.oldId, mark.conversationId);
    startedMarks.set(mark.oldId, mark);
  }
  return { done, startedConversation, startedMarks, newToOld: new Map(records.map((r) => [r.newId, r.oldId])) };
}

/** `limit` vale para a ordem inteira (os N primeiros); os já registrados saem em seguida. */
export function pendingTickets(order: readonly GabaritoTicket[], state: ResumeState, limit?: number): GabaritoTicket[] {
  const window = limit === undefined ? order : order.slice(0, limit);
  return window.filter((ticket) => !state.done.has(ticket.id));
}

// ---- tentativas em 503 -----------------------------------------------------------------------------------------

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [2000, 5000, 10000];

export type HttpResult = { status: number; body: unknown };

export async function withRetry503<R extends HttpResult>(
  run: () => Promise<R>,
  options: { sleep: (ms: number) => Promise<void>; delaysMs?: readonly number[] },
): Promise<{ response: R; attempts: number }> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const response = await run();
    const delay = delays[attempts - 1];
    if (response.status !== 503 || delay === undefined) return { response, attempts };
    await options.sleep(delay);
  }
}

// ---- linha de comando ------------------------------------------------------------------------------------------

export const COMMANDS = [
  "export",
  "check",
  "wipe",
  "rebuild",
  "restore-state",
  "report",
  "restore-original",
  "create-project",
  "archive-project",
  "leave-one-out",
  "collect",
  "pairs",
  "ticket-list",
  "ticket-create",
  "ticket-update",
  "relations-rebuild",
] as const;
export type Command = (typeof COMMANDS)[number];

export type CliOptions = {
  org?: string;
  user?: string;
  project?: string;
  /** Obrigatório em todos os comandos, menos nos de ticket (`ticket-*`) e no que a tabela `REQUIRED` dispensa. */
  dir?: string;
  confirm?: string;
  limit?: number;
  key?: string;
  name?: string;
  fakeProviders?: boolean;
  /** `report`: lê a execução do `leave-one-out` em vez da do `rebuild`. */
  loo?: boolean;
  /** `collect` e `report --collect`: a variante da coleta (nome dos arquivos). Padrão `base`. */
  variant?: string;
  /** `collect`: roda também a coleta D (o Claude vê o esboço do projeto). */
  claudeOutline?: boolean;
  /** `collect`: o texto dos agrupadores nas coletas A, A− e B: o resumo do produto ou uma definição escrita pelo Claude. */
  groupText?: "summary" | "definition";
  /** `collect`: arquivo JSON `{ "<número>": "<descrição>" }` com descrições novas para o rascunho. */
  ticketDescriptions?: string;
  /** `report --collect`: compara as duas variantes (a primeira é a A). */
  compare?: [string, string];
  /** `report --collect --compare`: projeto da variante B (padrão: o mesmo de `--project`). */
  compareProject?: string;
  /** `report --collect --compare`: números dos agrupadores "de fase" no gabarito. */
  phaseGroups?: number[];
  /** `report`: lê a coleta do `collect` em vez da do `rebuild`. */
  collect?: boolean;
  /** `collect`: quantas vezes cada requisição do Jev é repetida com o payload idêntico (padrão 3; no `pairs`, 1). */
  repeats?: number;
  /** `report --pairs`: o relatório do comando `pairs`. */
  pairs?: boolean;
  /** `pairs`: continua um arquivo interrompido sem repetir o que já foi respondido. */
  resume?: boolean;
  /** `leave-one-out`: além da procura normal, duas procuras com escopo (no pai original e em outro agrupador do mesmo nível). */
  scopeCheck?: boolean;
  /** `leave-one-out`: importa o gabarito achatado (só tickets, todos na raiz) e mede a proposta de agrupador. */
  flat?: boolean;
  /** `ticket-list`: imprime JSON em vez da árvore em texto. */
  json?: boolean;
  /** `ticket-create` e `ticket-update`: título do ticket. */
  title?: string;
  /** `ticket-create` e `ticket-update`: arquivo cujo conteúdo é a descrição. */
  descriptionFile?: string;
  /** `ticket-create` e `ticket-update`: número do ticket pai no projeto. */
  parent?: number;
  /** `ticket-create` e `ticket-update`: situação do ticket. */
  status?: TicketStatus;
  /** `ticket-update`: número do ticket a mudar. */
  number?: number;
  /** `ticket-update`: move o ticket para a raiz. */
  root?: boolean;
  /** `ticket-create`: cria uma ideia (ADR 0042). */
  idea?: boolean;
  /** `ticket-update`: estágio da ideia (`new`, `refining` ou `ready`). */
  ideaStage?: "new" | "refining" | "ready";
  /** `ticket-update`: aceita a ideia (a raiz). */
  ideaAccept?: boolean;
  /** `ticket-update`: descarta a ideia. */
  ideaDiscard?: boolean;
  /** `ticket-update`: transforma um ticket comum em ideia. */
  ideaMake?: boolean;
  role?: string;
  retryDelaysMs?: number[];
  fake503First?: number;
  fake503JudgeAt?: number;
  /** Ensaio do `leave-one-out`: interrompe o processo logo depois de remover o N-ésimo ticket desta execução. */
  looCrashAfterRemove?: number;
  /** Ensaio do `leave-one-out`: interrompe depois de gravar o rascunho do N-ésimo ticket (a conversa fica aberta). */
  looCrashAfterDraft?: number;
};

export type ParsedArgs = { ok: true; command: Command; options: CliOptions } | { ok: false; error: string };

const APP_REQUIRED = ["org", "user", "dir"] as const;
const REQUIRED: Record<Command, readonly (keyof CliOptions)[]> = {
  export: [...APP_REQUIRED, "project"],
  check: [...APP_REQUIRED, "project"],
  wipe: [...APP_REQUIRED, "project", "confirm"],
  rebuild: [...APP_REQUIRED, "project"],
  "restore-state": [...APP_REQUIRED, "project"],
  report: ["project", "dir"],
  "restore-original": [...APP_REQUIRED, "project"],
  "create-project": [...APP_REQUIRED, "key", "name"],
  "archive-project": [...APP_REQUIRED, "project"],
  "leave-one-out": [...APP_REQUIRED, "project"],
  collect: [...APP_REQUIRED, "project"],
  pairs: ["dir"],
  "ticket-list": ["org", "user", "project"],
  "ticket-create": ["org", "user", "project", "title"],
  "ticket-update": ["org", "user", "project", "number"],
  "relations-rebuild": ["org", "user", "project"],
};

export const TICKET_COMMANDS: readonly Command[] = ["ticket-list", "ticket-create", "ticket-update", "relations-rebuild"];
export const TICKET_STATUSES: readonly TicketStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];
/** Opções de cada comando de ticket, além de `--org`, `--user` e `--project`. */
const TICKET_OPTIONS: Record<string, readonly string[]> = {
  "ticket-list": ["json"],
  "ticket-create": ["title", "descriptionFile", "parent", "status", "idea"],
  "ticket-update": ["number", "title", "descriptionFile", "parent", "status", "root", "ideaStage", "ideaAccept", "ideaDiscard", "ideaMake"],
  "relations-rebuild": [],
};
const TICKET_ONLY = ["json", "title", "descriptionFile", "parent", "status", "number", "root", "idea", "ideaStage", "ideaAccept", "ideaDiscard", "ideaMake"] as const;
const IDEA_STAGES_CLI = ["new", "refining", "ready"] as const;

const FLAGS: Record<string, keyof CliOptions> = {
  "--org": "org",
  "--user": "user",
  "--project": "project",
  "--dir": "dir",
  "--confirm": "confirm",
  "--limit": "limit",
  "--key": "key",
  "--name": "name",
  "--fake-providers": "fakeProviders",
  "--loo": "loo",
  "--collect": "collect",
  "--pairs": "pairs",
  "--resume": "resume",
  "--repeats": "repeats",
  "--variant": "variant",
  "--claude-outline": "claudeOutline",
  "--group-text": "groupText",
  "--ticket-descriptions": "ticketDescriptions",
  "--compare": "compare",
  "--compare-project": "compareProject",
  "--phase-groups": "phaseGroups",
  "--scope-check": "scopeCheck",
  "--flat": "flat",
  "--json": "json",
  "--title": "title",
  "--description-file": "descriptionFile",
  "--parent": "parent",
  "--status": "status",
  "--number": "number",
  "--root": "root",
  "--idea": "idea",
  "--idea-stage": "ideaStage",
  "--idea-accept": "ideaAccept",
  "--idea-discard": "ideaDiscard",
  "--idea-make": "ideaMake",
  "--role": "role",
  "--retry-delays-ms": "retryDelaysMs",
  "--fake-503-first": "fake503First",
  "--fake-503-judge-at": "fake503JudgeAt",
  "--loo-crash-after-remove": "looCrashAfterRemove",
  "--loo-crash-after-draft": "looCrashAfterDraft",
};

const usage = `Comandos: ${COMMANDS.join(", ")}.
  pairs          --dir [--org <organização, obrigatório sem --fake-providers>] [--variant <nome>] [--limit N] [--repeats N] [--resume] [--fake-providers]
  report --pairs --dir [--variant <nome>]
  ticket-list    --org --user --project [--json]
  ticket-create  --org --user --project --title <texto> [--description-file <caminho>] [--parent <número>] [--status <situação> | --idea]
  ticket-update  --org --user --project --number <número> [--status <situação>] [--title <texto>] [--description-file <caminho>] [--parent <número> | --root] [--idea-stage <new|refining|ready>]
                 ou, sozinho no comando (uma coisa por vez): --idea-accept | --idea-discard | --idea-make
  relations-rebuild --org --user --project`;

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  const fail = (message: string): ParsedArgs => ({ ok: false, error: `${message}\n${usage}` });
  const [command, ...rest] = argv;
  if (!command || !(COMMANDS as readonly string[]).includes(command)) {
    return fail(command ? `Comando desconhecido: ${command}.` : "Informe um comando.");
  }
  const options: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i] as string;
    const key = FLAGS[flag];
    if (!key) return fail(`Opção desconhecida: ${flag}.`);
    if (key === "fakeProviders" || key === "loo" || key === "collect" || key === "pairs" || key === "resume" || key === "claudeOutline" || key === "scopeCheck" || key === "flat" || key === "json" || key === "root" || key === "idea" || key === "ideaAccept" || key === "ideaDiscard" || key === "ideaMake") {
      options[key] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) return fail(`A opção ${flag} precisa de um valor.`);
    if (key === "compare") {
      const second = rest[++i];
      if (second === undefined) return fail("--compare precisa de duas variantes.");
      options[key] = [value, second];
      continue;
    }
    if (key === "repeats") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) return fail(`${flag} deve ser um inteiro maior que zero.`);
      options[key] = parsed;
    } else if (key === "limit" || key === "fake503First" || key === "fake503JudgeAt" || key === "looCrashAfterRemove" || key === "looCrashAfterDraft") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return fail(`${flag} deve ser um número inteiro.`);
      options[key] = parsed;
    } else if (key === "parent" || key === "number") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) return fail(`${flag} deve ser o número de um ticket (inteiro maior que zero).`);
      options[key] = parsed;
    } else if (key === "retryDelaysMs") {
      const delays = value.split(",").map(Number);
      if (delays.some((n) => !Number.isFinite(n) || n < 0)) return fail(`${flag} deve ser uma lista de milissegundos.`);
      options[key] = delays;
    } else {
      options[key] = value;
    }
  }
  if (options["flat"] !== undefined && command !== "leave-one-out") return fail("--flat só existe no leave-one-out.");
  if (options["flat"] !== undefined && options["scopeCheck"] !== undefined) return fail("--flat não combina com --scope-check.");
  const variantOk = (name: unknown): boolean => typeof name === "string" && /^[a-z0-9-]+$/.test(name);
  if (options["variant"] !== undefined && !variantOk(options["variant"])) return fail("--variant só aceita letras minúsculas, dígitos e hífen.");
  const compare = options["compare"] as [string, string] | undefined;
  if (compare !== undefined && !(variantOk(compare[0]) && variantOk(compare[1]))) return fail("--compare só aceita variantes com letras minúsculas, dígitos e hífen.");
  if (options["groupText"] !== undefined && options["groupText"] !== "summary" && options["groupText"] !== "definition") return fail("--group-text é `summary` ou `definition`.");
  for (const key of ["claudeOutline", "groupText", "ticketDescriptions"]) {
    if (options[key] !== undefined && command !== "collect") return fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} só existe no collect.`);
  }
  if (options["variant"] !== undefined && command !== "collect" && command !== "pairs" && !(command === "report" && (options["collect"] !== undefined || options["pairs"] !== undefined))) {
    return fail("--variant só existe no collect, no pairs, no report --collect e no report --pairs.");
  }
  for (const key of ["compare", "compareProject", "phaseGroups"]) {
    if (options[key] !== undefined && !(command === "report" && options["collect"] !== undefined)) return fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} só existe no report --collect.`);
  }
  if ((options["compareProject"] !== undefined || options["phaseGroups"] !== undefined) && compare === undefined) return fail("--compare-project e --phase-groups dependem de --compare.");
  if (options["phaseGroups"] !== undefined) {
    const numbers = String(options["phaseGroups"]).split(",").map(Number);
    if (numbers.some((n) => !Number.isInteger(n) || n < 1)) return fail("--phase-groups deve ser uma lista de números de ticket separados por vírgula.");
    options["phaseGroups"] = numbers;
  }
  if (options["repeats"] !== undefined && command !== "collect" && command !== "pairs") return fail("--repeats só existe no collect e no pairs.");
  if (options["collect"] !== undefined && command !== "report") return fail("--collect só existe no report.");
  if (options["pairs"] !== undefined && command !== "report") return fail("--pairs só existe no report.");
  if (options["resume"] !== undefined && command !== "pairs") return fail("--resume só existe no pairs.");
  if (options["collect"] !== undefined && options["loo"] !== undefined) return fail("--collect não combina com --loo.");
  if (options["pairs"] !== undefined && (options["collect"] !== undefined || options["loo"] !== undefined)) return fail("--pairs não combina com --collect nem com --loo.");
  const ticketOptions = TICKET_OPTIONS[command] ?? [];
  for (const key of TICKET_ONLY) {
    if (options[key] !== undefined && !ticketOptions.includes(key)) {
      return fail(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} não existe no ${command}.`);
    }
  }
  if (options["status"] !== undefined && !(TICKET_STATUSES as readonly string[]).includes(options["status"] as string)) {
    return fail(`--status é uma de: ${TICKET_STATUSES.join(", ")}.`);
  }
  if (options["parent"] !== undefined && options["root"] !== undefined) return fail("--parent não combina com --root.");
  if (options["ideaStage"] !== undefined && !(IDEA_STAGES_CLI as readonly string[]).includes(options["ideaStage"] as string)) {
    return fail(`--idea-stage é uma de: ${IDEA_STAGES_CLI.join(", ")}.`);
  }
  if (options["idea"] !== undefined && options["status"] !== undefined) return fail("--idea não combina com --status: a situação de uma ideia é sempre todo.");
  if (command === "ticket-update" && options["number"] !== undefined) {
    const changes = ["status", "title", "descriptionFile", "parent", "root", "ideaStage"];
    const actions = ["ideaAccept", "ideaDiscard", "ideaMake"].filter((key) => options[key] !== undefined);
    if (actions.length > 0 && (actions.length > 1 || changes.some((key) => options[key] !== undefined))) {
      return fail("--idea-accept, --idea-discard e --idea-make valem sozinhos: uma coisa por comando.");
    }
    if (actions.length === 0 && !changes.some((key) => options[key] !== undefined)) {
      return fail("ticket-update pede ao menos um de --status, --title, --description-file, --parent, --root, --idea-stage, --idea-accept, --idea-discard ou --idea-make.");
    }
  }
  // `report --pairs` lê só os arquivos de `--dir`: o projeto vem do gabarito.
  const required = command === "report" && options["pairs"] !== undefined ? ["dir" as const] : REQUIRED[command as Command];
  const missing = required.filter((key) => options[key] === undefined);
  if (missing.length > 0) return fail(`Faltam opções para ${command}: ${missing.map((k) => `--${k}`).join(", ")}.`);
  return { ok: true, command: command as Command, options: options as CliOptions };
}

// ---- relatório -------------------------------------------------------------------------------------------------

export type Band = "low" | "mid" | "high";

/** Abaixo de 0,3 a procura para; de 0,3 a 0,7 fica na faixa do meio; acima de 0,7 desce. */
export function judgmentBand(belongs: number): Band {
  if (belongs < 0.3) return "low";
  if (belongs <= 0.7) return "mid";
  return "high";
}

const ACTION: Record<Band, "stopped" | "band" | "descended"> = { low: "stopped", mid: "band", high: "descended" };

export type GroupCounts = Record<PlacementGroup, number>;
const emptyCounts = (): GroupCounts => ({ same_parent: 0, deeper: 0, elsewhere: 0 });

const median = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

export type Stats = {
  total: number;
  groups: GroupCounts;
  byDepth: Record<number, GroupCounts>;
  uncertain: {
    oldId: string;
    title: string;
    destinationPath: string[];
    alternatives: string[][];
    alternativeWouldMatch: boolean;
  }[];
  /** `chosenPath` é `null` quando o registro foi retomado (a procura não foi registrada). */
  misplaced: { oldId: string; title: string; group: PlacementGroup; expectedPath: string[]; chosenPath: string[] | null }[];
  /** Registros retomados após interrupção: ficam fora das medianas de tempo. */
  resumed: number;
  claude: { ready: number; noDraft: number };
  timing: Record<Step, { median: number; max: number }> & { totalMs: number };
  belongsByBand: Record<Band, { hit: number; miss: number }>;
};

export function computeStats(gabarito: readonly GabaritoTicket[], records: readonly RunRecord[]): Stats {
  const byId = new Map(gabarito.map((x) => [x.id, x]));
  const pathTitles = (parentOldId: string | null): string[] => {
    const titles: string[] = [];
    for (let cursor = parentOldId, guard = 0; cursor !== null && guard <= byId.size; guard++) {
      const ticket = byId.get(cursor);
      if (!ticket) break;
      titles.unshift(ticket.title);
      cursor = ticket.parentId;
    }
    return titles;
  };

  const groups = emptyCounts();
  const byDepth: Record<number, GroupCounts> = {};
  const uncertain: Stats["uncertain"] = [];
  const misplaced: Stats["misplaced"] = [];
  const belongsByBand: Stats["belongsByBand"] = { low: { hit: 0, miss: 0 }, mid: { hit: 0, miss: 0 }, high: { hit: 0, miss: 0 } };
  let ready = 0;
  let noDraft = 0;

  for (const record of records) {
    groups[record.group] += 1;
    const depth = byId.get(record.oldId)?.depth ?? 0;
    (byDepth[depth] ??= emptyCounts())[record.group] += 1;
    if (record.uncertain) {
      uncertain.push({
        oldId: record.oldId,
        title: record.title,
        destinationPath: record.destinationPath.map((n) => n.title),
        alternatives: record.alternatives.map((a) => a.path.map((n) => n.title)),
        alternativeWouldMatch: record.alternatives.some((a) =>
          a.parentNewId === null ? record.expectedParentOldId === null : a.parentOldId === record.expectedParentOldId,
        ),
      });
    }
    if (record.group !== "same_parent") {
      misplaced.push({
        oldId: record.oldId,
        title: record.title,
        group: record.group,
        expectedPath: pathTitles(record.expectedParentOldId),
        chosenPath: record.resumed ? null : record.destinationPath.map((n) => n.title),
      });
    }
    if (record.claude.draftTitle === null) noDraft += 1;
    else if (record.claude.ready) ready += 1;
    for (const judgment of record.judgments) {
      belongsByBand[judgmentBand(judgment.belongs)][record.group === "same_parent" ? "hit" : "miss"] += 1;
    }
  }

  const timing = { totalMs: 0 } as Stats["timing"];
  const measured = records.filter((r) => !r.resumed);
  for (const step of STEPS) {
    const values = measured.map((r) => r.timingsMs[step]);
    timing[step] = { median: median(values), max: values.length ? Math.max(...values) : 0 };
    timing.totalMs += values.reduce((sum, v) => sum + v, 0);
  }

  return { total: records.length, groups, byDepth, uncertain, misplaced, resumed: records.length - measured.length, claude: { ready, noDraft }, timing, belongsByBand };
}

export type CalibrationRow = {
  oldId: string;
  title: string;
  current: string | null;
  belongs: number;
  topChoice: number;
  action: "descended" | "band" | "stopped";
  hit: boolean;
};

export function calibrationRows(records: readonly RunRecord[]): CalibrationRow[] {
  return records.flatMap((record) =>
    record.judgments.map((j) => ({
      oldId: record.oldId,
      title: record.title,
      current: j.current,
      belongs: j.belongs,
      topChoice: Math.max(0, ...Object.values(j.choice)),
      action: ACTION[judgmentBand(j.belongs)],
      hit: record.group === "same_parent",
    })),
  );
}

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\n/g, " ");
const pct = (n: number): string => n.toFixed(2);
const pathText = (titles: string[]): string => (titles.length === 0 ? "(raiz)" : titles.join(" › "));

const LABEL_TEXT: Record<JudgmentLabel, string> = {
  deveria_descer: "o pai esperado é um dos candidatos ou está dentro de um deles",
  deveria_parar: "o nó atual é o pai esperado",
  fora_do_caminho: "o nó atual não é o pai esperado nem ancestral dele",
};

export type RenderOptions = {
  /** Árvore em que a procura rodou; por padrão, a reconstruída a partir dos registros. */
  view?: TreeView;
  /** Relatório do `leave-one-out`. */
  loo?: boolean;
  /** Agrupadores criados sem procura (o `rebuild` os cria direto; o `leave-one-out` os importa). */
  groupsCreated?: number;
};

export function renderReport(
  gabarito: readonly GabaritoTicket[],
  recordedRecords: readonly RunRecord[],
  projectKey: string,
  options: RenderOptions = {},
): string {
  const view = options.view ?? rebuildView(gabarito, recordedRecords);
  // Não confia no `group` gravado: recalcula pelo caminho do destino e pela correspondência de ids.
  const records = recomputeGroups(recordedRecords, view);
  const stats = computeStats(gabarito, records);
  const lines: string[] = [];
  const out = (line = ""): void => void lines.push(line);

  out(`# Relatório ${options.loo ? "do leave-one-out" : "da reconstrução"} — ${projectKey}`);
  out();
  out("## Resumo");
  out();
  const ticketNodes = gabarito.filter((x) => x.kind === "ticket").length;
  const groupNodes = gabarito.length - ticketNodes;
  out(`Tickets no gabarito: ${ticketNodes}. Agrupadores no gabarito: ${groupNodes}.`);
  out();
  out(`- Tickets ${options.loo ? "medidos" : "reinseridos"} pela procura: ${stats.total}.`);
  out(`- Agrupadores criados sem procura: ${options.groupsCreated ?? 0}.`);
  out();
  out("| Grupo | Total |");
  out("| --- | ---: |");
  for (const group of GROUPS) out(`| ${group} | ${stats.groups[group]} |`);
  out();
  out("## Por profundidade");
  out();
  out("| Profundidade | same_parent | deeper | elsewhere |");
  out("| ---: | ---: | ---: | ---: |");
  for (const depth of Object.keys(stats.byDepth).map(Number).sort((a, b) => a - b)) {
    const counts = stats.byDepth[depth] as GroupCounts;
    out(`| ${depth} | ${counts.same_parent} | ${counts.deeper} | ${counts.elsewhere} |`);
  }
  out();
  out("## Incertos");
  out();
  out(`Quantidade: ${stats.uncertain.length}.`);
  for (const item of stats.uncertain) {
    out();
    out(`- **${cell(item.title)}** — destino aceito: ${pathText(item.destinationPath)}`);
    for (const alternative of item.alternatives) out(`  - alternativa: ${pathText(alternative)}`);
    out(`  - alguma alternativa bateria com o gabarito: ${item.alternativeWouldMatch ? "sim" : "não"}`);
  }
  out();
  out("## Fora do pai esperado");
  out();
  if (stats.misplaced.length === 0) out("Nenhum.");
  else {
    out("| Título | Grupo | Caminho esperado | Caminho escolhido |");
    out("| --- | --- | --- | --- |");
    for (const m of stats.misplaced) {
      out(`| ${cell(m.title)} | ${m.group} | ${cell(pathText(m.expectedPath))} | ${cell(m.chosenPath === null ? "(não registrado: retomado)" : pathText(m.chosenPath))} |`);
    }
  }
  out();
  out("## Calibração");
  out();
  const rows = calibrationRows(records);
  const labeled = labeledJudgments(records, view);
  if (rows.length === 0) out("Nenhum julgamento registrado.");
  else {
    out("| Ticket | Nó atual | Rótulo | belongs | Maior choice | A procura | Bateu com o gabarito |");
    out("| --- | --- | --- | ---: | ---: | --- | --- |");
    rows.forEach((row, index) => {
      const label = (labeled[index] as LabeledRow).label;
      out(`| ${cell(row.title)} | ${cell(row.current ?? "(raiz)")} | ${label} | ${pct(row.belongs)} | ${pct(row.topChoice)} | ${row.action} | ${row.hit ? "sim" : "não"} |`);
    });
  }
  out();
  out("## Rótulos dos julgamentos");
  out();
  if (labeled.length === 0) out("Nenhum julgamento registrado.");
  else {
    const byLabel = labelStats(labeled);
    const sentence = LABELS.map((label) => `\`${label}\`: ${LABEL_TEXT[label]}`).join("; ");
    out(`${sentence}.`);
    out();
    out("| Rótulo | Julgamentos | belongs < 0,3 | 0,3 a 0,7 | > 0,7 | Mediana de belongs |");
    out("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const label of LABELS) {
      const x = byLabel[label];
      out(`| ${label} | ${x.count} | ${x.bands.low} | ${x.bands.mid} | ${x.bands.high} | ${pct(x.medianBelongs)} |`);
    }
    const topChoice = byLabel.deveria_descer.topChoice;
    if (topChoice) {
      out();
      out("Em `deveria_descer`, o candidato mais votado do `Choice` era o certo (o pai esperado ou o candidato que o contém):");
      out();
      out(`- até 10 candidatos: ${topChoice.upTo10.right} de ${topChoice.upTo10.total}`);
      out(`- mais de 10 candidatos: ${topChoice.over10.right} de ${topChoice.over10.total}`);
    }
    const byTitle = labeled.filter((row) => row.byTitle).length;
    if (byTitle > 0) {
      out();
      out(`Aviso: ${byTitle} julgamento(s) estão sem ids (execução antiga ou nó atual não resolvido) e foram rotulados por título; títulos repetidos podem confundir o rótulo.`);
    }
  }
  out();
  out("## Faixas de belongs");
  out();
  out("| Faixa | Acertos | Erros |");
  out("| --- | ---: | ---: |");
  const labels: Record<Band, string> = { low: "abaixo de 0,3", mid: "de 0,3 a 0,7", high: "acima de 0,7" };
  for (const band of ["low", "mid", "high"] as const) {
    out(`| ${labels[band]} | ${stats.belongsByBand[band].hit} | ${stats.belongsByBand[band].miss} |`);
  }
  out();
  const scopeStats = scopeCheckStats(records);
  if (scopeStats.original.total + scopeStats.other.total > 0) {
    out("## Conferência do escopo");
    out();
    out("Cada ticket foi procurado também com o escopo no agrupador pai original e com o escopo em outro agrupador do mesmo nível. Fora do escopo: Noul do escopo abaixo de 0,3.");
    out();
    out("| Escopo | Procuras | Fora do escopo | Noul < 0,3 | 0,3 a 0,7 | > 0,7 | Sem Noul |");
    out("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [label, x] of [["Agrupador original", scopeStats.original], ["Outro agrupador", scopeStats.other]] as const) {
      out(`| ${label} | ${x.total} | ${x.outOfScope} | ${x.bands.low} | ${x.bands.mid} | ${x.bands.high} | ${x.unknown} |`);
    }
    out();
  }
  renderProposalSection(out, gabarito, records);
  out("## Rascunhos do Claude");
  out();
  out(`- Com \`ready\` verdadeiro: ${stats.claude.ready}`);
  out(`- Sem rascunho (pergunta): ${stats.claude.noDraft}`);
  out();
  out("## Tempos");
  out();
  out(`Total: ${(stats.timing.totalMs / 1000).toFixed(1)} s${stats.resumed > 0 ? ` (${stats.resumed} registro(s) retomado(s) ficam de fora dos tempos)` : ""}.`);
  out();
  out("| Passo | Mediana (ms) | Máximo (ms) |");
  out("| --- | ---: | ---: |");
  for (const step of STEPS) out(`| ${step} | ${stats.timing[step].median} | ${stats.timing[step].max} |`);
  out();
  return lines.join("\n");
}

// ---- árvore viva, grupos recalculados e rótulos dos julgamentos --------------------------------------------------

/** A árvore em que a procura rodou, em ids novos, mais a correspondência com os ids do gabarito. */
export type TreeView = {
  oldToNew: ReadonlyMap<string, string>;
  parentOfNew: ReadonlyMap<string, string | null>;
  titleOfNew: ReadonlyMap<string, string>;
};

const invert = (map: ReadonlyMap<string, string>): Map<string, string> => new Map([...map].map(([k, v]) => [v, k]));

/** Árvore do `rebuild`: o pai de cada ticket novo é o que a procura escolheu. */
export function rebuildView(
  gabarito: readonly GabaritoTicket[],
  records: readonly RunRecord[],
  /** Agrupadores criados sem procura (id do gabarito → id novo): entram na árvore com o pai que tinham no gabarito. */
  groupMap: ReadonlyMap<string, string> = new Map(),
): TreeView {
  const oldToNew = new Map(records.map((r) => [r.oldId, r.newId]));
  const parentOfNew = new Map(records.map((r) => [r.newId, r.chosenParentNewId]));
  const titleOfNew = new Map(records.map((r) => [r.newId, r.title]));
  for (const group of gabarito) {
    const id = groupMap.get(group.id);
    if (id === undefined) continue;
    oldToNew.set(group.id, id);
    parentOfNew.set(id, group.parentId === null ? null : (groupMap.get(group.parentId) ?? null));
    titleOfNew.set(id, group.title);
  }
  return { oldToNew, parentOfNew, titleOfNew };
}

/** Árvore do `leave-one-out`: a do gabarito, com os ids vivos. */
export function looView(gabarito: readonly GabaritoTicket[], oldToNew: ReadonlyMap<string, string>): TreeView {
  const parentOfNew = new Map<string, string | null>();
  const titleOfNew = new Map<string, string>();
  for (const ticket of gabarito) {
    const id = oldToNew.get(ticket.id);
    if (id === undefined) continue;
    parentOfNew.set(id, ticket.parentId === null ? null : (oldToNew.get(ticket.parentId) ?? null));
    titleOfNew.set(id, ticket.title);
  }
  return { oldToNew, parentOfNew, titleOfNew };
}

/** Recalcula `group` de cada registro a partir do caminho do destino e da correspondência de ids, sem confiar no gravado. */
export function recomputeGroups(records: readonly RunRecord[], view: TreeView): RunRecord[] {
  const newToOld = invert(view.oldToNew);
  return records.map((record) => ({
    ...record,
    group: classifyPlacement({
      expectedParentOldId: record.expectedParentOldId,
      chosenNewParentId: record.chosenParentNewId,
      destinationPath: record.destinationPath,
      newToOld,
    }),
  }));
}

export type JudgmentLabel = "deveria_descer" | "deveria_parar" | "fora_do_caminho";
export const LABELS: readonly JudgmentLabel[] = ["deveria_descer", "deveria_parar", "fora_do_caminho"];

/** O pai esperado e seus ancestrais (o esperado primeiro), na árvore em que a procura rodou. Vazio: o esperado é a raiz. */
export type ExpectedChain = { ids: string[]; titles: string[]; expectedIsRoot: boolean };

export function expectedChain(expectedParentOldId: string | null, view: TreeView): ExpectedChain {
  if (expectedParentOldId === null) return { ids: [], titles: [], expectedIsRoot: true };
  const ids: string[] = [];
  const titles: string[] = [];
  let cursor: string | null | undefined = view.oldToNew.get(expectedParentOldId);
  for (let guard = 0; cursor && guard <= view.parentOfNew.size; guard++) {
    ids.push(cursor);
    titles.push(view.titleOfNew.get(cursor) ?? "");
    cursor = view.parentOfNew.get(cursor);
  }
  return { ids, titles, expectedIsRoot: false };
}

export type LabeledJudgment = {
  label: JudgmentLabel;
  /** Rotulado por título porque o registro não tem ids (execução antiga). */
  byTitle: boolean;
  /** Só para `deveria_descer`: o candidato mais votado do `Choice` era o certo. `null` nos outros rótulos. */
  topChoiceRight: boolean | null;
  belongs: number;
  candidateCount: number;
};

/** Tira o sufixo ` [id]` que o invólucro põe em títulos repetidos. */
const stripSuffix = (key: string): string => key.replace(/ \[[^\]]+\]$/, "");

export function labelJudgment(judgment: JudgmentRecord, chain: ExpectedChain): LabeledJudgment {
  const byTitle = judgment.currentId === undefined || judgment.candidateIds === undefined;
  const keys = byTitle ? chain.titles : chain.ids;
  const currentKey = byTitle ? judgment.current : (judgment.currentId ?? null);
  const candidateKeys = byTitle ? Object.keys(judgment.choice).map(stripSuffix) : (judgment.candidateIds as string[]);
  const base = { byTitle, belongs: judgment.belongs, candidateCount: judgment.candidateIds?.length ?? judgment.candidateCount };

  const stop = chain.expectedIsRoot ? currentKey === null : currentKey !== null && currentKey === keys[0];
  if (stop) return { ...base, label: "deveria_parar", topChoiceRight: null };

  const isRight = (candidate: string): boolean => keys.includes(candidate);
  if (!chain.expectedIsRoot && candidateKeys.some(isRight)) {
    const votes: [string, number][] = byTitle
      ? Object.entries(judgment.choice).map(([key, p]) => [stripSuffix(key), p])
      : Object.entries(judgment.choiceById ?? {});
    const top = votes.reduce<[string, number] | null>((best, vote) => (best === null || vote[1] > best[1] ? vote : best), null);
    return { ...base, label: "deveria_descer", topChoiceRight: top === null ? null : isRight(top[0]) };
  }
  return { ...base, label: "fora_do_caminho", topChoiceRight: null };
}

export type LabeledRow = LabeledJudgment & { oldId: string; title: string; current: string | null };

export function labeledJudgments(records: readonly RunRecord[], view: TreeView): LabeledRow[] {
  return records.flatMap((record) => {
    const chain = expectedChain(record.expectedParentOldId, view);
    return record.judgments.map((judgment) => ({
      ...labelJudgment(judgment, chain),
      oldId: record.oldId,
      title: record.title,
      current: judgment.current,
    }));
  });
}

export type LabelStats = {
  count: number;
  bands: Record<Band, number>;
  medianBelongs: number;
  /** Só `deveria_descer`: acerto do candidato mais votado, por tamanho da lista. */
  topChoice?: { upTo10: { right: number; total: number }; over10: { right: number; total: number } };
};

export function labelStats(rows: readonly LabeledRow[]): Record<JudgmentLabel, LabelStats> {
  const result = {} as Record<JudgmentLabel, LabelStats>;
  for (const label of LABELS) {
    const own = rows.filter((row) => row.label === label);
    const bands: Record<Band, number> = { low: 0, mid: 0, high: 0 };
    for (const row of own) bands[judgmentBand(row.belongs)] += 1;
    const stats: LabelStats = { count: own.length, bands, medianBelongs: median(own.map((row) => row.belongs)) };
    if (label === "deveria_descer") {
      const tally = { upTo10: { right: 0, total: 0 }, over10: { right: 0, total: 0 } };
      for (const row of own) {
        if (row.topChoiceRight === null) continue;
        const bucket = row.candidateCount <= 10 ? tally.upTo10 : tally.over10;
        bucket.total += 1;
        if (row.topChoiceRight) bucket.right += 1;
      }
      stats.topChoice = tally;
    }
    result[label] = stats;
  }
  return result;
}

/** Descobre o id do nó atual do juiz entre os candidatos já vistos nesta procura (pelo título e pelo resumo). */
export function resolveCurrentId(
  current: { title: string; summary: string } | null,
  seen: readonly { id: string; title: string; summary: string }[],
): string | null | undefined {
  if (current === null) return null;
  for (let i = seen.length - 1; i >= 0; i--) {
    const candidate = seen[i] as { id: string; title: string; summary: string };
    if (candidate.title === current.title && candidate.summary === current.summary) return candidate.id;
  }
  return undefined;
}

// ---- leave-one-out ---------------------------------------------------------------------------------------------

/** Só os nós do tipo ticket (agrupador, vazio ou não, não é medido), na ordem do número original. */
export function looTickets(tickets: readonly GabaritoTicket[]): GabaritoTicket[] {
  return tickets.filter((x) => x.kind === "ticket").sort((a, b) => a.number - b.number);
}

/** `limit` vale para a lista inteira (as N primeiras folhas); as já registradas saem em seguida. */
export function pendingLoo(leaves: readonly GabaritoTicket[], doneOldIds: ReadonlySet<string>, limit?: number): GabaritoTicket[] {
  const window = limit === undefined ? leaves : leaves.slice(0, limit);
  return window.filter((ticket) => !doneOldIds.has(ticket.id));
}

export type LooMark = {
  oldId: string;
  title: string;
  /** Id do ticket no projeto no momento da marca (antes da remoção). */
  ticketId: string;
  expectedParentNewId: string | null;
  conversationId?: string;
};

/** Marcas sem resultado correspondente; vale a última marca de cada ticket. */
export function pendingMarks(marks: readonly LooMark[], resultOldIds: ReadonlySet<string>): LooMark[] {
  const latest = new Map<string, LooMark>();
  for (const mark of marks) latest.set(mark.oldId, mark);
  return [...latest.values()].filter((mark) => !resultOldIds.has(mark.oldId));
}

export type LooResume = { kind: "present"; ticketId: string } | { kind: "recreated"; ticketId: string } | { kind: "missing" };

/** O ticket da marca ainda existe (mesmo id), foi recriado (mesmo título e pai, outro id) ou sumiu? */
export function looResumeAction(mark: LooMark, live: readonly LiveTicket[]): LooResume {
  if (live.some((x) => x.id === mark.ticketId)) return { kind: "present", ticketId: mark.ticketId };
  const recreated = live.find((x) => x.title === mark.title && x.parentId === mark.expectedParentNewId);
  return recreated ? { kind: "recreated", ticketId: recreated.id } : { kind: "missing" };
}

// ---- conferência do escopo (leave-one-out --scope-check) ------------------------------------------------------------

export type ScopeCheckRecord = { scopeOldId: string; scopeTitle: string; fit: number | null; outOfScope: boolean };
export type ScopeCheckSummary = { total: number; outOfScope: number; bands: Record<Band, number>; unknown: number };

/** O agrupador seguinte do mesmo nível (mesma profundidade) na ordem do número; o primeiro, se o original for o último. */
export function otherScopeGroup(gabarito: readonly GabaritoTicket[], originalId: string): GabaritoTicket | null {
  const original = gabarito.find((x) => x.id === originalId);
  if (!original) return null;
  const level = gabarito.filter((x) => x.kind === "group" && x.depth === original.depth).sort((a, b) => a.number - b.number);
  if (level.length < 2) return null;
  const index = level.findIndex((x) => x.id === originalId);
  return level[(index + 1) % level.length] ?? null;
}

const emptySummary = (): ScopeCheckSummary => ({ total: 0, outOfScope: 0, bands: { low: 0, mid: 0, high: 0 }, unknown: 0 });

/** Quantos saíram como fora do escopo e a distribuição do Noul do escopo nas três faixas, por tipo de escopo. */
export function scopeCheckStats(records: readonly RunRecord[]): { original: ScopeCheckSummary; other: ScopeCheckSummary } {
  const result = { original: emptySummary(), other: emptySummary() };
  for (const record of records) {
    for (const kind of ["original", "other"] as const) {
      const check = record.scopeChecks?.[kind];
      if (!check) continue;
      const summary = result[kind];
      summary.total += 1;
      if (check.outOfScope) summary.outOfScope += 1;
      if (check.fit === null) summary.unknown += 1;
      else summary.bands[judgmentBand(check.fit)] += 1;
    }
  }
  return result;
}

// ---- proposta de agrupador (ADR 0031, passo 4) ------------------------------------------------------------------

export const PROPOSAL_REASONS = ["none_passed", "not_settled", "no_loose_tickets", "too_large", "same_as_destination", "invalid_name", "unavailable"] as const;

/** O gabarito achatado: só os nós do tipo ticket, todos na raiz do projeto, sem agrupadores, na ordem do número. */
export function flattenGabarito(tickets: readonly GabaritoTicket[]): GabaritoTicket[] {
  return tickets
    .filter((x) => x.kind === "ticket")
    .sort((a, b) => a.number - b.number)
    .map((x) => ({ ...x, parentId: null, depth: 0 }));
}

export type PairLabel = "same_group" | "other_group" | "unlabeled";
export type PairBands = Record<Band, number> & { total: number };
export type AffinityTicketStats = {
  oldId: string;
  title: string;
  proposed: boolean;
  /** Do grupo proposto, quantos eram do mesmo agrupador do ticket no gabarito e quantos não. */
  same: number;
  other: number;
  /** Quantos outros tickets do agrupador original ficaram fora do grupo proposto. */
  leftOut: number;
  proposedTitle: string | null;
  originalTitle: string | null;
};
export type AffinityStats = {
  flat: boolean;
  /** Procuras que registraram a afinidade. */
  searches: number;
  proposals: number;
  reasons: Record<(typeof PROPOSAL_REASONS)[number], number>;
  pairs: Record<PairLabel, PairBands> & { labeled: boolean };
  perTicket: AffinityTicketStats[];
};

const emptyBands = (): PairBands => ({ low: 0, mid: 0, high: 0, total: 0 });

/**
 * Números da seção "Proposta de agrupador". `parentOf` devolve o agrupador do ticket no gabarito original (`null`: raiz;
 * `undefined`: ticket desconhecido). Só a execução `--flat` rotula os pares e fala de ticket por ticket.
 */
export function affinityStats(
  records: readonly RunRecord[],
  parentOf: (oldId: string) => string | null | undefined,
  flat: boolean,
  groupTitle: (groupOldId: string) => string | undefined = () => undefined,
  ticketsOfGroup: (groupOldId: string) => readonly string[] = () => [],
): AffinityStats {
  const reasons = Object.fromEntries(PROPOSAL_REASONS.map((r) => [r, 0])) as AffinityStats["reasons"];
  const pairs: AffinityStats["pairs"] = { same_group: emptyBands(), other_group: emptyBands(), unlabeled: emptyBands(), labeled: flat };
  const perTicket: AffinityTicketStats[] = [];
  let searches = 0;
  let proposals = 0;
  for (const record of records) {
    const affinity = record.affinity;
    if (!affinity) continue;
    searches += 1;
    if (affinity.proposal) proposals += 1;
    else reasons[(affinity.skipped ?? "none_passed") as keyof typeof reasons] += 1;
    const own = parentOf(record.oldId) ?? null;
    for (const pair of affinity.pairs) {
      const label: PairLabel = !flat ? "unlabeled" : own !== null && parentOf(pair.ticketOldId) === own ? "same_group" : "other_group";
      const bucket = pairs[label];
      bucket[judgmentBand(pair.noul)] += 1;
      bucket.total += 1;
    }
    if (!flat) continue;
    const members = new Set(affinity.proposal?.ticketOldIds ?? []);
    const same = [...members].filter((id) => own !== null && parentOf(id) === own).length;
    const mates = own === null ? [] : ticketsOfGroup(own).filter((id) => id !== record.oldId);
    perTicket.push({
      oldId: record.oldId,
      title: record.title,
      proposed: affinity.proposal !== null,
      same,
      other: members.size - same,
      leftOut: mates.filter((id) => !members.has(id)).length,
      proposedTitle: affinity.proposal?.title ?? null,
      originalTitle: own === null ? null : (groupTitle(own) ?? null),
    });
  }
  return { flat, searches, proposals, reasons, pairs, perTicket };
}

const PAIR_LABEL_TEXT: Record<PairLabel, string> = {
  same_group: "Mesmo agrupador no gabarito",
  other_group: "Outro agrupador no gabarito",
  unlabeled: "Sem rótulo",
};

function renderProposalSection(out: (line?: string) => void, gabarito: readonly GabaritoTicket[], records: readonly RunRecord[]): void {
  const byId = new Map(gabarito.map((x) => [x.id, x]));
  const flat = records.some((r) => r.flat === true);
  const stats = affinityStats(
    records,
    (id) => (byId.has(id) ? (byId.get(id)?.parentId ?? null) : undefined),
    flat,
    (id) => byId.get(id)?.title,
    (id) => gabarito.filter((x) => x.parentId === id && x.kind === "ticket").map((x) => x.id),
  );
  out("## Proposta de agrupador");
  out();
  if (stats.searches === 0) {
    out("Nenhuma procura registrou a afinidade (execução anterior à proposta de agrupador).");
    out();
    return;
  }
  out(`Procuras com afinidade: ${stats.searches}. Com proposta: ${stats.proposals}.`);
  out();
  out("| Motivo de não haver proposta | Procuras |");
  out("| --- | ---: |");
  for (const reason of PROPOSAL_REASONS) out(`| ${reason} | ${stats.reasons[reason]} |`);
  out();
  out(`Pares julgados${stats.pairs.labeled ? ", rotulados por terem ou não o mesmo agrupador no gabarito" : " (execução normal: sem rótulo)"}. Noul por faixa:`);
  out();
  out("| Pares | Total | < 0,3 | 0,3 a 0,7 | > 0,7 |");
  out("| --- | ---: | ---: | ---: | ---: |");
  for (const label of stats.pairs.labeled ? (["same_group", "other_group"] as const) : (["unlabeled"] as const)) {
    const x = stats.pairs[label];
    out(`| ${PAIR_LABEL_TEXT[label]} | ${x.total} | ${x.low} | ${x.mid} | ${x.high} |`);
  }
  out();
  if (!stats.flat) return;
  out("### Por ticket");
  out();
  out("| Ticket | Proposta | Do mesmo agrupador | De outro | Do original, de fora |");
  out("| --- | --- | ---: | ---: | ---: |");
  for (const t of stats.perTicket) out(`| ${cell(t.title)} | ${t.proposed ? "sim" : "não"} | ${t.same} | ${t.other} | ${t.leftOut} |`);
  out();
  out("### Títulos propostos");
  out();
  const named = stats.perTicket.filter((t) => t.proposedTitle !== null);
  if (named.length === 0) out("Nenhum.");
  else {
    out("| Ticket | Título proposto pelo Claude | Agrupador original |");
    out("| --- | --- | --- |");
    for (const t of named) out(`| ${cell(t.title)} | ${cell(t.proposedTitle as string)} | ${cell(t.originalTitle ?? "(raiz)")} |`);
  }
  out();
}
