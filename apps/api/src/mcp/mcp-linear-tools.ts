import { ConflictException, HttpException } from "@nestjs/common";
import { z } from "zod";
import type { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import type { TenantRunner } from "../db/own-transactions.js";
import type { RunView } from "../linear/linear-import.schema.js";
import type { LinearImportService } from "../linear/linear-import.service.js";
import { ToolInputError } from "./mcp-tools.js";
import type { PeopleSource, RunInTenant, ToolContext } from "./mcp-tools.js";
import { cleanMentions, truncateClean } from "./mcp-text.js";
import type { CleanText } from "./mcp-text.js";
import { mcpPersonRef } from "./person-name.js";

/**
 * O Linear pelo MCP (ADR 0062, seção 5). `get_linear_status` é leitura e não chama o Linear. `start_linear_sync` e
 * `continue_linear_sync` são escritas: abrem a rodada de sincronização da ADR 0061 e executam UM passo por chamada, pelo MESMO
 * serviço das rotas `…/linear/runs` e `…/runs/:id/step`, com a chave do Linear da dona do token. Abandonar uma rodada e a
 * categorização (que usa os provedores de IA do TreePM) ficam só na tela. Tudo o que o cliente lê é em inglês.
 */

const PHASES = ["projects", "issues", "hierarchy", "statuses", "mentions", "comments", "missing", "categorize", "done", "failed"] as const;
const progressFields = {
  id: z.string().describe("Sync run id; pass it to continue_linear_sync."),
  phase: z.enum(PHASES).describe("Where the sync is: projects, issues, hierarchy, statuses, mentions, comments, missing; done when it finished, failed when it was stopped on the TreePM screen."),
  done: z.boolean().describe("True when the sync run is over (done or failed)."),
  counts: z.record(z.string(), z.union([z.number(), z.boolean()])).describe("Counts so far (tickets created, updated, kept and so on)."),
  waitUntil: z.string().nullable().describe("Set while Linear asked to slow down: do not continue before this time."),
};
const runStatusSchema = z.strictObject(progressFields).describe("The sync run in progress, if there is one (only for people who can sync this project).");
const runStatusPeopleSchema = runStatusSchema.extend({
  startedBy: z.strictObject({ id: z.string(), name: z.string() }).nullable().describe("Who started this sync run; null when that person can no longer be assigned in this project (inactive or without access)."),
});
const statusFields = {
  linked: z.boolean().describe("True when this project is linked to a Linear team."),
  team: z
    .strictObject({ key: z.string().nullable().describe("The team key, like ENG; null when it does not look like a Linear team key."), name: z.string() })
    .optional()
    .describe("The Linear team this project is linked to."),
  lastSync: z.strictObject({ finishedAt: z.string() }).optional().describe("When the last finished import or sync of this project ended."),
};
export const linearStatusInput = z.strictObject({});
export const linearStatusOutput = z.strictObject({ ...statusFields, run: runStatusSchema.optional() });
const linearStatusPeopleOutput = z.strictObject({ ...statusFields, run: runStatusPeopleSchema.optional() });
export const startLinearSyncInput = z.strictObject({});
export const continueLinearSyncInput = z.strictObject({
  runId: z.uuid("runId must be the id returned by start_linear_sync.").describe("The sync run id returned by start_linear_sync."),
});
export const linearProgressOutput = z.strictObject({
  ...progressFields,
  nextAction: z.string().describe("What to do next: call continue_linear_sync again, wait until `waitUntil`, or nothing (finished)."),
});

/**
 * O prazo da parte do passo que vai ao Linear quando o passo vem do MCP, contado da entrada do passo (TREEPM-496). O gateway do MCP
 * corta a requisição em 30 s (`REQUEST_TIMEOUT_MS`) e responde 504, e o passo seguia em segundo plano. Na tela o teto é o de sempre
 * (`getTeam` até 10 s, e depois as páginas até 25 s), que passa dos 30 s. Pelo MCP, nenhuma página começa se o prazo inteiro dela
 * (10 s) não couber nos 20 s; com `getTeam` lento, o passo devolve o andamento e a chamada seguinte continua. Sobram cerca de 10 s
 * para a gravação: a fila de estrutura espera até 3 s, a conexão do pool até 5 s, e a transação de uma página costuma levar menos de
 * 1 s (estimativa, não medição). Escolhido no lugar de um prazo maior do gateway só para esta ferramenta, porque esse prazo é a proteção da API inteira e porque
 * os clientes e proxies de MCP também cortam em torno de 30 s.
 */
export const MCP_STEP_LINEAR_BUDGET_MS = 20_000;

const SYNC_NOTE =
  "It uses the Linear API key that the person who owns the token connected in TreePM (never somebody else's), with the same permissions and rules as the TreePM screen. The key is never returned. Each call counts toward the limit of 20 changes per minute of this token.";
const LINEAR_READ_DESCRIPTION =
  "Whether this project is linked to a Linear team, when the last import or sync from Linear finished, and the sync run in progress (if any; only for people who can sync this project). It does not call Linear.";

const definitions = (people: boolean) => ({
  get_linear_status: {
    title: "Get the Linear status of the project",
    description: LINEAR_READ_DESCRIPTION,
    inputSchema: linearStatusInput,
    outputSchema: people ? linearStatusPeopleOutput : linearStatusOutput,
  },
});
export const LINEAR_READ_TOOL_DEFINITIONS = definitions(false);
export const LINEAR_READ_PEOPLE_TOOL_DEFINITIONS = definitions(true);

export const LINEAR_WRITE_TOOL_DEFINITIONS = {
  start_linear_sync: {
    title: "Start a sync with Linear",
    description: `Start pulling the changes from the Linear team linked to this project (the same "Sync with Linear" of the TreePM screen): new issues become tickets, changed issues update their tickets unless they were changed in TreePM, nothing is deleted. It only works for a project that was already imported once; the first import is done on the TreePM screen. If a sync is already running, it returns that one. It does one short step at most: call continue_linear_sync with the returned id until \`done\` is true, following \`nextAction\`. ${SYNC_NOTE}`,
    inputSchema: startLinearSyncInput,
    outputSchema: linearProgressOutput,
  },
  continue_linear_sync: {
    title: "Continue a sync with Linear",
    description: `Run ONE step of a sync with Linear (a sync run of this project, started here or on the TreePM screen) and return where it is. Call it again until \`done\` is true, following \`nextAction\`. When Linear asks to slow down, the answer has \`waitUntil\`: calling before that time changes nothing and does not call Linear. ${SYNC_NOTE}`,
    inputSchema: continueLinearSyncInput,
    outputSchema: linearProgressOutput,
  },
} as const;

type Progress = z.infer<typeof linearProgressOutput>;

/** O que o cliente faz em seguida, em inglês. `failed` é uma rodada fechada pela tela ("Abandonar"): não é "terminou". */
export function nextAction(view: Pick<RunView, "phase" | "waitUntil">, now = Date.now()): string {
  if (view.phase === "done") return "The sync finished. Nothing else to do.";
  if (view.phase === "failed") return "This sync run was stopped on the TreePM screen and will not continue. Call start_linear_sync to start a new one.";
  if (view.waitUntil !== null && Date.parse(view.waitUntil) > now) return `Linear asked to slow down. Wait until ${view.waitUntil}, then call continue_linear_sync again with the same runId.`;
  return "Call continue_linear_sync again with the same runId.";
}

/** A rodada como o MCP a entrega: lista explícita de campos. Nada de pessoa, projeto, destino ou dado do Linear além das contagens. */
function progress(view: RunView): Progress {
  return { id: view.id, phase: view.phase, done: view.done, counts: view.counts, waitUntil: view.waitUntil, nextAction: nextAction(view) };
}

/**
 * Frases próprias para as recusas conhecidas do serviço do Linear: todas FIXAS, escritas aqui. Nunca a chave, o e-mail nem texto vindo
 * do Linear (nome de workspace ou de time, identificador, endereço): quem lê é um modelo, e texto de fora numa frase de erro seria um
 * caminho de injeção de instruções (revisão de segurança, TREEPM-496). Código desconhecido → `null` (cai em `refusalMessage`, também fixa).
 */
export function linearRefusal(error: unknown): string | null {
  if (!(error instanceof HttpException)) return null;
  const status = error.getStatus();
  const payload = error.getResponse();
  const body = typeof payload === "object" && payload !== null ? (payload as { code?: unknown; message?: unknown }) : { message: payload };
  const code = typeof body.code === "string" ? body.code : undefined;
  switch (code) {
    case "linear_not_connected":
      return "Connect your Linear API key in TreePM (Settings, Linear) first. If you already did, paste it again.";
    case "linear_workspace_mismatch":
      // Frase FIXA: o nome do workspace vem do Linear, e nenhuma frase de erro do MCP interpola texto de fora (TREEPM-496).
      return "This Linear key belongs to a different workspace than the one this project is linked to.";
    case "linear_team_not_visible":
      return "Your Linear API key cannot see the Linear team linked to this project.";
    case "linear_key_invalid":
      return "Linear refused your API key. Connect a new key in TreePM (Settings, Linear).";
    case "linear_rate_limited":
      return "Linear asked to slow down. Try again in a minute.";
    case "linear_unavailable":
      return "Linear is not responding right now. Try again later; nothing was changed.";
    case "linear_not_linked":
      return "This project is not linked to a Linear team.";
    case "linear_never_imported":
      return "This project was never imported from Linear. The first import is done on the TreePM screen (it asks where the tickets go); after it, you can sync from here.";
    case "linear_step_in_progress":
      return "Another step of this sync is running right now. Try again in a moment.";
    case "linear_categorize_open":
      return "TreePM is placing imported tickets in the tree right now. Sync after that finishes.";
    case "linear_destination_invalid":
      return "The place chosen for the first import no longer exists. Choose a new one on the TreePM screen to sync.";
    case "ticket_in_idea":
      return "The place chosen for the import is inside an idea. Choose a new one on the TreePM screen to sync.";
    case "project_archived":
      return "This project is archived and read-only.";
    default:
      break;
  }
  if (status === 403) return "You do not have permission to sync this project with Linear.";
  if (status === 404) return body.message === "Importação não encontrada." ? "Sync run not found in this project." : "Project not found.";
  return null;
}

export type LinearServices = { imports: LinearImportService; authorization: AuthorizationService };

/** A chave de um time do Linear (`ENG`): letras e dígitos ASCII, até 10. Fora disso, nula. */
const TEAM_KEY_SHAPE = /^[A-Za-z0-9]{1,10}$/;
export const TEAM_NAME_MAX = 80;
// eslint-disable-next-line no-control-regex -- é justamente o que se troca
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * O nome do time como sai pelo MCP (TREEPM-496): texto do Linear, lido por um modelo. Controles e quebras de linha viram espaço; passa
 * pelo limpador comum de menções do MCP (`mcp-text.ts`), sem resolver nomes (todo elo de pessoa vira `@Unnamed person`, o uuid nunca
 * sai); espaços repetidos viram um; corta em 80 sem partir um par substituto.
 */
export function teamNameForMcp(name: string): string {
  const flat = name.replace(CONTROLS, " ");
  const clean = cleanMentions(flat, () => undefined).replace(/\s+/g, " ").trim() as CleanText;
  return truncateClean(clean, TEAM_NAME_MAX);
}

/** `write` existe só para token de escrita com a chave da organização ligada: tokenId e a conferência fresca da participação. */
export type LinearContext = ToolContext & { write?: { tokenId: string; fresh: boolean } };

export class LinearTools {
  constructor(
    private readonly run: RunInTenant,
    private readonly services: LinearServices,
    private readonly context: LinearContext,
    /** A mesma fonte de `list_people`: quem iniciou a rodada só sai se puder ser responsável no projeto agora. */
    private readonly peopleSource?: PeopleSource,
  ) {}

  /** `get_linear_status`: leitura numa transação, sem o Linear. Quem iniciou a rodada só sai com o alcance de pessoas efetivo. */
  async status(): Promise<Record<string, unknown>> {
    return this.run(this.context.principal, async (tx) => {
      const found = await this.services.imports.syncStatus(tx, this.context.principal, this.context.project.id).catch((error: unknown) => {
        throw this.refusal(error);
      });
      if (found.team === null) return { linked: false };
      let run: Record<string, unknown> | undefined;
      if (found.run !== null) {
        const view = found.run;
        run = { id: view.id, phase: view.phase, done: view.done, counts: view.counts, waitUntil: view.waitUntil };
        if (this.context.people === true && this.peopleSource) {
          // Só quem passaria em `list_people` (ativa e com acesso ao projeto); senão `null`.
          const assignable = await this.peopleSource.assignablePeople(tx, this.context.project.id);
          const person = assignable.find((candidate) => candidate.id === view.startedBy.id);
          run["startedBy"] = person ? mcpPersonRef(person) : null;
        }
      }
      const key = TEAM_KEY_SHAPE.test(found.team.key) ? found.team.key : null;
      return {
        linked: true,
        team: { key, name: teamNameForMcp(found.team.name) },
        ...(found.lastFinishedAt === null ? {} : { lastSync: { finishedAt: found.lastFinishedAt } }),
        ...(run === undefined ? {} : { run }),
      };
    });
  }

  /** `start_linear_sync`: o `open` da tela para um projeto já importado; rodada já aberta → devolve a aberta. */
  async start(): Promise<Progress> {
    const tenant = this.tenant();
    try {
      return progress(await this.services.imports.open(tenant, this.principal(), this.context.project.id, {}, { requireImported: true }));
    } catch (error) {
      const open = openRun(error);
      if (open !== null) return progress(open);
      throw this.refusal(error);
    }
  }

  /** `continue_linear_sync`: UM passo, o mesmo da rota `…/runs/:id/step`. O limite de taxa do Linear responde com `waitUntil`, sem erro. */
  async continue(input: z.infer<typeof continueLinearSyncInput>): Promise<Progress> {
    const tenant = this.tenant();
    try {
      return progress(await this.services.imports.step(tenant, this.principal(), this.context.project.id, input.runId.toLowerCase(), { budgetMs: MCP_STEP_LINEAR_BUDGET_MS }));
    } catch (error) {
      throw this.refusal(error);
    }
  }

  private refusal(error: unknown): unknown {
    const message = linearRefusal(error);
    return message === null ? error : new ToolInputError(message);
  }

  private principal(): Principal {
    const write = this.context.write;
    if (!write) throw new ToolInputError("This tool is not available.");
    return { ...this.context.principal, via: { kind: "mcp", tokenId: write.tokenId } };
  }

  /**
   * O `TenantRunner` do MCP, o equivalente ao das rotas `@OwnTransactions` (`TenantInterceptor.runner`): o serviço abre as próprias
   * transações curtas e vai ao Linear FORA delas. Cada transação reconfere que a pessoa está ativa, relê os papéis atuais e marca a
   * origem (`via: mcp`), como toda escrita do MCP. Não há fila aqui: o passo toma a vaga da fila de estrutura e a trava do banco só em
   * volta da gravação, dentro do serviço (aninhar outra vaga em volta prenderia as duas vagas do projeto).
   */
  private tenant(): TenantRunner {
    const write = this.context.write;
    if (!write?.fresh) throw new ToolInputError("This change could not be verified. Try again.");
    const base = this.principal();
    return {
      run: (fn) =>
        this.run(base, async (tx) => {
          const person = await tx.person.findFirst({ where: { id: base.person.id }, select: { active: true } });
          if (!person?.active) throw new ToolInputError("Access denied.");
          const actor = await this.services.authorization.loadActor(tx, base.person.id, base.person.clerkRole);
          return fn(tx, { ...base, actor });
        }),
    };
  }
}

/** A recusa "já existe uma rodada aberta" traz a rodada: o `start` a devolve como resposta normal. */
function openRun(error: unknown): RunView | null {
  if (!(error instanceof ConflictException)) return null;
  const payload = error.getResponse() as { code?: unknown; details?: { run?: RunView } };
  return payload?.code === "linear_run_open" && payload.details?.run ? payload.details.run : null;
}
