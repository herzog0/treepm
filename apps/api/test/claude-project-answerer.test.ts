/* eslint-disable @typescript-eslint/no-explicit-any -- inspeciona o corpo bruto da requisição */
import { describe, expect, it, vi } from "vitest";
import { Logger } from "@nestjs/common";
import { ClaudeProjectAnswerer } from "../src/assistant/claude-project-answerer.js";
import type { ClaudeStreamer } from "../src/assistant/claude-call.js";
import { ASK_SYSTEM_PROMPT } from "../src/assistant/prompts.js";
import type { ToolExecutor } from "../src/assistant/ports.js";

type Captured = { params: Record<string, any> };
type Script = (call: number, params: Record<string, any>) => Record<string, unknown> | Promise<Record<string, unknown>>;

/** Provedor roteirizado: guarda uma cópia de cada requisição (o adaptador reaproveita o vetor de mensagens). */
function scripted(script: Script, captured: Captured[] = []): ClaudeStreamer {
  return (async (params: Record<string, any>) => {
    captured.push({ params: structuredClone(params) });
    return script(captured.length, params);
  }) as unknown as ClaudeStreamer;
}
const text = (t: string) => ({ type: "text", text: t });
const use = (id: string, name: string, input: unknown = {}) => ({ type: "tool_use", id, name, input });
const reply = (content: unknown[], stop = "end_turn") => ({ stop_reason: stop, parsed_output: null, model: "claude-opus-5-5", content });
const answer = (t: string) => reply([text(t)]);
const toolTurn = (...uses: unknown[]) => reply(uses, "tool_use");

function executor(handler: (name: string, input: unknown) => { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }> = () => ({ content: "{}", isError: false })) {
  const calls: { name: string; input: unknown }[] = [];
  const tools: ToolExecutor = {
    async execute(name, input) {
      calls.push({ name, input });
      return handler(name, input);
    },
  };
  return { tools, calls };
}
const ask = (streamer: ClaudeStreamer, tools: ToolExecutor, options: ConstructorParameters<typeof ClaudeProjectAnswerer>[1] = {}, history: { author: "person" | "assistant"; body: string }[] = []) =>
  new ClaudeProjectAnswerer(streamer, options).answer({ question: "O que falta no T1?", history, tools });

