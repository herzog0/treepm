import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { AssistantModule } from "../assistant/assistant.module.js";
import { AccessTokensModule } from "../access-tokens/access-tokens.module.js";
import { DbModule } from "../db/db.module.js";
import { LinearModule } from "../linear/linear.module.js";
import { QueryModule } from "../query/query.module.js";
import { TicketsModule } from "../tickets/tickets.module.js";
import { McpGateway } from "./mcp-gateway.js";

/** Servidor MCP por projeto (ADR 0038, fatia 2). A entrada HTTP é montada em `bootstrap.ts`. */
@Module({
  imports: [AccessModule, AssistantModule, AccessTokensModule, DbModule, QueryModule, TicketsModule, LinearModule],
  providers: [McpGateway],
  exports: [McpGateway],
})
export class McpModule {}
