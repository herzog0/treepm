import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma, TenantClient } from "@treepm/db";
import type { TicketStatus } from "@treepm/domain";
import type { LinearParentMove } from "@treepm/domain";
import { cleanLinearText, isFinished, linearInitialParent, mapLinearProjectStatus, mapLinearTitle, matchLinearAssignee, planLinearParents, safeLinearUrl } from "@treepm/domain";
import { refuseWhileActingAs } from "../access/act-as.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { isUniqueViolation } from "../common/conflict.js";
import { retryableConflict } from "../common/error.filter.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { touchProjectVersion } from "../tickets/project-version.js";
import { structureKey, withStructureSlot } from "../tickets/structure-queue.js";
import { MAX_TREE_DEPTH } from "../tickets/ticket-scope.js";
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
] as const;
/** `assigneeEmailUnavailable`: o Linear recusou o e-mail dos responsáveis nesta rodada; ninguém foi atribuído. */
type Counts = Record<(typeof COUNT_KEYS)[number], number> & { assigneeEmailUnavailable?: true };
const zeroCounts = (): Counts => Object.fromEntries(COUNT_KEYS.map((key) => [key, 0])) as unknown as Counts;
const readCounts = (raw: unknown): Counts => {
  const counts = zeroCounts();
  if (typeof raw === "object" && raw !== null) {
    for (const key of COUNT_KEYS) {
      const value = (raw as Record<string, unknown>)[key];
      if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
    }
    if ((raw as Record<string, unknown>)["assigneeEmailUnavailable"] === true) counts.assigneeEmailUnavailable = true;
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

/** Fase de passo que vai à rede. */
type Fetched =
  | { phase: "projects"; page: LinearPage<LinearProjectNode> }
  | { phase: "issues"; page: LinearIssuesPage; /** A página mapeada FORA da transação (função pura), com a chave do projeto lida no começo do passo. */ mapped: Map<string, MappedIssue>; mappedFor: string; /** O tamanho de página que vale daqui em diante. */ nextPageSize: number; /** A página veio sem descrição (a issue sozinha estourava o teto). */ withoutDescription: boolean };

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
    return (await tx.externalImportRun.findFirst({ where: { orgId, projectId }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] })) as RunRow | null;
  }

  // ---- abrir e ler ----

  async current(tenant: TenantRunner, principal: Principal, projectId: string): Promise<{ run: RunView | null }> {
    refuseWhileActingAs(principal);
    return tenant.run(async (tx, current) => {
      await this.guard(tx, current, projectId, { writable: false });
      const open = await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, projectId, phase: { notIn: ["done", "failed"] } } });
      const run = (open as RunRow | null) ?? (await this.lastRun(tx, current.organization.orgId, projectId));
      return { run: run ? view(run) : null };
    });
  }

  async open(tenant: TenantRunner, principal: Principal, projectId: string, body: { destinationTicketId?: string | null; categorize?: boolean }): Promise<RunView> {
    refuseWhileActingAs(principal);
    const destination = body.destinationTicketId ?? null;
    await tenant.run(async (tx, current) => {
      const project = await this.guard(tx, current, projectId, { writable: true });
      await this.checkOpenable(tx, current, project, destination);
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
        await this.checkOpenable(tx, current, project, destination);
        const row = await tx.externalImportRun.create({
          data: {
            orgId: current.organization.orgId,
            projectId,
            provider: PROVIDER,
            startedByPersonId: current.person.id,
            mode: "first",
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
      }
      throw error;
    }
  }

  /** O projeto está ligado, não tem rodada aberta nem concluída e o destino serve. */
  private async checkOpenable(tx: TenantClient, principal: Principal, project: ProjectRow, destination: string | null): Promise<void> {
    const orgId = principal.organization.orgId;
    const source = await tx.projectExternalSource.findUnique({ where: { orgId_projectId: { orgId, projectId: project.id } } });
    if (!source) throw new ConflictException({ code: "linear_not_linked", message: "Este projeto não está ligado a um time do Linear." });
    const last = await this.lastRun(tx, orgId, project.id);
    const openRun = last && !isTerminal(last.phase) ? last : null;
    if (openRun) throw runOpen(openRun);
    // Rodada concluída: a segunda é a reimportação, que é a fatia 3.
    if (await tx.externalImportRun.findFirst({ where: { orgId, projectId: project.id, phase: "done" }, select: { id: true } })) {
      throw new ConflictException({ code: "linear_reimport_not_available", message: "Este projeto já foi importado do Linear. Importar de novo ainda não está disponível." });
    }
    if (destination !== null) await this.requireDestination(tx, project, destination);
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
        const run = (await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, id: runId, projectId } })) as RunRow | null;
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
      const run = (await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, id: runId, projectId } })) as RunRow | null;
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
      const code = this.errorCode(error) ?? "step_failed";
      // Impasse e prazo de transação (os que o filtro de erros traduz em `concurrent_update`) se repetem sozinhos: não contam.
      if (!RETRYABLE_CODES.has(code) && !isTransient(error)) await this.noteError(tenant, seen, code);
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
   * deu certo vira o tamanho da rodada (e sobe de novo na página seguinte, para uma issue enorme não prender o resto numa página de 1).
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
        return { phase: "issues", page, nextPageSize: reduced ? size : Math.min(size * 2, FULL_PAGE), withoutDescription: !withDescription };
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
        data: { waitUntil, lastErrorCode: "linear_rate_limited", errorStreak: 0, pageSize: Math.min(run.pageSize, pageSize) },
      });
      const fresh = (await tx.externalImportRun.findFirstOrThrow({ where: { orgId: current.organization.orgId, id: run.id } })) as RunRow;
      return view(fresh);
    });
  }

  /**
   * Guarda o último erro para a tela e conta as falhas SEGUIDAS com o mesmo código (outro código recomeça a conta; um passo que grava
   * zera). A rodada fica aberta: nada decide sozinho; a tela oferece "Abandonar". Nunca atrapalha a resposta ao erro de verdade.
   */
  private async noteError(tenant: TenantRunner, run: RunRow, code: string, pageSize: number = run.pageSize): Promise<void> {
    try {
      await tenant.run(async (tx, current) => {
        await tx.$executeRaw`update external_import_runs set last_error_code = ${code}, error_streak = case when last_error_code = ${code} then error_streak + 1 else 1 end, page_size = least(page_size, ${pageSize}::int), updated_at = now()
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
    const run = (await tx.externalImportRun.findFirst({ where: { orgId: principal.organization.orgId, id: seen.id, projectId } })) as RunRow | null;
    if (!run) throw new NotFoundException("Importação não encontrada.");
    // Outro passo andou enquanto este esperava a trava (duas abas, resposta perdida): devolve o estado atual, sem gravar nada.
    if (isTerminal(run.phase) || run.phase !== seen.phase || run.cursor !== seen.cursor) return view(run);
    // O destino só importa onde se cria ticket; em `hierarchy` e `mentions` um destino apagado não obriga a abandonar.
    if (run.phase === "projects" || run.phase === "issues") await this.requireRunDestination(tx, project, run);
    const counts = readCounts(run.counts);
    let phase = run.phase;
    let cursor: string | null = run.cursor;
    let pageSize = run.pageSize;
    let finished: Date | null = null;

    if (run.phase === "projects" && fetched?.phase === "projects") {
      await this.importProjects(tx, principal, project, run, fetched.page, counts);
      [phase, cursor] = fetched.page.nextCursor === null ? ["issues", null] : ["projects", fetched.page.nextCursor];
    } else if (run.phase === "issues" && fetched?.phase === "issues") {
      const { sweep, known } = parseIssuesCursor(run.cursor);
      const fresh = await this.importIssues(tx, principal, project, run, fetched, counts, sweep > 0);
      pageSize = fetched.nextPageSize;
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
      [phase, cursor] = next === null ? ["mentions", null] : ["hierarchy", next];
    } else if (run.phase === "mentions") {
      const next = await this.linkMentions(tx, project, run);
      if (next === null) {
        // A categorização (fatia 4) entra aqui; nesta fatia a rodada vai direto a `done`.
        phase = "done";
        cursor = null;
        finished = new Date();
        await this.activity.record(tx, principal, {
          kind: "ticket.imported_from_linear",
          subjectType: "project",
          subjectId: projectId,
          payload: { provider: PROVIDER, runId: run.id, mode: run.mode, counts: { ...counts } },
        });
      } else cursor = next;
    } else {
      throw new Error(`fase inesperada da importação: ${run.phase}`);
    }
    const updated = await tx.externalImportRun.update({
      where: { orgId_id: { orgId: principal.organization.orgId, id: run.id } },
      data: { phase, cursor, pageSize, counts: { ...counts }, waitUntil: null, lastErrorCode: null, errorStreak: 0, finishedAt: finished },
    });
    return view(updated as RunRow);
  }

  // ---- fase projects ----

  private async importProjects(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, page: LinearPage<LinearProjectNode>, counts: Counts): Promise<void> {
    const unique = [...new Map(page.nodes.map((node) => [node.id, node])).values()];
    counts.skippedInvalid += page.skippedInvalid;
    counts.projectsSeen += unique.length;
    const existing = await this.existingRefs(tx, "project", unique.map((node) => node.id));
    const fresh: LinearProjectNode[] = [];
    for (const node of unique) {
      const found = existing.get(node.id);
      if (found === undefined) fresh.push(node);
      else if (found === project.id) counts.projectsExisting += 1;
      else counts.projectsElsewhere += 1;
    }
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
    const existing = await this.existingRefs(tx, "issue", live.map((node) => node.id));
    const fresh: LinearIssueNode[] = [];
    for (const node of live) {
      const found = existing.get(node.id);
      if (found === undefined) fresh.push(node);
      else if (!sweeping) {
        if (found === project.id) counts.issuesExisting += 1;
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
    const mapped = fetched.mappedFor === project.key ? fetched.mapped : mapLinearIssuePage(fresh, project.key);
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
    if (needReopen.length > 0) await this.reopenParents(tx, principal, project, needReopen, `${project.key}-${await this.tickets.peekNextNumber(tx, project)}`, counts);
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
        };
      }),
    });
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
  private async reopenParents(tx: TenantClient, principal: Principal, project: ProjectRow, parentIds: readonly string[], causedBy: string, counts: Counts, movingTo: ReadonlyMap<string, string> = new Map()): Promise<void> {
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
      const applied = new Map(
        (await tx.ticketExternalRef.findMany({ where: { ticketId: { in: chain.map((item) => item.id) } }, select: { ticketId: true, appliedSnapshot: true } })).map((row) => [row.ticketId, (row.appliedSnapshot as { status?: unknown } | null)?.status]),
      );
      for (const item of chain) {
        await tx.ticket.update({ where: { orgId_id: { orgId: project.orgId, id: item.id } }, data: { status: "todo" } });
        // O que a própria rodada criou já concluído muda em silêncio (nasceu assim); o que alguém concluiu no TreePM tem evento automático.
        if (applied.get(item.id) !== "done") {
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

  private async markTodo(tx: TenantClient, project: ProjectRow, ids: string[]): Promise<void> {
    await tx.$executeRaw`update ticket_external_refs set applied_snapshot = jsonb_set(applied_snapshot, '{status}', '"todo"') where org_id = ${project.orgId} and ticket_id = any(${ids}::uuid[])`;
  }

  /** O que já tem origem na ORGANIZAÇÃO (RLS) para os ids externos dados: id externo → projeto do TreePM onde o ticket está. */
  private async existingRefs(tx: TenantClient, kind: "issue" | "project", externalIds: string[]): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const rows = await tx.ticketExternalRef.findMany({ where: { provider: PROVIDER, kind, externalId: { in: externalIds } }, select: { externalId: true, projectId: true } });
    return new Map(rows.map((row) => [row.externalId, row.projectId]));
  }

  // ---- fase hierarchy ----

  /**
   * Leva para baixo do pai (que o Linear indicou e já foi importado NESTE projeto) até 200 tickets por passo. O cursor é a chave do
   * último ticket olhado (varredura por `ticket_id`), então o passo sempre avança, mesmo para o que ficou onde estava (ciclo, pai
   * ausente, subárvore que não cabe, ideia que não aceita). Devolve o cursor do próximo passo, ou `null` quando não há mais o que olhar.
   */
  private async linkHierarchy(tx: TenantClient, principal: Principal, project: ProjectRow, run: RunRow, counts: Counts): Promise<string | null> {
    const orgId = project.orgId;
    const batch = await tx.ticketExternalRef.findMany({
      where: { projectId: project.id, kind: "issue", externalParentId: { not: null }, ...(run.cursor === null ? {} : { ticketId: { gt: run.cursor } }) },
      orderBy: { ticketId: "asc" },
      take: HIERARCHY_BATCH,
      select: { ticketId: true, externalParentId: true, firstImportedAt: true, appliedSnapshot: true },
    });
    if (batch.length === 0) return null;
    const parentRefs = await tx.ticketExternalRef.findMany({
      where: { projectId: project.id, kind: "issue", externalId: { in: [...new Set(batch.map((row) => row.externalParentId as string))] } },
      select: { externalId: true, ticketId: true },
    });
    const parentTicket = new Map(parentRefs.map((row) => [row.externalId, row.ticketId]));
    const wanted = batch.flatMap((row) => {
      const parentId = parentTicket.get(row.externalParentId as string);
      return parentId === undefined ? [] : [{ row, parentId }];
    });
    if (wanted.length > 0) {
      // A floresta inteira do projeto: a profundidade e o ciclo contam a partir da raiz de verdade, não do destino.
      const rows = await tx.$queryRaw<{ id: string; parent_id: string | null; status: string; number: number }[]>`select id, parent_id, status, number from tickets where org_id = ${orgId} and project_id = ${project.id}::uuid`;
      // O que alguém arrumou à mão fica (ADR 0060, seção 5): só desce o ticket criado NESTA rodada, ou cujo pai atual ainda é o que a
      // importação deu a ele (`applied_snapshot.parentId`). Ticket movido no TreePM fica onde está e conta em `keptMoved`.
      const currentParent = new Map(rows.map((row) => [row.id, row.parent_id]));
      const requests = wanted.flatMap(({ row, parentId }) => {
        const appliedParent = (row.appliedSnapshot as { parentId?: unknown } | null)?.parentId ?? null;
        const createdNow = row.firstImportedAt.getTime() >= run.startedAt.getTime();
        const current = currentParent.get(row.ticketId) ?? null;
        if (!createdNow && current !== appliedParent) {
          if (current !== parentId) counts.keptMoved += 1; // já estar no pai do Linear não é "arrumado à mão contra o Linear"
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
        const needReopen = [...new Set(open.map((move) => move.parentId))].sort();
        if (needReopen.length > 0) await this.reopenParents(tx, principal, project, needReopen, `${project.key}-${info.get((open[0] as { id: string }).id)?.number}`, counts, new Map(moves.map((move) => [move.id, move.parentId])));
        const applied = await applyParentMoves(tx, orgId, moves);
        // O gatilho de ciclo do banco recusou o item sozinho: ele fica onde está e conta em `skipped`; o passo segue.
        const stayed = new Set(applied.skipped);
        counts.skipped += plan.skipped.length + stayed.size;
        counts.flattened += moves.filter((move) => move.flattened && !stayed.has(move.id)).length;
        counts.parentsLinked += moves.length - stayed.size;
        await touchProjectVersion(tx, project.id);
      } else counts.skipped += plan.skipped.length;
    }
    const last = (batch[batch.length - 1] as { ticketId: string }).ticketId;
    return batch.length < HIERARCHY_BATCH ? null : last;
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
       order by t.number limit ${MENTIONS_BATCH}`;
    if (batch.length === 0) return null;
    await this.tickets.backfillMentionsTo(tx, project, batch);
    await touchProjectVersion(tx, project.id);
    return batch.length < MENTIONS_BATCH ? null : String((batch[batch.length - 1] as { number: number }).number);
  }
}
