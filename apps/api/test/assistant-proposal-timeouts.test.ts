import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// Prazos curtos só para este arquivo: a procura leva centenas de milissegundos com o banco.
const h = useHarness(AI_CONFIG, { timeouts: { descentMs: 600, proposalMs: 250 } });
const priv = () => h.world().projects.priv;

const start = async () => {
  const tree = await seedTree(h.pool, h.world());
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Corrigir" })).body.id as string;
  return { tree, id };
};
const placement = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"));
const settleAtRoot = () => {
  h.judge().verdict = (input) => ({ belongs: 0.1, choice: Object.fromEntries(input.candidates.map((c) => [c.id, 0.5])) });
};

describe("placement — prazos", () => {
  it("afinidade que demora além do prazo da proposta: 201 com unavailable", async () => {
    const { id } = await start();
    settleAtRoot();
    h.affinity().hang = true;
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.destination).toEqual({ parentId: null, path: [] });
    expect(res.body.groupProposal).toBeNull();
    expect(res.body.groupProposalSkipped).toBe("unavailable");
  });

  it("nome que demora além do prazo da proposta: 201 com unavailable", async () => {
    const { id, tree } = await start();
    settleAtRoot();
    h.affinity().verdict = (input) => Object.fromEntries(input.tickets.map((t) => [t.id, t.id === tree.loose ? 0.9 : 0.1]));
    h.namer().hang = true;
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.groupProposalSkipped).toBe("unavailable");
  });

  it("o prazo da proposta fica fora do da descida: descida rápida e proposta lenta não somam", async () => {
    const { id } = await start();
    settleAtRoot();
    h.affinity().onCall = () => new Promise((resolve) => setTimeout(resolve, 150));
    const res = await placement(id);
    expect(res.status).toBe(201);
    expect(res.body.groupProposalSkipped).toBeNull();
  });

  it("a descida que demora continua dando o erro de sempre: 503 assistant_unavailable", async () => {
    const { id } = await start();
    h.judge().onCall = () => new Promise(() => undefined);
    const res = await placement(id);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("assistant_unavailable");
    expect(h.affinity().calls).toHaveLength(0);
  });
});
