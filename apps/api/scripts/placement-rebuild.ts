/**
 * Ferramenta de reconstrução de um projeto pela procura do caminho (ADR 0030). Quem roda com provedores de
 * verdade é a coordenação:
 *
 *   pnpm --filter @treepm/api placement:rebuild <comando> [opções]
 *
 * Comandos: export, check, wipe, rebuild, restore-state, report, restore-original, create-project, archive-project, leave-one-out, collect, pairs, ticket-list, ticket-create, ticket-update (com --idea-stage, --idea-accept, --idea-discard e --idea-make para ideias, e --depends-on e --no-depends-on para dependências), ticket-show, relations-rebuild, summary-show, summary-regenerate, conversation-dry-run, embeddings-status, embeddings-reindex, triage-measure, case-run.
 * Sobe a API real em processo (só a sessão é trocada), em 127.0.0.1 e porta efêmera, e fala com ela por HTTP.
 * O terminal mostra só progresso e contagens; todo texto de ticket fica nos arquivos de `--dir`.
 */
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootApp } from "./placement-rebuild/app.js";
import { requireAssistantConsentOfOrg } from "./placement-rebuild/consent.js";
import { caseRunCommand } from "./placement-rebuild/case-run.js";
import { collectCommand, collectCompareCommand, collectReportCommand } from "./placement-rebuild/collect.js";
import { ApiClient } from "./placement-rebuild/client.js";
import { runEmbeddingsCommand } from "./placement-rebuild/embeddings-commands.js";
import { refuseFakeOverRealOfOrg } from "./placement-rebuild/embeddings-kit.js";
import { runTriageMeasure } from "./placement-rebuild/triage-measure.js";
import { pairsCommand, pairsReportCommand } from "./placement-rebuild/pairs.js";
import { fakePairsKit, realPairsKit } from "./placement-rebuild/pairs-kit.js";
import { loadConfig } from "../src/config.js";
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
import { conversationDryRunCommand } from "./placement-rebuild/conversation-dry-run.js";
import { exitAfterFlush, log } from "./placement-rebuild/output.js";
import { summaryRegenerateCommand, summaryShowCommand } from "./placement-rebuild/summary-commands.js";
import { TicketCommandError, relationsRebuildCommand, ticketCreateCommand, ticketListCommand, ticketShowCommand, ticketUpdateCommand } from "./placement-rebuild/ticket-commands.js";

/** Comandos de ticket: só as rotas da API, sem IA e sem arquivos de `--dir`. Recusa da API: código e mensagem, sem pilha, saída 1. */
const TICKET_ROUTE_COMMANDS = ["ticket-list", "ticket-create", "ticket-update", "relations-rebuild", "ticket-show", "summary-show", "summary-regenerate", "conversation-dry-run"] as const;
type TicketRouteCommand = (typeof TICKET_ROUTE_COMMANDS)[number];
/** Estes passam pelas rotas do assistente: conferem o aceite da organização e a IA ligada (com `--fake-providers`, só para ensaio, usam os provedores falsos). */
const ASSISTANT_COMMANDS: readonly TicketRouteCommand[] = ["summary-show", "summary-regenerate", "conversation-dry-run"];

