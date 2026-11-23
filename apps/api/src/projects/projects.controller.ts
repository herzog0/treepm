import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { orConflict } from "../common/conflict.js";
import { PROJECT_KEY_PATTERN, idSchema, nameSchema, projectRoleSchema, visibilitySchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { AgentWorkService } from "../tickets/agent-work.service.js";

const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  visibility: visibilitySchema,
  archivedAt: z.string().nullable(),
  members: z.array(z.object({ personId: z.string(), role: projectRoleSchema })),
  teamIds: z.array(z.string()),
});
const memberOutput = z.object({ personId: z.string(), role: projectRoleSchema });
const teamOutput = z.object({ projectId: z.string(), teamId: z.string() });

const createSchema = z
  .object({
    name: nameSchema,
    key: z.string().regex(PROJECT_KEY_PATTERN, "2 a 10 caracteres: A-Z e 0-9, começando por letra"),
    visibility: visibilitySchema.default("organization"),
  })
  .strict();
const patchSchema = z
  .object({ name: nameSchema, visibility: visibilitySchema, archived: z.boolean() })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");
const memberBodySchema = z.object({ role: projectRoleSchema }).strict();

type ProjectOutput = z.output<typeof projectSchema>;
type ProjectRow = {
  id: string;
  name: string;
  key: string;
  visibility: "organization" | "private";
  archivedAt: Date | null;
  memberships: { personId: string; role: "manager" | "contributor" | "reader" }[];
  teams: { teamId: string }[];
};

const withRelations = { memberships: true, teams: true } as const;

function toOutput(project: ProjectRow): ProjectOutput {
  return parseOutput(projectSchema, {
    id: project.id,
    name: project.name,
    key: project.key,
    visibility: project.visibility,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    members: project.memberships
      .map(({ personId, role }) => ({ personId, role }))
      .sort((a, b) => a.personId.localeCompare(b.personId)),
    teamIds: project.teams.map((row) => row.teamId).sort(),
  });
}

