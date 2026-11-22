import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post, Put } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { TicketContributionsService } from "./ticket-contributions.service.js";
import { createContributionSchema, updateContributionSchema } from "./tickets.schema.js";
import type { Contribution } from "./tickets.schema.js";

/** Contribuições por área no ticket (ADR 0041). A leitura vem no detalhe (`GET tickets/:id`) e na atividade. */
@Controller()
export class TicketContributionsController {
  constructor(@Inject(TicketContributionsService) private readonly contributions: TicketContributionsService) {}

  @Post("tickets/:id/contributions")
  create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(createContributionSchema)) body: z.output<typeof createContributionSchema>,
  ): Promise<Contribution> {
    return this.contributions.add(tx, principal, id, body.areaId);
  }

  @Patch("contributions/:id")
  update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(updateContributionSchema)) body: z.output<typeof updateContributionSchema>,
  ): Promise<Contribution> {
    return this.contributions.update(tx, principal, id, body);
  }

  @Delete("contributions/:id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.contributions.remove(tx, principal, id);
  }

  @Put("contributions/:id/people/:personId")
  addPerson(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<Contribution> {
    return this.contributions.addPerson(tx, principal, id, personId);
  }

  @Delete("contributions/:id/people/:personId")
  @HttpCode(204)
  async removePerson(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Param("personId", new ZodPipe(idSchema)) personId: string,
  ): Promise<void> {
    await this.contributions.removePerson(tx, principal, id, personId);
  }
}
