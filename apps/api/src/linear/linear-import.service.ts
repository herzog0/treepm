import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma, TenantClient } from "@treepm/db";
import type { TicketStatus } from "@treepm/domain";
import type { LinearParentMove } from "@treepm/domain";
import { cleanLinearText, decideLinearField, decideLinearStatus, isFinished, linearInitialParent, mapLinearDescription, mapLinearPriority, mapLinearProjectStatus, mapLinearStatus, mapLinearTitle, matchLinearAssignee, planLinearParents, safeLinearUrl, sameLinearValue } from "@treepm/domain";
import { refuseWhileActingAs } from "../access/act-as.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { isUniqueViolation } from "../common/conflict.js";
import { isConnectionWaitTimeout } from "../common/connection-wait.js";
import { isStructureExpiredWhileWorking } from "../tickets/structure-lock.js";
import { retryableConflict } from "../common/error.filter.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { touchProjectVersion } from "../tickets/project-version.js";
import { structureKey, withStructureSlot } from "../tickets/structure-queue.js";
import { MAX_TREE_DEPTH } from "../tickets/ticket-scope.js";
import { AgentWorkService } from "../tickets/agent-work.service.js";
import { TicketsService } from "../tickets/tickets.service.js";
import type { ProjectRow, TicketRow } from "../tickets/tickets.service.js";
import { LINEAR_TIMEOUT_MS } from "./linear-client.js";
import { LINEAR_CLIENT, LinearError } from "./ports.js";
import type { LinearClient, LinearIssueNode, LinearIssuesPage, LinearPage, LinearProjectNode } from "./ports.js";
import { applyParentMoves } from "./linear-moves.js";
import { mapLinearIssuePage } from "./linear-mapping.js";
import type { MappedIssue } from "./linear-mapping.js";
import { LinearService, linearHttp } from "./linear.service.js";
import type { RunView } from "./linear-import.schema.js";

const PROVIDER = "linear";
/** Tickets cuja ligação com o pai é resolvida por passo da fase `hierarchy`. */
export const HIERARCHY_BATCH = 200;
/** Teto da espera pedida pelo Linear (segundos): um cabeçalho absurdo não congela a rodada. */
const MAX_WAIT_SECONDS = 3600;
const DEFAULT_WAIT_SECONDS = 60;
/** Tickets da rodada que a fase `mentions` olha por passo. */
export const MENTIONS_BATCH = 200;
/** Origens que a fase `missing` olha por passo. */
export const MISSING_BATCH = 500;
/** Origens pendentes de situação que a fase `statuses` decide por passo. */
export const STATUSES_BATCH = 25;
/** O tamanho do lote de uma fase em lote: o normal dela, ou o teto que a rodada guarda depois de uma transação estourada. */
const BATCH_OF_PHASE: Record<string, number | undefined> = { hierarchy: HIERARCHY_BATCH, statuses: STATUSES_BATCH, mentions: MENTIONS_BATCH, missing: MISSING_BATCH };
const batchOf = (run: { batchSize: number | null }, normal: number): number => Math.max(1, Math.min(normal, run.batchSize ?? normal));
/** Páginas da repescagem (volta ao começo da lista depois do último cursor): um teto, para uma lista que nunca para de crescer não prender a rodada. */
const MAX_SWEEP_PAGES = 40;
/** Itens por página de issues quando nada estourou. */
const FULL_PAGE = 50;
/** Teto de um passo que vai ao Linear: chamadas e tempo (uma chamada só começa se ainda cabe o prazo dela dentro dos 25 s). */
export const STEP_MAX_CALLS = 6;
export const STEP_MAX_MS = 25_000;
/** Páginas conhecidas seguidas que a repescagem aceita no topo antes de parar (uma issue conhecida sozinha não encerra). */
const SWEEP_MIN_PAGE = 10;

const COUNT_KEYS = [
  "projectsSeen",
  "projectsCreated",
  "projectsExisting",
  "projectsElsewhere",
  "issuesSeen",
  "issuesCreated",
  "issuesExisting",
  "issuesElsewhere",
  "issuesTrashed",
  "assigned",
  "parentsLinked",
  "flattened",
  "skipped",
  "reopened",
  "skippedInvalid",
  "withoutDescription",
  "movedOutOfIdea",
  "keptMoved",
  // Reimportação (ADR 0060, seção 5).
  "updated",
  "keptTouched",
  "unchanged",
  "elsewhere",
  "missing",
  "missingProjects",
] as const;
/**
 * `assigneeEmailUnavailable`: o Linear recusou o e-mail dos responsáveis nesta rodada; ninguém foi atribuído.
 * `descriptionUnavailable`: alguma página veio sem descrição (issue enorme); a descrição desses tickets não foi tocada na reimportação.
 * `missingNotChecked`: a leitura pulou itens fora do formato; por isso a fase `missing` não marcou nada.
 */
type Counts = Record<(typeof COUNT_KEYS)[number], number> & { assigneeEmailUnavailable?: true; descriptionUnavailable?: true; missingNotChecked?: true };
const zeroCounts = (): Counts => Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as unknown as Counts;
const readCounts = (raw: unknown): Counts => {
  const counts = zeroCounts();
  if (typeof raw === "object" && raw !== null) {
    for (const key of COUNT_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
    }
    if ((raw as Record<string, unknown>)["assigneeEmailUnavailable"] === true) counts.assigneeEmailUnavailable = true;
    if ((raw as Record<string, unknown>)["descriptionUnavailable"] === true) counts.descriptionUnavailable = true;
    if ((raw as Record<string, unknown>)["missingNotChecked"] === true) counts.missingNotChecked = true;
  }
  return counts;
};

/**
 * O cursor da fase `issues`: o do Linear na leitura principal; na REPESCAGEM (volta ao começo da lista, de novo as mais novas
 * primeiro, para achar o que foi criado durante a rodada) vem com a marca `~N` (N = páginas da repescagem já lidas) e o cursor
 * do Linear depois de `|`. Marca e cursor andam juntos na mesma coluna, então voltar um passo nunca desencontra os dois.
 */
const SWEEP_MARK = "~";
function parseIssuesCursor(raw: string | null): { sweep: number; known: number; after: string | null } {
  if (raw === null || !raw.startsWith(SWEEP_MARK)) return { sweep: 0, known: 0, after: raw };
  const bar = raw.indexOf("|");
  const [sweepText, knownText] = raw.slice(1, bar === -1 ? undefined : bar).split(".");
  const sweep = Number(sweepText);
  const known = Number(knownText ?? 0);
  return { sweep: Number.isInteger(sweep) && sweep > 0 ? sweep : 1, known: Number.isInteger(known) && known > 0 ? known : 0, after: bar === -1 ? null : raw.slice(bar + 1) };
}
/** `known`: issues conhecidas SEGUIDAS desde o começo da repescagem (a repescagem só para depois de `SWEEP_MIN_PAGE`). */
const issuesCursor = (sweep: number, known: number, after: string | null): string | null => (sweep === 0 ? after : `${SWEEP_MARK}${sweep}${known > 0 ? `.${known}` : ""}${after === null ? "" : `|${after}`}`);

/** Impasse entre travas (40P01), falha de serialização (40001) e prazo da transação interativa (P2028): se repetem sozinhos. */
const isTransient = (error: unknown): boolean => retryableConflict(error) !== null || (error as { code?: unknown } | null)?.code === "P2028";

/** Erros que se repetem sozinhos (outra aba na trava, limite do Linear): não entram na sequência de falhas da rodada. */
const RETRYABLE_CODES = new Set(["structure_busy", "concurrent_update", "linear_step_in_progress", "linear_rate_limited"]);

type RunRow = {
  orgId: string;
  id: string;
  projectId: string;
  mode: string;
  phase: string;
  cursor: string | null;
  destinationTicketId: string | null;
  categorize: boolean;
  counts: Prisma.JsonValue;
  totalExpected: number | null;
  waitUntil: Date | null;
  lastErrorCode: string | null;
  pageSize: number;
  batchSize: number | null;
  sizeStreak: number;
  errorStreak: number;
  hasDestination: boolean;
  startedByPersonId: string;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};

/** Data do Linear que não parseia vira nulo: nunca derruba o nó nem o passo. */
const validDate = (value: string): Date | null => {
  const date = new Date(value);
  // O banco guarda de 4713 a.C. a 294276 d.C.; o Linear não tem nada antes de 1970 nem depois de 9999.
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 9999 ? null : date;
};

const isTerminal = (phase: string): boolean => phase === "done" || phase === "failed";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * O controle da rodada na fase `statuses` (colunas `status_run_id` e `status_run_flags` da origem; só vale quando o id é o da rodada
 * em andamento): o que a fase `issues` já contou do ticket nesta rodada e o que a fase `statuses` já avaliou.
 */
const FLAG_UPDATED = 1;
const FLAG_KEPT = 2;
const FLAG_EVALUATED = 4;
const FLAG_STATUS_CHANGED = 8;
/** A chave da situação no retrato de origem: `stateType` na issue, `statusType` no projeto do Linear. */
const statusKeyOf = (kind: string): "stateType" | "statusType" => (kind === "project" ? "statusType" : "stateType");
const mapRawStatus = (kind: string, raw: unknown): TicketStatus => (kind === "project" ? mapLinearProjectStatus(typeof raw === "string" ? raw : null) : mapLinearStatus(typeof raw === "string" ? raw : ""));
/** Só as chaves de `patch` cujo valor difere do de `current` (um retrato só é regravado quando algo mudou). */
const changedKeys = (current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(patch).filter(([key, value]) => JSON.stringify(current[key] ?? null) !== JSON.stringify(value ?? null)));

/** A issue como a reimportação a compara: o que chega e o retrato de origem, os dois mapeados com a regra de hoje. */
function issueIncoming(node: LinearIssueNode, mapped: MappedIssue, ref: RefRow, projectKey: string, withoutDescription: boolean): Incoming {
  const source = (ref.sourceSnapshot ?? {}) as Record<string, unknown>;
  return {
    key: mapped.identifier,
    url: safeLinearUrl(node.url),
    updatedAt: validDate(node.updatedAt),
    parentId: node.parentId,
    projectId: node.projectId,
    title: mapped.title,
    description: withoutDescription ? null : mapped.description,
    status: mapped.status,
    priority: mapped.priority,
    assignee: { externalId: mapped.source.assigneeExternalId, email: node.assignee?.email ?? null, emailReadable: node.assignee === null || node.assignee.email !== null },
    source: mapped.source,
    previous: {
      title: mapLinearTitle(text(source["title"]), node.identifier),
      description: mapLinearDescription(typeof source["description"] === "string" ? source["description"] : null, projectKey),
      status: mapLinearStatus(text(source["stateType"])),
      priority: mapLinearPriority(typeof source["priority"] === "number" ? source["priority"] : 0),
      assigneeExternalId: typeof source["assigneeExternalId"] === "string" ? source["assigneeExternalId"] : null,
    },
  };
}

/** O retrato de origem do projeto (`name`, `statusType`) mapeado com a regra de hoje. */
function withProjectPrevious(incoming: Incoming, ref: RefRow): Incoming {
  const source = (ref.sourceSnapshot ?? {}) as Record<string, unknown>;
  return { ...incoming, previous: { ...incoming.previous, title: mapLinearTitle(text(source["name"]), "Projeto do Linear"), status: mapLinearProjectStatus(typeof source["statusType"] === "string" ? source["statusType"] : null) } };
}

/** O projeto do Linear que virou ticket pai: só título e situação. */
function projectIncoming(node: LinearProjectNode): Incoming {
  return {
    key: null,
    url: safeLinearUrl(node.url),
    updatedAt: null,
    parentId: undefined,
    projectId: null,
    title: mapLinearTitle(node.name, "Projeto do Linear"),
    description: undefined,
    status: mapLinearProjectStatus(node.statusType),
    priority: null,
    assignee: null,
    source: { name: cleanLinearText(node.name), statusType: node.statusType === null ? null : cleanLinearText(node.statusType) },
    previous: { title: "", description: "", status: "todo", priority: null, assigneeExternalId: null },
  };
}

