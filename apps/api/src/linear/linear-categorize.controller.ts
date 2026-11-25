import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { LinearCategorizeService } from "./linear-categorize.service.js";
import type { CategorizeOverview, CategorizeView, ToCheckItem } from "./linear-categorize.schema.js";
import { LinearEnabledGuard } from "./linear-enabled.guard.js";

/**
 * Procurar o lugar das raízes de uma importação concluída (ADR 0060, seção 6). O passo vai à IA fora de transação, então as rotas abrem as
 * próprias transações, como as da importação.
 */
@Controller("projects/:projectId/linear/categorize")
@UseGuards(LinearEnabledGuard)
export class LinearCategorizeController {
  constructor(@Inject(LinearCategorizeService) private readonly service: LinearCategorizeService) {}

  @Get()
  @OwnTransactions()
  overview(@Tenant() tenant: TenantRunner, @CurrentPrincipal() principal: Principal, @Param("projectId", new ZodPipe(idSchema)) projectId: string): Promise<CategorizeOverview> {
    return this.service.overview(tenant, principal, projectId);
  }

  @Post()
  @OwnTransactions()
  open(@Tenant() tenant: TenantRunner, @CurrentPrincipal() principal: Principal, @Param("projectId", new ZodPipe(idSchema)) projectId: string): Promise<CategorizeView> {
    return this.service.open(tenant, principal, projectId);
  }

  @Get("to-check")
  @OwnTransactions()
  toCheck(@Tenant() tenant: TenantRunner, @CurrentPrincipal() principal: Principal, @Param("projectId", new ZodPipe(idSchema)) projectId: string): Promise<{ items: ToCheckItem[] }> {
    return this.service.toCheck(tenant, principal, projectId);
  }

  @Post("to-check/:ticketId/dismiss")
  @HttpCode(200)
  @OwnTransactions()
  dismiss(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("ticketId", new ZodPipe(idSchema)) ticketId: string,
  ): Promise<{ ok: true }> {
    return this.service.dismiss(tenant, principal, projectId, ticketId);
  }

  @Post(":runId/step")
  @HttpCode(200)
  @OwnTransactions()
  step(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("runId", new ZodPipe(idSchema)) runId: string,
  ): Promise<CategorizeView> {
    return this.service.step(tenant, principal, projectId, runId);
  }

  @Post(":runId/abandon")
  @HttpCode(200)
  @OwnTransactions()
  abandon(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("runId", new ZodPipe(idSchema)) runId: string,
  ): Promise<CategorizeView> {
    return this.service.abandon(tenant, principal, projectId, runId);
  }
}
