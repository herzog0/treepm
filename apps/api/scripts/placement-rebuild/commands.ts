import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { JudgmentRecorder } from "./app.js";
import { describeFailure, expectOk } from "./client.js";
import type { ApiClient } from "./client.js";
import {
  buildImportTree,
  classifyPlacement,
  compareTrees,
  computeDepths,
  looTickets,
  looResumeAction,
  looView,
  pendingLoo,
  pendingMarks,
  pendingGroups,
  pendingTickets,
  rebuildOrder,
  recomputeGroups,
  resolveKinds,
  rebuildView,
  removalOrder,
  renderReport,
  resumeState,
  withRetry503,
} from "./core.js";
import type { Gabarito, GabaritoTicket, LooMark, NodeKind, RunRecord, StartedMark, Step, TicketStatus } from "./core.js";

type Summary = {
  id: string;
  number: number;
  key: string;
  parentId: string | null;
  kind?: NodeKind;
  title: string;
  status: TicketStatus | null;
  assigneeIds: string[];
};
type Detail = Summary & { description: string };
type ProjectOut = { id: string; key: string; name: string };
type Conversation = {
  id: string;
  status: string;
  draft: { title: string; description: string } | null;
  ready: boolean;
  createdTicketId: string | null;
  messages: { author: string; body: string }[];
};
type Target = { parentId: string | null; path: { id: string; title: string }[] };
type Outcome = {
  destination: Target;
  alternatives: Target[];
  uncertain: boolean;
  stoppedEarly: { reason: string; level: number; parentId: string | null } | null;
};

export type Context = {
  client: ApiClient;
  recorder: JudgmentRecorder;
  dir: string;
  project: string;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
  /** Ensaio: interrompe o `leave-one-out` logo depois da N-ésima remoção da execução. */
  looCrashAfterRemove?: number;
  looCrashAfterDraft?: number;
};

const MAX_MESSAGE = 4000;
const MAX_IMPORT_ITEMS = 500;

// ---- arquivos ---------------------------------------------------------------------------------------------------

export const gabaritoPath = (dir: string): string => join(dir, "gabarito.json");
export const runPath = (dir: string, projectId: string): string => join(dir, `run-${projectId}.jsonl`);
const startedPath = (dir: string, projectId: string): string => join(dir, `started-${projectId}.jsonl`);
export const reportPath = (dir: string, projectId: string): string => join(dir, `report-${projectId}.md`);
export const looPath = (dir: string, projectId: string): string => join(dir, `loo-${projectId}.jsonl`);
const looStatePath = (dir: string, projectId: string): string => join(dir, `loo-state-${projectId}.jsonl`);
export const looMapPath = (dir: string, projectId: string): string => join(dir, `loo-map-${projectId}.json`);
/** Agrupadores que o `rebuild` criou sem passar pela procura: uma linha `{ oldId, newId }` por agrupador. */
export const groupsPath = (dir: string, projectId: string): string => join(dir, `groups-${projectId}.jsonl`);
export const looReportPath = (dir: string, projectId: string): string => join(dir, `report-loo-${projectId}.md`);

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

export function readGabarito(dir: string): Gabarito {
  const path = gabaritoPath(dir);
  if (!existsSync(path)) throw new Error(`Não existe ${path}. Rode \`export\` primeiro.`);
  const raw = JSON.parse(readFileSync(path, "utf8")) as Omit<Gabarito, "tickets"> & { tickets: (Omit<GabaritoTicket, "kind"> & { kind?: NodeKind })[] };
  // Gabarito antigo, sem `kind`: quem tem filhos é agrupador.
  return { ...raw, tickets: resolveKinds(raw.tickets) as GabaritoTicket[] };
}

type GroupMark = { oldId: string; newId: string };

export function readGroupMap(dir: string, projectId: string): Map<string, string> {
  return new Map(readJsonLines<GroupMark>(groupsPath(dir, projectId)).map((m) => [m.oldId, m.newId]));
}

// ---- leitura do projeto -------------------------------------------------------------------------------------------

async function listTickets(ctx: Context, projectId = ctx.project): Promise<Summary[]> {
  return expectOk<Summary[]>("listar tickets", await ctx.client.request("GET", `/projects/${projectId}/tickets`));
}

