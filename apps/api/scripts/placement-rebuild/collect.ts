/**
 * Comando `collect` (ferramenta de medição): para cada ticket do gabarito, tira-o do projeto e coleta, no nível da raiz,
 * os julgamentos do Jev (A, A−, B) e do Claude (D); depois devolve o ticket ao lugar original. Nada do produto muda.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { Logger } from "@nestjs/common";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { CLAUDE_MODEL, FALLBACK_BETA, MAX_TOKENS, callClaude } from "../../src/assistant/claude-call.js";
import { AssistantUnavailableError } from "../../src/assistant/ports.js";
import type { BranchCandidate } from "../../src/assistant/ports.js";
import { describeFailure, expectOk } from "./client.js";
import { DefinitionCache } from "./collect-definitions.js";
import { definitionFormat, definitionInputs, definitionKey, definitionMessage, validateDefinition } from "./collect-requests.js";
import type { DefinitionInput } from "./collect-requests.js";
import { buildClaudeProject, buildFitRequest, buildOutline, rankingFormat, validateRanking } from "./collect-requests.js";
import { renderCompareReport } from "./collect-compare.js";
import { DEFAULT_VARIANT, compareFileName, renderCollectReport, variantFileName } from "./collect-core.js";
import type { ClaudeResult, CollectRecord, CollectRep, FitRep } from "./collect-core.js";
import { CLAUDE_SYSTEM_PROMPT, DEFINITION_SYSTEM_PROMPT } from "./collect-texts.js";
import {
  importGabarito,
  liveFor,
  listTickets,
  looTreeProblems,
  makeCaller,
  readGabarito,
  readJsonLines,
  readLooMap,
  restoreMissing,
  withOriginalDescription,
  looMapPath,
} from "./commands.js";
import type { Context, Conversation, Detail, Outcome, Summary, Timings } from "./commands.js";
import { DEFAULT_RETRY_DELAYS_MS, looResumeAction, looTickets, pendingLoo, pendingMarks } from "./core.js";
import type { Gabarito, GabaritoTicket, LooMark } from "./core.js";

export const collectPath = (dir: string, projectId: string, variant: string): string => join(dir, variantFileName("collect", projectId, variant));
const collectStatePath = (dir: string, projectId: string, variant: string): string => join(dir, variantFileName("collect-state", projectId, variant));
const definitionsPath = (dir: string, projectId: string): string => join(dir, `definitions-${projectId}.json`);
export const collectMapPath = (dir: string, projectId: string): string => join(dir, `collect-map-${projectId}.json`);
export const collectReportPath = (dir: string, projectId: string, variant: string): string => join(dir, variantFileName("report-collect", projectId, variant));

const DEFAULT_REPEATS = 3;
/** Mesmo prazo por tentativa que o juiz do produto usa com o Jev. */
const JEV_TIMEOUT_MS = 20_000;
const CLAUDE_TIMEOUT_MS = 60_000;
const logger = new Logger("Collect");

const readMap = (path: string): Map<string, string> => new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>));
const writeMap = (path: string, map: ReadonlyMap<string, string>): void => writeFileSync(path, JSON.stringify(Object.fromEntries(map), null, 2));

/** Tentativas em falha do provedor (as mesmas esperas do 503 das outras rotas); esgotadas, pede para rodar de novo. */
export async function withProvider<T>(ctx: Pick<Context, "sleep" | "retryDelaysMs">, what: string, run: () => Promise<T>): Promise<T> {
  const delays = ctx.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof AssistantUnavailableError)) throw error;
      if (attempt >= delays.length) {
        throw new Error(`${what}: provedor indisponível (${error.reason}) depois de ${attempt + 1} tentativas; rode de novo para continuar.`);
      }
      await ctx.sleep(delays[attempt] as number);
    }
  }
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await run();
  return { value, ms: Math.round(performance.now() - started) };
}