@Controller("projects")
export class ProjectsController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
    @Inject(AgentWorkService) private readonly agentWork: AgentWorkService,
  ) {}

  /** A visibilidade é aplicada ANTES de montar qualquer dado ou contagem do projeto. */
  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() { actor }: Principal): Promise<ProjectOutput[]> {
    this.authorization.viewDirectory(actor);
    const projects = await tx.project.findMany({ include: withRelations, orderBy: [{ key: "asc" }, { id: "asc" }] });
    return this.authorization.visible(actor, projects).map(toOutput);
  }

  @Post()
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(createSchema)) body: z.output<typeof createSchema>,
  ): Promise<ProjectOutput> {
    this.authorization.createProject(principal.actor);
    const project = await orConflict("project_key_taken", "Já existe um projeto com essa chave.", () =>
      tx.project.create({
        data: { orgId: principal.organization.orgId, name: body.name, key: body.key, visibility: body.visibility },
        include: withRelations,
      }),
    );
    await this.activity.record(tx, principal, {
      kind: "project.created",
      subjectType: "project",
      subjectId: project.id,
      payload: { name: project.name, key: project.key, visibility: project.visibility },
    });
    return toOutput(project);
  }

  @Get(":id")
  async get(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() { actor }: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<ProjectOutput> {
    return toOutput(await this.findVisible(tx, actor, id));
  }

  @Patch(":id")
  async update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(patchSchema)) body: z.output<typeof patchSchema>,
  ): Promise<ProjectOutput> {
    const current = await this.findVisible(tx, principal.actor, id);
    this.authorization.manageProject(principal.actor, id);
    const archivedAt =
      body.archived === undefined ? undefined : body.archived ? (current.archivedAt ?? new Date()) : null;
    // Ordem das travas (ADR 0046): os tickets (marcadores) antes da linha do projeto, que é sempre a última.
    if (archivedAt && !current.archivedAt) await this.agentWork.endForArchivedProject(tx, principal, id);
    const project = await tx.project.update({
      where: { orgId_id: { orgId: current.orgId, id } },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
        ...(archivedAt !== undefined ? { archivedAt } : {}),
      },
      include: withRelations,
    });
    await this.activity.record(tx, principal, {
      kind: "project.updated",
      subjectType: "project",
      subjectId: id,
      payload: body,
    });
    return toOutput(project);
  }

  @Put(":id/members/:personId")
  async putMember(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
    @Body(new ZodPipe(memberBodySchema)) body: z.output<typeof memberBodySchema>,
  ): Promise<z.output<typeof memberOutput>> {
    const project = await this.findVisible(tx, principal.actor, id);
    this.authorization.grantProjectRole(principal.actor, id);
    const person = await tx.person.findFirst({ where: { id: personId } });
    if (!person) throw new NotFoundException("Pessoa não encontrada.");
    if (!person.active) {
      throw new ConflictException({ code: "person_inactive", message: "A pessoa não está mais na organização." });
    }
    const key = { orgId_projectId_personId: { orgId: project.orgId, projectId: id, personId } };
    const existing = await tx.projectMembership.findUnique({ where: key });
    await tx.projectMembership.upsert({
      where: key,
      create: { orgId: project.orgId, projectId: id, personId, role: body.role },
      update: { role: body.role },
    });
    await this.activity.record(tx, principal, {
      kind: existing ? "project.member_role_changed" : "project.member_granted",
      subjectType: "project",
      subjectId: id,
      payload: existing ? { personId, from: existing.role, to: body.role } : { personId, role: body.role },
    });
    return parseOutput(memberOutput, { personId, role: body.role });
  }

  @Delete(":id/members/:personId")
  @HttpCode(204)
  async removeMember(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<void> {
    const project = await this.findVisible(tx, principal.actor, id);
    this.authorization.grantProjectRole(principal.actor, id);
    const key = { orgId_projectId_personId: { orgId: project.orgId, projectId: id, personId } };
    const existing = await tx.projectMembership.findUnique({ where: key });
    if (!existing) throw new NotFoundException("Papel não encontrado no projeto.");
    await tx.projectMembership.delete({ where: key });
    await this.activity.record(tx, principal, {
      kind: "project.member_revoked",
      subjectType: "project",
      subjectId: id,
      payload: { personId, role: existing.role },
    });
  }

  @Put(":id/teams/:teamId")
  async putTeam(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("teamId", new ZodPipe(idSchema)) teamId: string,
  ): Promise<z.output<typeof teamOutput>> {
    const project = await this.findVisible(tx, principal.actor, id);
    this.authorization.attachTeamToProject(principal.actor, id);
    // O RLS esconde times de outra organização: o ID de B chega aqui como inexistente.
    const team = await tx.team.findFirst({ where: { id: teamId } });
    if (!team) throw new NotFoundException("Time não encontrado.");
    const key = { orgId_projectId_teamId: { orgId: project.orgId, projectId: id, teamId } };
    const existing = await tx.projectTeam.findUnique({ where: key });
    if (!existing) await tx.projectTeam.create({ data: { orgId: project.orgId, projectId: id, teamId } });
    await this.activity.record(tx, principal, {
      kind: "project.team_attached",
      subjectType: "project",
      subjectId: id,
      payload: { teamId, alreadyAttached: Boolean(existing) },
    });
    return parseOutput(teamOutput, { projectId: id, teamId });
  }

  @Delete(":id/teams/:teamId")
  @HttpCode(204)
  async removeTeam(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("teamId", new ZodPipe(idSchema)) teamId: string,
  ): Promise<void> {
    const project = await this.findVisible(tx, principal.actor, id);
    this.authorization.attachTeamToProject(principal.actor, id);
    const key = { orgId_projectId_teamId: { orgId: project.orgId, projectId: id, teamId } };
    if (!(await tx.projectTeam.findUnique({ where: key }))) {
      throw new NotFoundException("Time não associado ao projeto.");
    }
    await tx.projectTeam.delete({ where: key });
    await this.activity.record(tx, principal, {
      kind: "project.team_detached",
      subjectType: "project",
      subjectId: id,
      payload: { teamId },
    });
  }

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404. */
  private async findVisible(tx: TenantClient, actor: Principal["actor"], id: string) {
    const project = await tx.project.findFirst({ where: { id }, include: withRelations });
    if (!project || !this.authorization.canView(actor, project)) {
      throw new NotFoundException("Projeto não encontrado.");
    }
    return project;
  }
}
