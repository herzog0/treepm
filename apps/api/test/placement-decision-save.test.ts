import { describe, expect, it } from "vitest";
import type { TenantClient } from "@treepm/db";
import { saveDecision, type PlacementDecisionRecord } from "../src/assistant/placement-decision.js";

const record = { chosenPath: [], alternatives: [], uncertain: false, stopReason: "leaf", scope: null, levels: [], related: [], duplicateTicketId: null, rule: null, triage: null, doubt: null } as unknown as PlacementDecisionRecord;
const input = { orgId: "o", projectId: "00000000-0000-0000-0000-000000000001", conversationId: "00000000-0000-0000-0000-000000000002", record };
const missingColumn = Object.assign(new Error("coluna"), { code: "P2022" });

/** Um cliente de mentira: o `create` completo falha com `createError` (ou passa) e os INSERTs em SQL cru contam as colunas que levam. */
const fakeTx = (createError: Error | null) => {
  const inserts: string[] = [];
  const tx = {
    placementDecision: { deleteMany: async () => ({ count: 0 }), create: async () => { if (createError) throw createError; return { id: "x" }; } },
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (!/savepoint/.test(sql)) inserts.push(sql);
      return 0;
    },
  } as unknown as TenantClient;
  return { tx, inserts };
};

describe("saveDecision diz se gravou a dúvida", () => {
  it("com todas as colunas grava inteira e devolve true", async () => {
    const { tx, inserts } = fakeTx(null);
    expect(await saveDecision(tx, input)).toBe(true);
    expect(inserts).toHaveLength(0);
  });

  it("sem a coluna `triage` (recuo para o SQL antigo) a dúvida não é gravada: devolve false", async () => {
    const { tx, inserts } = fakeTx(missingColumn);
    expect(await saveDecision(tx, input)).toBe(false);
    expect(inserts).toHaveLength(1);
  });
});
