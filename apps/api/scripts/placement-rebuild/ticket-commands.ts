import { readFileSync } from "node:fs";
import type { ApiClient, ApiResponse } from "./client.js";

/**
 * Comandos de ticket da ferramenta (`ticket-list`, `ticket-create`, `ticket-update`; este também aceita, descarta e transforma ideia). Só usam as rotas da API, não
 * chamam IA e nunca imprimem descrição de ticket nem dados de pessoas.
 */
export type TicketContext = { client: ApiClient; project: string; log: (line: string) => void };
export type TicketCreateInput = { title: string; descriptionFile?: string; parent?: number; status?: string; idea?: boolean };
export type TicketUpdateInput = { number: number; status?: string; title?: string; descriptionFile?: string; parent?: number; root?: boolean; ideaStage?: "new" | "refining" | "ready"; priority?: number; ideaAccept?: boolean; ideaDiscard?: boolean; ideaMake?: boolean; dependsOn?: number; noDependsOn?: number; dependsOnDeliver?: number; impediment?: string; noImpediment?: boolean };

/** Erro esperado de um comando de ticket: a mensagem é o que o terminal mostra, sem rastro de pilha. */
export class TicketCommandError extends Error {
  override name = "TicketCommandError";
}

export type Row = {
  id: string;
  number: number;
  key: string;
  parentId: string | null;
  title: string;
  status: string;
  progress: { done: number; total: number; excluded: number; ideas?: number } | null;
  /** ADR 0042: `null` ticket comum; raiz com o estágio; ou ticket dentro de uma ideia. */
  idea?: { root: true; stage: string } | { root: false; rootId: string; rootKey: string } | null;
  /** ADR 0047: prioridade própria (inteiro de -999 a 999); ausente é 0. */
  priority?: number;
};

export function failure(what: string, response: ApiResponse): TicketCommandError {
  const error = (response.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error?.message === "string" ? ` — ${error.message}` : "";
  return new TicketCommandError(`${what}: ${code}${message}`);
}

export async function call<T>(what: string, ctx: TicketContext, method: string, path: string, body?: unknown): Promise<T> {
  const response = await ctx.client.request(method, path, body);
  if (response.status < 200 || response.status >= 300) throw failure(what, response);
  return response.body as T;
}

export const listRows = (ctx: TicketContext): Promise<Row[]> => call<Row[]>("listar tickets", ctx, "GET", `/projects/${ctx.project}/tickets`);

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new TicketCommandError(`Não consegui ler o arquivo de descrição ${path}.`);
  }
}

/** Resolve o número de um ticket no projeto; mensagem com a chave quando não existe. */
export async function resolveNumber(ctx: TicketContext, rows: readonly Row[], number: number): Promise<Row> {
  const found = rows.find((row) => row.number === number);
  if (found) return found;
  const project = await call<{ key: string }>("ler projeto", ctx, "GET", `/projects/${ctx.project}`);
  throw new TicketCommandError(`${project.key}-${number} não existe neste projeto.`);
}

/** Tickets que estavam concluídos antes e deixaram de estar depois: o que a API reabriu. */
function reopened(before: readonly Row[], after: readonly Row[], except?: string): Row[] {
  const wasDone = new Set(before.filter((row) => row.status === "done" && row.id !== except).map((row) => row.id));
  return after.filter((row) => wasDone.has(row.id) && row.status !== "done");
}

function reportReopened(ctx: TicketContext, rows: readonly Row[]): void {
  if (rows.length === 0) return;
  ctx.log(`Reabertos (estavam concluídos): ${rows.map((row) => `${row.key} → ${row.status}`).join(", ")}`);
}

