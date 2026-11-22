import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { CurrentPrincipal } from "../access/principal.js";
import type { Principal } from "../access/principal.js";
import { idSchema } from "../common/schemas.js";
import { ZodPipe } from "../common/zod.js";
import { Tx } from "../db/tx.decorator.js";
import { AccessTokenManager } from "./access-token-manager.js";
import { createTokenSchema, mcpSwitchSchema, mcpWriteSwitchSchema } from "./access-token.schema.js";
import type { CreateTokenBody, CreatedTokenOutput, OrganizationTokenOutput, TokenOutput } from "./access-token.schema.js";
import type { z } from "zod";

/** A chave "Permitir acesso por MCP" da organização (ADR 0038). Só administrador. */
@Controller("organization")
export class OrganizationController {
  constructor(@Inject(AccessTokenManager) private readonly manager: AccessTokenManager) {}

  @Patch()
  update(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(mcpSwitchSchema)) body: z.output<typeof mcpSwitchSchema>,
  ): Promise<{ mcp: { enabled: boolean; writeEnabled: boolean } }> {
    return this.manager.setMcpEnabled(tx, principal, body.mcpEnabled);
  }

  /** A chave "Permitir escrita por MCP" (ADR 0043). Só administrador. */
  @Patch("mcp-write")
  updateWrite(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(mcpWriteSwitchSchema)) body: z.output<typeof mcpWriteSwitchSchema>,
  ): Promise<{ mcp: { enabled: boolean; writeEnabled: boolean } }> {
    return this.manager.setMcpWriteEnabled(tx, principal, body.mcpWriteEnabled);
  }
}

@Controller("access-tokens")
export class AccessTokensController {
  constructor(@Inject(AccessTokenManager) private readonly manager: AccessTokenManager) {}

  @Post()
  create(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(createTokenSchema)) body: CreateTokenBody,
  ): Promise<CreatedTokenOutput> {
    return this.manager.create(tx, principal, body);
  }

  @Get()
  listOwn(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<TokenOutput[]> {
    return this.manager.listOwn(tx, principal);
  }

  @Get("organization")
  listOrganization(@Tx() tx: TenantClient, @CurrentPrincipal() principal: Principal): Promise<OrganizationTokenOutput[]> {
    return this.manager.listOrganization(tx, principal);
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(
    @Tx() tx: TenantClient,
    @CurrentPrincipal() principal: Principal,
    @Param("id", new ZodPipe(idSchema)) id: string,
  ): Promise<void> {
    await this.manager.revoke(tx, principal, id);
  }
}