const rootAncestor = (ticket: GabaritoTicket, byId: ReadonlyMap<string, GabaritoTicket>): string | null => {
  let cursor: GabaritoTicket = ticket;
  while (cursor.parentId !== null) cursor = byId.get(cursor.parentId) as GabaritoTicket;
  return cursor.id === ticket.id ? null : cursor.id;
};

export async function collectCommand(ctx: Context, limit: number | undefined): Promise<boolean> {
  const kit = ctx.collectKit;
  if (!kit) throw new Error("O collect precisa do kit de coleta do app.");
  const repeats = ctx.repeats ?? DEFAULT_REPEATS;
  const gabarito = readGabarito(ctx.dir);
  const byId = new Map(gabarito.tickets.map((t) => [t.id, t]));
  const rootGroups = gabarito.tickets.filter((t) => t.kind === "group" && t.parentId === null).sort((a, b) => a.number - b.number);
  if (rootGroups.length === 0) throw new Error("O gabarito não tem agrupador na raiz; não há o que medir.");
  const variant = ctx.variant ?? DEFAULT_VARIANT;
  const descriptions = readDescriptions(ctx.ticketDescriptionsPath, gabarito);
  const cache = new DefinitionCache(readDefinitions(definitionsPath(ctx.dir, ctx.project)), (entries) =>
    writeFileSync(definitionsPath(ctx.dir, ctx.project), JSON.stringify(entries, null, 2)),
  );
  const results = readJsonLines<CollectRecord>(collectPath(ctx.dir, ctx.project, variant));

  // 1. a árvore do gabarito no projeto: a desta execução, a de um `leave-one-out` que terminou, ou a importação (projeto vazio)
  const mapPath = collectMapPath(ctx.dir, ctx.project);
  let map: Map<string, string>;
  if (existsSync(mapPath)) {
    map = readMap(mapPath);
  } else if (existsSync(looMapPath(ctx.dir, ctx.project))) {
    map = readLooMap(ctx.dir, ctx.project);
    const problems = await looTreeProblems(ctx, gabarito, map);
    if (problems.length > 0) throw new Error(`O projeto não confere com o mapa do leave-one-out (${problems.length} diferença(s)); recuso coletar.`);
    writeMap(mapPath, map);
  } else {
    const { created, order } = await importGabarito(ctx, gabarito);
    map = new Map(order.map((oldId, index) => [oldId, (created[index] as Summary).id]));
    writeMap(mapPath, map);
    // A importação não leva as pessoas: o projeto fica como o gabarito antes de qualquer remoção.
    for (const [oldId, newId] of map) {
      for (const personId of byId.get(oldId)?.assigneeIds ?? []) {
        expectOk("atribuir pessoa", await ctx.client.request("PUT", `/tickets/${newId}/assignees/${personId}`));
      }
    }
  }
  const saveMap = (): void => writeMap(mapPath, map);
  const done = new Set(results.map((r) => r.oldId));

  // 2. retomada: um ticket removido e não recolocado volta ao pai original (com situação e pessoas) antes de qualquer outra coisa
  const pending = pendingMarks(readJsonLines<LooMark>(collectStatePath(ctx.dir, ctx.project, variant)), done);
  if (pending.length > 0) {
    const live = liveFor(await listTickets(ctx));
    for (const mark of pending) {
      const action = looResumeAction(mark, live);
      const original = byId.get(mark.oldId) as GabaritoTicket;
      if (action.kind === "present") {
        ctx.log(`Retomada: "${mark.oldId}" ainda está no projeto; será refeito.`);
      } else if (action.kind === "recreated") {
        map.set(mark.oldId, action.ticketId);
        saveMap();
        ctx.log(`Retomada: "${mark.oldId}" já tinha sido recriado; será refeito.`);
      } else {
        const restoredId = await restoreMissing(ctx, original, mark);
        await restoreStateOf(ctx, restoredId, original);
        map.set(mark.oldId, restoredId);
        saveMap();
        ctx.log(`Retomada: "${mark.oldId}" estava removido; recriado no pai original.`);
      }
    }
  }

  // 3. um ticket por vez
  const tickets = looTickets(gabarito.tickets);
  const todo = pendingLoo(tickets, done, limit);
  ctx.log(`Tickets: ${tickets.length}; já coletados: ${done.size}; a coletar agora: ${todo.length}; repetições: ${repeats}.`);
  let removedThisRun = 0;
  let position = 0;
  for (const ticket of todo) {
    position += 1;
    const originalGroupId = rootAncestor(ticket, byId);
    const groupIds = rootGroups.map((g) => g.id);
    if (originalGroupId === null) {
      // Ticket solto na raiz: não tem agrupador original, fica fora das contas e nem sai do projeto.
      const record: CollectRecord = { oldId: ticket.id, number: ticket.number, title: ticket.title, originalGroupId: null, groupIds, a: [], aNeg: null, b: [], d: null, dNeg: null };
      appendFileSync(collectPath(ctx.dir, ctx.project, variant), `${JSON.stringify(record)}\n`);
      done.add(ticket.id);
      ctx.log(`[${position}/${todo.length}] ticket ${ticket.number}: solto na raiz, pulado`);
      continue;
    }
    const expectedParentNewId = ticket.parentId === null ? null : (map.get(ticket.parentId) as string);
    const mark: LooMark = { oldId: ticket.id, title: ticket.title, ticketId: map.get(ticket.id) as string, expectedParentNewId };
    appendFileSync(collectStatePath(ctx.dir, ctx.project, variant), `${JSON.stringify(mark)}\n`);
    const removal = await ctx.client.request("DELETE", `/tickets/${mark.ticketId}`);
    if (removal.status !== 204) throw new Error(describeFailure("remover ticket", removal));
    removedThisRun += 1;
    if (ctx.looCrashAfterRemove !== undefined && removedThisRun === ctx.looCrashAfterRemove) {
      throw new Error("Interrupção de ensaio: o processo parou depois de remover o ticket e antes de recolocá-lo.");
    }
    const { record, newId } = await collectOne(
      { ctx, kit, gabarito, cache, variant, draftDescription: descriptions.get(ticket.number) ?? ticket.description },
      ticket,
      mark,
      expectedParentNewId,
      map,
      originalGroupId,
      repeats,
      ctx.looCrashAfterDraft === removedThisRun,
    );
    map.set(ticket.id, newId);
    saveMap();
    appendFileSync(collectPath(ctx.dir, ctx.project, variant), `${JSON.stringify(record)}\n`);
    done.add(ticket.id);
    ctx.log(`[${position}/${todo.length}] ticket ${ticket.number}: coletado (${repeats} repetição(ões))`);
  }

  // 4. o projeto tem de estar igual ao gabarito: árvore, situações e pessoas
  const problems = await finalProblems(ctx, gabarito, map, done);
  if (problems.length === 0) {
    ctx.log("Collect: o projeto está igual ao gabarito (tickets no lugar, situações e pessoas).");
    return true;
  }
  ctx.log(`Collect: o projeto NÃO confere com o gabarito (${problems.length} diferença(s)).`);
  for (const problem of problems.slice(0, 20)) ctx.log(`  ${problem}`);
  return false;
}