async function getProject(ctx: Context, projectId = ctx.project): Promise<ProjectOut> {
  return expectOk<ProjectOut>("ler projeto", await ctx.client.request("GET", `/projects/${projectId}`));
}

function countByDepth(tickets: readonly { depth: number }[]): string {
  const counts = new Map<number, number>();
  for (const t of tickets) counts.set(t.depth, (counts.get(t.depth) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([depth, n]) => `profundidade ${depth}: ${n}`).join("; ");
}

// ---- export / check / wipe ----------------------------------------------------------------------------------------

export async function exportCommand(ctx: Context): Promise<void> {
  const path = gabaritoPath(ctx.dir);
  if (existsSync(path)) throw new Error(`${path} já existe; recuso sobrescrever o gabarito.`);
  const project = await getProject(ctx);
  const summaries = await listTickets(ctx);
  const details: Detail[] = [];
  for (let i = 0; i < summaries.length; i += 5) {
    const batch = summaries.slice(i, i + 5);
    details.push(...(await Promise.all(batch.map(async (s) => expectOk<Detail>("ler ticket", await ctx.client.request("GET", `/tickets/${s.id}`))))));
  }
  const tickets = resolveKinds(computeDepths(
    details.map((d) => ({
      id: d.id,
      number: d.number,
      ...(d.kind ? { kind: d.kind } : {}),
      key: d.key,
      title: d.title,
      description: d.description,
      status: d.status,
      parentId: d.parentId,
      assigneeIds: [...d.assigneeIds],
    })),
  )) as GabaritoTicket[];
  const gabarito: Gabarito = {
    exportedAt: new Date().toISOString(),
    project: { id: project.id, key: project.key, name: project.name },
    tickets,
  };
  writeFileSync(path, JSON.stringify(gabarito, null, 2), { flag: "wx" });
  const groupCount = tickets.filter((x) => x.kind === "group").length;
  ctx.log(`Gabarito gravado: ${tickets.length} nós (${tickets.length - groupCount} tickets e ${groupCount} agrupadores; ${countByDepth(tickets)}).`);
}

function liveFor(summaries: readonly Summary[]) {
  return summaries.map((s) => ({ id: s.id, title: s.title, parentId: s.parentId, status: s.status, ...(s.kind ? { kind: s.kind } : {}) }));
}

/** Devolve as diferenças; vazio = confere. */
async function checkAgainstLive(ctx: Context, gabarito: Gabarito): Promise<string[]> {
  if (gabarito.project.id !== ctx.project) {
    return [`o gabarito é do projeto ${gabarito.project.id}, não de ${ctx.project}`];
  }
  return compareTrees(gabarito.tickets, liveFor(await listTickets(ctx)));
}

export async function checkCommand(ctx: Context): Promise<boolean> {
  const problems = await checkAgainstLive(ctx, readGabarito(ctx.dir));
  if (problems.length === 0) {
    ctx.log("Confere: o projeto vivo é igual ao gabarito.");
    return true;
  }
  ctx.log(`NÃO confere: ${problems.length} diferença(s).`);
  for (const problem of problems.slice(0, 20)) ctx.log(`  ${problem}`);
  if (problems.length > 20) ctx.log(`  … e mais ${problems.length - 20}.`);
  return false;
}

export async function wipeCommand(ctx: Context, confirm: string): Promise<void> {
  const gabarito = readGabarito(ctx.dir);
  if (confirm !== gabarito.project.key) throw new Error("--confirm precisa ser igual à chave do projeto do gabarito.");
  const problems = await checkAgainstLive(ctx, gabarito);
  if (problems.length > 0) throw new Error(`O projeto vivo não confere com o gabarito (${problems.length} diferença(s)); rode \`check\`. Nada foi removido.`);
  const live = await listTickets(ctx);
  const order = removalOrder(live);
  let removed = 0;
  for (const id of order) {
    const response = await ctx.client.request("DELETE", `/tickets/${id}`);
    if (response.status !== 204) throw new Error(describeFailure("remover ticket", response));
    removed += 1;
    if (removed % 25 === 0 || removed === order.length) ctx.log(`Removidos ${removed}/${order.length}.`);
  }
  const left = await listTickets(ctx);
  if (left.length !== 0) throw new Error(`Depois da remoção o projeto ainda tem ${left.length} ticket(s).`);
  ctx.log("Projeto com zero tickets.");
}

// ---- rebuild ----------------------------------------------------------------------------------------------------------

export async function rebuildCommand(ctx: Context, limit: number | undefined): Promise<void> {
  const gabarito = readGabarito(ctx.dir);
  const records = readJsonLines<RunRecord>(runPath(ctx.dir, ctx.project));
  const started = readJsonLines<StartedMark>(startedPath(ctx.dir, ctx.project));
  const groupMap = readGroupMap(ctx.dir, ctx.project);
  if (records.length === 0 && started.length === 0 && groupMap.size === 0) {
    const existing = await listTickets(ctx);
    if (existing.length > 0) throw new Error(`O projeto ${ctx.project} já tem ${existing.length} ticket(s) e nenhuma execução registrada; recuso reconstruir por cima.`);
  }
  const plan = rebuildOrder(gabarito.tickets);
  // Agrupadores primeiro, direto, sem procura (a procura só coloca tickets).
  await createGroups(ctx, plan.groups, groupMap);
  const state = resumeState(records, started);
  for (const [oldId, newId] of groupMap) state.newToOld.set(newId, oldId);
  const order = plan.tickets;
  const pending = pendingTickets(order, state, limit);
  ctx.log(`Ordem: ${order.length} tickets; já registrados: ${state.done.size}; a processar agora: ${pending.length}.`);

  let position = 0;
  for (const ticket of pending) {
    position += 1;
    const record = await rebuildOne(ctx, ticket, state);
    state.done.add(ticket.id);
    state.newToOld.set(record.newId, ticket.id);
    appendFileSync(runPath(ctx.dir, ctx.project), `${JSON.stringify(record)}\n`);
    const total = Object.values(record.timingsMs).reduce((a, b) => a + b, 0);
    ctx.log(`[${position}/${pending.length}] ${record.newKey} (esperava profundidade ${ticket.depth}) → ${record.group}${record.uncertain ? " incerto" : ""}${record.resumed ? " retomado" : ""} em ${total} ms`);
  }
  ctx.log("Rebuild: nada mais a fazer nesta execução.");
}

/**
 * Cria os agrupadores do gabarito na raiz ou dentro do agrupador novo que corresponde ao pai deles, do mais raso ao
 * mais fundo. Idempotente: o que já está no arquivo é pulado, e um agrupador criado antes de uma interrupção e não
 * anotado é reconhecido pelo título e pelo pai.
 */
async function createGroups(ctx: Context, groups: readonly GabaritoTicket[], created: Map<string, string>): Promise<void> {
  const pending = pendingGroups(groups, created);
  if (pending.length === 0) return;
  const adopted = new Set(created.values());
  const orphans = (await listTickets(ctx)).filter((x) => x.kind === "group" && !adopted.has(x.id));
  for (const group of pending) {
    const parentNewId = group.parentId === null ? null : (created.get(group.parentId) as string);
    const orphan = orphans.find((x) => x.title === group.title && x.parentId === parentNewId);
    let newId: string;
    if (orphan) {
      orphans.splice(orphans.indexOf(orphan), 1);
      newId = orphan.id;
    } else {
      const body = { title: group.title, description: group.description, kind: "group", parentId: parentNewId };
      newId = expectOk<Detail>("criar agrupador", await ctx.client.request("POST", `/projects/${ctx.project}/tickets`, body)).id;
    }
    created.set(group.id, newId);
    appendFileSync(groupsPath(ctx.dir, ctx.project), `${JSON.stringify({ oldId: group.id, newId } satisfies GroupMark)}\n`);
  }
  ctx.log(`Agrupadores criados sem procura: ${pending.length}.`);
}

type Timings = Record<Step, number>;

/** Chamada HTTP com as tentativas em 503, somando tempo e tentativas do passo. */
function makeCaller(ctx: Context, timingsMs: Timings, attempts: Timings) {
  return async <T>(step: Step, what: string, run: () => ReturnType<ApiClient["request"]>): Promise<T> => {
    const started = performance.now();
    const { response, attempts: n } = await withRetry503(run, { sleep: ctx.sleep, ...(ctx.retryDelaysMs ? { delaysMs: ctx.retryDelaysMs } : {}) });
    timingsMs[step] += Math.round(performance.now() - started);
    attempts[step] += n;
    if (response.status === 503) throw new Error(`${describeFailure(what, response)} persistente depois de ${n} tentativas; rode de novo para continuar.`);
    return expectOk<T>(what, response);
  };
}

const claudeOf = (conversation: Conversation): RunRecord["claude"] => ({
  draftTitle: conversation.draft?.title ?? null,
  ready: conversation.ready,
  message: [...conversation.messages].reverse().find((m) => m.author === "assistant")?.body ?? "",
});

const openMessage = (ticket: GabaritoTicket): string => `${ticket.title}\n\n${ticket.description}`.slice(0, MAX_MESSAGE);

async function rebuildOne(
  ctx: Context,
  ticket: GabaritoTicket,
  state: ReturnType<typeof resumeState>,
): Promise<RunRecord> {
  const timingsMs: Record<Step, number> = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const attempts: Record<Step, number> = { open: 0, draft: 0, placement: 0, ticket: 0 };

  const call = makeCaller(ctx, timingsMs, attempts);

  // 1. conversa (reaproveita a que já foi aberta antes de uma interrupção)
  let conversation: Conversation;
  const reusedId = state.startedConversation.get(ticket.id);
  if (reusedId) {
    conversation = await call<Conversation>("open", "ler conversa", () => ctx.client.request("GET", `/ticket-conversations/${reusedId}`));
  } else {
    const message = openMessage(ticket);
    conversation = await call<Conversation>("open", "abrir conversa", () =>
      ctx.client.request("POST", `/projects/${ctx.project}/ticket-conversations`, { message }),
    );
  }
  // Numa conversa reaproveitada, o rascunho já foi trocado pelo do gabarito: vale o que a marca guardou.
  const claude = (reusedId ? state.startedMarks.get(ticket.id)?.claude : undefined) ?? claudeOf(conversation);
  if (!reusedId) {
    appendFileSync(startedPath(ctx.dir, ctx.project), `${JSON.stringify({ oldId: ticket.id, conversationId: conversation.id, claude } satisfies StartedMark)}\n`);
  }

  const finish = (created: Detail, outcome: Outcome | null, judgments: RunRecord["judgments"], resumed: boolean): RunRecord => {
    const chosen = outcome ? outcome.destination.parentId : created.parentId;
    const group = classifyPlacement({
      expectedParentOldId: ticket.parentId,
      chosenNewParentId: chosen,
      destinationPath: outcome?.destination.path ?? [],
      newToOld: state.newToOld,
    });
    return {
      oldId: ticket.id,
      oldNumber: ticket.number,
      title: ticket.title,
      newId: created.id,
      newKey: created.key,
      conversationId: conversation.id,
      resumed,
      expectedParentOldId: ticket.parentId,
      chosenParentNewId: chosen,
      chosenParentOldId: chosen === null ? null : (state.newToOld.get(chosen) ?? null),
      group,
      uncertain: outcome?.uncertain ?? false,
      stoppedEarly: outcome?.stoppedEarly ?? null,
      destinationPath: outcome?.destination.path ?? [],
      alternatives: (outcome?.alternatives ?? []).map((a) => ({
        parentNewId: a.parentId,
        parentOldId: a.parentId === null ? null : (state.newToOld.get(a.parentId) ?? null),
        path: a.path,
      })),
      judgments,
      claude,
      timingsMs,
      attempts,
    };
  };

  // Já tinha criado o ticket antes da interrupção: reaproveita, sem duplicar.
  if (conversation.status === "ticket_created" && conversation.createdTicketId) {
    const created = await call<Detail>("ticket", "ler ticket criado", () => ctx.client.request("GET", `/tickets/${conversation.createdTicketId}`));
    return finish(created, null, [], true);
  }

  // 2. rascunho exatamente como no gabarito
  await call("draft", "gravar rascunho", () =>
    ctx.client.request("PATCH", `/ticket-conversations/${conversation.id}/draft`, { title: ticket.title, description: ticket.description }),
  );
  // 3. procura do caminho
  // O reset fica dentro do fecho: uma tentativa que deu 503 no meio da descida não deixa julgamentos para a próxima.
  const outcome = await call<Outcome>("placement", "procurar o caminho", () => {
    ctx.recorder.reset();
    return ctx.client.request("POST", `/ticket-conversations/${conversation.id}/placement`);
  });
  const judgments = ctx.recorder.take();
  // 4. cria o ticket no destino
  const created = await call<{ ticket: Detail }>("ticket", "criar ticket", () =>
    ctx.client.request("POST", `/ticket-conversations/${conversation.id}/ticket`, { parentId: outcome.destination.parentId }),
  );
  return finish(created.ticket, outcome, judgments, false);
}

// ---- restore-state ------------------------------------------------------------------------------------------------

export async function restoreStateCommand(ctx: Context): Promise<boolean> {
  const gabarito = readGabarito(ctx.dir);
  const byId = new Map(gabarito.tickets.map((t) => [t.id, t]));
  const records = readJsonLines<RunRecord>(runPath(ctx.dir, ctx.project));
  const groupRecords = [...readGroupMap(ctx.dir, ctx.project)].map(([oldId, newId]) => ({ oldId, newId, newKey: newId }));
  let statuses = 0;
  let assigned = 0;
  let skipped = 0;
  let failed = 0;
  // Agrupador não tem situação: só as pessoas atribuídas voltam.
  for (const record of [...groupRecords, ...records]) {
    const original = byId.get(record.oldId);
    if (!original) continue;
    if (original.kind === "ticket" && original.status !== null && original.status !== "todo") {
      const response = await ctx.client.request("PATCH", `/tickets/${record.newId}`, { status: original.status });
      if (response.status === 409) skipped += 1; // ganhou filhos na reconstrução: não tem situação própria
      else if (response.status >= 200 && response.status < 300) statuses += 1;
      else {
        failed += 1;
        ctx.log(`  ${record.newKey}: ${describeFailure("aplicar situação", response)}`);
      }
    }
    for (const personId of original.assigneeIds) {
      const response = await ctx.client.request("PUT", `/tickets/${record.newId}/assignees/${personId}`);
      if (response.status >= 200 && response.status < 300) assigned += 1;
      else {
        failed += 1;
        ctx.log(`  ${record.newKey}: ${describeFailure("atribuir pessoa", response)}`);
      }
    }
  }
  ctx.log(`Situações aplicadas: ${statuses}; atribuições: ${assigned}; situações puladas (agrupador): ${skipped}; falhas: ${failed}.`);
  return failed === 0;
}

// ---- report -------------------------------------------------------------------------------------------------------------

export function reportCommand(ctx: Pick<Context, "dir" | "project" | "log">, loo = false): void {
  const gabarito = readGabarito(ctx.dir);
  const records = readJsonLines<RunRecord>(loo ? looPath(ctx.dir, ctx.project) : runPath(ctx.dir, ctx.project));
  const groupMap = loo ? new Map<string, string>() : readGroupMap(ctx.dir, ctx.project);
  const view = loo ? looView(gabarito.tickets, readLooMap(ctx.dir, ctx.project)) : rebuildView(gabarito.tickets, records, groupMap);
  const groupsCreated = loo ? gabarito.tickets.filter((x) => x.kind === "group").length : groupMap.size;
  const markdown = renderReport(gabarito.tickets, records, gabarito.project.key, { view, loo, groupsCreated });
  writeFileSync(loo ? looReportPath(ctx.dir, ctx.project) : reportPath(ctx.dir, ctx.project), markdown);
  // Mesma regra do relatório: o grupo é recalculado, não lido do arquivo.
  const groups = { same_parent: 0, deeper: 0, elsewhere: 0 };
  for (const r of recomputeGroups(records, view)) groups[r.group] += 1;
  ctx.log(`Relatório gravado: ${records.length} tickets (same_parent ${groups.same_parent}, deeper ${groups.deeper}, elsewhere ${groups.elsewhere}).`);
}

// ---- restore-original -------------------------------------------------------------------------------------------------

/** Recria a árvore do gabarito pela rota de importação, num projeto vazio; devolve os tickets criados na ordem do gabarito. */
async function importGabarito(ctx: Context, gabarito: Gabarito): Promise<{ created: Summary[]; order: string[] }> {
  const existing = await listTickets(ctx);
  if (existing.length > 0) throw new Error(`O projeto ${ctx.project} tem ${existing.length} ticket(s); recuso restaurar em projeto não vazio.`);
  const { items, order } = buildImportTree(gabarito.tickets);
  if (order.length > MAX_IMPORT_ITEMS) throw new Error(`O gabarito tem ${order.length} tickets e a rota de importação aceita ${MAX_IMPORT_ITEMS} por chamada.`);
  const created = expectOk<Summary[]>("importar árvore", await ctx.client.request("POST", `/projects/${ctx.project}/tickets/import`, { items }));
  if (created.length !== order.length) throw new Error(`A importação devolveu ${created.length} tickets, esperava ${order.length}.`);
  ctx.log(`Árvore recriada: ${created.length} tickets.`);
  return { created, order };
}

export async function restoreOriginalCommand(ctx: Context): Promise<boolean> {
  const gabarito = readGabarito(ctx.dir);
  const { created, order } = await importGabarito(ctx, gabarito);
  const byId = new Map(gabarito.tickets.map((t) => [t.id, t]));
  let assigned = 0;
  let failed = 0;
  for (const [index, oldId] of order.entries()) {
    const newId = (created[index] as Summary).id;
    for (const personId of byId.get(oldId)?.assigneeIds ?? []) {
      const response = await ctx.client.request("PUT", `/tickets/${newId}/assignees/${personId}`);
      if (response.status >= 200 && response.status < 300) assigned += 1;
      else {
        failed += 1;
        ctx.log(`  ${(created[index] as Summary).key}: ${describeFailure("atribuir pessoa", response)}`);
      }
    }
  }
  ctx.log(`Atribuições reaplicadas: ${assigned}; falhas: ${failed}.`);
  return failed === 0;
}

// ---- leave-one-out ------------------------------------------------------------------------------------------------------

export function readLooMap(dir: string, projectId: string): Map<string, string> {
  const path = looMapPath(dir, projectId);
  if (!existsSync(path)) throw new Error(`Não existe ${path}. Rode \`leave-one-out\` primeiro.`);
  return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>));
}

