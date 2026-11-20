/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import { JEV_MODEL } from "../src/assistant/prompts.js";
import { AFFINITY_TOKEN_BUDGET, JevAffinityJudge, affinityInputFits, buildAffinityRequest } from "../src/assistant/jev-affinity-judge.js";
import type { AffinityCall } from "../src/assistant/jev-affinity-judge.js";

const draft = { title: "Corrigir login", description: "O botão não responde" };
const tickets = [
  { id: "id-1", title: "Senha esquecida", descriptionExcerpt: "Link de redefinição" },
  { id: "id-2", title: "Cor do botão", descriptionExcerpt: "" },
];
const root = { draft, destination: { title: "Plataforma" }, tickets };
const inGroup = { draft, destination: { title: "Auth", summary: "Entrada no sistema" }, tickets };

const answers = (values: number[]) => ({
  model: JEV_MODEL,
  usage: { input_tokens: 10, output_tokens: null },
  answers: Object.fromEntries(values.map((noul, i) => [`ticket_${i + 1}`, { type: "noul", noul }])),
});
function fake(response: unknown | (() => Promise<unknown>), captured: { request: any; options: any }[] = []): AffinityCall {
  return (async (request: unknown, options: unknown) => {
    captured.push({ request, options });
    return typeof response === "function" ? (response as () => Promise<unknown>)() : response;
  }) as unknown as AffinityCall;
}

describe("JevAffinityJudge — a requisição", () => {
  it("na raiz o estado tem draft e destination só com o nome do projeto", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(root);
    expect(captured[0]!.request.model).toBe("jev-1.14.0");
    expect(captured[0]!.request.state).toEqual({ draft, destination: { title: "Plataforma" } });
  });

  it("em agrupador o destination leva título e resumo", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(inGroup);
    expect(captured[0]!.request.state).toEqual({ draft, destination: { title: "Auth", summary: "Entrada no sistema" } });
  });

  it("uma pergunta Noul por ticket solto, com o texto da ADR e o ticket como dado nomeado", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(root);
    const { questions } = captured[0]!.request;
    expect(Object.keys(questions)).toEqual(["ticket_1", "ticket_2"]);
    const question =
      "O trabalho descrito em `draft` e o ticket `ticket` desta pergunta fazem parte de um mesmo assunto, mais específico que o de `destination`, a ponto de a equipe guardá-los juntos em um agrupador próprio?";
    expect(questions.ticket_1.type).toBe("noul");
    expect(questions.ticket_1.instructions).toEqual({
      question,
      ticket: { title: "Senha esquecida", description: "Link de redefinição" },
    });
    // Descrição vazia: o campo some. O texto do ticket nunca entra na frase da pergunta.
    expect(questions.ticket_2.instructions).toEqual({ question, ticket: { title: "Cor do botão" } });
    expect("description" in questions.ticket_2.instructions.ticket).toBe(false);
    expect(questions.ticket_1.instructions.question).not.toContain("Senha esquecida");
  });

  it("critérios verdadeiro e falso são os da ADR, letra por letra", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(root);
    for (const key of ["ticket_1", "ticket_2"]) {
      expect(captured[0]!.request.questions[key].criteria).toEqual({
        true: "Os dois são partes de uma mesma entrega ou de um mesmo assunto específico: faria sentido um agrupador só para eles e para outros parecidos.",
        false:
          "Os dois tratam de assuntos diferentes, ou só têm em comum o assunto geral de `destination`, que já os contém.",
      });
    }
  });

  it("os ids dos tickets nunca saem", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(root);
    expect(JSON.stringify(captured[0]!.request)).not.toMatch(/id-1|id-2/);
  });

  it("repassa o sinal e um tempo máximo por tentativa", async () => {
    const captured: { request: any; options: any }[] = [];
    const controller = new AbortController();
    await new JevAffinityJudge(fake(answers([0.9, 0.1]), captured)).judge(root, { signal: controller.signal });
    expect(captured[0]!.options.signal).toBe(controller.signal);
    expect(captured[0]!.options.timeout).toBeGreaterThan(0);
  });
});

describe("JevAffinityJudge — as respostas", () => {
  it("liga cada resposta ao ticket pela chave da pergunta", async () => {
    const out = await new JevAffinityJudge(fake(answers([0.9, 0.2]))).judge(root);
    expect(out).toEqual({ "id-1": 0.9, "id-2": 0.2 });
  });

  it.each([
    ["resposta faltando", answers([0.9])],
    ["probabilidade fora de 0 a 1", answers([0.9, 1.5])],
    ["saída fora do formato", { model: JEV_MODEL, usage: {}, answers: null }],
  ])("%s vira assistant_unavailable", async (_n, response) => {
    await expect(new JevAffinityJudge(fake(response)).judge(root)).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it("falha do provedor não vaza a mensagem", async () => {
    const error = await new JevAffinityJudge(fake(() => Promise.reject(new Error("texto do usuário"))))
      .judge(root)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    expect(String((error as Error).message)).not.toContain("texto do usuário");
  });
});

describe("limite de tokens da afinidade", () => {
  it("o orçamento é 56 mil, para a requisição inteira", () => {
    expect(AFFINITY_TOKEN_BUDGET).toBe(56_000);
  });

  it("cabe com poucos tickets e não cabe com tickets demais", () => {
    expect(affinityInputFits(root)).toBe(true);
    const many = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, title: `Ticket ${i}`, descriptionExcerpt: "x".repeat(300) }));
    expect(buildAffinityRequest({ ...root, tickets: many }).labelled).toHaveLength(400);
    expect(affinityInputFits({ ...root, tickets: many })).toBe(false);
  });
});
