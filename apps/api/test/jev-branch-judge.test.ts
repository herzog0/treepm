/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import { JEV_MODEL, JevBranchJudge, estimateTokens, judgeInputFits } from "../src/assistant/jev-branch-judge.js";
import type { SystemOneCall } from "../src/assistant/jev-branch-judge.js";

const input = {
  draft: { title: "Corrigir login", description: "O botão não responde" },
  current: { title: "Autenticação", summary: "Entrada no sistema" },
  candidates: [
    { id: "id-1", title: "Login", summary: "Tela de login", hasChildren: true },
    { id: "id-2", title: "Cobrança", summary: "Faturas e pagamentos", hasChildren: true },
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

  it("o estado tem exatamente draft, current_group e candidate_groups", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input);
    expect(captured[0]!.request.state).toEqual({
      draft: input.draft,
      current_group: { title: "Autenticação", summary: "Entrada no sistema" },
      candidate_groups: [
        { title: "Login", summary: "Tela de login" },
        { title: "Cobrança", summary: "Faturas e pagamentos" },
      ],
    });
  });

  it("na raiz não há agrupador atual no estado", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge({ ...input, current: null });
    expect("current_group" in captured[0]!.request.state).toBe(false);
    expect(Object.keys(captured[0]!.request.state)).toEqual(["draft", "candidate_groups"]);
  });

  const mixed = {
    ...input,
    current: null,
    candidates: [
      { id: "id-1", title: "Login", summary: "Tela de login", hasChildren: true },
      { id: "id-2", title: "Senha", summary: "Trecho da descrição", hasChildren: false },
      { id: "id-3", title: "Sessão", summary: "", hasChildren: false },
    ],
  };

  it("candidatos em três formatos: agrupador com filhos, vazio com descrição e vazio sem descrição", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.5, Senha: 0.3, Sessão: 0.2 }), captured)).judge(mixed);
    const { state, questions } = captured[0]!.request;
    expect(state.candidate_groups).toEqual([
      { title: "Login", summary: "Tela de login" },
      { title: "Senha", description: "Trecho da descrição" },
      { title: "Sessão" },
    ]);
    expect("description" in state.candidate_groups[2]).toBe(false);
    expect(questions.branch.criteria).toEqual({ Login: "Tela de login", Senha: "Trecho da descrição", Sessão: null });
  });

  it("o texto das perguntas é o da ADR 0031, letra por letra", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input);
    const { belongs, branch } = captured[0]!.request.questions;
    expect(belongs.instructions).toBe(
      "O trabalho descrito em `draft` cabe dentro do assunto de pelo menos um dos agrupadores de `candidate_groups`?",
    );
    expect(belongs.criteria).toEqual({
      true: "O trabalho de `draft` trata de um assunto que um dos agrupadores de `candidate_groups` cobre, como um item que a equipe esperaria encontrar dentro dele.",
      false:
        "O trabalho de `draft` trata de um assunto que nenhum dos agrupadores de `candidate_groups` cobre: é mais geral que todos eles ou é um assunto novo, e seria encontrado direto no nível em que estamos.",
    });
    expect(branch.instructions).toBe("Qual dos agrupadores de `candidate_groups` cobre o trabalho descrito em `draft`?");
  });

  it("títulos repetidos misturando folha e ramo: sufixo e volta das probabilidades por id", async () => {
    const twins = {
      ...input,
      candidates: [
        { id: "id-1", title: "Login", summary: "Tela de login", hasChildren: true },
        { id: "id-3", title: "Login", summary: "Trecho", hasChildren: false },
        { id: "id-4", title: "Login", summary: "", hasChildren: false },
      ],
    };
    const captured: { request: any; options: any }[] = [];
    const out = await new JevBranchJudge(fake(answer(0.9, { Login: 0.5, "Login (2)": 0.3, "Login (3)": 0.2 }), captured)).judge(twins);
    expect(captured[0]!.request.questions.branch.criteria).toEqual({ Login: "Tela de login", "Login (2)": "Trecho", "Login (3)": null });
    expect(captured[0]!.request.state.candidate_groups.map((c: { title: string }) => c.title)).toEqual(["Login", "Login (2)", "Login (3)"]);
    expect(out.choice).toEqual({ "id-1": 0.5, "id-3": 0.3, "id-4": 0.2 });
  });

  it("títulos repetidos ganham sufixo e cada opção continua ligada ao seu ramo", async () => {
    const twin = { ...input, candidates: [input.candidates[0]!, { id: "id-3", title: "Login", summary: "Login de admin", hasChildren: true }] };
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

describe("JevBranchJudge — a pergunta do escopo", () => {
  const scoped = { ...input, current: null };
  const withScope = (scope: { id: string; title: string; summary: string; hasChildren: boolean }) => ({ ...scoped, scope });
  const scopeAnswer = (noul: number, probabilities: Record<string, number> | null) => ({
    model: JEV_MODEL,
    usage: {},
    answers: {
      ...(probabilities ? { belongs: { type: "noul", noul: 0.9 }, branch: { type: "choice", choice: "Login", confidence: 1, probabilities } } : {}),
      scope: { type: "noul", noul },
    },
  });

  it("escopo com filhos: o estado ganha scope com title e summary, e não repete current_group", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(scopeAnswer(0.8, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(
      withScope({ id: "esc", title: "Autenticação", summary: "Entrada no sistema", hasChildren: true }),
    );
    const { state } = captured[0]!.request;
    expect(state.scope).toEqual({ title: "Autenticação", summary: "Entrada no sistema" });
    expect("current_group" in state).toBe(false);
    expect(Object.keys(state)).toEqual(["draft", "scope", "candidate_groups"]);
    expect(JSON.stringify(captured[0]!.request)).not.toMatch(/esc"/);
  });

  it("escopo vazio com descrição: title e description; sem descrição: só title", async () => {
    const captured: { request: any; options: any }[] = [];
    const judge = new JevBranchJudge(fake(scopeAnswer(0.8, null), captured));
    await judge.judge({ draft: input.draft, current: null, candidates: [], scope: { id: "esc", title: "Acesso", summary: "Quem entra", hasChildren: false } });
    await judge.judge({ draft: input.draft, current: null, candidates: [], scope: { id: "esc", title: "Acesso", summary: "", hasChildren: false } });
    expect(captured[0]!.request.state.scope).toEqual({ title: "Acesso", description: "Quem entra" });
    expect(captured[1]!.request.state.scope).toEqual({ title: "Acesso" });
    expect("description" in captured[1]!.request.state.scope).toBe(false);
  });

  it("o texto da pergunta e dos critérios do escopo é o do brief, letra por letra", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(scopeAnswer(0.8, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(
      withScope({ id: "esc", title: "Autenticação", summary: "Entrada", hasChildren: true }),
    );
    const { scope, belongs, branch } = captured[0]!.request.questions;
    expect(scope.type).toBe("noul");
    expect(scope.instructions).toBe("O trabalho descrito em `draft` cabe dentro do assunto do agrupador `scope`?");
    expect(scope.criteria).toEqual({
      true: "O trabalho de `draft` trata de um assunto que o agrupador `scope` cobre, como um item que a equipe esperaria encontrar dentro dele.",
      false: "O trabalho de `draft` trata de um assunto que o agrupador `scope` não cobre: seria encontrado em outra parte do projeto.",
    });
    expect(belongs.type).toBe("noul");
    expect(branch.type).toBe("choice");
  });

  it("devolve o Noul do escopo ao lado do belongs e das escolhas", async () => {
    const out = await new JevBranchJudge(fake(scopeAnswer(0.25, { Login: 0.8, Cobrança: 0.2 }))).judge(
      withScope({ id: "esc", title: "Autenticação", summary: "Entrada", hasChildren: true }),
    );
    expect(out).toEqual({ belongs: 0.9, choice: { "id-1": 0.8, "id-2": 0.2 }, scopeFit: 0.25 });
  });

  it("escopo sem agrupadores filhos: a requisição leva só a pergunta do escopo", async () => {
    const captured: { request: any; options: any }[] = [];
    const out = await new JevBranchJudge(fake(scopeAnswer(0.6, null), captured)).judge({
      draft: input.draft,
      current: null,
      candidates: [],
      scope: { id: "esc", title: "Acesso", summary: "", hasChildren: false },
    });
    const { request } = captured[0]!;
    expect(Object.keys(request.questions)).toEqual(["scope"]);
    expect(Object.keys(request.state)).toEqual(["draft", "scope"]);
    expect(out.scopeFit).toBe(0.6);
    expect(out.choice).toEqual({});
  });

  it("sem escopo a requisição é a de sempre: nenhuma pergunta nem campo de escopo", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }), captured)).judge(input);
    expect(Object.keys(captured[0]!.request.questions)).toEqual(["belongs", "branch"]);
    expect("scope" in captured[0]!.request.state).toBe(false);
  });

  it("resposta sem o Noul do escopo, ou fora de 0 a 1: assistant_unavailable", async () => {
    const scopeInput = withScope({ id: "esc", title: "Autenticação", summary: "Entrada", hasChildren: true });
    await expect(new JevBranchJudge(fake(answer(0.9, { Login: 0.8, Cobrança: 0.2 }))).judge(scopeInput)).rejects.toMatchObject({ reason: "invalid_output" });
    await expect(new JevBranchJudge(fake(scopeAnswer(1.4, { Login: 0.8, Cobrança: 0.2 }))).judge(scopeInput)).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("judgeInputFits conta a pergunta do escopo e aceita o escopo sem candidatos", () => {
    expect(judgeInputFits({ draft: input.draft, current: null, candidates: [], scope: { id: "e", title: "A", summary: "", hasChildren: false } })).toBe(true);
    expect(judgeInputFits({ draft: input.draft, current: null, candidates: [], scope: { id: "e", title: "A", summary: "x".repeat(90_000), hasChildren: true } })).toBe(false);
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
    const huge = { ...input, candidates: Array.from({ length: 400 }, (_, i) => ({ id: `i${i}`, title: `Ramo ${i}`, summary: "x".repeat(600), hasChildren: true })) };
    expect(judgeInputFits(huge)).toBe(false);
  });

  it("a estimativa de tokens é de no mínimo um terço dos caracteres, com margem", () => {
    expect(estimateTokens("x".repeat(300))).toBeGreaterThanOrEqual(100);
    expect(estimateTokens("x".repeat(300))).toBeLessThanOrEqual(150);
  });
});