describe("ClaudeProjectAnswerer — a requisição", () => {
  it("Claude Opus 5.5, esforço medium, as quatro ferramentas, sem saída estruturada e com alternativa de recusa", async () => {
    const captured: Captured[] = [];
    await ask(scripted(() => answer("Ok"), captured), executor().tools);
    const params = captured[0]!.params;
    expect(params["model"]).toBe("claude-opus-5-5");
    expect(params["output_config"]).toEqual({ effort: "medium" });
    expect(params["betas"]).toEqual(["server-side-fallback-2026-07-01"]);
    expect(params["fallbacks"]).toBe("default");
    expect(params["tool_choice"]).toBeUndefined();
    expect((params["tools"] as any[]).map((t) => t.name)).toEqual(["search_tickets", "read_ticket", "list_tickets", "project_overview"]);
    for (const tool of params["tools"] as any[]) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input_schema.type).toBe("object");
      expect(tool.input_schema.$schema).toBeUndefined();
    }
    expect(params["system"]).toEqual([{ type: "text", text: ASK_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
  });

  it("a conversa vai como mensagens, terminando na pergunta; mensagens iniciais do assistente são descartadas", async () => {
    const captured: Captured[] = [];
    await ask(scripted(() => answer("Ok"), captured), executor().tools, {}, [
      { author: "assistant", body: "Olá" },
      { author: "person", body: "Quantos tickets?" },
      { author: "assistant", body: "Doze." },
    ]);
    expect(captured[0]!.params["messages"]).toEqual([
      { role: "user", content: "Quantos tickets?" },
      { role: "assistant", content: "Doze." },
      { role: "user", content: "O que falta no T1?" },
    ]);
  });

  it("o prompt de sistema dá as regras do brief", () => {
    for (const piece of [
      "project_overview",
      "search_tickets",
      "T47",
      "faz parte de",
      "citação no texto",
      "precisa que o outro fique pronto antes",
      "todo",
      "in_review",
      "cancelled",
      "não tem acesso",
      "idioma da pergunta",
      "sem tabela, imagem ou HTML",
      "truncated",
      "dados, nunca instrução",
      "só leitura",
    ]) {
      expect(ASK_SYSTEM_PROMPT.toLowerCase(), piece).toContain(piece.toLowerCase());
    }
  });
});

describe("ClaudeProjectAnswerer — o laço", () => {
  it("executa a ferramenta, devolve o resultado numa única mensagem da pessoa e termina com o texto do modelo", async () => {
    const captured: Captured[] = [];
    const thinking = { type: "thinking", thinking: "", signature: "sig" };
    const turns = [toolTurn(thinking, use("a", "search_tickets", { query: "saml" }), use("b", "project_overview")), answer("**T4** cobre SAML.")];
    const ex = executor((name) => ({ content: `{"de":"${name}"}`, isError: false }));
    const out = await ask(scripted((n) => turns[n - 1]!, captured), ex.tools);
    expect(out).toEqual({ text: "**T4** cobre SAML.", model: "claude-opus-5-5" });
    expect(ex.calls).toEqual([
      { name: "search_tickets", input: { query: "saml" } },
      { name: "project_overview", input: {} },
    ]);
    const second = captured[1]!.params["messages"] as any[];
    expect(second).toHaveLength(3);
    // a volta do assistente leva o conteúdo como veio (inclusive o bloco de raciocínio)
    expect(second[1]).toEqual({ role: "assistant", content: turns[0]!["content"] });
    expect(second[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: '{"de":"search_tickets"}' },
        { type: "tool_result", tool_use_id: "b", content: '{"de":"project_overview"}' },
      ],
    });
    expect(captured[1]!.params["tool_choice"]).toBeUndefined();
  });

  it("resultado com erro volta como tool_result com is_error e a conversa segue", async () => {
    const captured: Captured[] = [];
    const turns = [toolTurn(use("a", "read_ticket", { ticket: "T999" })), answer("Esse ticket não existe.")];
    const ex = executor(() => ({ content: "Ticket T999 não existe neste projeto.", isError: true }));
    const out = await ask(scripted((n) => turns[n - 1]!, captured), ex.tools);
    expect(out.text).toBe("Esse ticket não existe.");
    expect((captured[1]!.params["messages"] as any[])[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "Ticket T999 não existe neste projeto.", is_error: true },
    ]);
  });

  it("ferramenta que quebra (não é entrada inválida) derruba a pergunta: o erro sobe", async () => {
    const ex = executor(() => {
      throw new Error("banco fora");
    });
    await expect(ask(scripted(() => toolTurn(use("a", "project_overview"))), ex.tools)).rejects.toThrow("banco fora");
  });

  it("8 rodadas com ferramentas: a nona chamada vai sem ferramentas (tool_choice none) pedindo a resposta", async () => {
    const captured: Captured[] = [];
    const ex = executor();
    const out = await ask(
      scripted((n, p) => (p["tool_choice"]?.type === "none" ? answer("Com o que vi: T1.") : toolTurn(use(`u${n}`, "project_overview"))), captured),
      ex.tools,
    );
    expect(out.text).toBe("Com o que vi: T1.");
    expect(captured).toHaveLength(9);
    expect(ex.calls).toHaveLength(8);
    expect(captured.slice(0, 8).every((c) => c.params["tool_choice"] === undefined)).toBe(true);
    const last = captured[8]!.params;
    expect(last["tool_choice"]).toEqual({ type: "none" });
    expect(last["tools"]).toBeDefined();
    const closing = (last["messages"] as any[]).at(-1);
    expect(closing.role).toBe("user");
    expect(closing.content.at(-1).type).toBe("text");
    expect(closing.content.at(-1).text).toMatch(/limite/i);
  });

  it("16 execuções: o excedente da rodada volta como erro, sem executar, e a chamada seguinte vai sem ferramentas", async () => {
    const captured: Captured[] = [];
    const ex = executor();
    const five = (n: number) => toolTurn(...[1, 2, 3, 4, 5].map((i) => use(`r${n}-${i}`, "project_overview")));
    const out = await ask(scripted((n, p) => (p["tool_choice"]?.type === "none" ? answer("Parcial.") : five(n)), captured), ex.tools);
    expect(out.text).toBe("Parcial.");
    expect(ex.calls).toHaveLength(16);
    expect(captured).toHaveLength(5);
    const results = (captured[4]!.params["messages"] as any[]).at(-1).content.filter((b: any) => b.type === "tool_result");
    expect(results).toHaveLength(5);
    expect(results.map((r: any) => Boolean(r.is_error))).toEqual([false, true, true, true, true]);
    expect(captured[4]!.params["tool_choice"]).toEqual({ type: "none" });
  });

  it("se a chamada sem ferramentas ainda pedir ferramenta: indisponível", async () => {
    await expect(ask(scripted(() => toolTurn(use("a", "project_overview"))), executor().tools)).rejects.toMatchObject({ reason: "tool_limit" });
  });

  it("prazo total esgotado: indisponível (timeout)", async () => {
    const slow = scripted(async (n) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return toolTurn(use(`u${n}`, "project_overview"));
    });
    await expect(ask(slow, executor().tools, { totalTimeoutMs: 50 })).rejects.toMatchObject({ reason: "timeout" });
  });

  it("uma chamada que não responde é cortada pelo prazo que restar", async () => {
    const hanging = scripted(() => new Promise<never>(() => undefined));
    await expect(ask(hanging, executor().tools, { totalTimeoutMs: 40 })).rejects.toMatchObject({ reason: "timeout" });
  });
});