const writeLooMap = (dir: string, projectId: string, map: ReadonlyMap<string, string>): void =>
  writeFileSync(looMapPath(dir, projectId), JSON.stringify(Object.fromEntries(map), null, 2));

/** Mede o uso normal da procura: tira um ticket-folha de uma árvore já organizada e deixa a procura pô-lo de volta. */
export async function leaveOneOutCommand(ctx: Context, limit: number | undefined): Promise<boolean> {
  const gabarito = readGabarito(ctx.dir);
  const byId = new Map(gabarito.tickets.map((t) => [t.id, t]));
  const results = readJsonLines<RunRecord>(looPath(ctx.dir, ctx.project));

  // 1. a árvore do gabarito no projeto (só na primeira execução)
  let map: Map<string, string>;
  if (existsSync(looMapPath(ctx.dir, ctx.project))) {
    map = readLooMap(ctx.dir, ctx.project);
  } else {
    const { created, order } = await importGabarito(ctx, gabarito);
    map = new Map(order.map((oldId, index) => [oldId, (created[index] as Summary).id]));
    writeLooMap(ctx.dir, ctx.project, map);
  }
  const saveMap = (): void => writeLooMap(ctx.dir, ctx.project, map);
  const parentNewId = (ticket: GabaritoTicket): string | null => (ticket.parentId === null ? null : (map.get(ticket.parentId) as string));
  const done = new Set(results.map((r) => r.oldId));

  // 2. retomada: um ticket removido e não recolocado volta ao pai original antes de qualquer outra coisa
  const pending = pendingMarks(readJsonLines<LooMark>(looStatePath(ctx.dir, ctx.project)), done);
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
        map.set(mark.oldId, restoredId);
        saveMap();
        ctx.log(`Retomada: "${mark.oldId}" estava removido; recriado no pai original.`);
      }
    }
  }

  // 3. um ticket por vez
  const leaves = looTickets(gabarito.tickets);
  const todo = pendingLoo(leaves, done, limit);
  ctx.log(`Tickets: ${leaves.length}; já medidas: ${done.size}; a medir agora: ${todo.length}.`);
  let removedThisRun = 0;
  let position = 0;
  for (const ticket of todo) {
    position += 1;
    const expectedParentNewId = parentNewId(ticket);
    const mark: LooMark = { oldId: ticket.id, title: ticket.title, ticketId: map.get(ticket.id) as string, expectedParentNewId };
    appendFileSync(looStatePath(ctx.dir, ctx.project), `${JSON.stringify(mark)}\n`);
    const removal = await ctx.client.request("DELETE", `/tickets/${mark.ticketId}`);
    if (removal.status !== 204) throw new Error(describeFailure("remover ticket", removal));
    removedThisRun += 1;
    if (ctx.looCrashAfterRemove !== undefined && removedThisRun === ctx.looCrashAfterRemove) {
      throw new Error("Interrupção de ensaio: o processo parou depois de remover o ticket e antes de recolocá-lo.");
    }
    const record = await looOne(ctx, ticket, mark, expectedParentNewId, map, ctx.looCrashAfterDraft === removedThisRun);
    map.set(ticket.id, record.newId);
    saveMap();
    appendFileSync(looPath(ctx.dir, ctx.project), `${JSON.stringify(record)}\n`);
    done.add(ticket.id);
    const total = Object.values(record.timingsMs).reduce((a, b) => a + b, 0);
    ctx.log(`[${position}/${todo.length}] ${record.newKey} → ${record.group}${record.uncertain ? " incerto" : ""} em ${total} ms`);
  }

  // 4. a árvore tem de estar inteira: mesmos títulos e pais do gabarito
  const problems = await looTreeProblems(ctx, gabarito, map);
  if (problems.length === 0) {
    ctx.log("Leave-one-out: o projeto tem os mesmos tickets (títulos e pais) do gabarito.");
    return true;
  }
  ctx.log(`Leave-one-out: a árvore NÃO confere com o gabarito (${problems.length} diferença(s)).`);
  for (const problem of problems.slice(0, 20)) ctx.log(`  ${problem}`);
  return false;
}