/** Situação e pessoas do gabarito num ticket recriado (a recriação pela conversa nasce `todo` e sem pessoas). */
async function restoreStateOf(ctx: Context, newId: string, original: GabaritoTicket): Promise<void> {
  if (original.status !== null && original.status !== "todo") {
    expectOk("aplicar situação", await ctx.client.request("PATCH", `/tickets/${newId}`, { status: original.status }));
  }
  for (const personId of original.assigneeIds) {
    expectOk("atribuir pessoa", await ctx.client.request("PUT", `/tickets/${newId}/assignees/${personId}`));
  }
}

type OneContext = {
  ctx: Context;
  kit: NonNullable<Context["collectKit"]>;
  gabarito: Gabarito;
  cache: DefinitionCache;
  variant: string;
  /** A descrição do rascunho que as coletas usam (a do `--ticket-descriptions` ou a original). */
  draftDescription: string;
};

/** Descrições novas por número do ticket; número que não existe ou é de agrupador é erro, antes de qualquer remoção. */
function readDescriptions(path: string | undefined, gabarito: Gabarito): Map<number, string> {
  if (path === undefined) return new Map();
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("--ticket-descriptions: o arquivo precisa ser um objeto { número: descrição }.");
  const result = new Map<number, string>();
  for (const [key, value] of Object.entries(raw)) {
    const node = gabarito.tickets.find((t) => String(t.number) === key);
    if (!node) throw new Error(`--ticket-descriptions: o número ${key} não existe no gabarito.`);
    if (node.kind !== "ticket") throw new Error(`--ticket-descriptions: o número ${key} é de agrupador, não de ticket.`);
    if (typeof value !== "string") throw new Error(`--ticket-descriptions: a descrição do número ${key} precisa ser texto.`);
    result.set(node.number, value);
  }
  return result;
}