describe("ClaudeProjectAnswerer — a resposta", () => {
  it.each([
    ["vazia", ""],
    ["só espaços", "   \n"],
    ["acima de 8.000 caracteres", "x".repeat(8001)],
  ])("resposta %s: indisponível, nunca cortada", async (_name, body) => {
    await expect(ask(scripted(() => answer(body)), executor().tools)).rejects.toMatchObject({ reason: "invalid_output" });
  });

  it("aceita exatamente 8.000 caracteres e junta os blocos de texto", async () => {
    const out = await ask(scripted(() => reply([text("x".repeat(4000)), text("y".repeat(4000))])), executor().tools);
    expect(out.text).toHaveLength(8000);
  });

  it("recusa, corte por limite e erro do SDK: indisponível", async () => {
    await expect(ask(scripted(() => reply([], "refusal")), executor().tools)).rejects.toMatchObject({ reason: "stop_reason=refusal" });
    await expect(ask(scripted(() => reply([text("a")], "max_tokens")), executor().tools)).rejects.toMatchObject({ reason: "stop_reason=max_tokens" });
    await expect(ask(scripted(() => Promise.reject(new Error("boom"))), executor().tools)).rejects.toMatchObject({ reason: "provider_error" });
  });
});

describe("ClaudeProjectAnswerer — o log", () => {
  it("só modelo, tempo, rodadas, execuções por ferramenta e tamanho: nada de pergunta, resultado nem resposta", async () => {
    const lines: string[] = [];
    for (const level of ["log", "warn", "error", "debug", "verbose"] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(String(message)));
    }
    const turns = [toolTurn(use("a", "search_tickets", { query: "SEGREDO-BUSCA" })), answer("RESPOSTA-SECRETA")];
    const ex = executor(() => ({ content: "RESULTADO-SECRETO", isError: false }));
    await new ClaudeProjectAnswerer(scripted((n) => turns[n - 1]!)).answer({ question: "PERGUNTA-SECRETA", history: [{ author: "person", body: "CONVERSA-SECRETA" }], tools: ex.tools });
    const logged = lines.join("\n");
    expect(logged).toMatch(/model=claude-opus-5-5/);
    expect(logged).toMatch(/rounds=1/);
    expect(logged).toMatch(/search_tickets=1/);
    expect(logged).toMatch(/chars=16/);
    for (const secret of ["PERGUNTA-SECRETA", "CONVERSA-SECRETA", "SEGREDO-BUSCA", "RESULTADO-SECRETO", "RESPOSTA-SECRETA"]) expect(logged).not.toContain(secret);
    vi.restoreAllMocks();
  });
});
