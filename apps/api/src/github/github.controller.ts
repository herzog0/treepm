import { Body, Controller, Delete, Get, HttpCode, Inject, Post, UseGuards } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { GithubEnabledGuard } from "./github-enabled.guard.js";
import { GithubService } from "./github.service.js";
import { completeBodySchema } from "./github.schema.js";
import type { CompleteBody } from "./github.schema.js";

@Controller("github")
@UseGuards(GithubEnabledGuard)
export class GithubController {
  constructor(@Inject(GithubService) private readonly service: GithubService) {}

  @Post("connect")
  @HttpCode(200)
  connect(@CurrentPrincipal() principal: Principal): { url: string } {
    return this.service.connect(principal);
  }

  /** Chama o GitHub (troca do código, conferência da instalação): abre transações curtas só ao redor da gravação. */
  @Post("connect/complete")
  @OwnTransactions()
  complete(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(completeBodySchema)) body: CompleteBody,
  ) {
    return this.service.complete(tenant, principal, body);
  }

  @Get("installation")
  installation(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal) {
    return this.service.installation(tx, principal.organization.orgId);
  }

  @Delete("installation")
  @HttpCode(204)
  async disconnect(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.service.disconnect(tx, principal);
  }

  @Get("repositories")
  @OwnTransactions()
  repositories(@Tenant() tenant: TenantRunner, @CurrentPrincipal() principal: Principal) {
    return this.service.listInstallationRepositories(tenant, principal);
  }
}
