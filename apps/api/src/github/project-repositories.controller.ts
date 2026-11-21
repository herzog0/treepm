import { Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { AuthorizationService } from "../access/authorization.service.js";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { GithubEnabledGuard } from "./github-enabled.guard.js";
import { GithubService } from "./github.service.js";
import { linkBodySchema } from "./github.schema.js";

@Controller("projects/:projectId/repositories")
@UseGuards(GithubEnabledGuard)
export class ProjectRepositoriesController {
  constructor(
    @Inject(GithubService) private readonly service: GithubService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  /** Inexistente, de outra organização (RLS) ou privado sem papel: todos viram o mesmo 404, como nas rotas de projeto. */
  private async findVisible(tx: TenantClient, principal: Principal, id: string) {
    const project = await tx.project.findFirst({ where: { orgId: principal.organization.orgId, id } });
    if (!project || !this.authorization.canView(principal.actor, project)) throw new NotFoundException("Projeto não encontrado.");
    return project;
  }

  @Get()
  async list(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal, @Param("projectId", new ZodPipe(idSchema)) projectId: string) {
    await this.findVisible(tx, principal, projectId);
    return this.service.linkedRepositories(tx, principal.organization.orgId, projectId);
  }

  /** Confere a pertença na lista do GitHub (rede): abre transações curtas só ao redor das leituras e da gravação. */
  @Post()
  @OwnTransactions()
  link(
    @Tenant() tenant: TenantRunner,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(linkBodySchema)) body: z.output<typeof linkBodySchema>,
  ) {
    return this.service.linkRepository(tenant, projectId, body.repoId, (tx, principal) => this.findVisible(tx, principal, projectId));
  }

  @Delete(":repositoryId")
  @HttpCode(204)
  async unlink(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Param("repositoryId", new ZodPipe(idSchema)) repositoryId: string,
  ): Promise<void> {
    const project = await this.findVisible(tx, principal, projectId);
    await this.service.unlinkRepository(tx, principal, project, projectId, repositoryId);
  }
}
