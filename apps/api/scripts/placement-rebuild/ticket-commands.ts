import { readFileSync } from "node:fs";
import type { ApiClient, ApiResponse } from "./client.js";

/**
 * Comandos de ticket da ferramenta (`ticket-list`, `ticket-create`, `ticket-update`; este também aceita, descarta e transforma ideia). Só usam as rotas da API, não
 * chamam IA e nunca imprimem descrição de ticket nem dados de pessoas.
 */
export type TicketContext = { client: ApiClient; project: string; log: (line: string) => void };
export type TicketCreateInput = { title: string; descriptionFile?: string; parent?: number; status?: string; idea?: boolean };
export type TicketUpdateInput = { number: number; status?: string; title?: string; descriptionFile?: string; parent?: number; root?: boolean; ideaStage?: "new" | "refining" | "ready"; ideaAccept?: boolean; ideaDiscard?: boolean; ideaMake?: boolean };

/** Erro esperado de um comando de ticket: a mensagem é o que o terminal mostra, sem rastro de pilha. */
export class TicketCommandError extends Error {
  override name = "TicketCommandError";
}

type Row = {
  id: string;
  number: number;
  key: string;
  parentId: string | null;
  title: string;
  status: string;
  progress: { done: number; total: number; excluded: number; ideas?: number } | null;
  /** ADR 0042: `null` ticket comum; raiz com o estágio; ou ticket dentro de uma ideia. */
  idea?: { root: true; stage: string } | { root: false; rootId: string; rootKey: string } | null;
};

function failure(what: string, response: ApiResponse): TicketCommandError {
  const error = (response.body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error?.message === "string" ? ` — ${error.message}` : "";
  return new TicketCommandError(`${what}: ${code}${message}`);
}

async function call<T>(what: string, ctx: TicketContext, method: string, path: string, body?: unknown): Promise<T> {
  const response = await ctx.client.request(method, path, body);
  if (response.status < 200 || response.status >= 300) throw failure(what, response);
  return response.body as T;
}

const listRows = (ctx: TicketContext): Promise<Row[]> => call<Row[]>("listar tickets", ctx, "GET", `/projects/${ctx.project}/tickets`);

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new TicketCommandError(`Não consegui ler o arquivo de descrição ${path}.`);
  }
}

/** Resolve o número de um ticket no projeto; mensagem com a chave quando não existe. */
async function resolveNumber(ctx: TicketContext, rows: readonly Row[], number: number): Promise<Row> {
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
    ctx.log(`${"  ".repeat(depth)}${row.key}  [${state}]  ${row.title}${idea && !idea.root ? "  (ideia)" : ""}${progress}`);
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
  const others = [input.status, input.title, input.descriptionFile, input.parent, input.root, input.ideaStage].some((value) => value !== undefined);
  if (actions.length > 1 || (actions.length === 1 && others)) {
    throw new TicketCommandError(`${actions.join(", ")} valem sozinhos: uma coisa por comando.`);
  }
  if (actions.length === 1) return ideaActionCommand(ctx, input);
  const hasChange = [input.status, input.title, input.descriptionFile, input.parent, input.root, input.ideaStage].some((value) => value !== undefined);
  if (!hasChange) throw new TicketCommandError("Informe ao menos um de --status, --title, --description-file, --parent, --root ou --idea-stage.");
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
  if (description !== undefined) ctx.log(`${ticket.key}: descrição substituída (${description.length} caracteres)`);
  if (parent) ctx.log(`${ticket.key}: pai → ${parent.key}`);
  if (input.root) ctx.log(`${ticket.key}: pai → nenhum (raiz)`);
  reportReopened(ctx, reopened(before, await listRows(ctx), ticket.id));
}

/**
 * `relations-rebuild`: refaz as ligações "menciona" de todos os tickets do projeto a partir das descrições (ADR 0037), pela
 * rota da API e a mesma regra de quem grava descrição. Imprime só contagens. Rodar de novo não muda nada.
 */
export async function relationsRebuildCommand(ctx: TicketContext): Promise<void> {
  const result = await call<{ read: number; created: number; removed: number }>("refazer ligações", ctx, "POST", `/projects/${ctx.project}/tickets/mentions/rebuild`);
  ctx.log(`Tickets lidos: ${result.read}; ligações criadas: ${result.created}; ligações removidas: ${result.removed}`);
}