/** Recria um ticket que a interrupção deixou removido: pela conversa já aberta, se ela ainda serve; senão pela rota do projeto. */
async function restoreMissing(ctx: Context, original: GabaritoTicket, mark: LooMark): Promise<string> {
  const retry = async (what: string, run: () => ReturnType<ApiClient["request"]>) => {
    const { response, attempts } = await withRetry503(run, { sleep: ctx.sleep, ...(ctx.retryDelaysMs ? { delaysMs: ctx.retryDelaysMs } : {}) });
    if (response.status === 503) throw new Error(`${describeFailure(what, response)} persistente depois de ${attempts} tentativas; rode de novo para continuar.`);
    return response;
  };
  if (mark.conversationId) {
    const conversationResponse = await retry("ler conversa", () => ctx.client.request("GET", `/ticket-conversations/${mark.conversationId}`));
    const conversation = conversationResponse.status === 200 ? (conversationResponse.body as Conversation) : null;
    if (conversation && conversation.status === "open" && conversation.draft) {
      const created = await retry("criar ticket pela conversa", () =>
        ctx.client.request("POST", `/ticket-conversations/${mark.conversationId}/ticket`, { parentId: mark.expectedParentNewId }),
      );
      if (created.status >= 200 && created.status < 300) return (created.body as { ticket: Detail }).ticket.id;
    }
  }
  const created = await retry("recriar ticket", () =>
    ctx.client.request("POST", `/projects/${ctx.project}/tickets`, {
      title: original.title,
      description: original.description,
      parentId: mark.expectedParentNewId,
    }),
  );
  return expectOk<Detail>("recriar ticket", created).id;
}

