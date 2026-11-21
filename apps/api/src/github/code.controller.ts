import { Controller, Get, HttpCode, Inject, Param, Post, UseGuards } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { CodeService } from "./code.service.js";
import { GithubEnabledGuard } from "./github-enabled.guard.js";

/** Vínculos de código dos tickets (ADR 0032, passo 2): sincronização sob demanda e leitura do que já foi sincronizado. */
@Controller()
@UseGuards(GithubEnabledGuard)
export class CodeController {
  constructor(@Inject(CodeService) private readonly service: CodeService) {}

  /** Chama o GitHub: abre transações curtas só ao redor das leituras e das gravações de cada repositório. */
  @Post("projects/:projectId/code/refresh")
  @HttpCode(200)
  @OwnTransactions()
  refresh(@Tenant() tenant: TenantRunner, @Param("projectId", new ZodPipe(idSchema)) projectId: string) {
    return this.service.refresh(tenant, projectId);
  }

  /** Só lê o que está no banco; nunca chama o GitHub. */
  @Get("tickets/:id/code")
  read(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("id", new ZodPipe(idSchema)) id: string) {
    return this.service.read(tx, principal, id);
  }
}
