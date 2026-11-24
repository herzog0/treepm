import { describe, expect, it } from "vitest";
import type { TenantClient } from "@treepm/db";
import { recordPlacedBy } from "../src/assistant/placement-decision.js";

/** O Prisma 7 devolve `P2010` para qualquer falha de SQL cru; o código do PostgreSQL vem em `meta.driverAdapterError.cause.originalCode`. */
const rawError = (originalCode: string) => Object.assign(new Error("raw"), { code: "P2010", meta: { driverAdapterError: { cause: { originalCode } } } });
/** Um cliente de mentira: os pontos de salvamento passam, e o SQL do `placed_by` falha com o erro dado. */
const fakeTx = (outcome: { error: Error }) => {
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray) => {
      if (/savepoint/.test(strings.join("?"))) return 0;
      throw outcome.error;
    },
  } as unknown as TenantClient;
  return { tx };
};

describe("placed_by sem a coluna (migration 0032 ainda não aplicada)", () => {
  it("a criação funciona: gravar com a coluna ausente (42703) não é erro", async () => {
    const { tx } = fakeTx({ error: rawError("42703") });
    expect(await recordPlacedBy(tx, { conversationId: "c", placedBy: "search" })).toBeNull();
  });

  it("outro erro de banco não é engolido: a gravação devolve o código para o aviso", async () => {
    expect(await recordPlacedBy(fakeTx({ error: rawError("42501") }).tx, { conversationId: "c", placedBy: "map" })).toBe("P2010");
  });
});
