import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { orConflict } from "../common/conflict.js";
import { idOutput, idSchema, nameBodySchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";

const areasSchema = z.array(idOutput);
type AreaOutput = z.output<typeof idOutput>;

const TAKEN = ["area_name_taken", "Já existe uma área com esse nome."] as const;

@Controller("areas")
export class AreasController {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<z.output<typeof areasSchema>> {
    this.authorization.viewDirectory(principal.actor);
    return parseOutput(areasSchema, await tx.area.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }] }));
  }

  @Post()
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(nameBodySchema)) body: z.output<typeof nameBodySchema>,
  ): Promise<AreaOutput> {
    this.authorization.manageAreas(principal.actor);
    const area = await orConflict(...TAKEN, () =>
      tx.area.create({ data: { orgId: principal.organization.orgId, name: body.name } }),
    );
    await this.activity.record(tx, principal, {
      kind: "area.created",
      subjectType: "area",
      subjectId: area.id,
      payload: { name: area.name },
    });
    return parseOutput(idOutput, area);
  }

  @Patch(":id")
  async rename(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(nameBodySchema)) body: z.output<typeof nameBodySchema>,
  ): Promise<AreaOutput> {
    const current = await this.find(tx, id);
    this.authorization.manageAreas(principal.actor);
    const area = await orConflict(...TAKEN, () =>
      tx.area.update({ where: { orgId_id: { orgId: current.orgId, id } }, data: { name: body.name } }),
    );
    await this.activity.record(tx, principal, {
      kind: "area.renamed",
      subjectType: "area",
      subjectId: id,
      payload: { from: current.name, to: area.name },
    });
    return parseOutput(idOutput, area);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    const current = await this.find(tx, id);
    this.authorization.manageAreas(principal.actor);
    // Uma área nunca leva texto embora ao ser apagada (ADR 0041): com contribuição, é recusada com a contagem de tickets.
    const tickets = await tx.ticketContribution.count({ where: { areaId: id } });
    if (tickets > 0) {
      throw new ConflictException({
        code: "area_in_use",
        message: tickets === 1 ? "Um ticket usa esta área. Remova a contribuição dela antes de apagá-la." : `${tickets} tickets usam esta área. Remova a contribuição dela neles antes de apagá-la.`,
        details: { ticketCount: tickets },
      });
    }
    await tx.area.delete({ where: { orgId_id: { orgId: current.orgId, id } } });
    await this.activity.record(tx, principal, {
      kind: "area.deleted",
      subjectType: "area",
      subjectId: id,
      payload: { name: current.name },
    });
  }

  private async find(tx: TenantClient, id: string) {
    const area = await tx.area.findFirst({ where: { id } });
    if (!area) throw new NotFoundException("Área não encontrada.");
    return area;
  }
}
