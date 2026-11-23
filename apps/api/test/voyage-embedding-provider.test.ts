import { describe, expect, it } from "vitest";
import { EmbeddingError } from "../src/assistant/ports.js";
import { VoyageEmbeddingProvider } from "../src/assistant/voyage-embedding-provider.js";

type Call = { url: string; init: RequestInit; body: { input: string[]; model: string; input_type: string; output_dimension: number } };

const vector = (seed: number): number[] => Array.from({ length: 512 }, (_, i) => (i === seed % 512 ? 1 : 0));
const okBody = (n: number, offset = 0, extra: Record<string, unknown> = {}) => ({
  object: "list",
  // Fora de ordem de propósito: o adaptador usa o `index`.
  data: Array.from({ length: n }, (_, i) => ({ object: "embedding", embedding: vector(offset + i), index: i })).reverse(),
  model: "voyage-4-lite",
  usage: { total_tokens: 9 },
  ...extra,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function setup(reply: (call: Call, n: number) => Response | Promise<Response>, options: { timeoutMs?: number } = {}) {
  const calls: Call[] = [];
  const fetchFake = (async (url: string, init: RequestInit) => {
    const call: Call = { url, init, body: JSON.parse(init.body as string) };
    calls.push(call);
    return reply(call, calls.length);
  }) as unknown as typeof fetch;
  return { calls, provider: new VoyageEmbeddingProvider({ apiKey: "chave-secreta-xyz", fetch: fetchFake, ...options }) };
}

describe("VoyageEmbeddingProvider: a requisição", () => {
  it("manda exatamente o corpo e os cabeçalhos da ADR", async () => {
    const { calls, provider } = setup((call) => json(200, okBody(call.body.input.length)));
    const result = await provider.embed(["Primeiro texto", "Segundo texto"], "document");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers).toEqual({ Authorization: "Bearer chave-secreta-xyz", "Content-Type": "application/json" });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ input: ["Primeiro texto", "Segundo texto"], model: "voyage-4-lite", input_type: "document", output_dimension: 512 });
    expect(Object.keys(JSON.parse(calls[0]?.init.body as string))).toEqual(["input", "model", "input_type", "output_dimension"]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(vector(0));
    expect(result[1]).toEqual(vector(1));
  });

  it("não segue redirecionamento (o corpo com texto de tickets não pode ser reenviado a outro destino) e expõe o modelo", async () => {
    const { calls, provider } = setup((call) => json(200, okBody(call.body.input.length)));
    await provider.embed(["x"], "document");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(provider.model).toBe("voyage-4-lite");
  });

  it("a consulta usa input_type query", async () => {
    const { calls, provider } = setup((call) => json(200, okBody(call.body.input.length)));
    await provider.embed(["Pedido"], "query");
    expect(calls[0]?.body.input_type).toBe("query");
  });

  it("sem textos não chama a Voyage", async () => {
    const { calls, provider } = setup(() => json(200, okBody(0)));
    expect(await provider.embed([], "document")).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("divide em lotes de até 128 textos, em ordem, e junta o resultado na ordem dos textos", async () => {
    let offset = 0;
    const { calls, provider } = setup((call) => {
      const response = json(200, okBody(call.body.input.length, offset));
      offset += call.body.input.length;
      return response;
    });
    const texts = Array.from({ length: 300 }, (_, i) => `texto ${i}`);
    const result = await provider.embed(texts, "document");
    expect(calls.map((call) => call.body.input.length)).toEqual([128, 128, 44]);
    expect(calls[1]?.body.input[0]).toBe("texto 128");
    expect(result).toHaveLength(300);
    expect(result[299]).toEqual(vector(299));
  });
});

describe("VoyageEmbeddingProvider: as falhas viram códigos curtos, sem texto", () => {
  const failure = async (reply: Parameters<typeof setup>[0], options?: { timeoutMs?: number }) => {
    const { provider } = setup(reply, options);
    const error = await provider.embed(["Texto muito confidencial do ticket"], "document").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmbeddingError);
    const text = JSON.stringify([(error as Error).message, (error as Error).stack, Object.entries(error as object)]);
    expect(text).not.toContain("confidencial");
    expect(text).not.toContain("chave-secreta-xyz");
    expect(text).not.toContain("detalhe-do-corpo");
    return (error as EmbeddingError).code;
  };

  it.each([
    [401, "unauthorized"],
    [403, "unauthorized"],
    [400, "bad_request"],
    [429, "rate_limited"],
    [500, "server_error"],
    [503, "server_error"],
  ])("HTTP %i vira %s", async (status, code) => {
    expect(await failure(() => json(status, { detail: "detalhe-do-corpo Texto muito confidencial" }))).toBe(code);
  });

  it("o prazo por chamada vira timeout", async () => {
    const code = await failure((call) => new Promise<Response>((_resolve, reject) => (call.init.signal as AbortSignal).addEventListener("abort", () => reject((call.init.signal as AbortSignal).reason))), { timeoutMs: 20 });
    expect(code).toBe("timeout");
  });

  it("o sinal de quem chama também interrompe", async () => {
    const controller = new AbortController();
    const { provider } = setup((call) => new Promise<Response>((_resolve, reject) => (call.init.signal as AbortSignal).addEventListener("abort", () => reject((call.init.signal as AbortSignal).reason))));
    const pending = provider.embed(["x"], "document", { signal: controller.signal }).catch((e: unknown) => e);
    controller.abort();
    expect(((await pending) as EmbeddingError).code).toBe("timeout");
  });

  it("redirecionamento (o fetch recusa com redirect: error) vira network, sem texto", async () => {
    expect(await failure((call) => (call.init.redirect === "error" ? Promise.reject(new TypeError("fetch failed: redirect mode is set to error: https://outro.exemplo/Texto muito confidencial")) : json(307, {})))).toBe("network");
  });

  it("falha de rede vira network", async () => {
    expect(await failure(() => Promise.reject(new TypeError("fetch failed Texto muito confidencial")))).toBe("network");
  });

  it.each([
    ["corpo que não é JSON", () => new Response("<html>detalhe-do-corpo</html>", { status: 200 })],
    ["sem data", () => json(200, { object: "list" })],
    ["menos vetores que textos", () => json(200, okBody(0))],
    ["vetor curto", () => json(200, { data: [{ embedding: [0.1, 0.2], index: 0 }] })],
    ["número que não é finito", () => json(200, { data: [{ embedding: [...vector(0).slice(1), null], index: 0 }] })],
    ["valor que não é número", () => json(200, { data: [{ embedding: [...vector(0).slice(1), "1"], index: 0 }] })],
    ["índice repetido", () => json(200, { data: [{ embedding: vector(0), index: 0 }, { embedding: vector(1), index: 0 }] })],
    ["índice fora da faixa", () => json(200, { data: [{ embedding: vector(0), index: 7 }] })],
  ])("resposta malformada (%s) vira malformed", async (_name, reply) => {
    expect(await failure(reply)).toBe("malformed");
  });

  it("vetores demais também é malformado", async () => {
    expect(await failure(() => json(200, okBody(2)))).toBe("malformed");
  });
});
