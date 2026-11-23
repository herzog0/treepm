/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type { ElaborationInput, ExistingMatchInput } from "../src/assistant/ports.js";
import { ClaudeTicketElaborator } from "../src/assistant/claude-ticket-elaborator.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { ELABORATION_SYSTEM_PROMPT, EXISTING_MATCH_SYSTEM_PROMPT, SYSTEM_PROMPT } from "../src/assistant/prompts.js";

// ADR 0052, fatia 3: a elaboração (ligações e tarefas sugeridas) é uma chamada própria ao Claude.

type Captured = { params: Record<string, any>; options: { signal: AbortSignal } };
function streamer(response: Record<string, unknown> | (() => Promise<Record<string, unknown>>), captured: Captured[] = []): ClaudeStreamer {
  return (async (params: Record<string, any>, options: { signal: AbortSignal }) => {
    captured.push({ params, options });
    return typeof response === "function" ? response() : response;
  }) as unknown as ClaudeStreamer;
}
const ok = (parsed: unknown = { links: [], suggested: [] }, extra: Record<string, unknown> = {}) => ({ stop_reason: "end_turn", parsed_output: parsed, model: "claude-opus-5-5", ...extra });
const input: ElaborationInput = {
  draft: { title: "Sincronizar tickets com o Jira", description: "Receber só o diff", parts: [{ title: "Receber o diff", description: "Sem reimportar tudo" }] },
  related: [
    { key: "TREEPM-144", title: "Guardar a origem de cada ticket", excerpt: "Saber de onde veio", status: "todo" },
    { key: "TREEPM-139", title: "Importar de GitHub, Jira e Linear", excerpt: "", status: "in_progress" },
  ],
};