async function looOne(
  ctx: Context,
  ticket: GabaritoTicket,
  mark: LooMark,
  expectedParentNewId: string | null,
  map: ReadonlyMap<string, string>,
  crashAfterDraft: boolean,
): Promise<RunRecord> {
  const timingsMs: Timings = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const attempts: Timings = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const call = makeCaller(ctx, timingsMs, attempts);

  const conversation = await call<Conversation>("open", "abrir conversa", () =>
    ctx.client.request("POST", `/projects/${ctx.project}/ticket-conversations`, { message: openMessage(ticket) }),
  );
  const claude = claudeOf(conversation);
  // A conversa fica anotada: se o processo parar daqui, a retomada recria o ticket por ela.
  appendFileSync(looStatePath(ctx.dir, ctx.project), `${JSON.stringify({ ...mark, conversationId: conversation.id } satisfies LooMark)}\n`);

  await call("draft", "gravar rascunho", () =>
    ctx.client.request("PATCH", `/ticket-conversations/${conversation.id}/draft`, { title: ticket.title, description: ticket.description }),
  );
  if (crashAfterDraft) throw new Error("Interrupção de ensaio: o processo parou depois de gravar o rascunho.");
  const outcome = await call<Outcome>("placement", "procurar o caminho", () => {
    ctx.recorder.reset();
    return ctx.client.request("POST", `/ticket-conversations/${conversation.id}/placement`);
  });
  const judgments = ctx.recorder.take();
  // Não cria no destino da procura: recoloca no pai original, para a árvore ficar igual à de antes.
  const created = (
    await call<{ ticket: Detail }>("ticket", "recriar ticket", () =>
      ctx.client.request("POST", `/ticket-conversations/${conversation.id}/ticket`, { parentId: expectedParentNewId }),
    )
  ).ticket;

  const newToOld = new Map([...map].map(([oldId, newId]) => [newId, oldId]));
  const chosen = outcome.destination.parentId;
  return {
    oldId: ticket.id,
    oldNumber: ticket.number,
    title: ticket.title,
    newId: created.id,
    newKey: created.key,
    conversationId: conversation.id,
    resumed: false,
    expectedParentOldId: ticket.parentId,
    chosenParentNewId: chosen,
    chosenParentOldId: chosen === null ? null : (newToOld.get(chosen) ?? null),
    group: classifyPlacement({
      expectedParentOldId: ticket.parentId,
      chosenNewParentId: chosen,
      destinationPath: outcome.destination.path,
      newToOld,
    }),
    uncertain: outcome.uncertain,
    stoppedEarly: outcome.stoppedEarly,
    destinationPath: outcome.destination.path,
    alternatives: outcome.alternatives.map((a) => ({
      parentNewId: a.parentId,
      parentOldId: a.parentId === null ? null : (newToOld.get(a.parentId) ?? null),
      path: a.path,
    })),
    judgments,
    claude,
    timingsMs,
    attempts,
  };
}

