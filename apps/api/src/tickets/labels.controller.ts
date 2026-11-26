import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe, parseOutput } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { changeTicketLabelsSchema, createLabelSchema, deleteLabelOutputSchema, projectLabelSchema, ticketLabelsOutputSchema, updateLabelSchema } from "./labels.schema.js";
import type { ProjectLabelView } from "./labels.schema.js";
import { LabelsService } from "./labels.service.js";

/** Etiquetas por projeto (ADR 0065): a lista do projeto (configurações) e o pôr/tirar no ticket. As regras moram em `LabelsService`. */
@Controller()
export class LabelsController {
  constructor(@Inject(LabelsService) private readonly labels: LabelsService) {}

  @Get("projects/:projectId/labels")
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() { actor }: Principal, @Param("projectId", new ZodPipe(idSchema)) projectId: string): Promise<ProjectLabelView[]> {
    return (await this.labels.list(tx, actor, projectId)).map((label) => parseOutput(projectLabelSchema, label));
  }

  @Post("projects/:projectId/labels")
  async create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(createLabelSchema)) body: z.output<typeof createLabelSchema>,
  ): Promise<ProjectLabelView> {
    return parseOutput(projectLabelSchema, await this.labels.create(tx, principal, projectId, body));
  }

  @Patch("projects/:projectId/labels/:labelId")
  async update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("labelId", new ZodPipe(idSchema)) labelId: string,
    @Body(new ZodPipe(updateLabelSchema)) body: z.output<typeof updateLabelSchema>,
  ): Promise<ProjectLabelView> {
    return parseOutput(projectLabelSchema, await this.labels.update(tx, principal, projectId, labelId, body));
  }

  /** Apagar responde 200 com `{ ticketsAffected }` (quantos tickets perderam a etiqueta), não 204. */
  @Delete("projects/:projectId/labels/:labelId")
  async remove(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("labelId", new ZodPipe(idSchema)) labelId: string,
  ): Promise<z.output<typeof deleteLabelOutputSchema>> {
    return parseOutput(deleteLabelOutputSchema, await this.labels.remove(tx, principal, projectId, labelId));
  }

  /** Pôr e tirar etiquetas do ticket num pedido só; devolve as etiquetas do ticket depois da mudança. */
  @Post("tickets/:id/labels")
  @HttpCode(200)
  async change(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
    @Body(new ZodPipe(changeTicketLabelsSchema)) body: z.output<typeof changeTicketLabelsSchema>,
  ): Promise<z.output<typeof ticketLabelsOutputSchema>> {
    const { labels } = await this.labels.changeTicketLabels(tx, principal, id, body);
    return parseOutput(ticketLabelsOutputSchema, { labels });
  }
}