function readDefinitions(path: string): Record<string, string> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
}

/** Uma definição (do cache ou pelo Claude); inválida, devolve `null` e o chamador usa o resumo do produto. */
async function definitionFor(one: OneContext, input: DefinitionInput): Promise<string | null> {
  const { definition } = await one.cache.get(definitionKey(input), async () => {
    const params = {
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      output_config: { effort: "low", format: zodOutputFormat(definitionFormat) },
      system: [{ type: "text", text: DEFINITION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: definitionMessage(input) }],
    } as unknown as Parameters<typeof callClaude>[1];
    const final = await withProvider(one.ctx, "definição", () => callClaude(one.kit.claude, params, CLAUDE_TIMEOUT_MS, logger));
    const raw = final.parsed_output as { definition?: unknown } | null;
    // Guarda o texto como veio (mesmo inválido): a mesma entrada não é paga duas vezes.
    return final.stop_reason === "end_turn" && typeof raw?.definition === "string" ? raw.definition : "";
  });
  const checked = validateDefinition({ definition });
  return checked.ok ? checked.definition : null;
}

async function collectOne(
  one: OneContext,
  ticket: GabaritoTicket,
  mark: LooMark,
  expectedParentNewId: string | null,
  map: ReadonlyMap<string, string>,
  originalGroupId: string,
  repeats: number,
  crashAfterDraft: boolean,
): Promise<{ record: CollectRecord; newId: string }> {
  const { ctx, kit, gabarito, variant } = one;
  const timingsMs: Timings = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const attempts: Timings = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const call = makeCaller(ctx, timingsMs, attempts);

  // O caminho do produto que reescreve os resumos vencidos é a rota da procura; ela pede uma conversa, mas aqui o turno
  // do Claude não existe (a conversa do app não chama provedor). A conversa guarda a descrição ORIGINAL: é ela que volta ao projeto.
  const conversation = await call<Conversation>("open", "abrir conversa", () =>
    ctx.client.request("POST", `/projects/${ctx.project}/ticket-conversations`, { message: ticket.title.slice(0, 4000) }),
  );
  appendFileSync(collectStatePath(ctx.dir, ctx.project, variant), `${JSON.stringify({ ...mark, conversationId: conversation.id } satisfies LooMark)}\n`);
  await call("draft", "gravar rascunho", () =>
    ctx.client.request("PATCH", `/ticket-conversations/${conversation.id}/draft`, { title: ticket.title, description: ticket.description }),
  );
  if (crashAfterDraft) throw new Error("Interrupção de ensaio: o processo parou depois de gravar o rascunho.");
  await call<Outcome>("placement", "procurar o caminho", () => {
    kit.capture.reset();
    return ctx.client.request("POST", `/ticket-conversations/${conversation.id}/placement`);
  });
  const captured = kit.capture.candidates;
  if (captured === null) throw new Error("A procura não ofereceu os agrupadores da raiz ao juiz (requisição grande demais para o Jev?); nada foi coletado.");

  const newToOld = new Map([...map].map(([oldId, newId]) => [newId, oldId]));
  const oldOf = (newId: string): string => newToOld.get(newId) ?? newId;
  const rootGroups = gabarito.tickets.filter((t) => t.kind === "group" && t.parentId === null).sort((a, b) => a.number - b.number);
  const groupIds = captured.map((c) => oldOf(c.id));
  if (groupIds.length !== rootGroups.length || groupIds.some((id, index) => id !== (rootGroups[index] as GabaritoTicket).id)) {
    throw new Error("Os agrupadores que a procura ofereceu na raiz não são os do gabarito; nada foi coletado.");
  }

  // O texto de cada agrupador candidato: o resumo do produto ou a definição (escrita sem vazamento).
  const useDefinitions = ctx.groupText === "definition";
  const callsBefore = one.cache.calls;
  const hitsBefore = one.cache.hits;
  const fallbacks: string[] = [];
  const fallbacksNeg: string[] = [];
  const textsFor = async (inputs: Record<string, DefinitionInput> | null, onlyIds: readonly string[], failed: string[]): Promise<Record<string, string>> => {
    const texts: Record<string, string> = {};
    for (const id of onlyIds) {
      const product = (captured.find((c) => oldOf(c.id) === id) as BranchCandidate).summary;
      const input = inputs?.[id];
      const definition = useDefinitions && input ? await definitionFor(one, input) : null;
      if (useDefinitions && definition === null) failed.push(id);
      texts[id] = definition ?? product;
    }
    return texts;
  };
  const inputs = useDefinitions ? definitionInputs(gabarito.tickets, ticket.id) : null;
  const texts = await textsFor(inputs?.positive ?? null, groupIds, fallbacks);
  const negativeIds = groupIds.filter((id) => id !== originalGroupId);
  const textsNeg = negativeIds.length > 0 ? await textsFor(inputs?.negative ?? null, negativeIds, fallbacksNeg) : null;
  const withText = (list: readonly BranchCandidate[], by: Record<string, string>): BranchCandidate[] =>
    list.map((c) => ({ ...c, summary: by[oldOf(c.id)] ?? c.summary }));

  const draft = { title: ticket.title, description: one.draftDescription };
  const originalNewId = map.get(originalGroupId) as string;
  const positiveCandidates = withText(captured, texts);
  const negativeCandidates = withText(
    captured.filter((c) => c.id !== originalNewId),
    textsNeg ?? {},
  );
  const judge = async (list: readonly BranchCandidate[]): Promise<CollectRep[]> => {
    const reps: CollectRep[] = [];
    for (let i = 0; i < repeats; i++) {
      const { value, ms } = await withProvider(ctx, "coleta A", () => timed(() => kit.judge.judge({ draft, current: null, candidates: list })));
      reps.push({ gate: value.belongs, choice: Object.fromEntries(list.map((c) => [oldOf(c.id), value.choice[c.id] ?? 0])), ms });
    }
    return reps;
  };
  const a = await judge(positiveCandidates);
  const aNeg = negativeCandidates.length > 0 ? await judge(negativeCandidates) : null;
  const b = await fitReps(ctx, kit, draft, positiveCandidates, oldOf, repeats);
  // Com definições, o texto do positivo foi escrito vendo o agrupador original: o negativo da B usa os textos do negativo.
  const bNeg = useDefinitions && negativeCandidates.length > 0 ? await fitReps(ctx, kit, draft, negativeCandidates, oldOf, repeats) : undefined;

  // Coleta D (só com --claude-outline): o Claude vê o projeto inteiro (o ticket sai do esboço; no negativo, o agrupador original também).
  let outlineFields: Pick<CollectRecord, "d" | "dNeg"> | Record<string, never> = {};
  if (ctx.claudeOutline) {
    const outline = buildOutline(gabarito.tickets, ticket.id);
    const claude = (excludeGroupId: string | null) => askClaude(ctx, kit, { projectName: gabarito.project.name, groups: outline, excludeGroupId, newTicket: draft });
    const d = await claude(null);
    const dNeg = negativeCandidates.length > 0 ? await claude(originalGroupId) : null;
    outlineFields = { d, dNeg };
  }

  // Devolve o ticket ao lugar original pela conversa (rascunho original do gabarito), com situação e pessoas.
  const made = (
    await call<{ ticket: Detail }>("ticket", "recriar ticket", () =>
      ctx.client.request("POST", `/ticket-conversations/${conversation.id}/ticket`, { parentId: expectedParentNewId }),
    )
  ).ticket;
  // A conversa grava a citação do pedido na frente da descrição (ADR 0044); a coleta quer o texto do gabarito.
  const created = await call<Detail>("ticket", "restaurar a descrição do gabarito", () => withOriginalDescription(ctx, made, ticket.description));
  await restoreStateOf(ctx, created.id, ticket);

  const record: CollectRecord = {
    oldId: ticket.id,
    number: ticket.number,
    title: ticket.title,
    originalGroupId,
    groupIds,
    a,
    aNeg,
    b,
    ...(bNeg ? { bNeg } : {}),
    ...outlineFields,
    draftDescription: one.draftDescription,
    groupText: useDefinitions ? "definition" : "summary",
    texts,
    textsNeg,
    ...(useDefinitions
      ? { definitionFallbacks: fallbacks, definitionFallbacksNeg: fallbacksNeg, definitionCalls: one.cache.calls - callsBefore, definitionCached: one.cache.hits - hitsBefore }
      : {}),
  };
  return { record, newId: created.id };
}