/** Compara o projeto vivo com o gabarito traduzido para os ids vivos (as situações do gabarito não entram). */
async function looTreeProblems(ctx: Context, gabarito: Gabarito, map: ReadonlyMap<string, string>): Promise<string[]> {
  const translated = gabarito.tickets.map((t) => ({
    ...t,
    id: map.get(t.id) ?? `sem-id:${t.id}`,
    parentId: t.parentId === null ? null : (map.get(t.parentId) ?? `sem-id:${t.parentId}`),
  }));
  const expectedStatus = new Map(translated.map((t) => [t.id, t.status]));
  const live = liveFor(await listTickets(ctx)).map((x) => ({ ...x, status: expectedStatus.get(x.id) ?? x.status }));
  return compareTrees(translated, live);
}

// ---- projeto descartável ------------------------------------------------------------------------------------------

export async function createProjectCommand(ctx: Pick<Context, "client" | "log">, key: string, name: string): Promise<void> {
  const project = expectOk<ProjectOut>("criar projeto", await ctx.client.request("POST", "/projects", { key, name }));
  ctx.log(`Projeto criado: ${project.id}`);
}

export async function archiveProjectCommand(ctx: Context): Promise<void> {
  expectOk("arquivar projeto", await ctx.client.request("PATCH", `/projects/${ctx.project}`, { archived: true }));
  ctx.log(`Projeto ${ctx.project} arquivado.`);
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}
