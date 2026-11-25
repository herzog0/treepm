import { createHash } from "node:crypto";
import { ConflictException, HttpException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { mentionsPersonRaw } from "@treepm/domain";
import { refuseWhileActingAs } from "../access/act-as.js";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { AssistantGate } from "../assistant/assistant-gate.js";
import { loadPlacementTree } from "../assistant/branch-tree.js";
import { decisionOf, saveTicketDecision } from "../assistant/placement-decision.js";
import type { DoubtRecord } from "../assistant/placement-decision.js";
import { runPlacement } from "../assistant/placement-run.js";
import { PlacementService } from "../assistant/placement.service.js";
import type { PlacementSnapshot, TreeTicket } from "../assistant/placement.service.js";
import { AssistantUnavailableError } from "../assistant/ports.js";
import { semanticSearchOf } from "../assistant/semantic-triage.js";
import { embeddingStoreOf } from "../assistant/ticket-embeddings.js";
import { isUniqueViolation } from "../common/conflict.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { structureKey, withStructureSlot } from "../tickets/structure-queue.js";
import { TicketsService } from "../tickets/tickets.service.js";
import type { ProjectRow } from "../tickets/tickets.service.js";
import type { CategorizeOverview, CategorizeView, ToCheckItem } from "./linear-categorize.schema.js";

const PROVIDER = "linear";
/** O provedor falhou duas vezes no mesmo candidato: ele vira `failed` e a rodada segue. */
export const MAX_ATTEMPTS = 2;
/** Limite de taxa com prazo: depois de tantas esperas seguidas no mesmo candidato ele vira `failed`. */
export const MAX_WAITS = 10;
/** Quantos candidatos uma rodada leva (os mais antigos primeiro); o resto fica para a rodada seguinte. */
export const BATCH_LIMIT = 200;
const MAX_WAIT_SECONDS = 3600;
/** Quanto do texto do ticket vai à procura (a conversa também limita o rascunho que escreve). */
const DESCRIPTION_CAP = 2000;
/** Títulos de filhos que vão como "Partes" (a conversa manda os do rascunho; um projeto do Linear pode ter centenas). */
const PARTS_CAP = 20;

type RunRow = {
  id: string;
  orgId: string;
  projectId: string;
  mode: string;
  phase: string;
  sourceRunId: string | null;
  destinationTicketId: string | null;
  hasDestination: boolean;
  waitUntil: Date | null;
  lastErrorCode: string | null;
  errorStreak: number;
  startedAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
};
type ItemRow = { id: string; ticketId: string; position: number; state: string; attempts: number; waits: number; parentBefore: string | null };
type Candidate = { id: string; number: number; parentId: string | null };
/** Por que o passo não decidiu o candidato: `retryAfterSeconds` é o prazo pedido pelo provedor (limite de taxa). */
type StepFailure = { code: "assistant_unavailable" | "assistant_rate_limited" | "step_failed"; retryAfterSeconds?: number };
/** A decisão do passo: mover para um lugar, ficar onde está ou deixar "a conferir" (com o caminho sugerido, se houver). */
type Verdict = { kind: "move"; targetId: string; path: string[] } | { kind: "keep" } | { kind: "review"; path: string[] };

const isTerminal = (phase: string): boolean => phase === "done" || phase === "failed";
const mark = (title: string, description: string): string => createHash("sha256").update(`${title}\n${description}`).digest("hex").slice(0, 16);

/**
 * Categorização do lote importado do Linear (ADR 0060, seção 6): procura o lugar de cada raiz de uma importação concluída, com a MESMA
 * procura da conversa (`runPlacement`) e as mesmas regras de dúvida. Decisão segura move o ticket; na dúvida, ou quando a procura quer
 * um agrupador novo, nada é movido e o ticket fica "a conferir". Nunca cria agrupador e nunca pergunta.
 *
 * A rodada é uma linha de `external_import_runs` com `mode = categorize` (o índice "uma rodada aberta por projeto" vale entre importação e
 * categorização) e a lista congelada de candidatos fica em `external_categorize_items`. Cada passo decide UM candidato: lê, vai à IA fora
 * de transação e grava numa transação curta com a trava de estrutura, reconferindo tudo.
 */
@Injectable()
export class LinearCategorizeService {
  private readonly logger = new Logger("LinearCategorize");
  private readonly inFlight = new Set<string>();

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(AssistantGate) private readonly gate: AssistantGate,
    @Inject(PlacementService) private readonly placement: PlacementService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
  ) {}

  private async guard(tx: TenantClient, principal: Principal, projectId: string, options: { writable: boolean }): Promise<ProjectRow> {
    const project = await tx.project.findFirst({ where: { orgId: principal.organization.orgId, id: projectId } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    this.authorization.importTickets(principal.actor, projectId);
    if (options.writable && project.archivedAt) throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    return project;
  }

  // ---- candidatos ----

  private async lastImport(tx: TenantClient, orgId: string, projectId: string): Promise<RunRow | null> {
    return (await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: { not: "categorize" }, phase: "done" }, orderBy: [{ finishedAt: "desc" }, { id: "desc" }] })) as RunRow | null;
  }

  /**
   * Os candidatos do projeto, sem olhar rodada nenhuma: ticket com origem no Linear, deste projeto, ainda visto no Linear, que continua
   * exatamente onde a importação o pôs (o pai atual é o pai aplicado: ninguém o moveu) e que é a RAIZ do que veio do Linear (está na
   * raiz do projeto ou sob um ticket nativo, nunca sob outro ticket do Linear). Aberto, fora de ideia e sem decisão anterior
   * (`placed`, `to_check`, `kept`): quem falhou (`failed`) ou ficou numa rodada abandonada volta a ser candidato. Os mais antigos primeiro.
   */
  private async candidates(tx: TenantClient, project: ProjectRow, live: ReadonlySet<string>): Promise<Candidate[]> {
    const orgId = project.orgId;
    const rows = await tx.$queryRaw<Candidate[]>`
      select t.id, t.number, t.parent_id as "parentId" from ticket_external_refs r join tickets t on t.org_id = r.org_id and t.id = r.ticket_id
       where r.org_id = ${orgId} and r.project_id = ${project.id}::uuid and r.provider = ${PROVIDER} and r.missing_since is null
         and (r.applied_snapshot->>'parentId') is not distinct from t.parent_id::text
         and (t.parent_id is null or not exists (select 1 from ticket_external_refs p where p.org_id = t.org_id and p.ticket_id = t.parent_id and p.provider = ${PROVIDER}))
         and t.status not in ('done', 'cancelled') and t.idea_stage is null
         and not exists (select 1 from external_categorize_items i where i.org_id = t.org_id and i.ticket_id = t.id and i.state in ('placed', 'to_check', 'kept'))
       order by r.first_imported_at, t.number`;
    return rows.filter((row) => live.has(row.id));
  }

  /** O ticket de um item continua candidato? (Reconferência do passo e da gravação.) */
  private async stillCandidate(tx: TenantClient, orgId: string, item: ItemRow, live: ReadonlySet<string>): Promise<boolean> {
    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      select ((r.applied_snapshot->>'parentId') is not distinct from t.parent_id::text and r.missing_since is null and t.status not in ('done', 'cancelled') and t.idea_stage is null) as ok
        from tickets t join ticket_external_refs r on r.org_id = t.org_id and r.ticket_id = t.id
       where t.org_id = ${orgId} and t.id = ${item.ticketId}::uuid and t.parent_id is not distinct from ${item.parentBefore}::uuid`;
    return rows[0]?.ok === true && live.has(item.ticketId);
  }

  // ---- ler ----

  private async view(tx: TenantClient, run: RunRow): Promise<CategorizeView> {
    const groups = await tx.externalCategorizeItem.groupBy({ by: ["state"], where: { orgId: run.orgId, runId: run.id }, _count: { _all: true } });
    const n = (state: string): number => groups.find((group) => group.state === state)?._count._all ?? 0;
    const total = groups.reduce((sum, group) => sum + group._count._all, 0);
    return {
      id: run.id,
      projectId: run.projectId,
      sourceRunId: run.sourceRunId,
      phase: run.phase as CategorizeView["phase"],
      finished: isTerminal(run.phase),
      total,
      done: total - n("pending"),
      placed: n("placed"),
      toCheck: n("to_check"),
      kept: n("kept"),
      skipped: n("skipped"),
      failed: n("failed"),
      waitUntil: run.waitUntil && run.waitUntil.getTime() > Date.now() ? run.waitUntil.toISOString() : null,
      lastErrorCode: run.lastErrorCode,
      errorStreak: run.errorStreak,
      startedAt: run.startedAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    };
  }

  async overview(tenant: TenantRunner, principal: Principal, projectId: string): Promise<CategorizeOverview> {
    refuseWhileActingAs(principal);
    const base = await tenant.run(async (tx, current) => {
      const project = await this.guard(tx, current, projectId, { writable: false });
      const orgId = current.organization.orgId;
      const source = await this.lastImport(tx, orgId, projectId);
      const live = new Set((await loadPlacementTree(tx, projectId)).tickets.map((ticket) => ticket.id));
      const candidates = source ? (await this.candidates(tx, project, live)).length : 0;
      const open = (await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: "categorize", phase: "categorize" } })) as RunRow | null;
      const run = open ?? ((await tx.externalImportRun.findFirst({ where: { orgId, projectId, mode: "categorize" }, orderBy: [{ startedAt: "desc" }, { id: "desc" }] })) as RunRow | null);
      return { candidates, sourceRunId: source?.id ?? null, run: run ? await this.view(tx, run) : null, toCheck: (await this.toCheckRows(tx, orgId, projectId)).length };
    });
    // O portão só confere configuração e aceite: nada é lido nem enviado à IA para responder isto.
    let reason: CategorizeOverview["reason"] = null;
    try {
      await this.gate.open(tenant);
    } catch (error) {
      const code = error instanceof HttpException ? (error.getResponse() as { code?: string }).code : undefined;
      if (code === "assistant_not_configured" || code === "assistant_consent_required") reason = code;
      else throw error;
    }
    return { available: reason === null, reason, batchLimit: BATCH_LIMIT, ...base };
  }

  // ---- abrir e abandonar ----

  async open(tenant: TenantRunner, principal: Principal, projectId: string): Promise<CategorizeView> {
    refuseWhileActingAs(principal);
    await tenant.run((tx, current) => this.guard(tx, current, projectId, { writable: true }));
    await this.gate.open(tenant);
    try {
      return await tenant.run(async (tx, current) => {
        const project = await this.guard(tx, current, projectId, { writable: true });
        // A árvore é lida com a trava de estrutura: a lista congelada é a de um instante consistente.
        await this.tickets.lockStructure(tx, projectId);
        const orgId = current.organization.orgId;
        const openRun = await tx.externalImportRun.findFirst({ where: { orgId, projectId, phase: { notIn: ["done", "failed"] } }, select: { mode: true } });
        if (openRun) throw this.openConflict(openRun.mode);
        const source = await this.lastImport(tx, orgId, projectId);
        const live = new Set((await loadPlacementTree(tx, projectId)).tickets.map((ticket) => ticket.id));
        const list = source ? (await this.candidates(tx, project, live)).slice(0, BATCH_LIMIT) : [];
        if (!source || list.length === 0) throw new ConflictException({ code: "linear_nothing_to_categorize", message: "Não há itens importados para procurar o lugar." });
        const run = (await tx.externalImportRun.create({
          data: { orgId, projectId, provider: PROVIDER, startedByPersonId: current.person.id, mode: "categorize", phase: "categorize", categorize: false, counts: {}, totalExpected: list.length, sourceRunId: source.id },
        })) as RunRow;
        await tx.externalCategorizeItem.createMany({ data: list.map((candidate, position) => ({ orgId, runId: run.id, projectId, ticketId: candidate.id, position, parentBefore: candidate.parentId })) });
        return this.view(tx, run);
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const openRun = await tenant.run((tx, current) => tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, projectId, phase: { notIn: ["done", "failed"] } }, select: { mode: true } }));
        if (openRun) throw this.openConflict(openRun.mode);
      }
      throw error;
    }
  }

  private openConflict(mode: string): ConflictException {
    return mode === "categorize"
      ? new ConflictException({ code: "linear_categorize_open", message: "Já existe uma categorização em andamento neste projeto." })
      : new ConflictException({ code: "linear_import_in_progress", message: "Há uma importação em andamento neste projeto. Espere ela terminar." });
  }

  async abandon(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<CategorizeView> {
    refuseWhileActingAs(principal);
    const write = (): Promise<CategorizeView> =>
      tenant.run(async (tx, current) => {
        await this.guard(tx, current, projectId, { writable: false });
        await this.tickets.lockStructure(tx, projectId);
        const run = (await tx.externalImportRun.findFirst({ where: { orgId: current.organization.orgId, id: runId, projectId, mode: "categorize" } })) as RunRow | null;
        if (!run) throw new NotFoundException("Categorização não encontrada.");
        if (isTerminal(run.phase)) return this.view(tx, run);
        const updated = await tx.externalImportRun.update({ where: { orgId_id: { orgId: run.orgId, id: run.id } }, data: { phase: "failed", waitUntil: null, finishedAt: new Date() } });
        return this.view(tx, updated as RunRow);
      });
    const key = structureKey(principal.organization.orgId, projectId);
    return key === undefined ? write() : withStructureSlot(key, write);
  }

  // ---- o passo ----

  async step(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<CategorizeView> {
    refuseWhileActingAs(principal);
    const flight = `${principal.organization.orgId}:${runId}`;
    if (this.inFlight.has(flight)) throw new ConflictException({ code: "linear_step_in_progress", message: "Outro passo desta categorização está em andamento. Aguarde." });
    this.inFlight.add(flight);
    try {
      return await this.stepOnce(tenant, principal, projectId, runId);
    } finally {
      this.inFlight.delete(flight);
    }
  }

  /** Lê o que o passo precisa (e pula, sem IA, o candidato que deixou de ser candidato). `null` no `work` = nada a fazer com a IA. */
  private async stepRead(tenant: TenantRunner, projectId: string, runId: string) {
    return tenant.run(async (tx, current) => {
      await this.guard(tx, current, projectId, { writable: true });
      const orgId = current.organization.orgId;
      const run = (await tx.externalImportRun.findFirst({ where: { orgId, id: runId, projectId, mode: "categorize" } })) as RunRow | null;
      if (!run) throw new NotFoundException("Categorização não encontrada.");
      if (isTerminal(run.phase) || (run.waitUntil !== null && run.waitUntil.getTime() > Date.now())) return { view: await this.view(tx, run) };
      const item = (await tx.externalCategorizeItem.findFirst({ where: { orgId, runId, state: "pending" }, orderBy: { position: "asc" } })) as ItemRow | null;
      if (!item) return { view: await this.view(tx, await this.finish(tx, run)) };
      const tree = await loadPlacementTree(tx, projectId);
      const live = new Set(tree.tickets.map((ticket) => ticket.id));
      if (!(await this.stillCandidate(tx, orgId, item, live))) {
        await tx.externalCategorizeItem.updateMany({ where: { orgId, id: item.id, state: "pending" }, data: { state: "skipped", decidedAt: new Date() } });
        return { view: await this.view(tx, await this.finish(tx, run)) };
      }
      const [row] = await tx.$queryRaw<{ title: string; description: string; number: number }[]>`select title, description, number from tickets where org_id = ${orgId} and id = ${item.ticketId}::uuid`;
      return { work: { projectName: (await tx.project.findFirstOrThrow({ where: { orgId, id: projectId }, select: { name: true } })).name, run, item, tree, ticket: row as { title: string; description: string; number: number } } };
    });
  }

  private async stepOnce(tenant: TenantRunner, principal: Principal, projectId: string, runId: string): Promise<CategorizeView> {
    const read = await this.stepRead(tenant, projectId, runId);
    if (!("work" in read) || read.work === undefined) return (read as { view: CategorizeView }).view;
    const { projectName, run, item, tree, ticket } = read.work;
    // Configuração e aceite antes de qualquer envio: sem eles o passo responde o erro do portão e a rodada fica como está.
    const providers = await this.gate.open(tenant);

    const children = tree.tickets.filter((candidate) => candidate.parentId === item.ticketId);
    const draftText = { title: ticket.title, description: Array.from(ticket.description).slice(0, DESCRIPTION_CAP).join("") };
    const partTitles = children.slice(0, PARTS_CAP).map((child) => child.title);
    // O mesmo filtro da conversa (ADR 0058): texto com menção de pessoa não vai ao provedor. O ticket fica "a conferir", sem IA.
    if ([draftText.title, ticket.description, ...partTitles].some((text) => mentionsPersonRaw(text))) {
      return this.write(tenant, principal, projectId, run, item, { kind: "review", path: [] }, null);
    }
    const subtree = descendantsOf(tree.tickets, item.ticketId);
    // O mesmo filtro vale para o que os OUTROS tickets mostram ao provedor (a árvore e os relacionados): texto com menção de pessoa é
    // neutralizado (o ticket continua na árvore, para os filhos não ficarem órfãos). Pelas rotas normais ele nem existe (ADR 0058).
    const clean = (ticketOfTree: TreeTicket): TreeTicket => (mentionsPersonRaw(ticketOfTree.title) || mentionsPersonRaw(ticketOfTree.description) ? { ...ticketOfTree, title: "Sem título", description: "" } : ticketOfTree);
    const snapshot: PlacementSnapshot = { projectId, projectName, tickets: tree.tickets.filter((candidate) => !subtree.has(candidate.id)).map(clean), notes: new Map([...tree.notes].filter(([, note]) => !mentionsPersonRaw(note))) };
    const draft = { title: draftText.title, description: partTitles.length === 0 ? draftText.description : `${draftText.description === "" ? "" : `${draftText.description}\n\n`}Partes:\n${partTitles.map((title) => `- ${title}`).join("\n")}` };
    try {
      const searched = await runPlacement(this.placement, {
        snapshot,
        draft,
        triage: { title: draftText.title, description: draftText.description, partTitles },
        judge: providers.judge,
        related: providers.related,
        doubt: providers.doubt,
        semantic: semanticSearchOf(embeddingStoreOf(tenant), providers.embedder, projectId, providers.semantic),
        fusion: providers.semantic.mode === "interleave" ? "interleave" : "rrf",
        scopeId: null,
        startId: null,
      });
      const target = searched.outcome.destination.parentId;
      const guess = searched.outcome.destination.path.map((step) => step.id);
      let verdict: Verdict;
      // Sem lugar (a procura cai na raiz) nunca é "já no lugar": fica a conferir, sem sugestão. "Já no lugar" é só quando o melhor
      // lugar encontrado é o pai atual e esse pai não é a raiz.
      if (searched.doubt) verdict = { kind: "review", path: searched.doubt.kind === "root" ? [] : guess };
      else if (target === null) verdict = { kind: "review", path: [] };
      else if (target === item.parentBefore) verdict = { kind: "keep" };
      else {
        // Decisão segura que mexeria na árvore: se a procura quer um agrupador novo, o lote não cria, e a pessoa decide.
        const proposal = await this.placement.propose(draft, snapshot, searched.outcome, { affinity: providers.affinity, namer: providers.namer, ...(searched.picked.duplicate ? { excludeIds: [searched.picked.duplicate.id] } : {}) });
        if (proposal.groupProposalSkipped === "unavailable") throw new AssistantUnavailableError("proposal_unavailable");
        verdict = proposal.groupProposal ? { kind: "review", path: guess } : { kind: "move", targetId: target, path: guess };
      }
      const doubt: DoubtRecord = { draftMark: mark(draftText.title, ticket.description), confirmed: searched.doubt === null, startId: null, question: null };
      const record = decisionOf({ uncertain: searched.doubt !== null ? true : searched.outcome.uncertain, trace: searched.outcome.trace }, new Map(snapshot.tickets.map((t) => [t.id, t.number])), {
        related: searched.picked.related,
        duplicateId: searched.picked.duplicate?.id ?? null,
        rule: searched.rule,
        triage: searched.found.triage ?? null,
        doubt,
      });
      return await this.write(tenant, principal, projectId, run, item, verdict, record);
    } catch (error) {
      if (error instanceof AssistantUnavailableError) {
        this.logger.warn(`assistente indisponível motivo=${error.reason}`);
        const wait = error.retryAfterSeconds !== undefined && error.retryAfterSeconds > 0;
        return this.recordFailure(tenant, principal, projectId, run, item, { code: wait ? "assistant_rate_limited" : "assistant_unavailable", ...(wait ? { retryAfterSeconds: error.retryAfterSeconds as number } : {}) });
      }
      // Resposta deliberada (permissão, projeto arquivado...): segue como está. Qualquer outro erro conta como falha do candidato e nunca
      // trava a rodada; só o tipo do erro vai ao log (a mensagem pode trazer texto de ticket).
      if (error instanceof HttpException) throw error;
      this.logger.warn(`passo falhou tipo=${error instanceof Error ? error.name : "desconhecido"}`);
      return this.recordFailure(tenant, principal, projectId, run, item, { code: "step_failed" });
    }
  }

  /**
   * O passo não decidiu o candidato. Erro do provedor ou inesperado: tenta de novo no passo seguinte; na segunda falha do MESMO candidato ele
   * vira `failed` e a rodada segue. Limite de taxa com prazo: espera (teto de 1 h) e, na 10ª espera seguida, `failed`. A tentativa é gravada
   * sob a trava de estrutura e só vale se o item ainda está como o passo o leu (`attempts` e `waits`): falhas simultâneas do mesmo candidato
   * contam uma vez só.
   */
  private async recordFailure(tenant: TenantRunner, principal: Principal, projectId: string, run: RunRow, item: ItemRow, failure: StepFailure): Promise<CategorizeView> {
    const body = (): Promise<CategorizeView> =>
      tenant.run(async (tx, current) => {
        await this.guard(tx, current, projectId, { writable: false });
        await this.tickets.lockStructure(tx, projectId);
        const orgId = current.organization.orgId;
        const fresh = (await tx.externalCategorizeItem.findFirst({ where: { orgId, id: item.id } })) as ItemRow | null;
        const now = (await tx.externalImportRun.findFirstOrThrow({ where: { orgId, id: run.id } })) as RunRow;
        if (!fresh || fresh.state !== "pending" || isTerminal(now.phase) || fresh.attempts !== item.attempts || fresh.waits !== item.waits) return this.view(tx, now);
        const fail = async (data: { attempts?: number; waits?: number }): Promise<CategorizeView> => {
          await tx.externalCategorizeItem.update({ where: { orgId_id: { orgId, id: item.id } }, data: { ...data, state: "failed", decidedAt: new Date() } });
          const updated = await tx.externalImportRun.update({ where: { orgId_id: { orgId, id: run.id } }, data: { lastErrorCode: failure.code, errorStreak: 0, waitUntil: null } });
          return this.view(tx, await this.finish(tx, updated as RunRow));
        };
        if (failure.retryAfterSeconds !== undefined) {
          if (fresh.waits + 1 >= MAX_WAITS) return fail({ waits: fresh.waits + 1 });
          await tx.externalCategorizeItem.update({ where: { orgId_id: { orgId, id: item.id } }, data: { waits: fresh.waits + 1 } });
          const wait = new Date(Date.now() + Math.min(Math.ceil(failure.retryAfterSeconds), MAX_WAIT_SECONDS) * 1000);
          const updated = await tx.externalImportRun.update({ where: { orgId_id: { orgId, id: run.id } }, data: { waitUntil: wait, lastErrorCode: failure.code, errorStreak: { increment: 1 } } });
          return this.view(tx, updated as RunRow);
        }
        if (fresh.attempts + 1 >= MAX_ATTEMPTS) return fail({ attempts: fresh.attempts + 1 });
        await tx.externalCategorizeItem.update({ where: { orgId_id: { orgId, id: item.id } }, data: { attempts: fresh.attempts + 1 } });
        const updated = await tx.externalImportRun.update({ where: { orgId_id: { orgId, id: run.id } }, data: { lastErrorCode: failure.code, errorStreak: { increment: 1 } } });
        return this.view(tx, updated as RunRow);
      });
    const key = structureKey(principal.organization.orgId, projectId);
    return key === undefined ? body() : withStructureSlot(key, body);
  }

  /** Encerra a rodada quando não resta candidato pendente. */
  private async finish(tx: TenantClient, run: RunRow): Promise<RunRow> {
    if (isTerminal(run.phase) || (await tx.externalCategorizeItem.count({ where: { orgId: run.orgId, runId: run.id, state: "pending" } })) > 0) return run;
    return (await tx.externalImportRun.update({ where: { orgId_id: { orgId: run.orgId, id: run.id } }, data: { phase: "done", waitUntil: null, finishedAt: new Date() } })) as RunRow;
  }

  /** A gravação: a trava de estrutura, a reconferência de tudo, o movimento, a decisão e o item, na mesma transação. */
  private async write(tenant: TenantRunner, principal: Principal, projectId: string, run: RunRow, item: ItemRow, verdict: Verdict, record: ReturnType<typeof decisionOf> | null): Promise<CategorizeView> {
    const body = (): Promise<CategorizeView> =>
      tenant.run(async (tx, current) => {
        const project = await this.guard(tx, current, projectId, { writable: true });
        await this.tickets.lockStructure(tx, projectId);
        const orgId = current.organization.orgId;
        const now = (await tx.externalImportRun.findFirstOrThrow({ where: { orgId, id: run.id } })) as RunRow;
        const fresh = (await tx.externalCategorizeItem.findFirst({ where: { orgId, id: item.id } })) as ItemRow | null;
        // Outra aba ou instância já decidiu (ou a rodada acabou): nada se repete.
        if (!fresh || fresh.state !== "pending" || isTerminal(now.phase)) return this.view(tx, now);
        const tree = await loadPlacementTree(tx, projectId);
        const live = new Set(tree.tickets.map((ticket) => ticket.id));
        if (!(await this.stillCandidate(tx, orgId, item, live))) {
          await tx.externalCategorizeItem.updateMany({ where: { orgId, id: item.id, state: "pending" }, data: { state: "skipped", decidedAt: new Date() } });
          return this.view(tx, await this.finish(tx, now));
        }
        let final = verdict;
        if (final.kind === "move") {
          const subtree = descendantsOf(tree.tickets, item.ticketId);
          if (!live.has(final.targetId) || subtree.has(final.targetId)) final = { kind: "review", path: [] };
          else {
            // Mesmas invariantes de uma edição (reabertura de ancestral, ideia, ciclo...); se alguma recusar, o ticket fica a conferir.
            await tx.$executeRaw`savepoint categorize_move`;
            try {
              await this.tickets.updateTicket(tx, current, item.ticketId, { parentId: final.targetId }, { event: { automatic: true, source: "linear_categorize", runId: run.id } });
              await tx.$executeRaw`release savepoint categorize_move`;
              // O retrato aplicado acompanha o lugar: a reimportação lê o ticket como "onde a importação o pôs", não como "movido por pessoa" —
              // assim não o devolve ao destino, e uma mudança legítima do Linear (pai ou projeto) ainda vale enquanto ninguém o mexer.
              await tx.$executeRaw`update ticket_external_refs set applied_snapshot = jsonb_set(applied_snapshot, '{parentId}', to_jsonb(${final.targetId}::text)) where org_id = ${orgId} and ticket_id = ${item.ticketId}::uuid`;
            } catch (error) {
              if (!(error instanceof HttpException)) throw error;
              await tx.$executeRaw`rollback to savepoint categorize_move`;
              final = { kind: "review", path: [] };
            }
          }
        }
        if (record) await saveTicketDecision(tx, { orgId, projectId, ticketId: item.ticketId, record });
        const state = final.kind === "move" ? "placed" : final.kind === "keep" ? "kept" : "to_check";
        await tx.externalCategorizeItem.update({
          where: { orgId_id: { orgId, id: item.id } },
          data: { state, decidedAt: new Date(), parentBefore: item.parentBefore, suggestedPath: final.kind === "review" ? final.path : [] },
        });
        const updated = await tx.externalImportRun.update({ where: { orgId_id: { orgId, id: run.id } }, data: { errorStreak: 0, lastErrorCode: null, waitUntil: null } });
        void project;
        return this.view(tx, await this.finish(tx, updated as RunRow));
      });
    const key = structureKey(principal.organization.orgId, projectId);
    return key === undefined ? body() : withStructureSlot(key, body);
  }

  // ---- a conferir ----

  private async toCheckRows(tx: TenantClient, orgId: string, projectId: string): Promise<{ ticket_id: string; number: number; title: string; suggested_path: string[] }[]> {
    // Sai da lista quem a pessoa marcou como conferido e quem ela moveu depois (o pai deixou de ser o de quando foi decidido).
    return tx.$queryRaw`
      select i.ticket_id, t.number, t.title, i.suggested_path from external_categorize_items i join tickets t on t.org_id = i.org_id and t.id = i.ticket_id
       where i.org_id = ${orgId} and i.project_id = ${projectId}::uuid and i.state = 'to_check' and i.dismissed_at is null and t.parent_id is not distinct from i.parent_before
       order by t.number`;
  }

  async toCheck(tenant: TenantRunner, principal: Principal, projectId: string): Promise<{ items: ToCheckItem[] }> {
    refuseWhileActingAs(principal);
    return tenant.run(async (tx, current) => {
      const project = await this.guard(tx, current, projectId, { writable: false });
      const rows = await this.toCheckRows(tx, current.organization.orgId, projectId);
      const ids = [...new Set(rows.flatMap((row) => row.suggested_path))];
      const titles = new Map((ids.length === 0 ? [] : await tx.ticket.findMany({ where: { id: { in: ids }, projectId }, select: { id: true, title: true } })).map((row) => [row.id, row.title] as const));
      return {
        items: rows.map((row) => ({
          ticketId: row.ticket_id,
          key: `${project.key}-${row.number}`,
          title: row.title,
          suggestedPath: row.suggested_path.flatMap((id) => (titles.has(id) ? [{ id, title: titles.get(id) as string }] : [])),
        })),
      };
    });
  }

  async dismiss(tenant: TenantRunner, principal: Principal, projectId: string, ticketId: string): Promise<{ ok: true }> {
    refuseWhileActingAs(principal);
    return tenant.run(async (tx, current) => {
      await this.guard(tx, current, projectId, { writable: false });
      const done = await tx.externalCategorizeItem.updateMany({ where: { orgId: current.organization.orgId, projectId, ticketId, state: "to_check", dismissedAt: null }, data: { dismissedAt: new Date() } });
      if (done.count === 0) throw new NotFoundException("Este ticket não está na lista a conferir.");
      return { ok: true } as const;
    });
  }
}

/** O ticket e todos os descendentes dele na árvore lida. */
function descendantsOf(tickets: readonly TreeTicket[], rootId: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const ticket of tickets) if (ticket.parentId !== null) children.set(ticket.parentId, [...(children.get(ticket.parentId) ?? []), ticket.id]);
  const found = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop() as string) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}