const noulSchema = z.object({ noul: z.number().min(0).max(1) });

async function fitReps(
  ctx: Context,
  kit: NonNullable<Context["collectKit"]>,
  draft: { title: string; description: string },
  candidates: readonly BranchCandidate[],
  oldOf: (id: string) => string,
  repeats: number,
): Promise<FitRep[]> {
  const { request, keys } = buildFitRequest(
    draft,
    candidates.map((c) => ({ id: oldOf(c.id), title: c.title, summary: c.summary })),
  );
  const reps: FitRep[] = [];
  for (let i = 0; i < repeats; i++) {
    const { value, ms } = await withProvider(ctx, "coleta B", () =>
      timed(async () => {
        let result: Awaited<ReturnType<typeof kit.systemOne>>;
        try {
          result = await kit.systemOne(request as unknown as Parameters<typeof kit.systemOne>[0], { timeout: JEV_TIMEOUT_MS });
        } catch (error) {
          logger.warn(`falha do provedor tipo=${error instanceof Error ? error.constructor.name : typeof error}`);
          throw new AssistantUnavailableError("provider_error");
        }
        const parsed = z.object(Object.fromEntries(keys.map(({ key }) => [key, noulSchema]))).safeParse(result.answers);
        if (!parsed.success) throw new AssistantUnavailableError("invalid_output");
        return Object.fromEntries(keys.map(({ key, id }) => [id, (parsed.data[key] as { noul: number }).noul]));
      }),
    );
    reps.push({ fit: value, ms });
  }
  return reps;
}

