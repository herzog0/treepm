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
  insertionOrder,
  pendingTickets,
  removalOrder,
  renderReport,
  resumeState,
  withRetry503,
} from "./core.js";
import type { Gabarito, GabaritoTicket, RunRecord, StartedMark, Step, TicketStatus } from "./core.js";

type Summary = {
  id: string;
  number: number;
  key: string;
  parentId: string | null;
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
};

const MAX_MESSAGE = 4000;
const MAX_IMPORT_ITEMS = 500;

// ---- arquivos ---------------------------------------------------------------------------------------------------

export const gabaritoPath = (dir: string): string => join(dir, "gabarito.json");
export const runPath = (dir: string, projectId: string): string => join(dir, `run-${projectId}.jsonl`);
const startedPath = (dir: string, projectId: string): string => join(dir, `started-${projectId}.jsonl`);
export const reportPath = (dir: string, projectId: string): string => join(dir, `report-${projectId}.md`);

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
  return JSON.parse(readFileSync(path, "utf8")) as Gabarito;
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
  const tickets: GabaritoTicket[] = computeDepths(
    details.map((d) => ({
      id: d.id,
      number: d.number,
      key: d.key,
      title: d.title,
      description: d.description,
      status: d.status,
      parentId: d.parentId,
      assigneeIds: [...d.assigneeIds],
    })),
  );
  const gabarito: Gabarito = {
    exportedAt: new Date().toISOString(),
    project: { id: project.id, key: project.key, name: project.name },
    tickets,
  };
  writeFileSync(path, JSON.stringify(gabarito, null, 2), { flag: "wx" });
  ctx.log(`Gabarito gravado: ${tickets.length} tickets (${countByDepth(tickets)}).`);
}

function liveFor(summaries: readonly Summary[]) {
  return summaries.map((s) => ({ id: s.id, title: s.title, parentId: s.parentId, status: s.status }));
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
  if (records.length === 0 && started.length === 0) {
    const existing = await listTickets(ctx);
    if (existing.length > 0) throw new Error(`O projeto ${ctx.project} já tem ${existing.length} ticket(s) e nenhuma execução registrada; recuso reconstruir por cima.`);
  }
  const state = resumeState(records, started);
  const oldParents = new Map(gabarito.tickets.map((t) => [t.id, t.parentId]));
  const order = insertionOrder(gabarito.tickets);
  const pending = pendingTickets(order, state, limit);
  ctx.log(`Ordem: ${order.length} tickets; já registrados: ${state.done.size}; a processar agora: ${pending.length}.`);

  let position = 0;
  for (const ticket of pending) {
    position += 1;
    const record = await rebuildOne(ctx, ticket, state, oldParents);
    state.done.add(ticket.id);
    state.newToOld.set(record.newId, ticket.id);
    appendFileSync(runPath(ctx.dir, ctx.project), `${JSON.stringify(record)}\n`);
    const total = Object.values(record.timingsMs).reduce((a, b) => a + b, 0);
    ctx.log(`[${position}/${pending.length}] ${record.newKey} (esperava profundidade ${ticket.depth}) → ${record.group}${record.uncertain ? " incerto" : ""}${record.resumed ? " retomado" : ""} em ${total} ms`);
  }
  ctx.log("Rebuild: nada mais a fazer nesta execução.");
}

