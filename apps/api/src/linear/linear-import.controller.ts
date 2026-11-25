import { Body, Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { LinearEnabledGuard } from "./linear-enabled.guard.js";
import { openRunBodySchema } from "./linear-import.schema.js";
import type { RunView } from "./linear-import.schema.js";
import { LinearImportService } from "./linear-import.service.js";

/**
 * A importação do Linear em passos (ADR 0060, seção 3). A tela abre a rodada e chama o passo em laço. O passo vai ao Linear fora de
 * transação, então as rotas abrem as próprias transações (`@OwnTransactions`); a fila de estrutura é tomada só em volta da gravação.
 */
@Controller("projects/:projectId/linear/runs")
@UseGuards(LinearEnabledGuard)
export class LinearImportController {
  constructor(@Inject(LinearImportService) private readonly service: LinearImportService) {}

  @Post()
  @OwnTransactions()
  open(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(openRunBodySchema)) body: z.output<typeof openRunBodySchema>,
  ): Promise<RunView> {
    return this.service.open(tenant, principal, projectId, body);
  }

  /** A rodada aberta ou, se não há, a última; `{ run: null }` quando o projeto nunca importou. */
  @Get("current")
  @OwnTransactions()
  current(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<{ run: RunView | null }> {
    return this.service.current(tenant, principal, projectId);
  }

  @Post(":runId/step")
  @HttpCode(200)
  @OwnTransactions()
  step(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("runId", new ZodPipe(idSchema)) runId: string,
  ): Promise<RunView> {
    return this.service.step(tenant, principal, projectId, runId);
  }

  /** Fecha uma rodada que não termina: fase `failed`; o que já veio fica e uma rodada nova o reconhece. */
  @Post(":runId/abandon")
  @HttpCode(200)
  @OwnTransactions()
  abandon(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("runId", new ZodPipe(idSchema)) runId: string,
  ): Promise<RunView> {
    return this.service.abandon(tenant, principal, projectId, runId);
  }
}
