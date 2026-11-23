/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import { JEV_MODEL } from "../src/assistant/prompts.js";
import { JevRelatedJudge, RELATED_TOKEN_BUDGET, buildRelatedRequest, relatedInputFits } from "../src/assistant/jev-related-judge.js";
import type { RelatedCall } from "../src/assistant/jev-related-judge.js";

const draft = { title: "Sincronizar com o Jira", description: "Receber só o diff" };
const candidates = [
  { id: "id-1", title: "Importar do Jira", excerpt: "Lista de issues" },
  { id: "id-2", title: "Cor do botão", excerpt: "" },
];
const input = { draft, candidates };

const answers = (pairs: [number, number][]) => ({
  model: JEV_MODEL,
  usage: { input_tokens: 10, output_tokens: null },
  answers: Object.fromEntries(pairs.flatMap(([subject, request], i) => [[`subject_${i + 1}`, { type: "noul", noul: subject }], [`request_${i + 1}`, { type: "noul", noul: request }]])),
});
function fake(response: unknown | (() => Promise<unknown>), captured: { request: any; options: any }[] = []): RelatedCall {
  return (async (request: unknown, options: unknown) => {
    captured.push({ request, options });
    return typeof response === "function" ? (response as () => Promise<unknown>)() : response;
  }) as unknown as RelatedCall;
}

describe("JevRelatedJudge — a requisição (uma só, com as duas perguntas de cada candidato)", () => {
  it("o estado leva só o rascunho; o ticket vai dentro de cada pergunta", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevRelatedJudge(fake(answers([[0.9, 0.2], [0.1, 0.0]]), captured)).judge(input);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.request.model).toBe("jev-1.14.0");
    expect(captured[0]!.request.state).toEqual({ draft });
    expect(Object.keys(captured[0]!.request.questions)).toEqual(["subject_1", "request_1", "subject_2", "request_2"]);
  });

  it("as duas perguntas, exatamente como escritas, e o ticket como dado nomeado (descrição vazia some)", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevRelatedJudge(fake(answers([[0.9, 0.2], [0.1, 0.0]]), captured)).judge(input);
    const { questions } = captured[0]!.request;
    expect(questions.subject_1.type).toBe("noul");
    expect(questions.subject_1.instructions).toEqual({
      question: "O trabalho descrito em `draft` trata do mesmo assunto que o ticket `ticket` desta pergunta?",
      ticket: { title: "Importar do Jira", description: "Lista de issues" },
    });
    expect(questions.request_1.instructions).toEqual({
      question: "O trabalho descrito em `draft` pede a mesma coisa que o ticket `ticket` desta pergunta já descreve?",
      ticket: { title: "Importar do Jira", description: "Lista de issues" },
    });
    expect(questions.subject_2.instructions.ticket).toEqual({ title: "Cor do botão" });
    expect(questions.request_2.instructions.question).not.toContain("Cor do botão");
  });

  it("critérios verdadeiro e falso, letra por letra", async () => {
    const captured: { request: any; options: any }[] = [];
    await new JevRelatedJudge(fake(answers([[0.9, 0.2], [0.1, 0.0]]), captured)).judge(input);
    expect(captured[0]!.request.questions.subject_1.criteria).toEqual({
      true: "O trabalho de `draft` e o ticket `ticket` tratam do mesmo assunto: quem trabalha em um precisa conhecer o outro.",
      false: "Os dois tratam de assuntos diferentes, mesmo que usem algumas palavras em comum.",
    });
    expect(captured[0]!.request.questions.request_2.criteria).toEqual({
      true: "Fazer o que `draft` pede é fazer o que `ticket` já descreve: criar o ticket novo seria repetir o ticket existente.",
      false: "O que `draft` pede é diferente do que `ticket` descreve: é outra entrega, uma parte dela, ou algo que depende dela.",
    });
  });

  it("liga cada resposta ao id do ticket, nunca ao título", async () => {
    const result = await new JevRelatedJudge(fake(answers([[0.9, 0.2], [0.1, 0.0]]))).judge(input);
    expect(result).toEqual({ "id-1": { sameSubject: 0.9, sameRequest: 0.2 }, "id-2": { sameSubject: 0.1, sameRequest: 0 } });
  });

  it("sem candidatos não chama o provedor", async () => {
    const captured: { request: any; options: any }[] = [];
    expect(await new JevRelatedJudge(fake(answers([]), captured)).judge({ draft, candidates: [] })).toEqual({});
    expect(captured).toHaveLength(0);
  });
});

describe("JevRelatedJudge — erros e tamanho", () => {
  it("erro do provedor vira indisponível, sem texto", async () => {
    const judge = new JevRelatedJudge(fake(() => Promise.reject(new Error("TEXTO SECRETO do usuário"))));
    const error = await judge.judge(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssistantUnavailableError);
    expect((error as AssistantUnavailableError).reason).toBe("provider_error");
    expect(JSON.stringify(error)).not.toContain("SECRETO");
  });

  it("resposta sem uma das perguntas é saída inválida", async () => {
    const broken = answers([[0.9, 0.2], [0.1, 0.0]]);
    delete (broken.answers as any).request_2;
    await expect(new JevRelatedJudge(fake(broken)).judge(input)).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("probabilidade fora de 0 a 1 é saída inválida", async () => {
    await expect(new JevRelatedJudge(fake(answers([[1.5, 0.2], [0.1, 0.0]]))).judge(input)).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("repassa o sinal e usa o prazo por tentativa", async () => {
    const captured: { request: any; options: any }[] = [];
    const controller = new AbortController();
    await new JevRelatedJudge(fake(answers([[0.9, 0.2], [0.1, 0.0]]), captured)).judge(input, { signal: controller.signal });
    expect(captured[0]!.options.signal).toBe(controller.signal);
    expect(captured[0]!.options.timeout).toBe(20_000);
  });

  it("cabe no orçamento até 30 candidatos normais e não cabe com trechos enormes", () => {
    const normal = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: `Ticket ${i}`, excerpt: "x".repeat(600) }));
    expect(relatedInputFits({ draft, candidates: normal })).toBe(true);
    const huge = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, title: `Ticket ${i}`, excerpt: "x".repeat(40_000) }));
    expect(relatedInputFits({ draft, candidates: huge })).toBe(false);
    expect(RELATED_TOKEN_BUDGET).toBe(56_000);
    expect(buildRelatedRequest(input).labelled.map((l) => l.id)).toEqual(["id-1", "id-2"]);
  });
});
