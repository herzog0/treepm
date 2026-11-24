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
  /**
   * De onde vem a ação, quando não é a pessoa agindo por si: uma chamada MCP (ADR 0043; o id do REGISTRO do token, nunca o segredo) ou o
   * "entrar como" de um administrador numa pessoa de teste (ADR 0057; a pessoa de verdade). Nesse caso `person` é a de teste.
   */
  via?: { kind: "mcp"; tokenId: string } | { kind: "act-as"; realPersonId: string; realDisplayName: string };
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
