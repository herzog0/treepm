import { Module } from "@nestjs/common";
import { AccessTokensModule } from "../access-tokens/access-tokens.module.js";
import { DbModule } from "../db/db.module.js";
import { QueryModule } from "../query/query.module.js";
import { McpGateway } from "./mcp-gateway.js";

/** Servidor MCP por projeto (ADR 0038, fatia 2). A entrada HTTP é montada em `bootstrap.ts`. */
@Module({
  imports: [AccessTokensModule, DbModule, QueryModule],
  providers: [McpGateway],
  exports: [McpGateway],
})
export class McpModule {}
