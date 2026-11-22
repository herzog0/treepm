import type { INestApplication } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import type { Principal } from "../src/access/principal.js";
import { AuthorizationService } from "../src/access/authorization.service.js";
import { IdentityService } from "../src/access/identity.service.js";
import { PrincipalService } from "../src/access/principal.service.js";
import { TenantTransactions } from "../src/db/tenant-transactions.js";
import { ORG } from "./world.js";
import type { Who } from "./world.js";

/** O que uma porta (HTTP, serviço ou MCP) respondeu a uma escrita: sucesso (`null`) ou a recusa com o código. */
export type Refusal = { status: number; code: string } | null;

const DEFAULT_CODES: Record<number, string> = { 400: "validation_error", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict" };

/** A recusa de uma exceção do Nest, no mesmo formato `{ status, code }` que o filtro de erros põe na resposta HTTP. */
export function refusalOf(error: unknown): Refusal {
  if (!(error instanceof HttpException)) throw error;
  const payload = error.getResponse();
  const custom = typeof payload === "object" ? (payload as { code?: unknown }) : {};
  return { status: error.getStatus(), code: typeof custom.code === "string" ? custom.code : (DEFAULT_CODES[error.getStatus()] ?? "error") };
}

/** A recusa de uma resposta HTTP do `supertest`. */
export function refusalOfResponse(res: { status: number; body: { error?: { code?: string } } }): Refusal {
  return res.status < 400 ? null : { status: res.status, code: res.body.error?.code ?? "?" };
}

/**
 * Chama um serviço direto, sem HTTP, com o `Principal` de uma pessoa do mundo semeado (o mesmo caminho da sessão e do token:
 * `PrincipalService.load`), dentro de uma transação do tenant. É a "porta do serviço" das tabelas de recusa.
 */
export async function asService<T>(
  app: INestApplication,
  who: Who | "outsider",
  orgId: string,
  fn: (tx: TenantClient, principal: Principal) => Promise<T>,
): Promise<T> {
  const tenants = app.get(TenantTransactions);
  const principals = app.get(PrincipalService);
  const identities = app.get(IdentityService);
  const userId = `u_${who}`;
  const orgRole = who === "admin" || who === "outsider" ? "org:admin" : "org:member";
  const session = { userId, orgId, orgRole, sessionStatus: "active" as const };
  const clerkRole = identities.clerkRoleOf(session);
  return tenants.run({ orgId, userId }, async (tx) => fn(tx, await principals.load(tx, session, clerkRole, null)));
}

/** Executa e devolve a recusa (ou `null`, quando deu certo). */
export async function refusalOfService(
  app: INestApplication,
  who: Who | "outsider",
  orgId: string,
  fn: (tx: TenantClient, principal: Principal) => Promise<unknown>,
): Promise<Refusal> {
  try {
    await asService(app, who, orgId, fn);
    return null;
  } catch (error) {
    return refusalOf(error);
  }
}

export { AuthorizationService, ORG };
