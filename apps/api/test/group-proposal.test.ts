import { describe, expect, it } from "vitest";
import { AFFINITY_THRESHOLD, PROPOSAL_TIMEOUT_MS, proposeGroup } from "../src/assistant/group-proposal.js";
import type { ProposeInput } from "../src/assistant/group-proposal.js";
import { FakeAffinityJudge, FakeGroupNamer } from "./assistant-fakes.js";

const firm = { uncertain: false, stoppedEarly: null, scope: null };
const loose = [
  { id: "a", number: 7, title: "Senha esquecida", description: "Link de redefinição" },
  { id: "b", number: 3, title: "Cor do botão", description: "" },
  { id: "c", number: 5, title: "Reset por SMS", description: "Código por mensagem" },
];
const draft = { title: "Corrigir link de senha", description: "O link expira cedo" };

function setup(over: Partial<ProposeInput> = {}) {
  const affinity = new FakeAffinityJudge();
  const namer = new FakeGroupNamer();
  const run = () =>
    proposeGroup({ draft, outcome: firm, destination: { kind: "root", title: "Plataforma" }, looseTickets: loose, affinity, namer, ...over });
  return { affinity, namer, run, over };
}
const scores = (affinity: FakeAffinityJudge, byId: Record<string, number>) => {
  affinity.verdict = (input) => Object.fromEntries(input.tickets.map((t) => [t.id, byId[t.id] ?? 0]));
};

describe("proposeGroup — quando verificar", () => {
  it("o prazo e o limiar são os da ADR", () => {
    expect(AFFINITY_THRESHOLD).toBe(0.7);
    expect(PROPOSAL_TIMEOUT_MS).toBe(20_000);
  });

  it.each([
    ["resultado incerto", { uncertain: true, stoppedEarly: null, scope: null }],
    ["parou antes", { uncertain: false, stoppedEarly: { reason: "max_levels" as const, level: 20, parentId: null }, scope: null }],
    ["fora do escopo", { uncertain: false, stoppedEarly: null, scope: { id: "s", title: "S", outOfScope: true, fit: 0.1 } }],
  ])("%s: nenhum provedor é chamado e o motivo é not_settled", async (_n, outcome) => {
    const { affinity, namer, run } = setup({ outcome });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "not_settled" });
    expect(affinity.calls).toHaveLength(0);
    expect(namer.calls).toHaveLength(0);
  });

  it("escopo dentro dele (não fora) ainda verifica", async () => {
    const { affinity, run } = setup({ outcome: { uncertain: false, stoppedEarly: null, scope: { id: "s", title: "S", outOfScope: false, fit: 0.9 } } });
    await run();
    expect(affinity.calls).toHaveLength(1);
  });

  it("sem tickets soltos: nenhum provedor é chamado e o motivo é no_loose_tickets", async () => {
    const summaryCalls: number[] = [];
    const { affinity, namer, run } = setup({
      looseTickets: [],
      destination: { kind: "group", title: "Auth", summary: async () => (summaryCalls.push(1), "resumo") },
    });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "no_loose_tickets" });
    expect(affinity.calls).toHaveLength(0);
    expect(namer.calls).toHaveLength(0);
    expect(summaryCalls).toHaveLength(0);
  });
});

describe("proposeGroup — a afinidade", () => {
  it("na raiz o estado leva só o nome do projeto, e os tickets vão em ordem de número com o trecho da descrição", async () => {
    const { affinity, run } = setup();
    await run();
    expect(affinity.calls[0]).toEqual({
      draft,
      destination: { title: "Plataforma" },
      tickets: [
        { id: "b", title: "Cor do botão", descriptionExcerpt: "" },
        { id: "c", title: "Reset por SMS", descriptionExcerpt: "Código por mensagem" },
        { id: "a", title: "Senha esquecida", descriptionExcerpt: "Link de redefinição" },
      ],
    });
  });

  it("em agrupador o destino leva título e o resumo resolvido", async () => {
    const { affinity, run } = setup({ destination: { kind: "group", title: "Auth", summary: async () => "Entrada no sistema" } });
    await run();
    expect(affinity.calls[0]?.destination).toEqual({ title: "Auth", summary: "Entrada no sistema" });
  });

  it("requisição grande demais: não chama provedor e o motivo é too_large", async () => {
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, number: i + 1, title: `Ticket ${i}`, description: "x".repeat(300) }));
    const { affinity, namer, run } = setup({ looseTickets: many });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "too_large" });
    expect(affinity.calls).toHaveLength(0);
    expect(namer.calls).toHaveLength(0);
  });
});

