import { Body, Controller, Get, HttpCode, Inject, Param, Post, Put } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { IdeasService } from "./ideas.service.js";
import { ideaStageBodySchema } from "./tickets.schema.js";
import type { IdeaListItem, TicketPage } from "./tickets.schema.js";

/** Rotas das ideias (ADR 0042). Registrar é `POST projects/:projectId/tickets` com `idea: true`; todas devolvem o detalhe do ticket. */
@Controller()
export class IdeasController {
  constructor(@Inject(IdeasService) private readonly ideas: IdeasService) {}

  @Get("projects/:projectId/ideas")
  list(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<IdeaListItem[]> {
    return this.ideas.list(tx, principal, projectId);
  }

  @Put("tickets/:id/idea-stage")
  changeStage(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(ideaStageBodySchema)) body: z.output<typeof ideaStageBodySchema>,
  ): Promise<TicketPage> {
    return this.ideas.changeStage(tx, principal, id, body.stage);
  }

  @Post("tickets/:id/idea/accept")
  @HttpCode(200)
  accept(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<TicketPage> {
    return this.ideas.accept(tx, principal, id);
  }

  @Post("tickets/:id/idea/discard")
  @HttpCode(200)
  discard(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<TicketPage> {
    return this.ideas.discard(tx, principal, id);
  }

  @Post("tickets/:id/idea")
  @HttpCode(200)
  transform(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string): Promise<TicketPage> {
    return this.ideas.transform(tx, principal, id);
  }
}
