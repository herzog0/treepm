import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TicketCommandError, call, failure, listRows, resolveNumber } from "./ticket-commands.js";
import type { Row, TicketContext } from "./ticket-commands.js";

/**
 * Comandos do texto fixo dos agrupadores (ADR 0033, 0034): `summary-show` e `summary-regenerate`. Só usam as rotas
 * `GET tickets/:id/summary` e `POST tickets/:id/summary/regenerate`. O texto do resumo só sai no `summary-show`.
 */
export type SummaryContext = TicketContext & { sleep: (ms: number) => Promise<void>; /** Pasta do andamento do `--subtree` e do `--all` (para o `--resume`). */ dir?: string };
export type SummaryRegenerateInput = { number?: number; subtree?: number; all?: boolean; dryRun?: boolean; resume?: boolean };

type SummaryView = { summary: { text: string; source: string; updatedAt: string } | null };

/** Tentativas de um ticket quando a API pede para esperar (429). */
const MAX_RATE_LIMIT_WAITS = 5;

export async function summaryShowCommand(ctx: SummaryContext, number: number): Promise<void> {
  const ticket = await resolveNumber(ctx, await listRows(ctx), number);
  const view = await call<SummaryView>("ler resumo", ctx, "GET", `/tickets/${ticket.id}/summary`);
  if (!view.summary) {
    ctx.log(`${ticket.key}: sem resumo guardado`);
    return;
  }
  ctx.log(`${ticket.key}: resumo escrito ${view.summary.source === "person" ? "por pessoa" : "pelo assistente"}, atualizado em ${view.summary.updatedAt}`);
  ctx.log(view.summary.text);
}

/** Uma chamada de regenerar; espera o `Retry-After` do 429 e repete o mesmo ticket. */
async function regenerateOne(ctx: SummaryContext, ticket: Row): Promise<void> {
  for (let waits = 0; ; waits++) {
    const response = await ctx.client.request("POST", `/tickets/${ticket.id}/summary/regenerate`);
    if (response.status >= 200 && response.status < 300) return;
    if (response.status === 429 && waits < MAX_RATE_LIMIT_WAITS) {
      const ms = response.retryAfterMs ?? 1000;
      ctx.log(`${ticket.key}: limite de taxa, aguardando ${Math.ceil(ms / 1000)} s`);
      await ctx.sleep(ms);
      continue;
    }
    throw failure(`regenerar resumo de ${ticket.key}`, response);
  }
}

/** Tickets com filhos dentro de `rootNumber` (inclusive), ou do projeto todo; do mais fundo para o topo, irmãos pelo número. */
function regenerationOrder(rows: readonly Row[], rootNumber: number | null): { row: Row; depth: number }[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const hasChildren = new Set(rows.flatMap((row) => (row.parentId === null ? [] : [row.parentId])));
  const depthOf = (row: Row): number => {
    let depth = 0;
    for (let cursor = row.parentId === null ? undefined : byId.get(row.parentId); cursor; cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) depth++;
    return depth;
  };
  const insideRoot = (row: Row, rootId: string): boolean => {
    for (let cursor: Row | undefined = row, guard = 0; cursor && guard <= rows.length; guard++, cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)) {
      if (cursor.id === rootId) return true;
    }
    return false;
  };
  const rootId = rootNumber === null ? null : (rows.find((row) => row.number === rootNumber)?.id ?? null);
  return rows
    .filter((row) => hasChildren.has(row.id) && (rootId === null || insideRoot(row, rootId)))
    .map((row) => ({ row, depth: depthOf(row) }))
    .sort((a, b) => b.depth - a.depth || a.row.number - b.row.number);
}

type Progress = { order: number[]; done: number[] };

export async function summaryRegenerateCommand(ctx: SummaryContext, input: SummaryRegenerateInput): Promise<void> {
  const rows = await listRows(ctx);
  if (input.number !== undefined) {
    const ticket = await resolveNumber(ctx, rows, input.number);
    await call<unknown>(`regenerar resumo de ${ticket.key}`, ctx, "POST", `/tickets/${ticket.id}/summary/regenerate`);
    ctx.log(`${ticket.key}: resumo regenerado (assistente)`);
    return;
  }
  const scope = input.all ? "all" : `subtree-${input.subtree}`;
  const root = input.all ? null : await resolveNumber(ctx, rows, input.subtree as number);
  const byNumber = new Map(rows.map((row) => [row.number, row]));
  const statePath = ctx.dir === undefined ? null : join(ctx.dir, `summary-regenerate-${ctx.project}-${scope}.json`);

  if (input.dryRun) {
    const planned = regenerationOrder(rows, root?.number ?? null);
    for (const { row, depth } of planned) ctx.log(`${row.key} (nível ${depth})`);
    ctx.log(`${planned.length} tickets, nada foi regenerado (--dry-run).`);
    return;
  }

  let progress: Progress;
  if (input.resume) {
    if (statePath === null || !existsSync(statePath)) throw new TicketCommandError(`Não há andamento guardado${statePath ? ` em ${statePath}` : ""} para retomar.`);
    progress = JSON.parse(readFileSync(statePath, "utf8")) as Progress;
    ctx.log(`Retomando: ${progress.done.length} de ${progress.order.length} já feitos.`);
  } else {
    const planned = regenerationOrder(rows, root?.number ?? null);
    if (planned.length === 0) {
      ctx.log(`${root ? root.key : "O projeto"} não tem filhos: nada a regenerar.`);
      return;
    }
    progress = { order: planned.map(({ row }) => row.number), done: [] };
  }
  const save = (): void => {
    if (statePath === null || ctx.dir === undefined) return;
    mkdirSync(ctx.dir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(progress));
  };
  save();

  const total = progress.order.length;
  for (const number of progress.order) {
    if (progress.done.includes(number)) continue;
    const ticket = byNumber.get(number);
    if (!ticket) throw new TicketCommandError(`${number} não existe mais neste projeto: o andamento guardado não vale. Rode de novo sem --resume.`);
    try {
      await regenerateOne(ctx, ticket);
    } catch (error) {
      if (error instanceof TicketCommandError) {
        throw new TicketCommandError(`${error.message}. Parou aqui, com ${progress.done.length} de ${total} feitos; corrija e rode de novo com --resume.`);
      }
      throw error;
    }
    progress.done.push(number);
    save();
    ctx.log(`[${progress.done.length}/${total}] ${ticket.key} regenerado`);
  }
  if (statePath !== null) rmSync(statePath, { force: true });
  ctx.log(`Concluído: ${total} resumos regenerados.`);
}
