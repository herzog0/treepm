/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import { JEV_MODEL, JevBranchJudge, estimateTokens, judgeInputFits } from "../src/assistant/jev-branch-judge.js";
import type { SystemOneCall } from "../src/assistant/jev-branch-judge.js";

const input = {
  draft: { title: "Corrigir login", description: "O botão não responde" },
  current: { title: "Autenticação", summary: "Entrada no sistema" },
  candidates: [
    { id: "id-1", title: "Login", summary: "Tela de login" },
    { id: "id-2", title: "Cobrança", summary: "Faturas e pagamentos" },
  ],
};

const answer = (noul: number, probabilities: Record<string, number>, extra: Record<string, unknown> = {}) => ({
  model: JEV_MODEL,
  usage: { input_tokens: 10, output_tokens: null },
  answers: {
    belongs: { type: "noul", noul },
    branch: { type: "choice", choice: Object.keys(probabilities)[0], confidence: 1, probabilities },
  },
  ...extra,
});

function fake(response: unknown | (() => Promise<unknown>), captured: { request: any; options: any }[] = []): SystemOneCall {
  return (async (request: unknown, options: unknown) => {
    captured.push({ request, options });
    return typeof response === "function" ? (response as () => Promise<unknown>)() : response;
  }) as unknown as SystemOneCall;
}

describe("JevBranchJudge — a requisição", () => {
  it("usa jev-1.14.0, um Noul e um Choice, e nunca envia ids", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input);
    const { request } = captured[0]!;
    expect(request.model).toBe("jev-1.14.0");
    expect(request.questions.belongs.type).toBe("noul");
    expect(request.questions.branch.type).toBe("choice");
    expect(Object.keys(request.questions.branch.criteria)).toEqual(["Login", "Cobrança"]);
    expect(request.questions.branch.criteria["Login"]).toBe("Tela de login");
    expect(JSON.stringify(request)).not.toMatch(/id-1|id-2/);
  });

  it("o estado tem campos nomeados com rascunho, ramo atual e candidatos", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input);
    expect(captured[0]!.request.state).toEqual({
      draft: input.draft,
      current_branch: input.current,
      candidate_branches: [
        { title: "Login", summary: "Tela de login" },
        { title: "Cobrança", summary: "Faturas e pagamentos" },
      ],
    });
  });

  it("na raiz não há ramo atual no estado", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge({ ...input, current: null });
    expect("current_branch" in captured[0]!.request.state).toBe(false);
  });

  it("títulos repetidos ganham sufixo e cada opção continua ligada ao seu ramo", async () => {
    const twin = { ...input, candidates: [input.candidates[0]!, { id: "id-3", title: "Login", summary: "Login de admin" }] };
    const captured: { request: any; options: any }[] = [];
    const out = await new JevBranchJudge(fake(answer(0.9, { Login: 0.7, "Login (2)": 0.3 }), captured)).judge(twin);
    expect(Object.keys(captured[0]!.request.questions.branch.criteria)).toEqual(["Login", "Login (2)"]);
    expect(out.choice).toEqual({ "id-1": 0.7, "id-3": 0.3 });
  });

  it("repassa o sinal e um tempo máximo por tentativa", async () => {
    const captured: { request: any; options: any }[] = [];
    const controller = new AbortController();
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input, { signal: controller.signal });
    expect(captured[0]!.options.signal).toBe(controller.signal);
    expect(captured[0]!.options.timeout).toBeGreaterThan(0);
  });
});

describe("JevBranchJudge — a resposta", () => {
  it("devolve belongs e as probabilidades por id", async () => {
    const out = await new JevBranchJudge(fake(answer(0.42, { Login: 0.8, Cobrança: 0.2 }))).judge(input);
    expect(out).toEqual({ belongs: 0.42, choice: { "id-1": 0.8, "id-2": 0.2 } });
  });

  it.each([
    ["Noul fora de 0 a 1", answer(1.5, { Login: 0.8, Cobrança: 0.2 })],
    ["opção sem probabilidade", answer(0.5, { Login: 1 })],
    ["opção desconhecida", answer(0.5, { Login: 0.5, Outro: 0.5 })],
    ["sem respostas", { model: JEV_MODEL, usage: {}, answers: {} }],
  ])("%s: assistant_unavailable", async (_n, response) => {
    await expect(new JevBranchJudge(fake(response)).judge(input)).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("falha do provedor vira assistant_unavailable sem vazar a mensagem", async () => {
    const boom = fake(async () => {
      throw new Error("segredo do texto do usuário");
    });
    const error = await new JevBranchJudge(boom).judge(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    expect(String((error as Error).message) + String((error as AssistantUnavailableError).reason)).not.toContain("segredo");
  });
});

describe("judgeInputFits", () => {
  it("aceita poucos candidatos e recusa quando a estimativa passa do limite", () => {
    expect(judgeInputFits(input)).toBe(true);
    const huge = { ...input, candidates: Array.from({ length: 400 }, (_, i) => ({ id: `i${i}`, title: `Ramo ${i}`, summary: "x".repeat(600) })) };
    expect(judgeInputFits(huge)).toBe(false);
  });

  it("a estimativa de tokens é de no mínimo um terço dos caracteres, com margem", () => {
    expect(estimateTokens("x".repeat(300))).toBeGreaterThanOrEqual(100);
    expect(estimateTokens("x".repeat(300))).toBeLessThanOrEqual(150);
  });
});
