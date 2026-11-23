import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import type { TenantClient } from "@treepm/db";
import { createsDependencyCycle, isFinished, ticketProgress } from "@treepm/domain";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import {
  addDependencySchema,
  createTicketSchema,
  importTicketsSchema,
  ticketSummarySchema,
  updateTicketSchema,
} from "./tickets.schema.js";
import type { ImportItem, TicketPage, TicketSummary } from "./tickets.schema.js";
import { activityQuerySchema } from "./ticket-activity.schema.js";
import type { ActivityPage } from "./ticket-activity.schema.js";
import { TicketActivityService } from "./ticket-activity.service.js";
import { AgentWorkService } from "./agent-work.service.js";
import { ifNoneMatchHits, projectEtag, touchProjectVersion } from "./project-version.js";
import { readSummaryRows } from "./ticket-reads.js";
import { TicketsService, ideaViews, toNodes, toSummary } from "./tickets.service.js";
import type { ProjectRow, TicketRow } from "./tickets.service.js";

@Controller()
export class TicketsController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(TicketActivityService) private readonly ticketActivity: TicketActivityService,
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
  ) {}

  @Get("projects/:projectId/tickets")
  async list(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TicketSummary[] | undefined> {
    // Permissão primeiro (quem não vê recebe o 404 de sempre, nunca um 304); só então a versão (ADR 0046). A versão vem da mesma
    // linha do projeto que a conferência acabou de ler, e ANTES da lista: se uma escrita confirmar no meio, a lista pode ser mais
    // nova que o ETag (o cliente pede de novo uma vez), nunca mais velha.
    const project = await this.findVisibleProject(tx, actor, projectId);
    const etag = projectEtag(project.ticketsVersion);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (ifNoneMatchHits(ifNoneMatch, etag)) {
      res.status(304);
      return undefined;
    }
    const rows = await readSummaryRows(tx, projectId); // trecho da descrição e pessoas em uma consulta por projeto
    const progress = ticketProgress(toNodes(rows));
    const ideas = ideaViews(project, rows);
    const now = this.tickets.now();
    return rows.map((row) => parseOutput(ticketSummarySchema, toSummary(project, row, progress, ideas.get(row.id) ?? null, now)));
  }

  @Post("projects/:projectId/tickets")
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(createTicketSchema)) body: z.output<typeof createTicketSchema>,
  ): Promise<TicketPage> {
    const { project, created } = await this.tickets.createChecked(tx, principal, projectId, body);
    return {
      ...created,
      contributions: [],
      canEditContributions: this.tickets.canEditContributionsOf(principal.actor, project),
      canTriageIdea: this.tickets.canTriageIdeaOf(principal.actor, project, created.idea),
      canEndAgentWork: false,
    };
  }

  @Post("projects/:projectId/tickets/import")
  async import(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(importTicketsSchema)) body: z.output<typeof importTicketsSchema>,
  ): Promise<TicketSummary[]> {
    const project = await this.findVisibleProject(tx, principal.actor, projectId);
    this.authorization.importTickets(principal.actor, projectId);
    this.requireActive(project);
    await this.tickets.lockStructure(tx, projectId); // ADR 0045: o pai e a ideia que o contém são lidos já com a trava.
    if (body.parentId) await this.tickets.requireParent(tx, projectId, body.parentId);
    // Importar dentro de uma ideia (ADR 0042): os itens fazem parte dela, ficam `todo` e não reabrem o pai concluído.
    const parentIdea = await this.tickets.ideaRootFor(tx, project, body.parentId ?? null);

    // Pré-ordem: o pai antes dos filhos, irmãos na ordem recebida. Item com filhos é só um ticket com filhos.
    const flat: { item: ImportItem; parentIndex: number | null }[] = [];
    const walk = (items: readonly ImportItem[], parentIndex: number | null): void => {
      for (const item of items) {
        const index = flat.push({ item, parentIndex }) - 1;
        if (item.children) walk(item.children, index);
      }
    };
    walk(body.items, null);
    if (parentIdea && flat.some(({ item }) => (item.status ?? "todo") !== "todo")) {
      throw new ConflictException({ code: "ticket_in_idea", message: "Dentro de uma ideia a situação fica em a fazer; aceite a ideia antes." });
    }

    // Nenhum `done` com filho direto aberto (ADR 0034): item concluído que traz filho aberto na própria lista nasce `todo`.
    const hasOpenChild = new Set<number>();
    flat.forEach(({ item, parentIndex }) => {
      if (parentIndex !== null && !isFinished(item.status ?? "todo")) hasOpenChild.add(parentIndex);
    });
    await this.tickets.lockLinkedTickets(tx, project, body.parentId ?? null, flat.map(({ item }) => item.description ?? ""));
    // Ordem das travas (ADR 0046): as linhas dos pais primeiro, a linha do projeto (reserva de números) depois. O número que a
    // reserva vai devolver entra só no texto do evento de reabertura (`causedBy`): lê-se sem trava, então numa corrida com uma
    // criação sem pai pode diferir por um número no texto do evento; o número do ticket é sempre o da reserva.
    if (body.parentId && !parentIdea && flat.some(({ item, parentIndex }) => parentIndex === null && !isFinished(item.status ?? "todo"))) {
      await this.tickets.reopenAncestors(tx, principal, project, body.parentId, `${project.key}-${await this.tickets.peekNextNumber(tx, project)}`);
    }
    const first = await this.tickets.allocateNumbers(tx, project, flat.length);
    // IDs gerados pelo banco (`app_uuid_v7()`, o mesmo padrão da coluna) em UMA consulta; com eles, pais e filhos
    // entram na mesma inserção em lote (a FK do pai é verificada no fim do comando). Total de idas ao banco
    // da importação: constante, independente da quantidade de itens.
    const generated = await tx.$queryRaw<{ id: string }[]>`select app_uuid_v7() as id from generate_series(1, ${flat.length}::int)`;
    const ids = generated.map((row) => row.id);
    const rows: TicketRow[] = flat.map(({ item, parentIndex }, index) => ({
      id: ids[index] as string,
      projectId,
      number: first + index,
      parentId: parentIndex === null ? (body.parentId ?? null) : (ids[parentIndex] ?? null),
      title: item.title,
      description: item.description ?? "",
      status: item.status === "done" && hasOpenChild.has(index) ? "todo" : (item.status ?? "todo"),
      ideaStage: null,
      assignees: [],
    }));
    await tx.ticket.createMany({
      data: flat.map((_, index) => {
        const row = rows[index] as TicketRow;
        return {
          id: row.id,
          orgId: project.orgId,
          projectId,
          number: row.number,
          parentId: row.parentId,
          title: row.title,
          description: row.description,
          status: row.status,
          createdByPersonId: principal.person.id,
        };
      }),
    });
    await this.activity.record(tx, principal, {
      kind: "ticket.imported",
      subjectType: "project",
      subjectId: projectId,
      payload: { count: flat.length, firstNumber: first, lastNumber: first + flat.length - 1 },
    });
    await this.tickets.reconcileMentions(tx, project, rows);
    await this.tickets.backfillMentionsTo(tx, project, rows);
    // Dentro de uma ideia, o progresso e o `idea` dos itens são os de quem está dentro: um nó de raiz só para o cálculo.
    const nodes = toNodes(rows);
    if (parentIdea && body.parentId) nodes.push({ id: body.parentId, parentId: null, status: "todo", ideaStage: "new" });
    const progress = ticketProgress(nodes);
    const rootIdea = parentIdea ? { root: false as const, rootId: parentIdea.id, rootKey: `${project.key}-${parentIdea.number}` } : null;
    return rows.map((row) => parseOutput(ticketSummarySchema, toSummary(project, row, progress, rootIdea, this.tickets.now())));
  }

  /** Refaz as ligações "menciona" de todo o projeto a partir das descrições (ADR 0037); usada pela ferramenta local. */
  @Post("projects/:projectId/tickets/mentions/rebuild")
  @HttpCode(200)
  async rebuildMentions(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<{ read: number; created: number; removed: number }> {
    const project = await this.findVisibleProject(tx, actor, projectId);
    this.authorization.editTicket(actor, projectId);
    this.requireActive(project);
    return this.tickets.rebuildMentions(tx, project);
  }

  @Get("tickets/:id")
  async get(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<TicketPage> {
    const { project } = await this.findVisibleTicket(tx, actor, id);
    return this.tickets.detailFor(tx, project, id, { actor });
  }

  /** Atividade do ticket (ADR 0040): mudanças e comentários, da entrada mais recente para a mais antiga; só lê. */
  @Get("tickets/:id/activity")
  async activityOf(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor, person }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Query(new ZodPipe(activityQuerySchema)) query: z.output<typeof activityQuerySchema>,
  ): Promise<ActivityPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, actor, id);
    if (query.contribution !== undefined && !(await tx.ticketContribution.findFirst({ where: { id: query.contribution, ticketId: id }, select: { id: true } }))) {
      throw new NotFoundException("Contribuição não encontrada.");
    }
    return this.ticketActivity.read(tx, project, ticket, query, { personId: person.id, actor });
  }

  @Patch("tickets/:id")
  update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateTicketSchema)) body: z.output<typeof updateTicketSchema>,
  ): Promise<TicketPage> {
    return this.tickets.updateTicket(tx, principal, id, body);
  }

  /** Encerra o marcador de trabalho pela IA (ADR 0043): quem pode editar o ticket; idempotente; devolve o detalhe. */
  @Delete("tickets/:id/agent-work")
  async endAgentWork(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<TicketPage> {
    await this.agentWork.endByPerson(tx, principal, id);
    const { project } = await this.findVisibleTicket(tx, principal.actor, id);
    return this.tickets.detailFor(tx, project, id, principal);
  }

  @Delete("tickets/:id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.removeTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.tickets.lockStructure(tx, project.id); // ADR 0045: remover muda a estrutura; os filhos são contados já com a trava.
    await touchProjectVersion(tx, project.id); // ADR 0046
    await this.findVisibleTicket(tx, principal.actor, id); // removido por outra requisição enquanto esperava: 404.
    if (await this.hasChildren(tx, id)) {
      throw new ConflictException({ code: "ticket_has_children", message: "Remova ou mova os filhos antes." });
    }
    await tx.ticket.delete({ where: { orgId_id: { orgId: project.orgId, id } } });
    await this.activity.record(tx, principal, {
      kind: "ticket.deleted",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, title: ticket.title },
    });
  }

  @Put("tickets/:id/assignees/:personId")
  async assign(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    await this.tickets.requireAssignable(tx, project, personId);
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: id, personId } };
    if (!(await tx.ticketAssignee.findUnique({ where: key }))) {
      await touchProjectVersion(tx, project.id); // ADR 0046: as pessoas aparecem no resumo.
      await tx.ticketAssignee.create({ data: { orgId: project.orgId, ticketId: id, personId } });
      await this.activity.record(tx, principal, {
        kind: "ticket.assignee_added",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, personId },
      });
    }
    return this.tickets.detailFor(tx, project, id, principal);
  }

  @Delete("tickets/:id/assignees/:personId")
  @HttpCode(204)
  async unassign(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.assignTicket(principal.actor, project.id);
    this.requireActive(project);
    const key = { orgId_ticketId_personId: { orgId: project.orgId, ticketId: id, personId } };
    if (!(await tx.ticketAssignee.findUnique({ where: key }))) {
      throw new NotFoundException("Pessoa não atribuída ao ticket.");
    }
    await touchProjectVersion(tx, project.id); // ADR 0046
    await tx.ticketAssignee.delete({ where: key });
    await this.activity.record(tx, principal, {
      kind: "ticket.assignee_removed",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, personId },
    });
  }

  /**
   * "Este ticket depende de `body.ticketId`" (ADR 0037). Idempotente: ligação que já existe responde 200 sem novo evento.
   * O ciclo é decidido por `createsDependencyCycle` sobre as dependências do projeto, lidas depois de travar o projeto
   * (trava de aviso `pg_advisory_xact_lock`, só entre quem altera dependências): duas requisições simultâneas não
   * enxergam o mesmo estado antigo, então não fecham um ciclo juntas. Nada além da ligação e do evento é alterado.
   */
  @Post("tickets/:id/dependencies")
  @HttpCode(200)
  async addDependency(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(addDependencySchema)) body: z.output<typeof addDependencySchema>,
  ): Promise<TicketPage> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    const other = await this.requireSameProjectTicket(tx, project.id, body.ticketId);
    if (other.id === id) {
      throw new ConflictException({ code: "dependency_self", message: "Um ticket não pode depender de si mesmo." });
    }
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`ticket-dependencies:${project.id}`}, 0))`;
    const edges = await tx.ticketRelation.findMany({ where: { projectId: project.id, kind: "depends_on" }, select: { fromTicketId: true, toTicketId: true } });
    if (!edges.some((edge) => edge.fromTicketId === id && edge.toTicketId === other.id)) {
      if (createsDependencyCycle(edges.map((edge) => [edge.fromTicketId, edge.toTicketId] as const), id, other.id)) {
        throw new ConflictException({ code: "dependency_cycle", message: "Isso fecharia um ciclo de dependências.", details: { key: `${project.key}-${other.number}` } });
      }
      await touchProjectVersion(tx, project.id); // ADR 0046 (rev. 3): `blocked` do dependente muda; decidido depois da trava e da leitura das ligações.
      await tx.ticketRelation.create({ data: { orgId: project.orgId, projectId: project.id, fromTicketId: id, toTicketId: other.id, kind: "depends_on" } });
      await this.activity.record(tx, principal, {
        kind: "ticket.dependency_added",
        subjectType: "ticket",
        subjectId: id,
        payload: { key: `${project.key}-${ticket.number}`, dependsOnKey: `${project.key}-${other.number}`, dependsOnTicketId: other.id },
      });
    }
    return this.tickets.detailFor(tx, project, id, principal);
  }

  @Delete("tickets/:id/dependencies/:ticketId")
  @HttpCode(204)
  async removeDependency(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("ticketId", new ZodPipe(idSchema)) otherId: string,
  ): Promise<void> {
    const { project, ticket } = await this.findVisibleTicket(tx, principal.actor, id);
    this.authorization.editTicket(principal.actor, project.id);
    this.requireActive(project);
    const other = await this.requireSameProjectTicket(tx, project.id, otherId);
    const removed = await tx.ticketRelation.deleteMany({ where: { fromTicketId: id, toTicketId: other.id, kind: "depends_on" } });
    if (removed.count === 0) throw new NotFoundException("Dependência não encontrada.");
    await touchProjectVersion(tx, project.id); // ADR 0046 (rev. 3): marca porque a linha foi de fato apagada (`removed.count > 0`).
    await this.activity.record(tx, principal, {
      kind: "ticket.dependency_removed",
      subjectType: "ticket",
      subjectId: id,
      payload: { key: `${project.key}-${ticket.number}`, dependsOnKey: `${project.key}-${other.number}`, dependsOnTicketId: other.id },
    });
  }

  /** Inexistente, de outra organização (RLS) ou de outro projeto: o mesmo 404 de "ticket não encontrado". */
  private async requireSameProjectTicket(tx: TenantClient, projectId: string, ticketId: string): Promise<{ id: string; number: number }> {
    const other = await tx.ticket.findFirst({ where: { id: ticketId, projectId }, select: { id: true, number: true } });
    if (!other) throw new NotFoundException("Ticket não encontrado.");
    return other;
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async findVisibleProject(tx: TenantClient, actor: Principal["actor"], projectId: string): Promise<ProjectRow & { ticketsVersion: bigint }> {
    const project = await tx.project.findFirst({ where: { id: projectId } });
    if (!project || !this.authorization.canView(actor, project)) {
      throw new NotFoundException("Projeto não encontrado.");
    }
    return project;
  }

  private async findVisibleTicket(tx: TenantClient, actor: Principal["actor"], id: string) {
    const ticket = await tx.ticket.findFirst({ where: { id } });
    if (!ticket) throw new NotFoundException("Ticket não encontrado.");
    const project = await tx.project.findFirst({ where: { id: ticket.projectId } });
    if (!project || !this.authorization.canView(actor, project)) {
      throw new NotFoundException("Ticket não encontrado.");
    }
    return { project, ticket };
  }

  private requireActive(project: ProjectRow): void {
    if (project.archivedAt) {
      throw new ConflictException({ code: "project_archived", message: "Projeto arquivado é somente leitura." });
    }
  }



  private async hasChildren(tx: TenantClient, id: string): Promise<boolean> {
    return (await this.childCount(tx, id)) > 0;
  }

  private childCount(tx: TenantClient, id: string): Promise<number> {
    return tx.ticket.count({ where: { parentId: id } });
  }
}
