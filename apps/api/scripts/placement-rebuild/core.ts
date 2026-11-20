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
    if (found.status !== expected.status) problems.push(`${expected.id}: situação diferente`);
    if (found.kind !== undefined && found.kind !== expected.kind) problems.push(`${expected.id}: tipo diferente`);
  }
  for (const extra of live) if (!knownIds.has(extra.id)) problems.push(`${extra.id}: a mais no projeto`);
  return problems;
}

export type ImportItem = { title: string; description?: string; status?: TicketStatus; kind?: NodeKind; children?: ImportItem[] };

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
      const item: ImportItem = { title: ticket.title, description: ticket.description, kind: ticket.kind };
      if (ticket.status !== null) item.status = ticket.status;
      const children = build(ticket.id);
      if (children.length > 0) item.children = children;
      return item;
    });
  return { items: build(null), order };
}

/**
 * Preenche o tipo de cada nó. Gabarito antigo (sem `kind`): quem tem filhos é agrupador. Um `ticket` declarado
 * com filhos é um gabarito inválido.
 */
export function resolveKinds<T extends { id: string; parentId: string | null; kind?: NodeKind | undefined }>(
  tickets: readonly T[],
): (T & { kind: NodeKind })[] {
  const parents = new Set(tickets.map((x) => x.parentId).filter((id): id is string => id !== null));
  return tickets.map((x) => {
    const hasChildren = parents.has(x.id);
    if (x.kind === "ticket" && hasChildren) throw new Error(`O ticket ${x.id} do gabarito tem filhos; só agrupador tem filhos.`);
    return { ...x, kind: x.kind ?? (hasChildren ? "group" : "ticket") };
  });
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
] as const;
export type Command = (typeof COMMANDS)[number];

export type CliOptions = {
  org?: string;
  user?: string;
  project?: string;
  dir: string;
  confirm?: string;
  limit?: number;
  key?: string;
  name?: string;
  fakeProviders?: boolean;
  /** `report`: lê a execução do `leave-one-out` em vez da do `rebuild`. */
  loo?: boolean;
  /** `leave-one-out`: além da procura normal, duas procuras com escopo (no pai original e em outro agrupador do mesmo nível). */
  scopeCheck?: boolean;
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
};

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
  "--scope-check": "scopeCheck",
  "--role": "role",
  "--retry-delays-ms": "retryDelaysMs",
  "--fake-503-first": "fake503First",
  "--fake-503-judge-at": "fake503JudgeAt",
  "--loo-crash-after-remove": "looCrashAfterRemove",
  "--loo-crash-after-draft": "looCrashAfterDraft",
};

const usage = `Comandos: ${COMMANDS.join(", ")}.`;

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
    if (key === "fakeProviders" || key === "loo" || key === "scopeCheck") {
      options[key] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) return fail(`A opção ${flag} precisa de um valor.`);
    if (key === "limit" || key === "fake503First" || key === "fake503JudgeAt" || key === "looCrashAfterRemove" || key === "looCrashAfterDraft") {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) return fail(`${flag} deve ser um número inteiro.`);
      options[key] = parsed;
    } else if (key === "retryDelaysMs") {
      const delays = value.split(",").map(Number);
      if (delays.some((n) => !Number.isFinite(n) || n < 0)) return fail(`${flag} deve ser uma lista de milissegundos.`);
      options[key] = delays;
    } else {
      options[key] = value;
    }
  }
  const missing = REQUIRED[command as Command].filter((key) => options[key] === undefined);
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
