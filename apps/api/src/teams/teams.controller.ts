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
import { idSchema, nameBodySchema, teamRoleSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";

const memberSchema = z.object({ personId: z.string(), role: teamRoleSchema });
const teamSchema = z.object({ id: z.string(), name: z.string(), members: z.array(memberSchema) });
const memberBodySchema = z.object({ role: teamRoleSchema }).strict();

type TeamOutput = z.output<typeof teamSchema>;
type TeamRow = { id: string; name: string; memberships: { personId: string; role: "admin" | "member" }[] };

const TAKEN = ["team_name_taken", "Já existe um time com esse nome."] as const;

function toOutput(team: TeamRow): TeamOutput {
  const members = team.memberships
    .map(({ personId, role }) => ({ personId, role }))
    .sort((a, b) => a.personId.localeCompare(b.personId));
  return parseOutput(teamSchema, { id: team.id, name: team.name, members });
}

@Controller("teams")
export class TeamsController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<TeamOutput[]> {
    this.authorization.viewDirectory(principal.actor);
    const teams = await tx.team.findMany({ include: { memberships: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
    return teams.map(toOutput);
  }

  @Post()
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(nameBodySchema)) body: z.output<typeof nameBodySchema>,
  ): Promise<TeamOutput> {
    this.authorization.createTeam(principal.actor);
    const team = await orConflict(...TAKEN, () =>
      tx.team.create({
        data: { orgId: principal.organization.orgId, name: body.name },
        include: { memberships: true },
      }),
    );
    await this.activity.record(tx, principal, {
      kind: "team.created",
      subjectType: "team",
      subjectId: team.id,
      payload: { name: team.name },
    });
    return toOutput(team);
  }

  @Patch(":id")
  async rename(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(nameBodySchema)) body: z.output<typeof nameBodySchema>,
  ): Promise<TeamOutput> {
    const current = await this.find(tx, id);
    this.authorization.renameTeam(principal.actor, id);
    const team = await orConflict(...TAKEN, () =>
      tx.team.update({
        where: { orgId_id: { orgId: current.orgId, id } },
        data: { name: body.name },
        include: { memberships: true },
      }),
    );
    await this.activity.record(tx, principal, {
      kind: "team.renamed",
      subjectType: "team",
      subjectId: id,
      payload: { from: current.name, to: team.name },
    });
    return toOutput(team);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    const current = await this.find(tx, id);
    this.authorization.removeTeam(principal.actor);
    await tx.team.delete({ where: { orgId_id: { orgId: current.orgId, id } } });
    await this.activity.record(tx, principal, {
      kind: "team.deleted",
      subjectType: "team",
      subjectId: id,
      payload: { name: current.name },
    });
  }

  /** Incluir e alterar o papel de quem já é membro usam a mesma regra (`canManageTeamMembers`). */
  @Put(":id/members/:personId")
  async putMember(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
    @Body(new ZodPipe(memberBodySchema)) body: z.output<typeof memberBodySchema>,
  ): Promise<z.output<typeof memberSchema>> {
    const team = await this.find(tx, id);
    this.authorization.manageTeamMembers(principal.actor, id);
    const person = await tx.person.findFirst({ where: { id: personId } });
    if (!person) throw new NotFoundException("Pessoa não encontrada.");
    if (!person.active) {
      throw new ConflictException({ code: "person_inactive", message: "A pessoa não está mais na organização." });
    }
    const orgId = team.orgId;
    const existing = await tx.teamMembership.findUnique({
      where: { orgId_teamId_personId: { orgId, teamId: id, personId } },
    });
    await tx.teamMembership.upsert({
      where: { orgId_teamId_personId: { orgId, teamId: id, personId } },
      create: { orgId, teamId: id, personId, role: body.role },
      update: { role: body.role },
    });
    await this.activity.record(tx, principal, {
      kind: existing ? "team.member_role_changed" : "team.member_added",
      subjectType: "team",
      subjectId: id,
      payload: existing
        ? { personId, from: existing.role, to: body.role }
        : { personId, role: body.role },
    });
    return parseOutput(memberSchema, { personId, role: body.role });
  }

  @Delete(":id/members/:personId")
  @HttpCode(204)
  async removeMember(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<void> {
    const team = await this.find(tx, id);
    this.authorization.manageTeamMembers(principal.actor, id);
    const existing = await tx.teamMembership.findUnique({
      where: { orgId_teamId_personId: { orgId: team.orgId, teamId: id, personId } },
    });
    if (!existing) throw new NotFoundException("Membro não encontrado no time.");
    await tx.teamMembership.delete({
      where: { orgId_teamId_personId: { orgId: team.orgId, teamId: id, personId } },
    });
    await this.activity.record(tx, principal, {
      kind: "team.member_removed",
      subjectType: "team",
      subjectId: id,
      payload: { personId, role: existing.role },
    });
  }

  private async find(tx: TenantClient, id: string) {
    const team = await tx.team.findFirst({ where: { id } });
    if (!team) throw new NotFoundException("Time não encontrado.");
    return team;
  }
}
