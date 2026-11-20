/**
 * Parte pura da ferramenta de reconstrução (ADR 0030): ordem de inserção e de remoção, classificação do
 * resultado nos três grupos, retomada, tentativas em 503, comparação de árvores, argumentos da linha de comando
 * e números do relatório. Nada aqui fala com rede, banco ou disco.
 */

// ---- tipos -----------------------------------------------------------------------------------------------------

export type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

export type GabaritoTicket = {
  id: string;
  number: number;
  key: string;
  title: string;
  /** Descrição inteira (a rota de lista só devolve um trecho). */
  description: string;
  /** `null` para quem tem filhos (não tem situação própria). */
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
  candidateCount: number;
  belongs: number;
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
};

export type StartedMark = { oldId: string; conversationId: string };

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

export function classifyPlacement(input: {
  expectedParentOldId: string | null;
  chosenNewParentId: string | null;
  newToOld: ReadonlyMap<string, string>;
  oldParents: ReadonlyMap<string, string | null>;
}): PlacementGroup {
  const { expectedParentOldId: expected, chosenNewParentId: chosen, newToOld, oldParents } = input;
  if (chosen === null) return expected === null ? "same_parent" : "elsewhere";
  const chosenOld = newToOld.get(chosen);
  if (chosenOld === undefined) return "elsewhere";
  if (chosenOld === expected) return "same_parent";
  if (expected === null) return "deeper"; // a raiz é ancestral de qualquer ticket
  let cursor = oldParents.get(chosenOld) ?? null;
  for (let guard = 0; cursor !== null && guard <= oldParents.size; guard++) {
    if (cursor === expected) return "deeper";
    cursor = oldParents.get(cursor) ?? null;
  }
  return "elsewhere";
}

export type LiveTicket = { id: string; title: string; parentId: string | null; status: string | null };

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

// ---- retomada --------------------------------------------------------------------------------------------------

export type ResumeState = {
  done: Set<string>;
  startedConversation: Map<string, string>;
  newToOld: Map<string, string>;
};

export function resumeState(records: readonly RunRecord[], started: readonly StartedMark[]): ResumeState {
  const done = new Set(records.map((r) => r.oldId));
  const startedConversation = new Map<string, string>();
  for (const mark of started) if (!done.has(mark.oldId)) startedConversation.set(mark.oldId, mark.conversationId);
  return { done, startedConversation, newToOld: new Map(records.map((r) => [r.newId, r.oldId])) };
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
  role?: string;
  retryDelaysMs?: number[];
  fake503First?: number;
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
  "--role": "role",
  "--retry-delays-ms": "retryDelaysMs",
  "--fake-503-first": "fake503First",
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
    if (key === "fakeProviders") {
      options[key] = true;
      continue;
    }
    const value = rest[++i];
    if (value === undefined) return fail(`A opção ${flag} precisa de um valor.`);
    if (key === "limit" || key === "fake503First") {
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
  misplaced: { oldId: string; title: string; group: PlacementGroup; expectedPath: string[]; chosenPath: string[] }[];
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
        chosenPath: record.destinationPath.map((n) => n.title),
      });
    }
    if (record.claude.draftTitle === null) noDraft += 1;
    else if (record.claude.ready) ready += 1;
    for (const judgment of record.judgments) {
      belongsByBand[judgmentBand(judgment.belongs)][record.group === "same_parent" ? "hit" : "miss"] += 1;
    }
  }

  const timing = { totalMs: 0 } as Stats["timing"];
  for (const step of STEPS) {
    const values = records.map((r) => r.timingsMs[step]);
    timing[step] = { median: median(values), max: values.length ? Math.max(...values) : 0 };
    timing.totalMs += values.reduce((sum, v) => sum + v, 0);
  }

  return { total: records.length, groups, byDepth, uncertain, misplaced, claude: { ready, noDraft }, timing, belongsByBand };
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

export function renderReport(gabarito: readonly GabaritoTicket[], records: readonly RunRecord[], projectKey: string): string {
  const stats = computeStats(gabarito, records);
  const lines: string[] = [];
  const out = (line = ""): void => void lines.push(line);

  out(`# Relatório da reconstrução — ${projectKey}`);
  out();
  out("## Resumo");
  out();
  out(`Tickets no gabarito: ${gabarito.length}. Reinseridos: ${stats.total}.`);
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
      out(`| ${cell(m.title)} | ${m.group} | ${cell(pathText(m.expectedPath))} | ${cell(pathText(m.chosenPath))} |`);
    }
  }
  out();
  out("## Calibração");
  out();
  const rows = calibrationRows(records);
  if (rows.length === 0) out("Nenhum julgamento registrado.");
  else {
    out("| Ticket | Nó atual | belongs | Maior choice | A procura | Bateu com o gabarito |");
    out("| --- | --- | ---: | ---: | --- | --- |");
    for (const row of rows) {
      out(`| ${cell(row.title)} | ${cell(row.current ?? "(raiz)")} | ${pct(row.belongs)} | ${pct(row.topChoice)} | ${row.action} | ${row.hit ? "sim" : "não"} |`);
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
  out("## Rascunhos do Claude");
  out();
  out(`- Com \`ready\` verdadeiro: ${stats.claude.ready}`);
  out(`- Sem rascunho (pergunta): ${stats.claude.noDraft}`);
  out();
  out("## Tempos");
  out();
  out(`Total: ${(stats.timing.totalMs / 1000).toFixed(1)} s.`);
  out();
  out("| Passo | Mediana (ms) | Máximo (ms) |");
  out("| --- | ---: | ---: |");
  for (const step of STEPS) out(`| ${step} | ${stats.timing[step].median} | ${stats.timing[step].max} |`);
  out();
  return lines.join("\n");
}
