/**
 * Ferramenta de reconstrução de um projeto pela procura do caminho (ADR 0030). Quem roda com provedores de
 * verdade é a coordenação:
 *
 *   pnpm --filter @treepm/api placement:rebuild <comando> [opções]
 *
 * Comandos: export, check, wipe, rebuild, restore-state, report, restore-original, create-project, archive-project, leave-one-out.
 * Sobe a API real em processo (só a sessão é trocada), em 127.0.0.1 e porta efêmera, e fala com ela por HTTP.
 * O terminal mostra só progresso e contagens; todo texto de ticket fica nos arquivos de `--dir`.
 */
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { bootApp } from "./placement-rebuild/app.js";
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

const log = (line: string): void => console.log(line);

async function main(): Promise<number> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    return 2;
  }
  const { command, options } = parsed;
  const dir = resolve(options.dir);
  ensureDir(dir);

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
    needsAi: command === "rebuild" || command === "leave-one-out",
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
      ...(options.scopeCheck ? { scopeCheck: true } : {}),
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