async function rebuildOne(
  ctx: Context,
  ticket: GabaritoTicket,
  state: ReturnType<typeof resumeState>,
  oldParents: ReadonlyMap<string, string | null>,
): Promise<RunRecord> {
  const timingsMs: Record<Step, number> = { open: 0, draft: 0, placement: 0, ticket: 0 };
  const attempts: Record<Step, number> = { open: 0, draft: 0, placement: 0, ticket: 0 };

  const call = async <T>(step: Step, what: string, run: () => ReturnType<ApiClient["request"]>): Promise<T> => {
    const started = performance.now();
    const { response, attempts: n } = await withRetry503(run, { sleep: ctx.sleep, ...(ctx.retryDelaysMs ? { delaysMs: ctx.retryDelaysMs } : {}) });
    timingsMs[step] += Math.round(performance.now() - started);
    attempts[step] += n;
    if (response.status === 503) throw new Error(`${describeFailure(what, response)} persistente depois de ${n} tentativas; rode de novo para continuar.`);
    return expectOk<T>(what, response);
  };

  // 1. conversa (reaproveita a que já foi aberta antes de uma interrupção)
  let conversation: Conversation;
  const reusedId = state.startedConversation.get(ticket.id);
  if (reusedId) {
    conversation = await call<Conversation>("open", "ler conversa", () => ctx.client.request("GET", `/ticket-conversations/${reusedId}`));
  } else {
    const message = `${ticket.title}\n\n${ticket.description}`.slice(0, MAX_MESSAGE);
    conversation = await call<Conversation>("open", "abrir conversa", () =>
      ctx.client.request("POST", `/projects/${ctx.project}/ticket-conversations`, { message }),
    );
    appendFileSync(startedPath(ctx.dir, ctx.project), `${JSON.stringify({ oldId: ticket.id, conversationId: conversation.id } satisfies StartedMark)}\n`);
  }
  const lastAssistant = [...conversation.messages].reverse().find((m) => m.author === "assistant");
  const claude = { draftTitle: conversation.draft?.title ?? null, ready: conversation.ready, message: lastAssistant?.body ?? "" };

  const finish = (created: Detail, outcome: Outcome | null, judgments: RunRecord["judgments"], resumed: boolean): RunRecord => {
    const chosen = outcome ? outcome.destination.parentId : created.parentId;
    const group = classifyPlacement({
      expectedParentOldId: ticket.parentId,
      chosenNewParentId: chosen,
      newToOld: state.newToOld,
      oldParents,
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
  ctx.recorder.reset();
  const outcome = await call<Outcome>("placement", "procurar o caminho", () =>
    ctx.client.request("POST", `/ticket-conversations/${conversation.id}/placement`),
  );
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
  let statuses = 0;
  let assigned = 0;
  let skipped = 0;
  let failed = 0;
  for (const record of records) {
    const original = byId.get(record.oldId);
    if (!original) continue;
    if (original.status !== null && original.status !== "todo") {
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
  ctx.log(`Situações aplicadas: ${statuses}; atribuições: ${assigned}; situações puladas (ticket com filhos): ${skipped}; falhas: ${failed}.`);
  return failed === 0;
}

// ---- report -------------------------------------------------------------------------------------------------------------

export function reportCommand(ctx: Pick<Context, "dir" | "project" | "log">): void {
  const gabarito = readGabarito(ctx.dir);
  const records = readJsonLines<RunRecord>(runPath(ctx.dir, ctx.project));
  writeFileSync(reportPath(ctx.dir, ctx.project), renderReport(gabarito.tickets, records, gabarito.project.key));
  const groups = { same_parent: 0, deeper: 0, elsewhere: 0 };
  for (const r of records) groups[r.group] += 1;
  ctx.log(`Relatório gravado: ${records.length} tickets (same_parent ${groups.same_parent}, deeper ${groups.deeper}, elsewhere ${groups.elsewhere}).`);
}

// ---- restore-original -------------------------------------------------------------------------------------------------

export async function restoreOriginalCommand(ctx: Context): Promise<boolean> {
  const gabarito = readGabarito(ctx.dir);
  const existing = await listTickets(ctx);
  if (existing.length > 0) throw new Error(`O projeto ${ctx.project} tem ${existing.length} ticket(s); recuso restaurar em projeto não vazio.`);
  const { items, order } = buildImportTree(gabarito.tickets);
  if (order.length > MAX_IMPORT_ITEMS) throw new Error(`O gabarito tem ${order.length} tickets e a rota de importação aceita ${MAX_IMPORT_ITEMS} por chamada.`);
  const created = expectOk<Summary[]>("importar árvore", await ctx.client.request("POST", `/projects/${ctx.project}/tickets/import`, { items }));
  if (created.length !== order.length) throw new Error(`A importação devolveu ${created.length} tickets, esperava ${order.length}.`);
  ctx.log(`Árvore recriada: ${created.length} tickets.`);
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
