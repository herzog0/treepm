import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import { SESSION_KEY } from "../auth/auth.guard.js";
import type { AuthenticatedSession } from "../auth/auth.guard.js";

/** Sessão verificada pelo guard (`userId`, `orgId`, `orgRole`). */
export const Session = createParamDecorator((_data: unknown, context: ExecutionContext): AuthenticatedSession => {
  const request = context.switchToHttp().getRequest<Record<string, unknown>>();
  return request[SESSION_KEY] as AuthenticatedSession;
});
