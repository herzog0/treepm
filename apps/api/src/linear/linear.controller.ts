import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, UseGuards } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { z } from "zod";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { OwnTransactions, Tenant } from "../db/own-transactions.js";
import type { TenantRunner } from "../db/own-transactions.js";
import { Tx } from "../db/tx.decorator.js";
import { LinearEnabledGuard } from "./linear-enabled.guard.js";
import { connectBodySchema, linkBodySchema } from "./linear.schema.js";
import type { ConnectionOutput, ProjectLinearOutput, TeamOutput } from "./linear.schema.js";
import { LinearService } from "./linear.service.js";

/** A chave do Linear da própria pessoa (ADR 0060). Nenhuma resposta devolve a chave nem o texto cifrado. */
@Controller("linear")
export class LinearController {
  constructor(@Inject(LinearService) private readonly service: LinearService) {}

  /** Sem a variável de cifra responde `configured: false` (200), para a web esconder a seção; é a única rota que não dá 503. */
  @Get("connection")
  connection(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<ConnectionOutput> {
    return this.service.getConnection(tx, principal);
  }

  @Put("connection")
  @UseGuards(LinearEnabledGuard)
  @OwnTransactions()
  connect(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(connectBodySchema)) body: z.output<typeof connectBodySchema>,
  ): Promise<ConnectionOutput> {
    return this.service.connect(tenant, principal, body.apiKey);
  }

  @Delete("connection")
  @HttpCode(204)
  // Sem `LinearEnabledGuard`: a pessoa sempre consegue remover a própria chave guardada, mesmo sem `CREDENTIALS_ENCRYPTION_KEY`.
  async disconnect(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<void> {
    await this.service.disconnect(tx, principal);
  }

  @Get("teams")
  @UseGuards(LinearEnabledGuard)
  @OwnTransactions()
  teams(@Tenant() tenant: TenantRunner, @CurrentPrincipal() principal: Principal): Promise<TeamOutput[]> {
    return this.service.listTeams(tenant, principal);
  }
}

/**
 * O vínculo permanente do projeto com um time do Linear. Só leitura e criação: não existe rota que altere ou remova o vínculo
 * (o banco também não permite ao papel da aplicação).
 */
@Controller("projects/:projectId/linear")
@UseGuards(LinearEnabledGuard)
export class ProjectLinearController {
  constructor(@Inject(LinearService) private readonly service: LinearService) {}

  @Get()
  @OwnTransactions()
  read(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
  ): Promise<ProjectLinearOutput> {
    return this.service.projectLinear(tenant, principal, projectId);
  }

  @Post()
  @OwnTransactions()
  link(
    @Tenant() tenant: TenantRunner,
    @CurrentPrincipal() principal: Principal,
    @Param("projectId", new ZodPipe(idSchema)) projectId: string,
    @Body(new ZodPipe(linkBodySchema)) body: z.output<typeof linkBodySchema>,
  ): Promise<ProjectLinearOutput> {
    return this.service.link(tenant, principal, projectId, body);
  }
}
