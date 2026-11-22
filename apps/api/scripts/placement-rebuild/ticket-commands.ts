import { readFileSync } from "node:fs";
import type { ApiClient, ApiResponse } from "./client.js";

/**
 * Comandos de ticket da ferramenta (`ticket-list`, `ticket-create`, `ticket-update`). Só usam as rotas da API, não
 * chamam IA e nunca imprimem descrição de ticket nem dados de pessoas.
 */
export type TicketContext = { client: ApiClient; project: string; log: (line: string) => void };
export type TicketCreateInput = { title: string; descriptionFile?: string; parent?: number; status?: string };
export type TicketUpdateInput = { number: number; status?: string; title?: string; descriptionFile?: string; parent?: number; root?: boolean };

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
  progress: { done: number; total: number; excluded: number } | null;
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
        })),
      ),
    );
    return;
  }
  for (const { row, depth } of ordered) {
    const progress = row.progress ? `  (${row.progress.done} de ${row.progress.total})` : "";
    ctx.log(`${"  ".repeat(depth)}${row.key}  [${row.status}]  ${row.title}${progress}`);
  }
}

export async function ticketCreateCommand(ctx: TicketContext, input: TicketCreateInput): Promise<void> {
  const description = input.descriptionFile === undefined ? undefined : readText(input.descriptionFile);
  const before = await listRows(ctx);
  const parent = input.parent === undefined ? null : await resolveNumber(ctx, before, input.parent);
  const created = await call<{ id: string; key: string }>("criar ticket", ctx, "POST", `/projects/${ctx.project}/tickets`, {
    title: input.title,
    ...(description === undefined ? {} : { description }),
    parentId: parent?.id ?? null,
    ...(input.status === undefined ? {} : { status: input.status }),
  });
  ctx.log(`Criado: ${created.key}  ${created.id}`);
  reportReopened(ctx, reopened(before, await listRows(ctx)));
}

export async function ticketUpdateCommand(ctx: TicketContext, input: TicketUpdateInput): Promise<void> {
  const hasChange = [input.status, input.title, input.descriptionFile, input.parent, input.root].some((value) => value !== undefined);
  if (!hasChange) throw new TicketCommandError("Informe ao menos um de --status, --title, --description-file, --parent ou --root.");
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
  const updated = await call<Row>("mudar ticket", ctx, "PATCH", `/tickets/${ticket.id}`, body);
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
