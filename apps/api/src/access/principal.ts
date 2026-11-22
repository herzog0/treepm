import { createParamDecorator, SetMetadata } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { Actor } from "@treepm/domain";
import type { AuthenticatedSession } from "../auth/auth.guard.js";
import type { OrganizationRecord, PersonRecord } from "./identity.service.js";

export const PRINCIPAL_KEY = "treepm:principal";

/** Quem está agindo, já provisionado e com os papéis da transação atual. */
export type Principal = {
  session: AuthenticatedSession;
  person: PersonRecord;
  organization: OrganizationRecord;
  actor: Actor;
  /** Quando a ação vem de uma chamada MCP (ADR 0043): a origem e o id do REGISTRO do token (nunca o segredo). */
  via?: { kind: "mcp"; tokenId: string };
};

/** Entrega ao handler o `Principal` montado pelo interceptor do tenant. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, context: ExecutionContext): Principal => {
  const request = context.switchToHttp().getRequest<Record<string, unknown>>();
  const principal = request[PRINCIPAL_KEY] as Principal | undefined;
  if (!principal) throw new Error("Rota sem principal (rota pública?).");
  return principal;
});

export const REFRESH_IDENTITY = "treepm:refresh-identity";

/** A rota sempre relê o diretório (Clerk) para atualizar nome, e-mail e organização. */
export const RefreshIdentity = (): MethodDecorator => SetMetadata(REFRESH_IDENTITY, true);
