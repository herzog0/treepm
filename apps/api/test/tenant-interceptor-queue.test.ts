import { Reflector } from "@nestjs/core";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { SESSION_KEY } from "../src/auth/auth.guard.js";
import { OwnTransactions } from "../src/db/own-transactions.js";
import { TenantInterceptor } from "../src/db/tenant.interceptor.js";
import { QueuesStructure } from "../src/tickets/structure-queue.js";

/**
 * `@QueuesStructure` numa rota `@OwnTransactions` não faz sentido (a rota abre as próprias transações e o interceptor não abriria a
 * fila): seria ignorado em silêncio. É defeito de programação, e o interceptor recusa a combinação em vez de ignorá-la.
 */
class Routes {
  @OwnTransactions()
  @QueuesStructure({ by: "project" })
  both(): void {}
}

const interceptor = () => new TenantInterceptor({} as never, new Reflector(), {} as never, {} as never, {} as never);
const contextFor = (handler: () => void): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({ [SESSION_KEY]: { orgId: "o", userId: "u" }, params: {}, body: {} }),
      getResponse: () => ({ once: () => undefined, destroyed: false }),
    }),
  }) as unknown as ExecutionContext;
const next: CallHandler = { handle: () => { throw new Error("não devia chegar ao handler"); } } as never;

describe("@QueuesStructure com @OwnTransactions", () => {
  it("é recusado com erro de programação, não ignorado", () => {
    const proto = Routes.prototype;
    expect(() => interceptor().intercept(contextFor(proto.both), next)).toThrow(/QueuesStructure.*OwnTransactions/);
  });
});