async function askClaude(
  ctx: Context,
  kit: NonNullable<Context["collectKit"]>,
  input: Parameters<typeof buildClaudeProject>[0],
): Promise<ClaudeResult> {
  const { content, optionIds } = buildClaudeProject(input);
  const params = {
    model: CLAUDE_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    output_config: { effort: "low", format: zodOutputFormat(rankingFormat) },
    system: [{ type: "text", text: CLAUDE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
  } as unknown as Parameters<typeof callClaude>[1];
  const { value: final, ms } = await withProvider(ctx, "coleta D", () => timed(() => callClaude(kit.claude, params, CLAUDE_TIMEOUT_MS, logger)));
  const usage = final.usage;
  const inputTokens = usage ? (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : null;
  const outputTokens = usage ? (usage.output_tokens ?? 0) : null;
  if (final.stop_reason !== "end_turn") return { ranking: null, invalid: `stop_reason=${final.stop_reason}`, ms, inputTokens, outputTokens };
  const checked = validateRanking(final.parsed_output, optionIds);
  return checked.ok
    ? { ranking: checked.ranking, invalid: null, ms, inputTokens, outputTokens }
    : { ranking: null, invalid: checked.reason, ms, inputTokens, outputTokens };
}

/** Árvore (títulos e pais) do projeto inteiro; situação e pessoas só dos tickets já coletados (os outros nunca saíram do projeto). */
async function finalProblems(ctx: Context, gabarito: Gabarito, map: ReadonlyMap<string, string>, collected: ReadonlySet<string>): Promise<string[]> {
  const problems = await looTreeProblems(ctx, gabarito, map);
  for (const original of gabarito.tickets.filter((t) => t.kind === "ticket" && collected.has(t.id))) {
    const id = map.get(original.id);
    if (id === undefined) continue;
    const live = expectOk<Detail>("ler ticket", await ctx.client.request("GET", `/tickets/${id}`));
    if (live.status !== original.status) problems.push(`ticket ${original.number}: situação ${live.status ?? "nenhuma"}, esperava ${original.status ?? "nenhuma"}`);
    const want = [...original.assigneeIds].sort().join(",");
    const have = [...live.assigneeIds].sort().join(",");
    if (want !== have) problems.push(`ticket ${original.number}: pessoas diferentes do gabarito`);
  }
  return problems;
}

// ---- relatório ---------------------------------------------------------------------------------------------------

export function collectReportCommand(ctx: { dir: string; project: string; variant?: string; log: (line: string) => void }): void {
  const variant = ctx.variant ?? DEFAULT_VARIANT;
  const gabarito = readGabarito(ctx.dir);
  const path = collectPath(ctx.dir, ctx.project, variant);
  const records = readJsonLines<CollectRecord>(path);
  if (records.length === 0) throw new Error(`Não há coleta em ${path}. Rode \`collect\` primeiro.`);
  const groupTitles = new Map(gabarito.tickets.filter((t) => t.kind === "group").map((t) => [t.id, t.title]));
  writeFileSync(collectReportPath(ctx.dir, ctx.project, variant), renderCollectReport(records, { projectKey: gabarito.project.key, groupTitles }));
  ctx.log(`Relatório da coleta gravado: ${records.length} tickets.`);
}

/** `report --collect --compare A B`: sem chamada a provedor; o pareamento é pelo número do ticket no gabarito. */
export function collectCompareCommand(ctx: {
  dir: string;
  project: string;
  compare: [string, string];
  compareProject?: string;
  phaseGroups?: number[];
  log: (line: string) => void;
}): void {
  const gabarito = readGabarito(ctx.dir);
  const [variantA, variantB] = ctx.compare;
  const projectB = ctx.compareProject ?? ctx.project;
  const load = (project: string, variant: string): CollectRecord[] => {
    const path = collectPath(ctx.dir, project, variant);
    const records = readJsonLines<CollectRecord>(path);
    if (records.length === 0) throw new Error(`Não há coleta em ${path}.`);
    return records;
  };
  const a = load(ctx.project, variantA);
  const b = load(projectB, variantB);
  let phaseGroupIds: Set<string> | null = null;
  if (ctx.phaseGroups !== undefined) {
    phaseGroupIds = new Set();
    for (const number of ctx.phaseGroups) {
      const group = gabarito.tickets.find((t) => t.number === number && t.kind === "group" && t.parentId === null);
      if (!group) throw new Error(`--phase-groups: o número ${number} não é de um agrupador da raiz do gabarito.`);
      phaseGroupIds.add(group.id);
    }
  }
  const groupTitles = new Map(gabarito.tickets.filter((t) => t.kind === "group").map((t) => [t.id, t.title]));
  const text = renderCompareReport(a, b, { labelA: `${ctx.project}/${variantA}`, labelB: `${projectB}/${variantB}`, groupTitles, phaseGroupIds });
  writeFileSync(join(ctx.dir, compareFileName(ctx.project, variantA, projectB, variantB)), text);
  ctx.log(`Comparação gravada: ${a.length} tickets em ${variantA} e ${b.length} em ${variantB}.`);
}