/** Pré-ordem: o pai antes dos filhos; irmãos pelo número. */
function preOrder(rows: readonly Row[]): { row: Row; depth: number }[] {
  const byParent = new Map<string | null, Row[]>();
  for (const row of [...rows].sort((a, b) => a.number - b.number)) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const out: { row: Row; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    for (const row of byParent.get(parentId) ?? []) {
      out.push({ row, depth });
      visit(row.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

export async function ticketListCommand(ctx: TicketContext, json: boolean): Promise<void> {
  const rows = await listRows(ctx);
  const ordered = preOrder(rows);
  if (json) {
    const numberById = new Map(rows.map((row) => [row.id, row.number]));
    ctx.log(
      JSON.stringify(
        ordered.map(({ row }) => ({
          key: row.key,
          number: row.number,
          id: row.id,
          parentNumber: row.parentId === null ? null : (numberById.get(row.parentId) ?? null),
          status: row.status,
          title: row.title,
          progress: row.progress,
          idea: row.idea ?? null,
          ...((row.priority ?? 0) === 0 ? {} : { priority: row.priority }),
        })),
      ),
    );
    return;
  }
  for (const { row, depth } of ordered) {
    const idea = row.idea ?? null;
    const ideas = row.progress?.ideas ?? 0;
    // Dentro de uma ideia não há progresso a mostrar; fora, as ideias abaixo aparecem à parte.
    const progress =
      idea || !row.progress
        ? ""
        : `  (${row.progress.done} de ${row.progress.total}${ideas > 0 ? `; ${ideas} ${ideas === 1 ? "ideia" : "ideias"}` : ""})`;
    const state = idea?.root ? `ideia: ${idea.stage}` : row.status;
    ctx.log(`${"  ".repeat(depth)}${row.key}  [${state}]  ${row.title}${idea && !idea.root ? "  (ideia)" : ""}${progress}${(row.priority ?? 0) === 0 ? "" : `  {prioridade ${row.priority}}`}`);
  }
}

export async function ticketCreateCommand(ctx: TicketContext, input: TicketCreateInput): Promise<void> {
  if (input.idea && input.status !== undefined) throw new TicketCommandError("--idea não combina com --status: a situação de uma ideia é sempre todo.");
  const description = input.descriptionFile === undefined ? undefined : readText(input.descriptionFile);
  const before = await listRows(ctx);
  const parent = input.parent === undefined ? null : await resolveNumber(ctx, before, input.parent);
  const created = await call<{ id: string; key: string }>("criar ticket", ctx, "POST", `/projects/${ctx.project}/tickets`, {
    title: input.title,
    ...(description === undefined ? {} : { description }),
    parentId: parent?.id ?? null,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.idea ? { idea: true } : {}),
  });
  ctx.log(`Criado: ${created.key}  ${created.id}`);
  if (input.idea) ctx.log(`${created.key}: ideia (estágio new)`);
  reportReopened(ctx, reopened(before, await listRows(ctx)));
}

/** `--idea-accept`, `--idea-discard` e `--idea-make`: as mesmas rotas e regras da interface; o erro da API sai com código e mensagem. */
async function ideaActionCommand(ctx: TicketContext, input: TicketUpdateInput): Promise<void> {
  const before = await listRows(ctx);
  const ticket = await resolveNumber(ctx, before, input.number);
  const [what, path, done] = input.ideaAccept
    ? (["aceitar ideia", `/tickets/${ticket.id}/idea/accept`, "ideia aceita"] as const)
    : input.ideaDiscard
      ? (["descartar ideia", `/tickets/${ticket.id}/idea/discard`, "ideia descartada"] as const)
      : (["transformar em ideia", `/tickets/${ticket.id}/idea`, "transformado em ideia"] as const);
  await call<unknown>(what, ctx, "POST", path);
  ctx.log(`${ticket.key}: ${done}`);
  reportReopened(ctx, reopened(before, await listRows(ctx), ticket.id));
}

export async function ticketUpdateCommand(ctx: TicketContext, input: TicketUpdateInput): Promise<void> {
  const actions = [
    input.ideaAccept ? "--idea-accept" : null,
    input.ideaDiscard ? "--idea-discard" : null,
    input.ideaMake ? "--idea-make" : null,
  ].filter((value) => value !== null);
  const changes = [input.status, input.title, input.descriptionFile, input.parent, input.root, input.ideaStage, input.priority, input.dependsOn, input.noDependsOn, input.dependsOnDeliver, input.impediment, input.noImpediment];
  if (actions.length > 1 || (actions.length === 1 && changes.some((value) => value !== undefined))) {
    throw new TicketCommandError(`${actions.join(", ")} valem sozinhos: uma coisa por comando.`);
  }
  if (actions.length === 1) return ideaActionCommand(ctx, input);
  const hasChange = changes.some((value) => value !== undefined);
  if (!hasChange) throw new TicketCommandError("Informe ao menos um de --status, --title, --description-file, --parent, --root, --idea-stage, --priority, --depends-on, --depends-on-deliver, --no-depends-on, --impediment ou --no-impediment.");
  if (input.parent !== undefined && input.root) throw new TicketCommandError("--parent não combina com --root.");
  const description = input.descriptionFile === undefined ? undefined : readText(input.descriptionFile);
  const before = await listRows(ctx);
  const ticket = await resolveNumber(ctx, before, input.number);
  const parent = input.parent === undefined ? undefined : await resolveNumber(ctx, before, input.parent);
  const body = {
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(description === undefined ? {} : { description }),
    ...(parent ? { parentId: parent.id } : {}),
    ...(input.root ? { parentId: null } : {}),
    ...(input.priority === undefined ? {} : { priority: input.priority }),
  };
  const onlyStage = Object.keys(body).length === 0;
  const updated = onlyStage ? ticket : await call<Row>("mudar ticket", ctx, "PATCH", `/tickets/${ticket.id}`, body);
  if (input.ideaStage !== undefined) {
    const before = ticket.idea?.root ? ticket.idea.stage : null;
    const after = await call<Row>("mudar estágio da ideia", ctx, "PUT", `/tickets/${ticket.id}/idea-stage`, { stage: input.ideaStage });
    const to = after.idea?.root ? after.idea.stage : input.ideaStage;
    ctx.log(`${ticket.key}: estágio da ideia ${before ?? "?"} → ${to}`);
  }
  if (input.status !== undefined) ctx.log(`${ticket.key}: situação ${ticket.status} → ${updated.status}`);
  if (input.title !== undefined) ctx.log(`${ticket.key}: título alterado`);
  if (input.priority !== undefined) ctx.log(`${ticket.key}: prioridade ${ticket.priority ?? 0} → ${updated.priority ?? input.priority}`);
  if (description !== undefined) ctx.log(`${ticket.key}: descrição substituída (${description.length} caracteres)`);
  if (parent) ctx.log(`${ticket.key}: pai → ${parent.key}`);
  if (input.root) ctx.log(`${ticket.key}: pai → nenhum (raiz)`);
  if (input.dependsOn !== undefined) await dependencyCommand(ctx, before, ticket, input.dependsOn, "start");
  if (input.dependsOnDeliver !== undefined) await dependencyCommand(ctx, before, ticket, input.dependsOnDeliver, "deliver");
  if (input.noDependsOn !== undefined) await dependencyCommand(ctx, before, ticket, input.noDependsOn, null);
  if (input.impediment !== undefined) {
    await call<unknown>("marcar impedimento", ctx, "PUT", `/tickets/${ticket.id}/impediment`, { reason: input.impediment });
    ctx.log(`${ticket.key}: bloqueado (impedimento marcado)`);
  }
  if (input.noImpediment) {
    const current = await call<Detail>("ler ticket", ctx, "GET", `/tickets/${ticket.id}`);
    if (current.impediment !== null) await call<unknown>("limpar impedimento", ctx, "DELETE", `/tickets/${ticket.id}/impediment`);
    ctx.log(`${ticket.key}: ${current.impediment !== null ? "impedimento limpo" : "já estava sem impedimento"}`);
  }
  reportReopened(ctx, reopened(before, await listRows(ctx), ticket.id));
}

type DependencyLink = { id: string; key: string; title: string; status: string; need?: "start" | "deliver" };
type Detail = Row & { description: string; dependsOn: DependencyLink[]; blocks: DependencyLink[]; mentionedBy: DependencyLink[]; impediment: { reason: string } | null };
const NEED_TEXT = { start: "para começar", deliver: "para entregar" } as const;

/**
 * `--depends-on M` / `--depends-on-deliver M` / `--no-depends-on M` (ADR 0037, 0068): "N depende de M", para começar (`start`) ou
 * para entregar (`deliver`); `need` nulo remove. Idempotente: o estado atual vem do detalhe e repetir só avisa que já estava assim; o
 * outro tipo troca o tipo da dependência que existe. Ciclo e dependência de si mesmo saem com o código da API.
 */
async function dependencyCommand(ctx: TicketContext, rows: readonly Row[], ticket: Row, otherNumber: number, need: "start" | "deliver" | null): Promise<void> {
  const other = await resolveNumber(ctx, rows, otherNumber);
  const current = await call<Detail>("ler ticket", ctx, "GET", `/tickets/${ticket.id}`);
  const existing = current.dependsOn.find((link) => link.id === other.id);
  const already = existing !== undefined;
  if (need !== null) {
    const was = existing?.need ?? null;
    if (was !== need) await call<unknown>("criar dependência", ctx, "POST", `/tickets/${ticket.id}/dependencies`, { ticketId: other.id, need });
    const suffix = need === "deliver" ? ` ${NEED_TEXT.deliver}` : "";
    const line = was === need ? `já dependia de ${other.key}${suffix}` : `depende de ${other.key}${suffix}${was === null ? "" : ` (era ${NEED_TEXT[was]})`}`;
    ctx.log(`${ticket.key}: ${line}`);
    return;
  }
  if (already) await call<unknown>("remover dependência", ctx, "DELETE", `/tickets/${ticket.id}/dependencies/${other.id}`);
  ctx.log(`${ticket.key}: ${already ? "não depende mais de" : "já não dependia de"} ${other.key}`);
}

/**
 * `ticket-show --number N`: o detalhe do ticket em JSON (título, situação, pai, caminho dos ancestrais, descrição, de quem
 * depende, quem depende dele e onde é mencionado). É a única saída que traz a descrição inteira, porque foi pedida.
 */
export async function ticketShowCommand(ctx: TicketContext, number: number): Promise<void> {
  const all = await listRows(ctx);
  const ticket = await resolveNumber(ctx, all, number);
  const detail = await call<Detail>("ler ticket", ctx, "GET", `/tickets/${ticket.id}`);
  const byId = new Map(all.map((row) => [row.id, row]));
  const ancestors: Row[] = [];
  for (let cursor = ticket.parentId === null ? undefined : byId.get(ticket.parentId); cursor && ancestors.length <= all.length; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
    ancestors.unshift(cursor);
  }
  const parent = ancestors.at(-1);
  const brief = (row: Row) => ({ key: row.key, number: row.number, title: row.title });
  const link = (item: DependencyLink) => ({ key: item.key, title: item.title, status: item.status });
  const dependency = (item: DependencyLink) => ({ ...link(item), need: item.need });
  ctx.log(
    JSON.stringify({
      key: detail.key,
      number: detail.number,
      title: detail.title,
      status: detail.status,
      parent: parent ? brief(parent) : null,
      path: ancestors.map((row) => ({ key: row.key, title: row.title })),
      description: detail.description,
      dependsOn: detail.dependsOn.map(dependency),
      blocks: detail.blocks.map(dependency),
      blocked: detail.impediment !== null,
      mentionedBy: detail.mentionedBy.map(link),
    }),
  );
}

/**
 * `relations-rebuild`: refaz as ligações "menciona" de todos os tickets do projeto a partir das descrições (ADR 0037), pela
 * rota da API e a mesma regra de quem grava descrição. Imprime só contagens. Rodar de novo não muda nada.
 */
export async function relationsRebuildCommand(ctx: TicketContext): Promise<void> {
  const result = await call<{ read: number; created: number; removed: number }>("refazer ligações", ctx, "POST", `/projects/${ctx.project}/tickets/mentions/rebuild`);
  ctx.log(`Tickets lidos: ${result.read}; ligações criadas: ${result.created}; ligações removidas: ${result.removed}`);
}
