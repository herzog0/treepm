/**
 * Ferramenta de reconstrução de um projeto pela procura do caminho (ADR 0030). Quem roda com provedores de
 * verdade é a coordenação:
 *
 *   pnpm --filter @treepm/api placement:rebuild <comando> [opções]
 *
 * Comandos: export, check, wipe, rebuild, restore-state, report, restore-original, create-project, archive-project, leave-one-out, collect, ticket-list, ticket-create, ticket-update.
 * Sobe a API real em processo (só a sessão é trocada), em 127.0.0.1 e porta efêmera, e fala com ela por HTTP.
 * O terminal mostra só progresso e contagens; todo texto de ticket fica nos arquivos de `--dir`.
 */
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootApp } from "./placement-rebuild/app.js";
import { collectCommand, collectCompareCommand, collectReportCommand } from "./placement-rebuild/collect.js";
import { ApiClient } from "./placement-rebuild/client.js";
import {
  archiveProjectCommand,
  checkCommand,
  createProjectCommand,
  ensureDir,
  exportCommand,
  leaveOneOutCommand,
  rebuildCommand,
  reportCommand,
  restoreOriginalCommand,
  restoreStateCommand,
  wipeCommand,
} from "./placement-rebuild/commands.js";
import type { Context } from "./placement-rebuild/commands.js";
import { parseCliArgs } from "./placement-rebuild/core.js";
import type { CliOptions } from "./placement-rebuild/core.js";
import { TicketCommandError, ticketCreateCommand, ticketListCommand, ticketUpdateCommand } from "./placement-rebuild/ticket-commands.js";

const log = (line: string): void => console.log(line);

/** Comandos de ticket: só as rotas da API, sem IA e sem arquivos de `--dir`. Recusa da API: código e mensagem, sem pilha, saída 1. */
async function runTicketCommand(command: "ticket-list" | "ticket-create" | "ticket-update", options: CliOptions): Promise<number> {
  const booted = await bootApp({
    org: options.org as string,
    user: options.user as string,
    role: options.role ?? "org:admin",
    fakeProviders: false,
    fake503First: 0,
    fake503JudgeAt: 0,
    needsAi: false,
  });
  try {
    const ctx = { client: new ApiClient(booted.baseUrl, booted.token), project: options.project as string, log };
    if (command === "ticket-list") await ticketListCommand(ctx, options.json ?? false);
    else if (command === "ticket-create") {
      await ticketCreateCommand(ctx, {
        title: options.title as string,
        ...(options.descriptionFile ? { descriptionFile: options.descriptionFile } : {}),
        ...(options.parent ? { parent: options.parent } : {}),
        ...(options.status ? { status: options.status } : {}),
      });
    } else {
      await ticketUpdateCommand(ctx, {
        number: options.number as number,
        ...(options.status ? { status: options.status } : {}),
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.descriptionFile ? { descriptionFile: options.descriptionFile } : {}),
        ...(options.parent ? { parent: options.parent } : {}),
        ...(options.root ? { root: true } : {}),
      });
    }
    return 0;
  } catch (error) {
    if (error instanceof TicketCommandError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  } finally {
    await booted.close();
  }
}

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { command, options } = parsed;
  if (command === "ticket-list" || command === "ticket-create" || command === "ticket-update") return runTicketCommand(command, options);
  const dir = resolve(options.dir as string);
  ensureDir(dir);

  if (command === "report" && options.collect) {
    if (options.compare) {
      collectCompareCommand({
        dir,
        project: options.project as string,
        compare: options.compare,
        ...(options.compareProject ? { compareProject: options.compareProject } : {}),
        ...(options.phaseGroups ? { phaseGroups: options.phaseGroups } : {}),
        log,
      });
      return 0;
    }
    collectReportCommand({ dir, project: options.project as string, ...(options.variant ? { variant: options.variant } : {}), log });
    return 0;
  }
  if (command === "report") {
    reportCommand({ dir, project: options.project as string, log }, options.loo ?? false);
    return 0;
  }

  const booted = await bootApp({
    org: options.org as string,
    user: options.user as string,
    role: options.role ?? "org:admin",
    fakeProviders: options.fakeProviders ?? false,
    fake503First: options.fake503First ?? 0,
    fake503JudgeAt: options.fake503JudgeAt ?? 0,
    needsAi: command === "rebuild" || command === "leave-one-out" || command === "collect",
    collect: command === "collect",
  });
  try {
    const ctx: Context = {
      client: new ApiClient(booted.baseUrl, booted.token),
      recorder: booted.recorder,
      dir,
      project: options.project ?? "",
      log,
      sleep: (ms) => sleep(ms),
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(options.looCrashAfterRemove ? { looCrashAfterRemove: options.looCrashAfterRemove } : {}),
      ...(options.looCrashAfterDraft ? { looCrashAfterDraft: options.looCrashAfterDraft } : {}),
      ...(booted.collectKit ? { collectKit: booted.collectKit } : {}),
      ...(options.repeats ? { repeats: options.repeats } : {}),
      ...(options.variant ? { variant: options.variant } : {}),
      ...(options.claudeOutline ? { claudeOutline: true } : {}),
      ...(options.groupText ? { groupText: options.groupText } : {}),
      ...(options.ticketDescriptions ? { ticketDescriptionsPath: resolve(options.ticketDescriptions) } : {}),
      ...(options.scopeCheck ? { scopeCheck: true } : {}),
      ...(options.flat ? { flat: true } : {}),
    };
    switch (command) {
      case "export":
        await exportCommand(ctx);
        return 0;
      case "check":
        return (await checkCommand(ctx)) ? 0 : 1;
      case "wipe":
        await wipeCommand(ctx, options.confirm as string);
        return 0;
      case "rebuild":
        await rebuildCommand(ctx, options.limit);
        return 0;
      case "leave-one-out":
        return (await leaveOneOutCommand(ctx, options.limit)) ? 0 : 1;
      case "collect":
        return (await collectCommand(ctx, options.limit)) ? 0 : 1;
      case "restore-state":
        return (await restoreStateCommand(ctx)) ? 0 : 1;
      case "restore-original":
        return (await restoreOriginalCommand(ctx)) ? 0 : 1;
      case "create-project":
        await createProjectCommand(ctx, options.key as string, options.name as string);
        return 0;
      case "archive-project":
        await archiveProjectCommand(ctx);
        return 0;
      default:
        return 2;
    }
  } finally {
    await booted.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Erro inesperado.");
    process.exit(1);
  },
);