const view = (row: RunRow): RunView => ({
  id: row.id,
  projectId: row.projectId,
  mode: row.mode as RunView["mode"],
  phase: row.phase as RunView["phase"],
  done: isTerminal(row.phase),
  categorize: row.categorize,
  categorizeAvailable: false,
  counts: readCounts(row.counts),
  totalExpected: row.totalExpected,
  waitUntil: row.waitUntil ? row.waitUntil.toISOString() : null,
  lastErrorCode: row.lastErrorCode,
  errorStreak: row.errorStreak,
  pageSize: row.pageSize,
  destinationTicketId: row.destinationTicketId,
  startedBy: { id: row.startedByPersonId },
  startedAt: row.startedAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
});

const runOpen = (run: RunRow): ConflictException => new ConflictException({ code: "linear_run_open", message: "Já existe uma importação em andamento neste projeto.", details: { run: view(run) } });

/** O que a fase de criação grava para um ticket novo (e a origem dele). */
type NewTicket = {
  title: string;
  description: string;
  status: string;
  priority: number;
  parentId: string | null;
  assigneeIds: string[];
  ref: { kind: "issue" | "project"; externalId: string; externalKey: string | null; externalUrl: string | null; externalParentId: string | null; externalProjectId: string | null; source: Prisma.InputJsonObject; externalUpdatedAt: Date | null };
};

/** A origem de um ticket como a reimportação a lê. */
type RefRow = {
  ticketId: string;
  kind: string;
  statusPending: boolean;
  projectId: string;
  externalId: string;
  externalKey: string | null;
  externalUrl: string | null;
  externalParentId: string | null;
  externalProjectId: string | null;
  sourceSnapshot: Prisma.JsonValue;
  appliedSnapshot: Prisma.JsonValue;
  lastSeenRunId: string | null;
  statusRunId: string | null;
  statusRunFlags: number;
};
type TicketNow = { id: string; number: number; title: string; description: string; status: string; priority: number; parentId: string | null; ideaStage: string | null; assigneeIds: string[] };
/**
 * O que chega do Linear para uma origem que já existe, com os dois lados já MAPEADOS do mesmo jeito (o retrato de origem guarda o
 * texto cru; mapeá-lo com a regra de hoje evita ler uma mudança da regra de mapeamento como "mudou no Linear").
 */
type Incoming = {
  key: string | null;
  url: string | null;
  updatedAt: Date | null;
  parentId: string | null | undefined;
  projectId: string | null;
  title: string;
  /** `null` = esta leitura não trouxe a descrição; `undefined` = o projeto do Linear não tem descrição. */
  description: string | null | undefined;
  status: TicketStatus;
  /** `null` = projeto do Linear (não tem prioridade nem responsável). */
  priority: number | null;
  assignee: { externalId: string | null; email: string | null; emailReadable: boolean } | null;
  /** O retrato de origem novo (cru, sem e-mail). */
  source: Prisma.InputJsonObject;
  previous: { title: string; description: string; status: TicketStatus; priority: number | null; assigneeExternalId: string | null };
};

/** Fase de passo que vai à rede. */
type Fetched =
  | { phase: "projects"; page: LinearPage<LinearProjectNode> }
  | { phase: "issues"; page: LinearIssuesPage; /** A página mapeada FORA da transação (função pura), com a chave do projeto lida no começo do passo. */ mapped: Map<string, MappedIssue>; mappedFor: string; /** O passo precisou reduzir a página (o Linear estourou o teto ou o prazo) e o tamanho que deu certo. */ reduced: boolean; usedSize: number; /** A página veio sem descrição (a issue sozinha estourava o teto). */ withoutDescription: boolean };

/** O Linear limitou: o código 429 de `linearHttp` ou do `requireLinearAccess`, com a espera pedida. */
function rateLimitWait(error: unknown): number | null {
  if (!(error instanceof HttpException) || error.getStatus() !== 429) return null;
  const body = error.getResponse() as { details?: { retryAfterSeconds?: unknown } };
  const seconds = Number(body?.details?.retryAfterSeconds);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), MAX_WAIT_SECONDS) : DEFAULT_WAIT_SECONDS;
}

/**
 * Importação do Linear em passos (ADR 0060, seções 3 a 5): abre a rodada e executa um passo por chamada. Cada passo faz no máximo
 * UMA ida ao Linear (fora de transação) e UMA transação curta de gravação, que trava a estrutura do projeto como a importação por
 * lista, confere que a rodada ainda está onde o passo a leu (fase e cursor) e grava tickets, origem e cursor juntos.
 */