describe("proposeGroup — a decisão", () => {
  it("0,7 não passa; acima de 0,7 passa", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.7, b: 0.7000001, c: 0.2 });
    const out = await run();
    expect(out.groupProposal?.tickets).toEqual([{ id: "b", number: 3, title: "Cor do botão" }]);
    expect(namer.calls).toHaveLength(1);
  });

  it("nenhum acima do limiar: sem proposta e sem motivo, e o Claude não é chamado", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.7, b: 0.5, c: 0 });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: null });
    expect(namer.calls).toHaveLength(0);
  });

  it("o grupo proposto vem na ordem do número, com o título e a descrição do Claude", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.9, b: 0.1, c: 0.8 });
    namer.reply = () => ({ title: "Redefinição de senha", description: "Fluxos de senha." });
    expect(await run()).toEqual({
      groupProposal: {
        title: "Redefinição de senha",
        description: "Fluxos de senha.",
        tickets: [
          { id: "c", number: 5, title: "Reset por SMS" },
          { id: "a", number: 7, title: "Senha esquecida" },
        ],
      },
      groupProposalSkipped: null,
    });
  });

  it("o Claude recebe o destino, o ticket novo e os existentes do grupo, com título e trecho", async () => {
    const { affinity, namer, run } = setup({ destination: { kind: "group", title: "Auth", summary: async () => "r" } });
    scores(affinity, { a: 0.9, c: 0.8 });
    await run();
    expect(namer.calls[0]).toEqual({
      destinationTitle: "Auth",
      newTicket: { title: "Corrigir link de senha", descriptionExcerpt: "O link expira cedo" },
      existingTickets: [
        { title: "Reset por SMS", descriptionExcerpt: "Código por mensagem" },
        { title: "Senha esquecida", descriptionExcerpt: "Link de redefinição" },
      ],
    });
  });

  it("na raiz, o destino enviado ao Claude é o nome do projeto", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.9 });
    await run();
    expect(namer.calls[0]?.destinationTitle).toBe("Plataforma");
  });

  it("destino agrupador e todos os soltos passam: same_as_destination, sem chamar o Claude", async () => {
    const { affinity, namer, run } = setup({ destination: { kind: "group", title: "Auth", summary: async () => "r" } });
    scores(affinity, { a: 0.9, b: 0.9, c: 0.9 });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "same_as_destination" });
    expect(namer.calls).toHaveLength(0);
  });

  it("na raiz, todos os soltos passando dá proposta", async () => {
    const { affinity, run } = setup();
    scores(affinity, { a: 0.9, b: 0.9, c: 0.9 });
    const out = await run();
    expect(out.groupProposal?.tickets.map((t) => t.id)).toEqual(["b", "c", "a"]);
    expect(out.groupProposalSkipped).toBeNull();
  });

  it("agrupador com todos menos um passando: há proposta", async () => {
    const { affinity, run } = setup({ destination: { kind: "group", title: "Auth", summary: async () => "r" } });
    scores(affinity, { a: 0.9, b: 0.9, c: 0.2 });
    expect((await run()).groupProposal?.tickets).toHaveLength(2);
  });
});

describe("proposeGroup — o nome", () => {
  it.each([
    ["título vazio", { title: "", description: "ok" }],
    ["título só de espaços", { title: "   ", description: "ok" }],
    ["título com 201 caracteres", { title: "x".repeat(201), description: "ok" }],
    ["descrição com 20001 caracteres", { title: "ok", description: "x".repeat(20_001) }],
  ])("%s: invalid_name", async (_n, reply) => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.9 });
    namer.reply = () => reply;
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "invalid_name" });
  });

  it("200 caracteres de título e 20000 de descrição valem", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.9 });
    namer.reply = () => ({ title: "x".repeat(200), description: "y".repeat(20_000) });
    expect((await run()).groupProposal).not.toBeNull();
  });
});

describe("proposeGroup — falha não derruba a procura", () => {
  it("erro da afinidade: unavailable", async () => {
    const { affinity, namer, run } = setup();
    affinity.fail = true;
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
    expect(namer.calls).toHaveLength(0);
  });

  it("erro do nome: unavailable", async () => {
    const { affinity, namer, run } = setup();
    scores(affinity, { a: 0.9 });
    namer.fail = true;
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
  });

  it("erro ao escrever o resumo do destino: unavailable", async () => {
    const { affinity, run } = setup({
      destination: { kind: "group", title: "Auth", summary: async () => Promise.reject(new (await import("../src/assistant/ports.js")).AssistantUnavailableError("x")) },
    });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
    expect(affinity.calls).toHaveLength(0);
  });

  it("afinidade que demora além do prazo: unavailable", async () => {
    const { affinity, run } = setup({ timeoutMs: 30 });
    affinity.hang = true;
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
  });

  it("nome que demora além do prazo: unavailable", async () => {
    const { affinity, namer, run } = setup({ timeoutMs: 30 });
    scores(affinity, { a: 0.9 });
    namer.hang = true;
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
  });

  it("o prazo vale para a soma: afinidade lenta mais nome lento estouram juntos", async () => {
    const { affinity, namer, run } = setup({ timeoutMs: 60 });
    scores(affinity, { a: 0.9 });
    affinity.onCall = () => new Promise((r) => setTimeout(r, 40));
    namer.onCall = () => new Promise((r) => setTimeout(r, 40));
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
  });

  it("afinidade que não responde por um dos tickets: unavailable", async () => {
    const { affinity, run } = setup();
    affinity.verdict = () => ({ a: 0.9 });
    expect(await run()).toEqual({ groupProposal: null, groupProposalSkipped: "unavailable" });
  });
});