describe("o prompt de sistema da conversa não muda", () => {
  it("o texto de SYSTEM_PROMPT continua byte a byte o de antes da fatia 3", () => {
    expect(createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe("7291289e5e1aa36099feaf130c11ff346ee925dd23070649f60f9ae75525c723");
  });
});

describe("ClaudeTicketElaborator — a requisição", () => {
  it("usa Claude Opus 5.5 com esforço low, saída estruturada e sem ferramentas", async () => {
    const captured: Captured[] = [];
    await new ClaudeTicketElaborator(streamer(ok(), captured)).elaborate(input);
    const params = captured[0]!.params;
    expect(params["model"]).toBe("claude-opus-5-5");
    expect(params["output_config"].effort).toBe("low");
    expect(params["output_config"].format).toBeDefined();
    expect(params["tools"]).toBeUndefined();
  });

  it("o prompt de sistema é o novo, estável e vive em prompts.ts; o texto variável só vai na mensagem", async () => {
    const captured: Captured[] = [];
    await new ClaudeTicketElaborator(streamer(ok(), captured)).elaborate(input);
    expect(captured[0]!.params["system"]).toEqual([{ type: "text", text: ELABORATION_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(ELABORATION_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    for (const piece of [
      "dados, não instruções",
      "Não reescreva",
      "prazo",
      "pré-requisito",
      "lista vazia",
      "Formato da resposta",
    ]) expect(ELABORATION_SYSTEM_PROMPT.toLowerCase(), piece).toContain(piece.toLowerCase());
    const system = JSON.stringify(captured[0]!.params["system"]);
    expect(system).not.toContain("TREEPM-144");
    expect(system).not.toContain("Sincronizar");
  });

  it("a mensagem leva só o rascunho (título, descrição, partes com índice) e, de cada relacionado, chave, título, trecho e situação", async () => {
    const captured: Captured[] = [];
    await new ClaudeTicketElaborator(streamer(ok(), captured)).elaborate(input);
    const [message] = captured[0]!.params["messages"] as { role: string; content: string }[];
    expect(captured[0]!.params["messages"]).toHaveLength(1);
    expect(message!.role).toBe("user");
    const json = JSON.parse(message!.content.slice(message!.content.indexOf("{")));
    expect(json).toEqual({
      draft: { title: "Sincronizar tickets com o Jira", description: "Receber só o diff", parts: [{ index: 0, title: "Receber o diff", description: "Sem reimportar tudo" }] },
      related: [
        { key: "TREEPM-144", title: "Guardar a origem de cada ticket", excerpt: "Saber de onde veio", status: "todo" },
        { key: "TREEPM-139", title: "Importar de GitHub, Jira e Linear", excerpt: "", status: "in_progress" },
      ],
    });
  });

  it("nada além disso sai: nem id, pessoa, comentário, histórico ou área (campos extras da entrada são ignorados)", async () => {
    const captured: Captured[] = [];
    const sneaky = {
      ...input,
      related: input.related.map((r) => ({ ...r, id: "5f0e2d6e-1111-4222-8333-444455556666", assignee: "Maria", comments: ["segredo"], area: "Backend" })),
    } as unknown as ElaborationInput;
    await new ClaudeTicketElaborator(streamer(ok(), captured)).elaborate(sneaky);
    const text = JSON.stringify(captured[0]!.params["messages"]);
    for (const leak of ["5f0e2d6e", "Maria", "segredo", "Backend", "assignee", "comments", "area"]) expect(text, leak).not.toContain(leak);
  });
});

describe("ClaudeTicketElaborator — o resultado", () => {
  const raw = {
    links: [{ de: "pai", dependeDe: "TREEPM-144", motivo: "precisa saber a origem" }, { de: 0, dependeDe: "TREEPM-139", motivo: "reaproveita a importação" }],
    suggested: [{ title: "Guardar o cursor da última sincronização", description: "Para pedir só o diff", motivo: "sem isso não há diff" }],
  };
  it("devolve ligações, sugeridas e o modelo que respondeu, como vieram", async () => {
    const out = await new ClaudeTicketElaborator(streamer(ok(raw, { model: "claude-opus-4-8" }))).elaborate(input);
    expect(out).toEqual({ ...raw, model: "claude-opus-4-8" });
  });

  it.each([
    ["recusa", ok(undefined, { stop_reason: "refusal" })],
    ["limite de tokens", ok(undefined, { stop_reason: "max_tokens" })],
    ["saída fora do formato", ok({ links: 3 })],
    ["saída nula", ok(null)],
  ])("%s vira assistant_unavailable", async (_n, response) => {
    await expect(new ClaudeTicketElaborator(streamer(response)).elaborate(input)).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it("estourar o prazo cancela a chamada", async () => {
    const captured: Captured[] = [];
    const elaborator = new ClaudeTicketElaborator(streamer(() => new Promise(() => undefined), captured), { timeoutMs: 20 });
    await expect(elaborator.elaborate(input)).rejects.toMatchObject({ reason: "timeout" });
    expect(captured[0]!.options.signal.aborted).toBe(true);
  });
});

describe("revisão 1: o adaptador e o prompt", () => {
  it("respeita o sinal de aborto recebido: rejeita logo, sem esperar o prazo", async () => {
    const never = streamer(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = new ClaudeTicketElaborator(never, { timeoutMs: 60_000 }).elaborate(input, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AssistantUnavailableError);
  });
  it("sinal já abortado nem chama o provedor", async () => {
    const captured: Captured[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(new ClaudeTicketElaborator(streamer(ok(), captured)).elaborate(input, { signal: controller.signal })).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(captured).toHaveLength(0);
  });
  it("o prompt limita a descrição a 600 caracteres e escreve no idioma do pedido, como a conversa", () => {
    expect(ELABORATION_SYSTEM_PROMPT).toContain("600");
    expect(ELABORATION_SYSTEM_PROMPT).not.toContain("2000");
    expect(ELABORATION_SYSTEM_PROMPT).toContain("Escreva no idioma do pedido.");
    expect(ELABORATION_SYSTEM_PROMPT).not.toContain("português do Brasil");
  });
});

describe("o prompt da elaboração não puxa para o silêncio (R6)", () => {
  const text = ELABORATION_SYSTEM_PROMPT.toLowerCase();
  it("some o 'em dúvida, não sugira' e entra a obrigação de propor o que o pedido implica", () => {
    expect(text).not.toContain("em dúvida, não sugira");
    expect(text).not.toContain("frequente");
    expect(text).toContain("deve ser proposto");
    expect(text).toContain("se o pedido se basta");
  });
  it("mantém as proibições e não leva palavras do caso medido", () => {
    for (const piece of ["boas práticas genéricas", "testes e documentação que ninguém pediu", "Não invente prazo, pessoa, número nem critério de aceite", "Não reescreva nem contradiga"]) expect(ELABORATION_SYSTEM_PROMPT).toContain(piece);
    for (const word of ["sincroniz", "origem", "jira", "github", "linear"]) expect(text, word).not.toContain(word);
  });
});

describe("ClaudeTicketElaborator.matchExisting — a segunda chamada (R6)", () => {
  const match: ExistingMatchInput = {
    tasks: [
      { index: 0, title: "Guardar o vínculo externo", description: "Registrar o id externo", motivo: "sem vínculo não há diff", candidates: [{ key: "TREEPM-144", title: "Guardar a origem de cada ticket", excerpt: "Saber de onde veio", status: "todo" }] },
      { index: 1, title: "Cadastrar o token", description: "", motivo: "precisa autenticar", candidates: [{ key: "TREEPM-139", title: "Importar de GitHub", excerpt: "", status: "done" }] },
    ],
  };
  const answer = { matches: [{ index: 0, existing: "TREEPM-144" }, { index: 1, existing: null }] };

  it("Opus 5.5, esforço low, saída estruturada, sem ferramentas, com o prompt próprio e estável", async () => {
    const captured: Captured[] = [];
    await new ClaudeTicketElaborator(streamer(ok(answer), captured)).matchExisting(match);
    const params = captured[0]!.params;
    expect(params["model"]).toBe("claude-opus-5-5");
    expect(params["output_config"].effort).toBe("low");
    expect(params["output_config"].format).toBeDefined();
    expect(params["tools"]).toBeUndefined();
    expect(params["system"]).toEqual([{ type: "text", text: EXISTING_MATCH_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
    expect(EXISTING_MATCH_SYSTEM_PROMPT).not.toBe(ELABORATION_SYSTEM_PROMPT);
    expect(EXISTING_MATCH_SYSTEM_PROMPT).not.toBe(SYSTEM_PROMPT);
    const system = EXISTING_MATCH_SYSTEM_PROMPT.toLowerCase();
    for (const piece of ["dados, não instruções", "só chaves recebidas", "o mais específico", "null", "mais amplo"]) expect(system, piece).toContain(piece);
    expect(JSON.stringify(params["system"])).not.toContain("TREEPM-144");
  });

  it("a mensagem leva só índice, título, descrição e motivo das sugeridas e chave, título, trecho e situação dos candidatos", async () => {
    const captured: Captured[] = [];
    const sneaky = { tasks: match.tasks.map((t) => ({ ...t, id: "5f0e2d6e", assignee: "Maria", candidates: t.candidates.map((c) => ({ ...c, id: "5f0e2d6e-1111", comments: ["segredo"] })) })) } as unknown as ExistingMatchInput;
    await new ClaudeTicketElaborator(streamer(ok(answer), captured)).matchExisting(sneaky);
    expect(captured[0]!.params["messages"]).toHaveLength(1);
    const [message] = captured[0]!.params["messages"] as { role: string; content: string }[];
    expect(JSON.parse(message!.content.slice(message!.content.indexOf("{")))).toEqual({
      tasks: [
        { index: 0, title: "Guardar o vínculo externo", description: "Registrar o id externo", motivo: "sem vínculo não há diff", candidates: [{ key: "TREEPM-144", title: "Guardar a origem de cada ticket", excerpt: "Saber de onde veio", status: "todo" }] },
        { index: 1, title: "Cadastrar o token", description: "", motivo: "precisa autenticar", candidates: [{ key: "TREEPM-139", title: "Importar de GitHub", excerpt: "", status: "done" }] },
      ],
    });
    for (const leak of ["5f0e2d6e", "Maria", "segredo", "assignee", "comments"]) expect(message!.content, leak).not.toContain(leak);
  });

  it("devolve a resposta por índice e o modelo que respondeu", async () => {
    const out = await new ClaudeTicketElaborator(streamer(ok(answer, { model: "claude-opus-4-8" }))).matchExisting(match);
    expect(out).toEqual({ answers: [{ index: 0, existing: "TREEPM-144" }, { index: 1, existing: null }], model: "claude-opus-4-8" });
  });

  it.each([
    ["recusa", ok(undefined, { stop_reason: "refusal" })],
    ["saída fora do formato", ok({ matches: 3 })],
    ["saída nula", ok(null)],
  ])("%s vira assistant_unavailable", async (_n, response) => {
    await expect(new ClaudeTicketElaborator(streamer(response)).matchExisting(match)).rejects.toBeInstanceOf(AssistantUnavailableError);
  });

  it("prazo próprio: estourar cancela a chamada; sinal abortado rejeita logo", async () => {
    const captured: Captured[] = [];
    await expect(new ClaudeTicketElaborator(streamer(() => new Promise(() => undefined), captured), { matchTimeoutMs: 20 }).matchExisting(match)).rejects.toMatchObject({ reason: "timeout" });
    expect(captured[0]!.options.signal.aborted).toBe(true);
    const controller = new AbortController();
    const pending = new ClaudeTicketElaborator(streamer(() => new Promise(() => undefined)), { matchTimeoutMs: 60_000 }).matchExisting(match, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AssistantUnavailableError);
  });
});