@Injectable()
export class LinearImportService {
  private readonly logger = new Logger("LinearImport");
  /** Rodadas com um passo em andamento NESTA instância: um segundo passo na mesma rodada recebe 409 sem ir ao Linear. */
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(LINEAR_CLIENT) private readonly client: LinearClient,
    @Inject(LinearService) private readonly linear: LinearService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
  ) {}

  // ---- guarda comum ----

  /** Projeto visível (404), permissão de importar (403) e não arquivado (409): a mesma da importação por lista. */
  private async guard(tx: TenantClient, principal: Principal, projectId: string, options: { writable: boolean }): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { orgId: principal.organization.orgId, id: projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    this.authorization.importTickets(principal.actor, projectId);
    if (options.writable && project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    return project;
  }

  private async lastRun(tx: TenantClient, orgId: string, projectId: string): Promise<RunRow | null> {
    return (await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: { not: "categorize" } }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] })) as RunRow | null;
  }

  // ---- abrir e ler ----

  async current(tenant: TenantRunner, principal: Principal, projectId: string): Promise<{ run: RunView | null; lastFinished: RunView | null }> {
    refuseWhileActingAs(principal);
    return tenant.run(async (tx, current) => {
      await this.guard(tx, current, projectId, { writable: false });
      const orgId = current.organization.orgId;
      const open = await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: { not: "categorize" }, phase: { notIn: ["done", "failed"] } } });
      const run = (open as RunRow | null) ?? (await this.lastRun(tx, orgId, projectId));
      // A última concluída (para a tela dizer "Reimportação · há 2 dias"), mesmo quando a rodada atual é outra.
      const finished = (await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: { not: "categorize" }, phase: "done" }, orderBy: [{ finishedAt: "desc" }, { id: "desc" }] })) as RunRow | null;
      return { run: run ? view(run) : null, lastFinished: finished ? view(finished) : null };
    });
  }

  /** Quantas issues o time ligado tem, para a tela dizer antes de importar. Qualquer falha do Linear (chave, limite, queda) vira `null`. */
  async preview(tenant: TenantRunner, principal: Principal, projectId: string): Promise<{ issueCount: number | null }> {
    refuseWhileActingAs(principal);
    await tenant.run(async (tx, current) => {
      await this.guard(tx, current, projectId, { writable: false });
    });
    let access: { key: string; source: { externalTeamId: string } };
    try {
      access = await this.linear.requireLinearAccess(tenant, principal, projectId);
    } catch (error) {
      // Chave ausente ou de outro workspace (4xx) continua erro; o Linear fora do ar ou limitando só tira a contagem.
      if (error instanceof HttpException && (error.getStatus() >= 500 || error.getStatus() === 429)) return { issueCount: null };
      throw error;
    }
    try {
      return { issueCount: await this.client.countTeamIssues(access.key, access.source.externalTeamId) };
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      return { issueCount: null };
    }
  }

  async open(tenant: TenantRunner, principal: Principal, projectId: string, body: { destinationTicketId?: string | null; categorize?: boolean }): Promise<RunView> {
    refuseWhileActingAs(principal);
    await tenant.run(async (tx, current) => {
      const project = await this.guard(tx, current, projectId, { writable: true });
      await this.checkOpenable(tx, current, project, body.destinationTicketId);
    });
    // O Linear (rede) fora de transação: a chave de QUEM abre tem de funcionar e enxergar o time; a contagem é só para a tela.
    const { key, source } = await this.linear.requireLinearAccess(tenant, principal, projectId);
    let totalExpected: number | null = null;
    try {
      totalExpected = await this.client.countTeamIssues(key, source.externalTeamId);
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      // Contagem é só informação: o limite ou uma falha do Linear não impedem abrir.
    }
    try {
      return await tenant.run(async (tx, current) => {
        const project = await this.guard(tx, current, projectId, { writable: true });
        const { mode, destination } = await this.checkOpenable(tx, current, project, body.destinationTicketId);
        const row = await tx.externalImportRun.create({
          data: {
            orgId: current.organization.orgId,
            projectId,
            provider: PROVIDER,
            startedByPersonId: current.person.id,
            mode,
            phase: "projects",
            destinationTicketId: destination,
            hasDestination: destination !== null,
            categorize: body.categorize === true,
            counts: zeroCounts(),
            totalExpected,
          },
        });
        return view(row as RunRow);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Corrida: outra aba abriu a rodada entre a conferência e a gravação.
        const open = await tenant.run((tx, current) => this.lastRun(tx, current.organization.orgId, projectId));
        if (open && !isTerminal(open.phase)) throw runOpen(open);
        // A corrida foi com a categorização (o índice único vale entre os modos).
        const categorizing = await tenant.run((tx, current) => tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, projectId, mode: "categorize", phase: "categorize" }, select: { id: true } }));
        if (categorizing) throw new ConflictException({ code: "linear_categorize_open", message: "Já existe uma categorização em andamento neste projeto." });
      }
      throw error;
    }
  }

  /**
   * O projeto está ligado, não tem rodada aberta e o destino serve. Com uma rodada `done` no projeto a nova é a reimportação
   * (`reimport`); o destino que vale para ela é o da PRIMEIRA concluída, a menos que o corpo traga outro (`undefined` herda;
   * `null` é a raiz). O herdado que não serve mais (ticket apagado, ou dentro de uma ideia) recusa: nunca cai na raiz em silêncio.
   */
  private async checkOpenable(tx: TenantClient, principal: Principal, project: ProjectRow, requested: string | null | undefined): Promise<{ mode: "first" | "reimport"; destination: string | null }> {
    const orgId = principal.organization.orgId;
    const source = await tx.projectExternalSource.findUnique({ where: { orgId_projectId: { orgId, projectId: project.id } } });
    if (!source) throw new ConflictException({ code: "linear_not_linked", message: "Este projeto não está ligado a um time do Linear." });
    const last = await this.lastRun(tx, orgId, project.id);
    const openRun = last && !isTerminal(last.phase) ? last : null;
    if (openRun) throw runOpen(openRun);
    // Uma categorização aberta também ocupa o projeto (o índice único parcial vale entre os modos): a importação espera ela terminar.
    if (await tx.externalImportRun.findFirst({ where: { orgId, projectId: project.id, mode: "categorize", phase: "categorize" }, select: { id: true } })) {
      throw new ConflictException({ code: "linear_categorize_open", message: "Já existe uma categorização em andamento neste projeto." });
    }
    const firstDone = (await tx.externalImportRun.findFirst({ where: { orgId, projectId: project.id, mode: { not: "categorize" }, phase: "done" }, orderBy: [{ startedAt: "asc" }, { id: "asc" }] })) as RunRow | null;
    const mode = firstDone ? "reimport" : "first";
    if (requested !== undefined) {
      if (requested !== null) await this.requireDestination(tx, project, requested);
      return { mode, destination: requested };
    }
    if (!firstDone || !firstDone.hasDestination) return { mode, destination: null };
    // A primeira importação tinha um destino: ele continua valendo (a rodada concluída não o guarda se o ticket foi apagado).
    const inherited = firstDone.destinationTicketId;
    const invalid = (): ConflictException => new ConflictException({ code: "linear_destination_invalid", message: "O destino da primeira importação não está mais disponível. Escolha outro destino para esta importação." });
    if (inherited === null) throw invalid();
    try {
      await this.requireDestination(tx, project, inherited);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw invalid();
      throw error;
    }
    return { mode, destination: inherited };
  }

  /** O destino é um ticket do projeto (404) e não está dentro de uma ideia (409): as regras da importação por lista. */
  private async requireDestination(tx: TenantClient, project: ProjectRow, destination: string): Promise<void> {
    await this.tickets.requireParent(tx, project.id, destination);
    if (await this.tickets.ideaRootFor(tx, project, destination)) {
      throw new ConflictException({ code: "ticket_in_idea", message: "Dentro de uma ideia a importação não é possível; aceite a ideia antes." });
    }
  }

  // ---- abandonar ----

  /**
   * Fecha uma rodada que não termina (destino que ficou inválido, página que não vem, chave que não volta): fase `failed`. O que já
   * foi importado fica, com a origem, e uma rodada nova `first` o reconhece e segue de onde parou. Concluída não se abandona.
   */
  async abandon(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<RunView> {
    refuseWhileActingAs(principal);
    const write = (): Promise<RunView> =>
      tenant.run(async (tx, current) => {
        await this.guard(tx, current, projectId, { writable: false });
        await this.tickets.lockStructure(tx, projectId);
        const run = (await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, id: runId, projectId, mode: { not: "categorize" } } })) as RunRow | null;
        if (!run) throw new NotFoundException("Importação não encontrada.");
        if (run.phase === "failed") return view(run);
        if (run.phase === "done") throw new ConflictException({ code: "linear_run_finished", message: "Esta importação já foi concluída." });
        const updated = await tx.externalImportRun.update({
          where: { orgId_id: { orgId: current.organization.orgId, id: run.id } },
          data: { phase: "failed", waitUntil: null, finishedAt: new Date() },
        });
        await this.activity.record(tx, current, {
          kind: "ticket.import_abandoned_from_linear",
          subjectType: "project",
          subjectId: projectId,
          payload: { provider: PROVIDER, runId: run.id, phase: run.phase, counts: readCounts(run.counts) },
        });
        return view(updated as RunRow);
      });
    const key = structureKey(principal.organization.orgId, projectId);
    return key === undefined ? write() : withStructureSlot(key, write);
  }

  // ---- o passo ----

  async step(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<RunView> {
    refuseWhileActingAs(principal);
    const flightKey = `${principal.organization.orgId}:${runId}`;
    if (this.inFlight.has(flightKey)) {
      throw new ConflictException({ code: "linear_step_in_progress", message: "Outro passo desta importação está em andamento. Aguarde." });
    }
    this.inFlight.add(flightKey);
    try {
      return await this.stepOnce(tenant, principal, projectId, runId);
    } finally {
      this.inFlight.delete(flightKey);
    }
  }

  private async stepOnce(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<RunView> {
    const { run: seen, projectKey } = await tenant.run(async (tx, current) => {
      const project = await this.guard(tx, current, projectId, { writable: false });
      const run = (await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, id: runId, projectId, mode: { not: "categorize" } } })) as RunRow | null;
      if (!run) throw new NotFoundException("Importação não encontrada.");
      return { run, projectKey: project.key };
    });
    if (isTerminal(seen.phase)) return view(seen);
    // Ainda dentro da espera pedida pelo Linear: responde o mesmo estado, sem chamar o Linear.
    if (seen.waitUntil !== null && seen.waitUntil.getTime() > Date.now()) return view(seen);

    let fetched: Fetched | null = null;
    if (seen.phase === "projects" || seen.phase === "issues") {
      const result = await this.fetchPage(tenant, principal, projectId, seen, projectKey);
      if ("wait" in result) return result.wait;
      fetched = result.fetched;
    }
    const write = (): Promise<RunView> => tenant.run((tx, current) => this.apply(tx, current, projectId, seen, fetched));
    const key = structureKey(principal.organization.orgId, projectId);
    try {
      return await (key === undefined ? write() : withStructureSlot(key, write));
    } catch (error) {
      // Falha na gravação (destino inválido, queda do banco, limite de tempo da transação): fica registrada na rodada, que segue aberta.
      // Transação que estourou o prazo (P2028 de transação já aberta): o passo seguinte começa com a metade do tamanho; com tamanho 1 e
      // ainda estourando, conta na sequência de erros (a tela oferece "Abandonar"). A espera por uma conexão do pool (o outro P2028)
      // não é culpa do tamanho do passo: só se repete.
      const expired = isStructureExpiredWhileWorking(error) || ((error as { code?: unknown } | null)?.code === "P2028" && !isConnectionWaitTimeout(error));
      const code = expired ? "step_too_slow" : (this.errorCode(error) ?? "step_failed");
      if (expired) {
        if (!(await this.shrinkStep(tenant, seen))) await this.noteError(tenant, seen, code);
      } else if (!RETRYABLE_CODES.has(code) && !isTransient(error)) await this.noteError(tenant, seen, code);
      throw error;
    }
  }

  /** A ida ao Linear (fora de transação). Limite → grava a espera e devolve a rodada; chave/time/queda → erro com a rodada intacta. */
  private async fetchPage(tenant: TenantRunner, principal: Principal, projectId: string, run: RunRow, projectKey: string): Promise<{ fetched: Fetched } | { wait: RunView }> {
    // O tamanho de página que este passo alcançou: gravado mesmo quando o passo termina em erro, para o próximo começar de onde este chegou.
    const progress = { size: run.pageSize };
    try {
      const { key, source } = await this.linear.requireLinearAccess(tenant, principal, projectId);
      if (run.phase === "projects") return { fetched: { phase: "projects", page: await this.client.listTeamProjects(key, source.externalTeamId, run.cursor) } };
      const issues = await this.fetchIssues(key, source.externalTeamId, run, progress);
      // O mapeamento da página (função pura) roda aqui, FORA da transação de gravação.
      return { fetched: { ...issues, mapped: mapLinearIssuePage(issues.page.nodes, projectKey), mappedFor: projectKey } };
    } catch (error) {
      const http = error instanceof LinearError ? linearHttp(error) : error;
      const seconds = rateLimitWait(http);
      if (seconds !== null) return { wait: await this.recordWait(tenant, run, seconds, progress.size) };
      const code = this.errorCode(http);
      if (code !== null) await this.noteError(tenant, run, code, progress.size);
      throw http;
    }
  }

  /**
   * Uma página de issues no tamanho que a rodada guarda. Se a resposta estoura o teto do corpo ou o prazo, repete com a metade (50,
   * 25, 12, 6, 3, 1); com 1 e ainda falhando, busca aquela issue SEM descrição. Um passo faz no máximo `STEP_MAX_CALLS` chamadas e
   * `STEP_MAX_MS`: ao estourar, termina em erro, mas o tamanho alcançado já está em `progress.size` (gravado pelo chamador). O que
   * deu certo vira o tamanho da rodada, e só volta a crescer (ao dobro) depois de três passos seguidos bem-sucedidos sem reduzir
   * (`size_streak`): voltar ao dobro no passo seguinte repetiria o estouro.
   */
  private async fetchIssues(key: string, teamId: string, run: RunRow, progress: { size: number }): Promise<Omit<Extract<Fetched, { phase: "issues" }>, "mapped" | "mappedFor">> {
    const { after } = parseIssuesCursor(run.cursor);
    const withEmail = readCounts(run.counts).assigneeEmailUnavailable !== true;
    let size = Math.min(Math.max(run.pageSize, 1), FULL_PAGE);
    progress.size = size;
    let reduced = false;
    let withDescription = true;
    const startedAt = Date.now();
    let lastError: LinearError | null = null;
    for (let calls = 0; ; calls += 1) {
      // Mais uma chamada só se ainda cabem as chamadas e o prazo dela (`LINEAR_TIMEOUT_MS`) dentro do teto do passo.
      if (lastError !== null && (calls >= STEP_MAX_CALLS || Date.now() - startedAt + LINEAR_TIMEOUT_MS > STEP_MAX_MS)) throw lastError;
      try {
        const page = await this.client.listTeamIssues(key, teamId, after, { first: size, withDescription, withEmail });
        return { phase: "issues", page, reduced, usedSize: size, withoutDescription: !withDescription };
      } catch (error) {
        if (!(error instanceof LinearError) || (error.code !== "linear_response_too_large" && error.code !== "linear_timeout")) throw error;
        lastError = error;
        if (size > 1) {
          size = Math.max(1, Math.floor(size / 2));
          reduced = true;
          progress.size = size;
        } else if (withDescription) withDescription = false;
        else throw error;
      }
    }
  }

  private errorCode(error: unknown): string | null {
    if (!(error instanceof HttpException)) return null;
    const code = (error.getResponse() as { code?: unknown })?.code;
    return typeof code === "string" ? code : null;
  }

  private async recordWait(tenant: TenantRunner, run: RunRow, seconds: number, pageSize: number): Promise<RunView> {
    return tenant.run(async (tx, current) => {
      const waitUntil = new Date(Date.now() + seconds * 1000);
      await tx.externalImportRun.updateMany({
        where: { orgId: current.organization.orgId, id: run.id, phase: run.phase, cursor: run.cursor },
        data: { waitUntil, lastErrorCode: "linear_rate_limited", errorStreak: 0, pageSize: Math.min(run.pageSize, pageSize), ...(pageSize < run.pageSize ? { sizeStreak: 0 } : {}) },
      });
      const fresh = (await tx.externalImportRun.findFirstOrThrow({ where: { orgId: current.organization.orgId, id: run.id } })) as RunRow;
      return view(fresh);
    });
  }

  /**
   * Transação estourada (P2028): a próxima começa com a metade do tamanho do passo (a página de issues, ou o lote das outras fases) em
   * vez de repetir igual, e a contagem dos passos bons recomeça. Devolve `false` quando o passo já estava no tamanho 1 (não há mais o que
   * reduzir: quem chama conta o erro). Nunca atrapalha a resposta ao erro.
   */
  private async shrinkStep(tenant: TenantRunner, run: RunRow): Promise<boolean> {
    const issues = run.phase === "issues";
    const normal = BATCH_OF_PHASE[run.phase];
    if (!issues && normal === undefined) return true; // `projects` e as demais não têm lote a reduzir: só se repetem
    const effective = issues ? Math.min(run.pageSize, FULL_PAGE) : batchOf(run, normal as number);
    if (effective <= 1) return false;
    const next = Math.max(1, Math.floor(effective / 2));
    try {
      await tenant.run(async (tx, current) => {
        if (issues) {
          await tx.$executeRaw`update external_import_runs set page_size = least(page_size, ${next}::int), size_streak = 0, updated_at = now()
            where org_id = ${current.organization.orgId} and id = ${run.id}::uuid and phase = ${run.phase} and cursor is not distinct from ${run.cursor}::text`;
        } else {
          await tx.$executeRaw`update external_import_runs set batch_size = least(coalesce(batch_size, ${next}::int), ${next}::int), size_streak = 0, updated_at = now()
            where org_id = ${current.organization.orgId} and id = ${run.id}::uuid and phase = ${run.phase} and cursor is not distinct from ${run.cursor}::text`;
        }
      });
    } catch (error) {
      this.logger.warn(`não foi possível reduzir o passo da rodada (${error instanceof Error ? error.name : "erro"})`);
    }
    return true;
  }

  /**
   * Guarda o último erro para a tela e conta as falhas SEGUIDAS com o mesmo código (outro código recomeça a conta; um passo que grava
   * zera). A rodada fica aberta: nada decide sozinho; a tela oferece "Abandonar". Nunca atrapalha a resposta ao erro de verdade.
   */
  private async noteError(tenant: TenantRunner, run: RunRow, code: string, pageSize: number = run.pageSize): Promise<void> {
    try {
      await tenant.run(async (tx, current) => {
        await tx.$executeRaw`update external_import_runs set last_error_code = ${code}, error_streak = case when last_error_code = ${code} then error_streak + 1 else 1 end, size_streak = case when ${pageSize}::int < page_size then 0 else size_streak end, page_size = least(page_size, ${pageSize}::int), updated_at = now()
          where org_id = ${current.organization.orgId} and id = ${run.id}::uuid and phase = ${run.phase} and cursor is not distinct from ${run.cursor}::text`;
      });
    } catch (error) {
      this.logger.warn(`não foi possível guardar o último erro da rodada (${error instanceof Error ? error.name : "erro"})`);
    }
  }

  /** O destino escolhido ao abrir tem de continuar servindo (existir, fora de ideia): senão o passo recusa e a pessoa abandona e abre outra. */
  private async requireRunDestination(tx: TenantClient, project: ProjectRow, run: RunRow): Promise<void> {
    if (!run.hasDestination) return;
    const invalid = (): ConflictException => new ConflictException({ code: "linear_destination_invalid", message: "O destino escolhido não está mais disponível. Abandone esta importação e abra outra." });
    if (run.destinationTicketId === null) throw invalid(); // o ticket foi apagado (a chave estrangeira zera o destino)
    try {
      await this.requireDestination(tx, project, run.destinationTicketId);
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw invalid();
      throw error;
    }
  }

  /** A transação de gravação do passo. Reconfere tudo com o `Principal` recarregado. */
  private async apply(tx: TenantClient, principal: Principal, projectId: string, seen: RunRow, fetched: Fetched | null): Promise<RunView> {
    const project = await this.guard(tx, principal, projectId, { writable: true });
    await this.tickets.lockStructure(tx, projectId);
    const run = (await tx.externalImportRun.findFirst({ where: { orgId: principal.organization.orgId, id: seen.id, projectId, mode: { not: "categorize" } } })) as RunRow | null;
    if (!run) throw new NotFoundException("Importação não encontrada.");
    // Outro passo andou enquanto este esperava a trava (duas abas, resposta perdida): devolve o estado atual, sem gravar nada.
    if (isTerminal(run.phase) || run.phase !== seen.phase || run.cursor !== seen.cursor) return view(run);
    // O destino só importa onde se cria ticket; em `hierarchy` e `mentions` um destino apagado não obriga a abandonar.
    if (run.phase === "projects" || run.phase === "issues") await this.requireRunDestination(tx, project, run);
    const counts = readCounts(run.counts);
    let phase = run.phase;
    let cursor: string | null = run.cursor;
    let pageSize = run.pageSize;
    let batchSize = run.batchSize;
    let sizeStreak = run.sizeStreak;
    let finished: Date | null = null;

    if (run.phase === "projects" && fetched?.phase === "projects") {
      await this.importProjects(tx, principal, project, run, fetched.page, counts);
      [phase, cursor] = fetched.page.nextCursor === null ? ["issues", null] : ["projects", fetched.page.nextCursor];
    } else if (run.phase === "issues" && fetched?.phase === "issues") {
      const { sweep, known } = parseIssuesCursor(run.cursor);
      const fresh = await this.importIssues(tx, principal, project, run, fetched, counts, sweep > 0);
      if (fetched.reduced) [pageSize, sizeStreak] = [fetched.usedSize, 0];
      else if (run.pageSize < FULL_PAGE) {
        // Só cresce depois de três passos seguidos bons no tamanho de agora.
        sizeStreak += 1;
        if (sizeStreak >= 3) [pageSize, sizeStreak] = [Math.min(run.pageSize * 2, FULL_PAGE), 0];
      }
      const next = fetched.page.nextCursor;
      if (sweep === 0) {
        // Acabou a leitura principal: repescagem, do começo (mais novas primeiro), até haver `SWEEP_MIN_PAGE` issues conhecidas seguidas.
        [phase, cursor] = next === null ? ["issues", issuesCursor(1, 0, null)] : ["issues", next];
      } else {
        // Uma issue nova zera a conta; as páginas conhecidas somam o que trouxeram (uma só issue conhecida no topo não encerra).
        const knownNow = fresh === 0 ? known + new Set(fetched.page.nodes.map((node) => node.id)).size : 0;
        if (next === null || knownNow >= SWEEP_MIN_PAGE || sweep >= MAX_SWEEP_PAGES) [phase, cursor] = ["hierarchy", null];
        else cursor = issuesCursor(sweep + 1, knownNow, next);
      }
    } else if (run.phase === "hierarchy") {
      const next = await this.linkHierarchy(tx, principal, project, run, counts);
      [phase, cursor] = next === null ? [run.mode === "reimport" ? "statuses" : "mentions", null] : ["hierarchy", next];
    } else if (run.phase === "statuses") {
      const next = await this.applyStatuses(tx, principal, project, run, counts);
      [phase, cursor] = next === null ? ["mentions", null] : ["statuses", next];
    } else if (run.phase === "mentions") {
      const next = await this.linkMentions(tx, project, run);
      if (next !== null) cursor = next;
      else if (run.mode === "reimport") [phase, cursor] = ["missing", null];
      else ({ phase, cursor, finished } = await this.finishRun(tx, principal, projectId, run, counts));
    } else if (run.phase === "missing") {
      const next = await this.markMissing(tx, project, run, counts);
      if (next !== null) cursor = next;
      else ({ phase, cursor, finished } = await this.finishRun(tx, principal, projectId, run, counts));
    } else {
      throw new Error(`fase inesperada da importação: ${run.phase}`);
    }
    if (BATCH_OF_PHASE[run.phase] !== undefined && batchSize !== null) {
      // O teto do lote, reduzido por uma transação estourada, só volta a crescer depois de três passos seguidos bons.
      sizeStreak += 1;
      if (sizeStreak >= 3) [batchSize, sizeStreak] = [batchSize * 2 >= (BATCH_OF_PHASE[run.phase] as number) ? null : batchSize * 2, 0];
    }
    const updated = await tx.externalImportRun.update({
      where: { orgId_id: { orgId: principal.organization.orgId, id: run.id } },
      data: { phase, cursor, pageSize, batchSize, sizeStreak, counts: { ...counts }, waitUntil: null, lastErrorCode: null, errorStreak: 0, finishedAt: finished },
    });
    return view(updated as RunRow);
  }

  /** Fim da rodada: a categorização (fatia 4) entra aqui; por enquanto vai direto a `done`. */
  private async finishRun(tx: TenantClient, principal: Principal, projectId: string, run: RunRow, counts: Counts): Promise<{ phase: string; cursor: string | null; finished: Date }> {
    await this.activity.record(tx, principal, {
      kind: "ticket.imported_from_linear",
      subjectType: "project",
      subjectId: projectId,
      payload: { provider: PROVIDER, runId: run.id, mode: run.mode, counts: { ...counts } },
    });
    return { phase: "done", cursor: null, finished: new Date() };
  }

  // ---- fase missing ----

  /**
   * Marca as origens DESTE projeto que a rodada não viu (`last_seen_run_id` diferente da rodada) com `missing_since = agora`, se ainda
   * nulo; o ticket não é alterado. Só chega aqui uma rodada que percorreu o time inteiro (uma rodada abandonada nunca marca nada).
   * Se a leitura pulou itens fora do formato (`skippedInvalid`), o time não foi percorrido por inteiro: nada é marcado e a rodada
   * diz isso (`missingNotChecked`). Issue na lixeira não conta como vista; origem em outro projeto do TreePM não é tocada. Em lotes
   * de `MISSING_BATCH`, por `ticket_id`. Issues e projetos do Linear em contadores próprios (`missing`, `missingProjects`).
   */
  private async markMissing(tx: TenantClient, project: ProjectRow, run: RunRow, counts: Counts): Promise<string | null> {
    if (counts.skippedInvalid > 0) {
      counts.missingNotChecked = true;
      return null;
    }
    // Guarda de sanidade: uma rodada que não viu NENHUMA issue, num projeto que tem origens, é leitura vazia e não "tudo sumiu". Aceito de
    // propósito: um time que de fato foi esvaziado no Linear não marca nada como não encontrado (o custo é não avisar; o contrário, marcar
    // tudo por uma leitura vazia, esconderia o projeto inteiro).
    if (run.cursor === null && counts.issuesSeen === 0 && (await tx.ticketExternalRef.findFirst({ where: { projectId: project.id, provider: PROVIDER, kind: "issue" }, select: { ticketId: true } }))) {
      counts.missingNotChecked = true;
      return null;
    }
    const batch = await tx.ticketExternalRef.findMany({
      where: { projectId: project.id, provider: PROVIDER, OR: [{ lastSeenRunId: null }, { lastSeenRunId: { not: run.id } }], ...(run.cursor === null ? {} : { ticketId: { gt: run.cursor } }) },
      orderBy: { ticketId: "asc" },
      take: batchOf(run, MISSING_BATCH),
      select: { ticketId: true, kind: true },
    });
    if (batch.length === 0) return null;
    await tx.ticketExternalRef.updateMany({ where: { ticketId: { in: batch.map((row) => row.ticketId) }, missingSince: null }, data: { missingSince: new Date() } });
    for (const row of batch) {
      if (row.kind === "issue") counts.missing += 1;
      else counts.missingProjects += 1;
    }
    return batch.length < batchOf(run, MISSING_BATCH) ? null : (batch[batch.length - 1] as { ticketId: string }).ticketId;
  }

  // ---- fase projects ----

  private async importProjects(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, page: LinearPage<LinearProjectNode>, counts: Counts): Promise<void> {
    const unique = [...new Map(page.nodes.map((node) => [node.id, node])).values()];
    counts.skippedInvalid += page.skippedInvalid;
    counts.projectsSeen += unique.length;
    const existing = await this.existingRefRows(tx, "project", unique.map((node) => node.id));
    const reimport = run.mode === "reimport";
    const fresh: LinearProjectNode[] = [];
    const known: { ref: RefRow; incoming: Incoming }[] = [];
    for (const node of unique) {
      const found = existing.get(node.id);
      if (found === undefined) fresh.push(node);
      else if (reimport) {
        if (found.projectId === project.id) known.push({ ref: found, incoming: withProjectPrevious(projectIncoming(node), found) });
        else counts.elsewhere += 1;
      } else if (found.projectId === project.id) counts.projectsExisting += 1;
      else counts.projectsElsewhere += 1;
    }
    if (known.length > 0) await this.reimportExisting(tx, principal, project, run, known, counts, async () => null);
    const items: NewTicket[] = fresh.map((node) => ({
      title: mapLinearTitle(node.name, "Projeto do Linear"),
      description: "",
      status: mapLinearProjectStatus(node.statusType),
      priority: 0,
      parentId: run.destinationTicketId,
      assigneeIds: [],
      ref: { kind: "project", externalId: node.id, externalKey: null, externalUrl: safeLinearUrl(node.url), externalParentId: null, externalProjectId: null, source: { name: cleanLinearText(node.name), statusType: node.statusType === null ? null : cleanLinearText(node.statusType) }, externalUpdatedAt: null },
    }));
    counts.projectsCreated += (await this.createTickets(tx, principal, project, run, items, counts)).length;
  }

  // ---- fase issues ----

  /** Devolve quantas issues NOVAS a página trouxe (a repescagem para na primeira página sem nenhuma). */
  private async importIssues(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, fetched: Extract<Fetched, { phase: "issues" }>, counts: Counts, sweeping: boolean): Promise<number> {
    const { page } = fetched;
    const unique = [...new Map(page.nodes.map((node) => [node.id, node])).values()];
    if (!sweeping) counts.skippedInvalid += page.skippedInvalid;
    if (page.emailUnavailable) counts.assigneeEmailUnavailable = true;
    const live = unique.filter((node) => !node.trashed);
    const existing = await this.existingRefRows(tx, "issue", live.map((node) => node.id));
    const reimport = run.mode === "reimport";
    const fresh: LinearIssueNode[] = [];
    const known: { ref: RefRow; node: LinearIssueNode }[] = [];
    for (const node of live) {
      const found = existing.get(node.id);
      if (found === undefined) fresh.push(node);
      else if (reimport) {
        if (found.projectId === project.id) known.push({ ref: found, node });
        else if (!sweeping) counts.elsewhere += 1;
      } else if (!sweeping) {
        if (found.projectId === project.id) counts.issuesExisting += 1;
        else counts.issuesElsewhere += 1;
      }
    }
    // A repescagem só conta o que achou de novo: reler as conhecidas não infla as contagens da leitura principal.
    counts.issuesSeen += sweeping ? fresh.length : unique.length;
    if (!sweeping) counts.issuesTrashed += unique.length - live.length;
    if (fetched.withoutDescription) counts.withoutDescription += fresh.length;
    // Os tickets dos projetos do Linear DESTE projeto do TreePM (nunca de outro: pai de outro projeto conta como "sem pai").
    const projectTickets = new Map(
      (await tx.ticketExternalRef.findMany({ where: { projectId: project.id, kind: "project", externalId: { in: [...new Set(fresh.flatMap((node) => (node.projectId ? [node.projectId] : [])))] } }, select: { externalId: true, ticketId: true } })).map(
        (row) => [row.externalId, row.ticketId] as const,
      ),
    );
    const assignee = await this.assigneeResolver(tx, project);
    // A chave do projeto pode ter mudado entre o começo do passo e a gravação (raro): remapeia só nesse caso.
    const mapped = fetched.mappedFor === project.key ? fetched.mapped : mapLinearIssuePage(live, project.key);
    if (known.length > 0) {
      await this.reimportExisting(
        tx,
        principal,
        project,
        run,
        known.map(({ ref, node }) => ({ ref, incoming: issueIncoming(node, mapped.get(node.id) as MappedIssue, ref, project.key, fetched.withoutDescription) })),
        counts,
        assignee,
      );
    }
    const items: NewTicket[] = [];
    for (const node of fresh) {
      const issue = mapped.get(node.id) as MappedIssue;
      const assigneeId = node.assignee ? await assignee(node.assignee.email) : null;
      items.push({
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        parentId: linearInitialParent({ parentId: node.parentId, projectId: node.projectId }, projectTickets, run.destinationTicketId),
        assigneeIds: assigneeId === null ? [] : [assigneeId],
        ref: {
          kind: "issue",
          externalId: node.id,
          externalKey: issue.identifier,
          externalUrl: safeLinearUrl(node.url),
          externalParentId: node.parentId,
          externalProjectId: node.projectId,
          // O e-mail do Linear nunca entra aqui: só o id do responsável no Linear. Nada de controle nem byte nulo (o JSONB os recusa).
          source: issue.source,
          externalUpdatedAt: validDate(node.updatedAt),
        },
      });
    }
    const created = await this.createTickets(tx, principal, project, run, items, counts);
    counts.issuesCreated += created.length;
    counts.assigned += items.filter((item) => item.assigneeIds.length > 0).length;
    return fresh.length;
  }

  /** O e-mail do Linear → a pessoa do TreePM (ativa, não de teste, única) que enxerga o projeto; o e-mail some aqui. */
  private async assigneeResolver(tx: TenantClient, project: ProjectRow): Promise<(email: string | null) => Promise<string | null>> {
    const people = await tx.person.findMany({ where: { active: true, isTest: false }, select: { id: true, email: true, active: true, isTest: true, clerkRole: true } });
    const sees = new Map<string, boolean>();
    return async (email) => {
      const id = matchLinearAssignee(email, people);
      if (id === null) return null;
      let visible = sees.get(id);
      if (visible === undefined) {
        const person = people.find((candidate) => candidate.id === id) as (typeof people)[number];
        // Atribuir nunca concede acesso (como `requireAssignable`): quem não enxerga o projeto não vira responsável.
        visible = this.authorization.canView(await this.authorization.loadActor(tx, person.id, person.clerkRole), project);
        sees.set(id, visible);
      }
      return visible ? id : null;
    };
  }

  /**
   * Cria os tickets e as origens como a importação por lista cria (travas, números), mas SEM menções: o texto importado não cita
   * ninguém (ver `neutralizeOwnTicketKey`) e as descrições antigas que citam os números novos são ligadas na fase `mentions`. Antes
   * de gravar, confere cada pai que vai ganhar filho (M2/M3): concluído reabre; ideia, ou dentro de ideia, só recebe filho a
   * fazer (os outros vão para o destino da rodada).
   */
  private async createTickets(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, wanted: NewTicket[], counts: Counts): Promise<TicketRow[]> {
    if (wanted.length === 0) return [];
    const items = await this.keepOutOfIdeas(tx, project, run, wanted, counts);
    const parents = [...new Set(items.flatMap((item) => (item.parentId === null ? [] : [item.parentId])))].sort();
    await this.tickets.lockTickets(tx, parents);
    const needReopen = parents.filter((parent) => items.some((item) => item.parentId === parent && !isFinished(item.status as TicketStatus)));
    if (needReopen.length > 0) await this.reopenParents(tx, principal, project, needReopen, `${project.key}-${await this.tickets.peekNextNumber(tx, project)}`, counts, run.startedAt);
    const first = await this.tickets.allocateNumbers(tx, project, items.length);
    const generated = await tx.$queryRaw<{ id: string }[]>`select app_uuid_v7() as id from generate_series(1, ${items.length}::int)`;
    const rows: TicketRow[] = items.map((item, index) => ({
      id: generated[index]?.id as string,
      projectId: project.id,
      number: first + index,
      parentId: item.parentId,
      title: item.title,
      description: item.description,
      status: item.status,
      ideaStage: null,
      priority: item.priority,
      assignees: item.assigneeIds.map((personId) => ({ personId })),
    }));
    await tx.ticket.createMany({
      data: rows.map((row) => ({
        id: row.id,
        orgId: project.orgId,
        projectId: project.id,
        number: row.number,
        parentId: row.parentId,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority ?? 0,
        createdByPersonId: principal.person.id,
      })),
    });
    const assignees = rows.flatMap((row) => row.assignees.map((assignee) => ({ orgId: project.orgId, ticketId: row.id, personId: assignee.personId })));
    if (assignees.length > 0) await tx.ticketAssignee.createMany({ data: assignees });
    await tx.ticketExternalRef.createMany({
      data: rows.map((row, index) => {
        const item = items[index] as NewTicket;
        return {
          orgId: project.orgId,
          ticketId: row.id,
          projectId: project.id,
          provider: PROVIDER,
          kind: item.ref.kind,
          externalId: item.ref.externalId,
          externalKey: item.ref.externalKey,
          externalUrl: item.ref.externalUrl,
          externalParentId: item.ref.externalParentId,
          externalProjectId: item.ref.externalProjectId,
          sourceSnapshot: item.ref.source,
          appliedSnapshot: { title: row.title, description: row.description, status: row.status, assigneeIds: item.assigneeIds, priority: row.priority ?? 0, parentId: row.parentId },
          externalUpdatedAt: item.ref.externalUpdatedAt,
          // Criada nesta rodada: já vista (senão a fase `missing` a marcaria como não encontrada).
          lastSeenRunId: run.id,
          // Toda issue criada nasce pendente de hierarquia: só a fase `hierarchy` a limpa (uma rodada abandonada não a perde).
          hierarchyPending: item.ref.kind === "issue",
        };
      }),
    });
    // Issue nova que é o pai de origens já guardadas (o pai estava em outro time e chegou agora): essas também ficam pendentes.
    const newIssueIds = items.filter((item) => item.ref.kind === "issue").map((item) => item.ref.externalId);
    if (run.mode === "reimport" && newIssueIds.length > 0) {
      await tx.$executeRaw`update ticket_external_refs set hierarchy_pending = true where org_id = ${project.orgId} and project_id = ${project.id}::uuid and provider = ${PROVIDER} and kind = 'issue' and not hierarchy_pending and external_parent_id = any(${newIssueIds}::text[])`;
    }
    return rows;
  }

  /**
   * Pai que virou ideia (ou foi para dentro de uma) entre os passos: filho `todo` entra (a regra da importação por lista); filho em
   * outra situação vai para o destino da rodada e conta em `movedOutOfIdea`. Sem nenhuma ideia no projeto não há o que consultar.
   */
  private async keepOutOfIdeas(tx: TenantClient, project: ProjectRow, run: RunRow, items: NewTicket[], counts: Counts): Promise<NewTicket[]> {
    const parents = [...new Set(items.flatMap((item) => (item.parentId === null ? [] : [item.parentId])))];
    const inIdea = await this.parentsInIdeas(tx, project, parents);
    if (inIdea.size === 0) return items;
    return items.map((item) => {
      if (item.parentId === null || !inIdea.has(item.parentId) || item.status === "todo") return item;
      counts.movedOutOfIdea += 1;
      return { ...item, parentId: run.destinationTicketId };
    });
  }

  /** Quais dos tickets dados são ideia ou estão dentro de uma (uma consulta só para saber se o projeto tem alguma ideia). */
  private async parentsInIdeas(tx: TenantClient, project: ProjectRow, parents: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (parents.length === 0 || !(await tx.ticket.findFirst({ where: { projectId: project.id, ideaStage: { not: null } }, select: { id: true } }))) return found;
    for (const parent of parents) if (await this.tickets.ideaRootFor(tx, project, parent)) found.add(parent);
    return found;
  }

  /**
   * "Concluído com filho aberto nasce a fazer" (ADR 0034) quando o pai já existe e vai ganhar um filho aberto: o pai (e a cadeia de
   * concluídos acima dele) volta a `todo`, ANTES de o filho ser gravado (a ordem de `reopenAncestors`). O que a própria rodada criou
   * já concluído muda em silêncio (nasceu assim); o que alguém concluiu no TreePM é reaberto pelo caminho de sempre, com evento
   * automático. O retrato aplicado acompanha, para a reimportação não ler isso como edição de quem usa o TreePM.
   */
  private async reopenParents(tx: TenantClient, principal: Principal, project: ProjectRow, parentIds: readonly string[], causedBy: string, counts: Counts, since: Date, movingTo: ReadonlyMap<string, string> = new Map()): Promise<void> {
    for (const start of parentIds) {
      // A cadeia de concluídos de baixo para cima, já como ficará depois das descidas do plano (`movingTo`: ticket → pai novo).
      const chain: { id: string; number: number }[] = [];
      for (let cursor: string | null = start; cursor !== null && chain.length < MAX_TREE_DEPTH; ) {
        // A situação é lida JÁ com a trava de linha (pais antes de filhos, de baixo para cima): ler e só depois travar deixaria outra transação concluir/reabrir no meio.
        const row: { id: string; number: number; parentId: string | null; status: string } | undefined = (
          await tx.$queryRaw<{ id: string; number: number; parentId: string | null; status: string }[]>`select id, number, parent_id as "parentId", status from tickets where org_id = ${project.orgId} and project_id = ${project.id}::uuid and id = ${cursor}::uuid for update`
        )[0];
        if (!row || row.status !== "done") break;
        chain.push({ id: row.id, number: row.number });
        cursor = movingTo.get(row.id) ?? row.parentId;
      }
      if (chain.length === 0) continue;
      // Só o que a PRÓPRIA rodada criou concluído (e ninguém mexeu depois) muda em silêncio; qualquer outro ticket (com ou sem origem) tem evento.
      const bornHere = new Set(
        (await tx.ticketExternalRef.findMany({ where: { ticketId: { in: chain.map((item) => item.id) }, firstImportedAt: { gte: since } }, select: { ticketId: true, appliedSnapshot: true } }))
          // ...e ainda concluído como nasceu: se alguém o concluiu depois, o evento é devido.
          .filter((row) => (row.appliedSnapshot as { status?: unknown } | null)?.status === "done")
          .map((row) => row.ticketId),
      );
      for (const item of chain) {
        await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id: item.id } }, data: { status: "todo" } });
        if (!bornHere.has(item.id)) {
          await this.activity.record(tx, principal, {
            kind: "ticket.updated",
            subjectType: "ticket",
            subjectId: item.id,
            payload: { key: `${project.key}-${item.number}`, fields: ["status"], status: { from: "done", to: "todo" }, automatic: true, causedBy },
          });
        }
        await this.markTodo(tx, project, [item.id]);
        counts.reopened += 1;
      }
    }
  }

  /**
   * O retrato aplicado acompanha uma reabertura por invariante SÓ para quem não tinha sido mexido (aplicada = concluído = atual antes da
   * reabertura): quem foi concluído à mão tem aplicada diferente de concluído, e ela fica como estava, para a reimportação continuar
   * lendo a edição da pessoa. Quem acompanha passa a estar em desvio (aplicada ≠ desejada): a fase `statuses` o reavalia.
   */
  private async markTodo(tx: TenantClient, project: ProjectRow, ids: string[]): Promise<void> {
    await tx.$executeRaw`update ticket_external_refs set applied_snapshot = jsonb_set(applied_snapshot, '{status}', '"todo"'), status_pending = true
      where org_id = ${project.orgId} and ticket_id = any(${ids}::uuid[]) and applied_snapshot->>'status' = 'done'`;
  }

  /** As origens já guardadas (com os retratos) para os ids externos dados, em toda a organização (RLS): id externo → linha. */
  private async existingRefRows(tx: TenantClient, kind: "issue" | "project", externalIds: string[]): Promise<Map<string, RefRow>> {
    if (externalIds.length === 0) return new Map();
    const rows = await tx.ticketExternalRef.findMany({
      where: { provider: PROVIDER, kind, externalId: { in: externalIds } },
      select: { ticketId: true, kind: true, statusPending: true, projectId: true, externalId: true, externalKey: true, externalUrl: true, externalParentId: true, externalProjectId: true, sourceSnapshot: true, appliedSnapshot: true, lastSeenRunId: true, statusRunId: true, statusRunFlags: true },
    });
    return new Map(rows.map((row) => [row.externalId, row as RefRow]));
  }

  // ---- reimportação: o que já tem origem (ADR 0060, seção 5) ----

  /**
   * Aplica a regra por campo aos tickets que JÁ têm origem neste projeto: só se aplica o que mudou no Linear e não foi mexido aqui.
   * A decisão é tomada DENTRO da transação, com os tickets da página travados em ordem de id (uma edição simultânea não é
   * sobrescrita). A origem vista nesta rodada não é revista (a repescagem relê páginas): conta uma vez só.
   *
   * A SITUAÇÃO não é aplicada aqui (a árvore ainda não está no lugar e a regra "concluído com filho aberto" olha os filhos): o retrato
   * de origem avança já (é o que o Linear diz) e a origem fica `status_pending` quando o Linear mudou a situação, quando já está em
   * desvio (aplicada ≠ desejada sem que ninguém tenha mexido) ou quando já estava pendente; só a fase `statuses` aplica e desliga a
   * marca. Por isso uma rodada abandonada, ou um ticket da fatia 2, converge sem preenchimento. Os retratos são gravados por MESCLA
   * (só as chaves decididas, e só quando mudaram), nunca por uma cópia inteira lida antes. O retrato de origem não avança nos campos
   * que esta leitura não trouxe (descrição que veio vazia por causa do tamanho; responsável cujo e-mail não veio): a mudança não se perde.
   */
  private async reimportExisting(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, entries: readonly { ref: RefRow; incoming: Incoming }[], counts: Counts, resolveAssignee: (email: string | null) => Promise<string | null>): Promise<void> {
    const todo = entries.filter((entry) => entry.ref.lastSeenRunId !== run.id);
    if (todo.length === 0) return;
    const orgId = project.orgId;
    const ids = [...new Set(todo.map((entry) => entry.ref.ticketId))].sort();
    await tx.$queryRaw`select id from tickets where org_id = ${orgId} and id = any(${ids}::uuid[]) order by id for update`;
    const rows = await this.readTickets(tx, ids);
    const now = new Date();
    let touchedProject = false;
    for (const { ref, incoming } of todo) {
      const row = rows.get(ref.ticketId);
      if (!row) continue;
      const applied = (ref.appliedSnapshot ?? {}) as Record<string, unknown>;
      const source = (ref.sourceSnapshot ?? {}) as Record<string, unknown>;
      const key = `${project.key}-${row.number}`;
      const data: { title?: string; description?: string; priority?: number } = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const appliedPatch: Record<string, unknown> = {};
      const sourcePatch: Record<string, unknown> = { ...incoming.source };
      let keptTouched = false;

      const title = decideLinearField({ incoming: incoming.title, previousSource: incoming.previous.title, current: row.title, applied: (applied["title"] as string | undefined) ?? row.title });
      keptTouched ||= title.changedInLinear && title.touchedHere;
      if (title.apply) {
        data.title = incoming.title;
        changes["title"] = { from: row.title, to: incoming.title };
        appliedPatch["title"] = incoming.title;
      }

      if (incoming.description === undefined) {
        // Projeto do Linear: não tem descrição.
      } else if (incoming.description === null) {
        // Esta leitura não trouxe a descrição: o campo não é tocado e o retrato de origem não avança.
        delete sourcePatch["description"];
        counts.descriptionUnavailable = true;
      } else {
        const description = decideLinearField({ incoming: incoming.description, previousSource: incoming.previous.description, current: row.description, applied: (applied["description"] as string | undefined) ?? row.description });
        keptTouched ||= description.changedInLinear && description.touchedHere;
        if (description.apply) {
          data.description = incoming.description;
          appliedPatch["description"] = incoming.description;
        }
      }

      if (incoming.priority !== null) {
        const priority = decideLinearField({ incoming: incoming.priority, previousSource: incoming.previous.priority as number, current: row.priority, applied: (applied["priority"] as number | undefined) ?? row.priority });
        keptTouched ||= priority.changedInLinear && priority.touchedHere;
        if (priority.apply) {
          data.priority = incoming.priority;
          changes["priority"] = { from: row.priority, to: incoming.priority };
          appliedPatch["priority"] = incoming.priority;
        }
      }

      let newAssignees: string[] | null = null;
      if (incoming.assignee !== null) {
        const appliedAssignees = Array.isArray(applied["assigneeIds"]) ? (applied["assigneeIds"] as string[]) : row.assigneeIds;
        const assignee = decideLinearField<string | null, string[]>({ incoming: incoming.assignee.externalId, previousSource: incoming.previous.assigneeExternalId, current: row.assigneeIds, applied: appliedAssignees });
        if (assignee.changedInLinear && incoming.assignee.externalId !== null && !incoming.assignee.emailReadable) {
          // O e-mail não veio nesta rodada: o campo não é tocado e o retrato de origem não avança (a mudança não se perde).
          delete sourcePatch["assigneeExternalId"];
        } else {
          keptTouched ||= assignee.changedInLinear && assignee.touchedHere;
          // O e-mail que antes não vinha e agora é legível: sem responsável aqui, nem na importação, e com responsável no Linear, atribui.
          const becameReadable = incoming.assignee.externalId !== null && incoming.assignee.emailReadable && row.assigneeIds.length === 0 && appliedAssignees.length === 0;
          if (assignee.apply || becameReadable) {
            const personId = incoming.assignee.externalId === null ? null : await resolveAssignee(incoming.assignee.email);
            const wanted = personId === null ? [] : [personId];
            appliedPatch["assigneeIds"] = wanted;
            if (!sameLinearValue(wanted, row.assigneeIds)) newAssignees = wanted;
          }
        }
      }

      // A situação: não é aplicada aqui. O Linear mudou, ou o ticket já está em desvio (aplicada ≠ desejada e ninguém mexeu) → a fase `statuses` avalia.
      const appliedStatus = ((applied["status"] as string | undefined) ?? row.status) as TicketStatus;
      const statusChanged = incoming.status !== incoming.previous.status;
      const queueStatus = ref.statusPending || statusChanged || (row.status === appliedStatus && appliedStatus !== incoming.status);

      const changed = Object.keys(data).length > 0 || newAssignees !== null;
      if (changed) {
        if (Object.keys(data).length > 0) await tx.ticket.update({ where: { orgId_id: { orgId, id: row.id } }, data });
        if (newAssignees !== null) {
          await tx.ticketAssignee.deleteMany({ where: { orgId, ticketId: row.id } });
          if (newAssignees.length > 0) await tx.ticketAssignee.createMany({ data: newAssignees.map((personId) => ({ orgId, ticketId: row.id, personId })) });
          changes["assignees"] = { from: row.assigneeIds, to: newAssignees };
        }
        const fields = [...(data.title !== undefined ? ["title"] : []), ...(data.description !== undefined ? ["description"] : []), ...(data.priority !== undefined ? ["priority"] : []), ...(newAssignees !== null ? ["assignees"] : [])];
        // UM evento automático por ticket e por rodada (a situação, quando muda, tem o seu na fase `statuses`), sem notificar ninguém.
        await this.activity.record(tx, principal, { kind: "ticket.updated", subjectType: "ticket", subjectId: row.id, payload: { key, fields, ...changes, automatic: true, source: "linear_reimport", runId: run.id } });
        touchedProject = true;
        counts.updated += 1;
      }
      if (keptTouched) counts.keptTouched += 1;
      // Com a situação mudando no Linear, quem conta é a fase `statuses` (uma atualização por ticket, mesmo com campos e situação juntos).
      if (!changed && !keptTouched && !statusChanged) counts.unchanged += 1;

      const parentChanged = incoming.parentId !== undefined && (incoming.parentId !== ref.externalParentId || incoming.projectId !== ref.externalProjectId);
      await tx.ticketExternalRef.update({
        where: { orgId_ticketId: { orgId, ticketId: row.id } },
        data: {
          externalKey: incoming.key,
          externalUrl: incoming.url,
          externalUpdatedAt: incoming.updatedAt,
          lastSeenRunId: run.id,
          lastImportedAt: now,
          missingSince: null,
          ...(queueStatus && !ref.statusPending ? { statusPending: true } : {}),
          // O que esta fase já contou do ticket, para a fase `statuses` não contar de novo; só quando há algo a dizer (rodada quieta não grava).
          ...(queueStatus && (changed || keptTouched || statusChanged) ? { statusRunId: run.id, statusRunFlags: (changed ? FLAG_UPDATED : 0) | (keptTouched ? FLAG_KEPT : 0) | (statusChanged ? FLAG_STATUS_CHANGED : 0) } : {}),
          ...(parentChanged ? { externalParentId: incoming.parentId, externalProjectId: incoming.projectId, hierarchyPending: true } : {}),
        },
      });
      // Os retratos: só as chaves que mudaram, mescladas na linha de hoje.
      await this.mergeSnapshots(tx, orgId, row.id, { source: changedKeys(source, sourcePatch), applied: changedKeys(applied, appliedPatch) });
    }
    if (touchedProject) await touchProjectVersion(tx, project.id);
  }

  /**
   * Escritor único dos retratos: mescla (`||`) só as chaves dadas na linha de hoje, numa instrução só (uma cópia lida antes nunca
   * volta a ser gravada por cima). Sem chave nenhuma, não grava.
   */
  private async mergeSnapshots(tx: TenantClient, orgId: string, ticketId: string, parts: { source: Record<string, unknown>; applied: Record<string, unknown> }): Promise<void> {
    const source = Object.keys(parts.source).length > 0 ? JSON.stringify(parts.source) : null;
    const applied = Object.keys(parts.applied).length > 0 ? JSON.stringify(parts.applied) : null;
    if (source === null && applied === null) return;
    await tx.$executeRaw`update ticket_external_refs set
        source_snapshot = case when ${source}::text is null then source_snapshot else source_snapshot || ${source}::jsonb end,
        applied_snapshot = case when ${applied}::text is null then applied_snapshot else applied_snapshot || ${applied}::jsonb end
      where org_id = ${orgId} and ticket_id = ${ticketId}::uuid`;
  }

  /** Os tickets, com os responsáveis, como a decisão por campo os lê (depois da trava de linha). */
  private async readTickets(tx: TenantClient, ids: readonly string[]): Promise<Map<string, TicketNow>> {
    const rows = await tx.ticket.findMany({ where: { id: { in: [...ids] } }, select: { id: true, number: true, title: true, description: true, status: true, priority: true, parentId: true, ideaStage: true, assignees: { select: { personId: true } } } });
    return new Map(rows.map((row) => [row.id, { id: row.id, number: row.number, title: row.title, description: row.description, status: row.status, priority: row.priority, parentId: row.parentId, ideaStage: row.ideaStage, assigneeIds: row.assignees.map((a) => a.personId).sort() }]));
  }

  // ---- fase statuses ----

  /**
   * A situação dos tickets que já existiam, DEPOIS de a árvore estar no lugar, como UMA regra (`decideLinearStatus`): a desejada é a
   * do Linear mapeada (o retrato de origem já avançou); quem foi mexido aqui (atual ≠ aplicada) não se toca; os outros assumem a
   * desejada, a menos que uma invariante impeça (concluído com filho aberto; dentro de ideia), e então ficam como estão e EM DESVIO,
   * avaliados de novo em toda reimportação, até poderem assumir. A lista de trabalho é: origens vistas nesta rodada (quem sumiu do
   * Linear não é tocado), marcadas `status_pending` (o Linear mudou, desvio, ou a hierarquia tocou) e ainda não avaliadas nesta
   * rodada, do mais fundo para o mais raso, e é RECALCULADA a cada passo (sem cursor de profundidade: um ticket que muda de nível
   * entre dois passos não é pulado). Para cada uma lê o ticket e o retrato DE AGORA e grava, na mesma transação, a situação, o retrato
   * aplicado, o evento e a marca. Terminando aberto, o ticket reabre os ancestrais concluídos (mesmo sem ter mudado: um ticket aberto
   * que desceu para baixo de um concluído). O cursor só conta os passos (o passo repetido por resposta perdida não grava de novo).
   */
  private async applyStatuses(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, counts: Counts): Promise<string | null> {
    const orgId = project.orgId;
    const size = batchOf(run, STATUSES_BATCH);
    // A profundidade de cada pendente = quantos ancestrais tem (subindo a árvore, no máximo `MAX_TREE_DEPTH` passos).
    const batch = await tx.$queryRaw<{ ticketId: string; depth: number }[]>`
      with recursive up as (
        select r.ticket_id as origin, t.parent_id as pid, 0 as step
          from ticket_external_refs r join tickets t on t.org_id = r.org_id and t.id = r.ticket_id
         where r.org_id = ${orgId} and r.project_id = ${project.id}::uuid and r.status_pending and r.last_seen_run_id = ${run.id}::uuid
           and (r.status_run_id is distinct from ${run.id}::uuid or (r.status_run_flags & ${FLAG_EVALUATED}::int) = 0)
        union all
        select up.origin, t.parent_id, up.step + 1 from up join tickets t on t.org_id = ${orgId} and t.project_id = ${project.id}::uuid and t.id = up.pid where up.step < ${MAX_TREE_DEPTH}::int
      ), depths as (select origin as "ticketId", (count(*) filter (where pid is not null))::int as depth from up group by origin)
      select "ticketId", depth from depths order by depth desc, "ticketId" asc limit ${size}::int`;
    if (batch.length === 0) return null;
    await tx.$queryRaw`select id from tickets where org_id = ${orgId} and id = any(${batch.map((item) => item.ticketId).sort()}::uuid[]) order by id for update`;
    let touched = false;
    for (const { ticketId } of batch) {
      // Lido AGORA (as reaberturas dos itens anteriores deste lote já mudaram retratos e situações).
      const ref = await tx.ticketExternalRef.findUnique({ where: { orgId_ticketId: { orgId, ticketId } }, select: { kind: true, statusPending: true, sourceSnapshot: true, appliedSnapshot: true, statusRunId: true, statusRunFlags: true } });
      const row = (await this.readTickets(tx, [ticketId])).get(ticketId);
      if (!ref || !row || !ref.statusPending) continue;
      const source = (ref.sourceSnapshot ?? {}) as Record<string, unknown>;
      const applied = (ref.appliedSnapshot ?? {}) as Record<string, unknown>;
      const flags = ref.statusRunId === run.id ? ref.statusRunFlags : 0;
      const linearChanged = (flags & FLAG_STATUS_CHANGED) !== 0;
      const desired = mapRawStatus(ref.kind, source[statusKeyOf(ref.kind)]);
      const current = row.status as TicketStatus;
      const appliedStatus = ((applied["status"] as string | undefined) ?? row.status) as TicketStatus;
      // Só quem vai de fato tentar assumir a desejada precisa saber de ideia e de filho aberto.
      const trying = current === appliedStatus && desired !== current;
      let inIdea: boolean | null = null;
      const insideIdea = async (): Promise<boolean> => (inIdea ??= row.ideaStage !== null || (row.parentId !== null && (await this.parentsInIdeas(tx, project, [row.parentId])).has(row.parentId)));
      const hasOpenChildren = trying && desired === "done" && (await tx.ticket.count({ where: { parentId: row.id, status: { notIn: ["done", "cancelled"] }, ideaStage: null } })) > 0;
      // `previousSource: desired`: se o Linear mudou a situação nesta rodada quem sabe é a marca da fase `issues` (o retrato de origem já avançou).
      const decision = decideLinearStatus({ desired, previousSource: desired, current, applied: appliedStatus, insideIdea: trying ? await insideIdea() : false, hasOpenChildren });
      const key = `${project.key}-${row.number}`;
      let updated = false;
      const appliedPatch: Record<string, unknown> = {};
      if (decision.outcome === "apply") {
        // Ticket que volta a ficar aberto reabre o pai concluído (ADR 0034); fora do processo (ideia) nada reabre.
        if (!isFinished(decision.target) && row.parentId !== null) await this.reopenParents(tx, principal, project, [row.parentId], key, counts, run.startedAt);
        // O marcador de trabalho pela IA acaba antes: o banco recusa concluído ou cancelado com marcador.
        if (decision.target === "done" || decision.target === "cancelled") await this.agentWork.clearTicket(tx, principal, project.key, row.id, "finished");
        await tx.ticket.update({ where: { orgId_id: { orgId, id: row.id } }, data: { status: decision.target } });
        await this.activity.record(tx, principal, { kind: "ticket.updated", subjectType: "ticket", subjectId: row.id, payload: { key, fields: ["status"], status: { from: row.status, to: decision.target }, automatic: true, source: "linear_reimport", runId: run.id } });
        appliedPatch["status"] = decision.target;
        updated = true;
        touched = true;
      } else if (!isFinished(current) && row.parentId !== null && !(await insideIdea())) {
        // O ticket aberto que a hierarquia pôs embaixo de um concluído (ou que já estava): a invariante manda reabrir os ancestrais.
        await this.reopenParents(tx, principal, project, [row.parentId], key, counts, run.startedAt);
      }
      // A marca acaba, salvo o desvio: aplicada ≠ desejada por invariante, avaliada de novo na rodada seguinte.
      const stillPending = decision.outcome === "blocked";
      await tx.ticketExternalRef.update({
        where: { orgId_ticketId: { orgId, ticketId } },
        data: { ...(stillPending ? {} : { statusPending: false }), statusRunId: run.id, statusRunFlags: flags | FLAG_EVALUATED },
      });
      await this.mergeSnapshots(tx, orgId, ticketId, { source: {}, applied: appliedPatch });
      const kept = decision.touchedHere && linearChanged;
      if (updated && (flags & FLAG_UPDATED) === 0) counts.updated += 1;
      if (kept && (flags & FLAG_KEPT) === 0) counts.keptTouched += 1;
      if (linearChanged && !updated && !kept && (flags & (FLAG_UPDATED | FLAG_KEPT)) === 0) counts.unchanged += 1;
    }
    if (touched) await touchProjectVersion(tx, project.id);
    return batch.length < size ? null : String(Number(run.cursor ?? 0) + 1);
  }

  // ---- fase hierarchy ----

  /**
   * Leva para baixo do pai (que o Linear indicou e já foi importado NESTE projeto) até 200 tickets por passo. O cursor é a chave do
   * último ticket olhado (varredura por `ticket_id`), então o passo sempre avança, mesmo para o que ficou onde estava (ciclo, pai
   * ausente, subárvore que não cabe, ideia que não aceita). Devolve o cursor do próximo passo, ou `null` quando não há mais o que olhar.
   */
  private async linkHierarchy(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, counts: Counts): Promise<string | null> {
    const orgId = project.orgId;
    // Na reimportação os candidatos são só os pendentes: os criados em qualquer rodada (inclusive abandonada) e os que a leitura das
    // issues marcou (o pai ou o projeto mudou no Linear, ou o pai chegou agora): sem mudança no Linear a reimportação não toca na
    // hierarquia. Só esta fase limpa a marca. E só quem foi VISTO nesta rodada: quem sumiu do Linear (ou foi à lixeira) não é movido
    // com base no que o Linear dizia antes; a marca dele fica para quando reaparecer.
    const reimport = run.mode === "reimport";
    const after = run.cursor === null ? {} : { ticketId: { gt: run.cursor } };
    const batch = await tx.ticketExternalRef.findMany({
      where: reimport
        ? { projectId: project.id, kind: "issue", hierarchyPending: true, lastSeenRunId: run.id, ...after }
        : { projectId: project.id, kind: "issue", externalParentId: { not: null }, ...after },
      orderBy: { ticketId: "asc" },
      take: batchOf(run, HIERARCHY_BATCH),
      select: { ticketId: true, externalParentId: true, externalProjectId: true, firstImportedAt: true, appliedSnapshot: true },
    });
    if (batch.length === 0) {
      // A primeira importação decide só quem tem pai no Linear: a marca dos demais (nascida com a origem) sai ao fim da fase.
      if (!reimport) await tx.ticketExternalRef.updateMany({ where: { projectId: project.id, hierarchyPending: true }, data: { hierarchyPending: false } });
      return null;
    }
    const parentRefs = await tx.ticketExternalRef.findMany({
      where: { projectId: project.id, kind: "issue", externalId: { in: [...new Set(batch.flatMap((row) => (row.externalParentId === null ? [] : [row.externalParentId])))] } },
      select: { externalId: true, ticketId: true },
    });
    const parentTicket = new Map(parentRefs.map((row) => [row.externalId, row.ticketId]));
    // Reimportação: o alvo de uma issue é o ticket da issue-pai, senão o do projeto do Linear, senão o destino da rodada (nulo = raiz).
    const projectTicket = new Map(
      reimport
        ? (await tx.ticketExternalRef.findMany({ where: { projectId: project.id, kind: "project", externalId: { in: [...new Set(batch.flatMap((row) => (row.externalProjectId === null ? [] : [row.externalProjectId])))] } }, select: { externalId: true, ticketId: true } })).map((row) => [row.externalId, row.ticketId] as const)
        : [],
    );
    // Destino escolhido que foi apagado no meio da rodada (a chave estrangeira o zerou): quem de fato iria para ele fica onde está.
    const destinationGone = run.hasDestination && run.destinationTicketId === null;
    const wanted: { row: (typeof batch)[number]; parentId: string | null; needsDestination: boolean }[] = batch.flatMap((row) => {
      const viaParent = row.externalParentId === null ? undefined : parentTicket.get(row.externalParentId);
      if (!reimport) return viaParent === undefined ? [] : [{ row, parentId: viaParent, needsDestination: false }];
      const viaProject = row.externalProjectId === null ? undefined : projectTicket.get(row.externalProjectId);
      const target = viaParent ?? viaProject;
      return [{ row, parentId: target ?? run.destinationTicketId, needsDestination: target === undefined && destinationGone }];
    });
    /** Os que precisavam do destino apagado: contam em `skipped` e a marca de hierarquia deles NÃO é limpa (uma rodada com destino válido os decide). */
    const stuck = new Set<string>();
    /** A hierarquia da reimportação só MOVE: a situação (reabrir ancestrais, concluir quem estava em desvio) é da fase `statuses`; aqui se marcam os tocados. */
    const touchedByMoves = new Set<string>();
    const toRoot: string[] = [];
    const inSync: string[] = [];
    /** Os que já existiam antes desta rodada e vão mudar de pai: cada um ganha o evento automático e o fim do marcador da IA, como numa edição. */
    const existed = new Set<string>();
    const fromParent = new Map<string, string | null>();
    if (wanted.length > 0) {
      // A floresta inteira do projeto: a profundidade e o ciclo contam a partir da raiz de verdade, não do destino.
      const rows = await tx.$queryRaw<{ id: string; parent_id: string | null; status: string; number: number }[]>`select id, parent_id, status, number from tickets where org_id = ${orgId} and project_id = ${project.id}::uuid`;
      // O que alguém arrumou à mão fica (ADR 0060, seção 5): só desce o ticket criado NESTA rodada, ou cujo pai atual ainda é o que a
      // importação deu a ele (`applied_snapshot.parentId`). Ticket movido no TreePM fica onde está e conta em `keptMoved`.
      const currentParent = new Map(rows.map((row) => [row.id, row.parent_id]));
      const requests = wanted.flatMap(({ row, parentId, needsDestination }) => {
        const appliedParent = (row.appliedSnapshot as { parentId?: unknown } | null)?.parentId ?? null;
        const createdNow = row.firstImportedAt.getTime() >= run.startedAt.getTime();
        const current = currentParent.get(row.ticketId) ?? null;
        if (!createdNow && current !== appliedParent) {
          if (current !== parentId) counts.keptMoved += 1; // já estar no pai do Linear não é "arrumado à mão contra o Linear"
          else inSync.push(row.ticketId);
          return [];
        }
        if (needsDestination) {
          counts.skipped += 1;
          stuck.add(row.ticketId);
          return [];
        }
        if (!createdNow) fromParent.set(row.ticketId, current);
        if (!createdNow) existed.add(row.ticketId);
        if (current !== null) touchedByMoves.add(current);
        if (parentId === null) {
          if (current !== null) toRoot.push(row.ticketId);
          return [];
        }
        return [{ id: row.ticketId, parentId }];
      });
      const forest = new Map(rows.map((row) => [row.id, row.parent_id]));
      const info = new Map(rows.map((row) => [row.id, row] as const));
      // Tirar uma descida do plano (ideia que não aceita) pode deixar outra inválida (ciclo, profundidade): o plano é REFEITO sem os
      // pedidos tirados, até nenhum sair mais. Cada volta tira ao menos um pedido, então termina.
      let active = requests;
      let plan = planLinearParents(forest, active, MAX_TREE_DEPTH);
      let moves: LinearParentMove[];
      const outOfIdea = new Set<string>();
      for (;;) {
        moves = await this.withoutIdeaMoves(tx, project, plan.moves, rows);
        const kept = new Set(moves.map((move) => move.id));
        const removed = plan.moves.filter((move) => !kept.has(move.id)).map((move) => move.id);
        if (removed.length === 0) break;
        for (const id of removed) outOfIdea.add(id);
        const dropped = new Set(removed);
        active = active.filter((request) => !dropped.has(request.id));
        plan = planLinearParents(forest, active, MAX_TREE_DEPTH);
      }
      counts.movedOutOfIdea += outOfIdea.size;
      if (moves.length > 0) {
        // Os pais concluídos que vão ganhar filho aberto reabrem ANTES de o filho descer (ordem de `reopenAncestors`).
        // Os pais são travados em ordem de id (a mesma ordem da criação), antes de qualquer reabertura.
        await this.tickets.lockTickets(tx, [...new Set(moves.map((move) => move.parentId))].sort());
        const open = moves.filter((move) => !isFinished((info.get(move.id)?.status ?? "todo") as TicketStatus));
        const needReopen = reimport ? [] : [...new Set(open.map((move) => move.parentId))].sort();
        if (needReopen.length > 0) await this.reopenParents(tx, principal, project, needReopen, `${project.key}-${info.get((open[0] as { id: string }).id)?.number}`, counts, run.startedAt, new Map(moves.map((move) => [move.id, move.parentId])));
        const applied = await applyParentMoves(tx, orgId, moves);
        // O gatilho de ciclo do banco recusou o item sozinho: ele fica onde está e conta em `skipped`; o passo segue.
        const stayed = new Set(applied.skipped);
        const intoIdea = await this.parentsInIdeas(tx, project, [...new Set(moves.map((move) => move.parentId))]);
        for (const move of moves) {
          if (stayed.has(move.id) || !existed.has(move.id) || fromParent.get(move.id) === move.parentId) continue;
          await this.recordParentMove(tx, principal, project, run, info.get(move.id)?.number ?? 0, move.id, fromParent.get(move.id) ?? null, move.parentId);
          // Entrando numa ideia o marcador da IA acaba junto, com a subárvore (como em `updateTicket`).
          if (intoIdea.has(move.parentId)) await this.agentWork.clearSubtree(tx, principal, project, move.id, "idea");
        }
        for (const move of moves) {
          if (stayed.has(move.id)) continue;
          touchedByMoves.add(move.id);
          touchedByMoves.add(move.parentId);
        }
        counts.skipped += plan.skipped.length + stayed.size;
        counts.flattened += moves.filter((move) => move.flattened && !stayed.has(move.id)).length;
        counts.parentsLinked += moves.length - stayed.size;
        await touchProjectVersion(tx, project.id);
      } else counts.skipped += plan.skipped.length;
    }
    if (toRoot.length > 0) {
      await tx.$executeRaw`update tickets set parent_id = null, updated_at = now() where org_id = ${orgId} and id = any(${toRoot}::uuid[])`;
      const numbers = new Map((await tx.ticket.findMany({ where: { id: { in: toRoot } }, select: { id: true, number: true } })).map((row) => [row.id, row.number] as const));
      for (const id of toRoot) {
        touchedByMoves.add(id);
        if (existed.has(id)) await this.recordParentMove(tx, principal, project, run, numbers.get(id) ?? 0, id, fromParent.get(id) ?? null, null);
      }
      counts.parentsLinked += toRoot.length;
      await touchProjectVersion(tx, project.id);
    }
    // O retrato aplicado acompanha o pai de hoje dos que foram à raiz ou já estavam onde o Linear pede.
    const synced = [...toRoot, ...inSync];
    if (synced.length > 0) {
      await tx.$executeRaw`update ticket_external_refs r set applied_snapshot = jsonb_set(r.applied_snapshot, '{parentId}', coalesce(to_jsonb(t.parent_id::text), 'null'::jsonb)) from tickets t where r.org_id = ${orgId} and t.org_id = r.org_id and t.id = r.ticket_id and r.ticket_id = any(${synced}::uuid[]) and (r.applied_snapshot->>'parentId') is distinct from t.parent_id::text`;
    }
    if (reimport) {
      await tx.ticketExternalRef.updateMany({ where: { ticketId: { in: batch.map((row) => row.ticketId).filter((id) => !stuck.has(id)) }, hierarchyPending: true }, data: { hierarchyPending: false } });
      // O ticket movido, o pai novo e o pai antigo entram na lista da fase `statuses` (os nativos, sem origem, nada têm a marcar).
      if (touchedByMoves.size > 0) await tx.ticketExternalRef.updateMany({ where: { projectId: project.id, ticketId: { in: [...touchedByMoves] }, statusPending: false }, data: { statusPending: true } });
    }
    const last = (batch[batch.length - 1] as { ticketId: string }).ticketId;
    if (batch.length < batchOf(run, HIERARCHY_BATCH) && !reimport) await tx.ticketExternalRef.updateMany({ where: { projectId: project.id, hierarchyPending: true }, data: { hierarchyPending: false } });
    return batch.length < batchOf(run, HIERARCHY_BATCH) ? null : last;
  }

  /** O evento automático de uma mudança de pai de ticket que já existia (o mesmo `ticket.updated` de uma edição), sem notificar ninguém. */
  private async recordParentMove(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, number: number, ticketId: string, from: string | null, to: string | null): Promise<void> {
    await this.activity.record(tx, principal, {
      kind: "ticket.updated",
      subjectType: "ticket",
      subjectId: ticketId,
      payload: { key: `${project.key}-${number}`, fields: ["parentId"], parentId: { from, to }, automatic: true, source: "linear_reimport", runId: run.id },
    });
  }

  /**
   * M3 na hierarquia: o destino da descida é ideia (ou está dentro de uma): só desce quem, com toda a sua subárvore, está a fazer
   * (a regra da importação por lista). O resto fica onde está (quem chama conta `movedOutOfIdea`). Tirar uma descida do plano PODE
   * deixar outra inválida (ciclo, profundidade): quem chama refaz o plano sem as tiradas.
   */
  private async withoutIdeaMoves<M extends { id: string; parentId: string }>(tx: TenantClient, project: ProjectRow, moves: M[], forest: readonly { id: string; parent_id: string | null; status: string }[]): Promise<M[]> {
    const inIdea = await this.parentsInIdeas(tx, project, [...new Set(moves.map((move) => move.parentId))]);
    if (inIdea.size === 0) return moves;
    const children = new Map<string, string[]>();
    for (const row of forest) if (row.parent_id !== null) (children.get(row.parent_id) ?? children.set(row.parent_id, []).get(row.parent_id)!).push(row.id);
    const status = new Map(forest.map((row) => [row.id, row.status]));
    const allTodo = (root: string): boolean => {
      const stack = [root];
      while (stack.length > 0) {
        const id = stack.pop() as string;
        if (status.get(id) !== "todo") return false;
        stack.push(...(children.get(id) ?? []));
      }
      return true;
    };
    return moves.filter((move) => !inIdea.has(move.parentId) || allTodo(move.id));
  }

  // ---- fase mentions ----

  /**
   * Liga, em lotes, os textos ANTIGOS do projeto que já citavam números que a rodada criou (o texto importado não cita ninguém, então
   * só este sentido existe). O cursor é o último número olhado; cada passo faz um número fixo de consultas, qualquer que seja o
   * tamanho do projeto. Devolve o cursor do próximo passo, ou `null` ao terminar.
   */
  private async linkMentions(tx: TenantClient, project: ProjectRow, run: RunRow): Promise<string | null> {
    const after = run.cursor === null ? 0 : Number(run.cursor);
    const batch = await tx.$queryRaw<{ id: string; number: number }[]>`
      select t.id, t.number from tickets t join ticket_external_refs r on r.org_id = t.org_id and r.ticket_id = t.id
       where t.org_id = ${project.orgId} and t.project_id = ${project.id}::uuid and t.number > ${Number.isFinite(after) ? after : 0}::int
       order by t.number limit ${batchOf(run, MENTIONS_BATCH)}`;
    if (batch.length === 0) return null;
    await this.tickets.backfillMentionsTo(tx, project, batch);
    await touchProjectVersion(tx, project.id);
    return batch.length < batchOf(run, MENTIONS_BATCH) ? null : String((batch[batch.length - 1] as { number: number }).number);
  }
}
