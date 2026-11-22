import { Body, Controller, Delete, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import type { CommentEntry } from "./ticket-activity.schema.js";
import { commentInputSchema } from "./ticket-comments.schema.js";
import type { CommentInput } from "./ticket-comments.schema.js";
import { TicketCommentsService } from "./ticket-comments.service.js";

/** Comentários do ticket (ADR 0040, fatia 2). A leitura vem na rota de atividade (`GET tickets/:id/activity`). */
@Controller()
export class TicketCommentsController {
  constructor(@Inject(TicketCommentsService) private readonly comments: TicketCommentsService) {}

  @Post("tickets/:id/comments")
  create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(commentInputSchema)) body: CommentInput,
  ): Promise<CommentEntry> {
    return this.comments.add(tx, principal, id, body.body);
  }

  @Patch("comments/:id")
  edit(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(commentInputSchema)) body: CommentInput,
  ): Promise<CommentEntry> {
    return this.comments.edit(tx, principal, id, body.body);
  }

  @Delete("comments/:id")
  @HttpCode(204)
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.comments.remove(tx, principal, id);
  }
}