async function runTicketCommand(command: TicketRouteCommand, options: CliOptions): Promise<number> {
  const needsAi = ASSISTANT_COMMANDS.includes(command) && !(command === "summary-regenerate" && options.dryRun);
  const booted = await bootApp({
    org: options.org as string,
    user: options.user as string,
    role: options.role ?? "org:admin",
    fakeProviders: options.fakeProviders ?? false,
    fake503First: 0,
    fake503JudgeAt: 0,
    needsAi,
  });
  try {
    // O falso nunca sobrescreve vetor de verdade (o `case-run` usa projeto novo e não precisa disto).
    if (command === "conversation-dry-run" && options.fakeProviders) await refuseFakeOverRealOfOrg(options.org as string, options.user as string, options.project as string);
    const ctx = { client: new ApiClient(booted.baseUrl, booted.token), project: options.project as string, log };
    if (command === "ticket-list") await ticketListCommand(ctx, options.json ?? false);
    else if (command === "ticket-show") await ticketShowCommand(ctx, options.number as number);
    else if (command === "summary-show") await summaryShowCommand({ ...ctx, sleep: (ms) => sleep(ms) }, options.number as number);
    else if (command === "summary-regenerate") {
      await summaryRegenerateCommand(
        { ...ctx, sleep: (ms) => sleep(ms), ...(options.dir ? { dir: resolve(options.dir) } : {}) },
        {
          ...(options.number !== undefined ? { number: options.number } : {}),
          ...(options.subtree !== undefined ? { subtree: options.subtree } : {}),
          ...(options.all ? { all: true } : {}),
          ...(options.dryRun ? { dryRun: true } : {}),
          ...(options.resume ? { resume: true } : {}),
        },
      );
    } else if (command === "conversation-dry-run") {
      await conversationDryRunCommand(ctx, { textFile: options.textFile as string, ...(options.scope !== undefined ? { scope: options.scope } : {}) });
    } else if (command === "relations-rebuild") await relationsRebuildCommand(ctx);
    else if (command === "ticket-create") {
      await ticketCreateCommand(ctx, {
        title: options.title as string,
        ...(options.descriptionFile ? { descriptionFile: options.descriptionFile } : {}),
        ...(options.parent ? { parent: options.parent } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.idea ? { idea: true } : {}),
      });
    } else {
      await ticketUpdateCommand(ctx, {
        number: options.number as number,
        ...(options.status ? { status: options.status } : {}),
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.descriptionFile ? { descriptionFile: options.descriptionFile } : {}),
        ...(options.parent ? { parent: options.parent } : {}),
        ...(options.root ? { root: true } : {}),
        ...(options.ideaStage ? { ideaStage: options.ideaStage } : {}),
        ...(options.ideaAccept ? { ideaAccept: true } : {}),
        ...(options.ideaDiscard ? { ideaDiscard: true } : {}),
        ...(options.ideaMake ? { ideaMake: true } : {}),
        ...(options.priority !== undefined ? { priority: options.priority } : {}),
        ...(options.dependsOn !== undefined ? { dependsOn: options.dependsOn } : {}),
        ...(options.noDependsOn !== undefined ? { noDependsOn: options.noDependsOn } : {}),
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
  if (command === "embeddings-status" || command === "embeddings-reindex") return runEmbeddingsCommand(command, options, { log });
  if (command === "triage-measure") return runTriageMeasure(options, { log });
  if ((TICKET_ROUTE_COMMANDS as readonly string[]).includes(command)) return runTicketCommand(command as TicketRouteCommand, options);
  const dir = resolve(options.dir as string);
  ensureDir(dir);

  if (command === "report" && options.pairs) {
    pairsReportCommand({ dir, ...(options.variant ? { variant: options.variant } : {}), log });
    return 0;
  }
  if (command === "pairs") {
    // Só os provedores, sem API em processo. Com provedor de verdade o texto dos tickets de uma organização sai da
    // máquina: `--org` é obrigatório e o aceite do assistente dessa organização é conferido antes (ADR 0039).
    if (!options.fakeProviders) {
      if (!options.org) {
        console.error("O pairs com provedores de verdade precisa de --org: o aceite do assistente de IA dessa organização é conferido antes de qualquer envio.");
        return 2;
      }
      await requireAssistantConsentOfOrg(loadConfig(process.env), options.org);
    }
    const kit = options.fakeProviders ? fakePairsKit() : realPairsKit(loadConfig(process.env));
    const ok = await pairsCommand(
      {
        dir,
        kit,
        log,
        sleep: (ms) => sleep(ms),
        ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
        ...(options.variant ? { variant: options.variant } : {}),
        ...(options.repeats ? { repeats: options.repeats } : {}),
        ...(options.resume ? { resume: true } : {}),
      },
      options.limit,
    );
    return ok ? 0 : 1;
  }
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
    needsAi: command === "rebuild" || command === "leave-one-out" || command === "collect" || command === "case-run",
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
      ...(booted.setConcepts ? { setConcepts: booted.setConcepts } : {}),
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
      case "case-run":
        return (await caseRunCommand(ctx, { caseFile: resolve(options.caseFile as string), repeats: options.repeats ?? 3 })) ? 0 : 1;
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

// `exitAfterFlush`: com a saída num pipe, `process.exit` direto cortava a saída em 64 KB (TREEPM-325).
main().then(
  (code) => exitAfterFlush(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "Erro inesperado.");
    return exitAfterFlush(1);
  },
);
