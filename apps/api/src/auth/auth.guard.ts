import { ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { IS_PUBLIC } from "./public.decorator.js";
import { SESSION_VERIFIER } from "./session-verifier.js";
import type { SessionVerifier, VerifiableRequest, VerifiedSession } from "./session-verifier.js";

export const SESSION_KEY = "treepm:session";

export type AuthenticatedSession = VerifiedSession & { orgId: string };

export type RequestWithSession = VerifiableRequest & { [SESSION_KEY]?: AuthenticatedSession };

/**
 * Guard global (ADR 0022): sem sessão → 401; sessão pendente ou sem organização
 * ativa → 403. `orgId` e `userId` vêm só do verificador, nunca do cliente.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithSession>();
    const session = await this.verifier.verify(request);
    if (!session) throw new UnauthorizedException("Sessão ausente ou inválida.");
    if (session.sessionStatus !== "active") throw new ForbiddenException("Sessão pendente.");
    if (!session.orgId) throw new ForbiddenException("Nenhuma organização ativa.");

    request[SESSION_KEY] = { ...session, orgId: session.orgId };
    return true;
  }
}
