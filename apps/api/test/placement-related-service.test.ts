import { describe, expect, it } from "vitest";
import { PlacementService } from "../src/assistant/placement.service.js";
import type { PlacementSnapshot } from "../src/assistant/placement.service.js";
import { relatedInputFits } from "../src/assistant/jev-related-judge.js";
import { FakeRelatedJudge } from "./assistant-fakes.js";
import type { SemanticSearch } from "../src/assistant/semantic-triage.js";

// ADR 0052, item 2: se a requisição ao Jev não couber, cortam-se os candidatos de menor pontuação.
const service = new PlacementService();
const draft = { title: "Webhook de saída", description: "Avisar outro sistema", partTitles: [] as string[] };
const ticket = (n: number, title: string) => ({ id: `t${n}`, parentId: null, number: n, title, description: "", status: "todo" });
const snapshotOf = (tickets: ReturnType<typeof ticket>[]): PlacementSnapshot => ({ projectId: "p", projectName: "P", tickets, notes: new Map() });

describe("findRelated", () => {
  it("corta os de menor pontuação quando a requisição não cabe", async () => {
    // Trinta candidatos com título enorme (a triagem os acha todos); os mais bem pontuados têm o termo no título e são os primeiros.
    const huge = "x".repeat(5000);
    const tickets = Array.from({ length: 30 }, (_, i) => ticket(i + 1, `${i < 3 ? "Webhook webhook" : "Saída"} ${huge}`));
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf(tickets), { related: judge });
    expect(found.failed).toBe(false);
    const sent = judge.calls[0]!.candidates;
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(30);
    expect(relatedInputFits({ draft: { title: draft.title, description: draft.description }, candidates: sent })).toBe(true);
    // O corte tira do fim da lista da triagem: os três de maior pontuação ficam.
    expect(sent.slice(0, 3).map((c) => c.id).sort()).toEqual(["t1", "t2", "t3"]);
    expect(found.judged.map((entry) => entry.id)).toEqual(sent.map((c) => c.id));
  });

  it("nada cabe: não chama o Jev e segue sem relacionados", async () => {
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf([ticket(1, `Webhook ${"x".repeat(200_000)}`)]), { related: judge });
    expect(found).toEqual({ judged: [], failed: false });
    expect(judge.calls).toHaveLength(0);
  });

  it("falha do Jev: devolve failed e nenhum julgamento", async () => {
    const judge = new FakeRelatedJudge();
    judge.fail = true;
    expect(await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge })).toEqual({ judged: [], failed: true });
  });

  it("prazo estourado: o mesmo, no tempo pedido", async () => {
    const judge = new FakeRelatedJudge();
    judge.hang = true;
    const started = Date.now();
    expect(await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, timeoutMs: 100 })).toEqual({ judged: [], failed: true });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("exceção na triagem vira sem relacionados, não erro (ponto 7)", async () => {
    const judge = new FakeRelatedJudge();
    const broken = { ...snapshotOf([ticket(1, "Webhook")]), tickets: null as unknown as ReturnType<typeof ticket>[] };
    expect(await service.findRelated(draft, broken, { related: judge })).toEqual({ judged: [], failed: true });
  });

  it("a triagem não depende da ordem em que a consulta devolve os tickets (ponto 9)", async () => {
    const tickets = Array.from({ length: 40 }, (_, i) => ticket(i + 1, "Webhook"));
    const a = new FakeRelatedJudge();
    const b = new FakeRelatedJudge();
    await service.findRelated(draft, snapshotOf(tickets), { related: a });
    await service.findRelated(draft, snapshotOf([...tickets].reverse()), { related: b });
    expect(b.calls[0]!.candidates.map((c) => c.id)).toEqual(a.calls[0]!.candidates.map((c) => c.id));
  });

  it("o sinal de fora aborta a requisição (ponto 7)", async () => {
    const judge = new FakeRelatedJudge();
    judge.hang = true;
    const outside = new AbortController();
    const pending = service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, signal: outside.signal });
    outside.abort();
    expect(await pending).toEqual({ judged: [], failed: true });
  });
});

// ADR 0053, item 7: a fusão da triagem por palavras com os vizinhos por vetor entrega até 30 candidatos ao Jev.
describe("findRelated com vizinhos por vetor", () => {
  const diag = { synced: 5, embedded: 1, pending: 0, syncMs: 3, queryMs: 4 };
  const semanticOf = (ids: string[], extra: Partial<typeof diag & { failure: "timeout" }> = {}): SemanticSearch & { calls: { queries: unknown[]; k: number; deadlineMs: number | undefined }[] } => {
    const calls: { queries: unknown[]; k: number; deadlineMs: number | undefined }[] = [];
    const search = ((queries, k, options) => {
      calls.push({ queries: [...queries], k, deadlineMs: options.deadlineMs });
      return Promise.resolve({ neighbours: [ids.map((ticketId, i) => ({ ticketId, distance: i / 10 }))], diagnostics: { ...diag, ...extra } });
    }) as SemanticSearch & { calls: typeof calls };
    search.calls = calls;
    return search;
  };

  it("candidato que só o vetor acha chega ao Jev e pode virar relacionado", async () => {
    const tickets = [ticket(1, "Webhook de saída"), ticket(2, "Reimportar sem duplicar: guardar a origem")];
    const judge = new FakeRelatedJudge();
    judge.verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.id === "t2" ? 0.95 : 0.1, sameRequest: 0 }]));
    const found = await service.findRelated(draft, snapshotOf(tickets), { related: judge, semantic: semanticOf(["t2"]) });
    expect(judge.calls[0]!.candidates.map((c) => c.id)).toEqual(["t1", "t2"]);
    expect(found.judged.find((entry) => entry.id === "t2")?.sameSubject).toBe(0.95);
    expect(found.triage).toMatchObject({ words: 1, vector: 1, both: 0, onlyVector: 1, sent: 2, semantic: diag });
  });

  it("a consulta é o título e a descrição do rascunho: sem títulos das partes, k = 30 e o prazo do passo", async () => {
    const semantic = semanticOf([]);
    await service.findRelated({ ...draft, partTitles: ["Parte secreta"] }, snapshotOf([ticket(1, "Webhook")]), { related: new FakeRelatedJudge(), semantic });
    expect(semantic.calls).toHaveLength(1);
    expect(semantic.calls[0]!.queries).toEqual([{ title: draft.title, description: draft.description }]);
    expect(semantic.calls[0]!.k).toBe(30);
    expect(semantic.calls[0]!.deadlineMs).toBeLessThanOrEqual(5000);
  });

  it("com a união dentro de 30, nenhum achado por palavras some; a ordem é a da fusão", async () => {
    const tickets = [ticket(1, "Webhook"), ticket(2, "Webhook saída"), ticket(3, "Outro assunto"), ticket(4, "Mais um")];
    const judge = new FakeRelatedJudge();
    await service.findRelated(draft, snapshotOf(tickets), { related: judge, semantic: semanticOf(["t3", "t2"]) });
    const sent = judge.calls[0]!.candidates.map((c) => c.id);
    expect(new Set(sent)).toEqual(new Set(["t1", "t2", "t3"]));
    expect(sent[0]).toBe("t2"); // nas duas listas
  });

  it("com mais de 30 na união, o corte é por nota: nunca mais de 30 vão ao Jev", async () => {
    const tickets = [...Array.from({ length: 30 }, (_, i) => ticket(i + 1, "Webhook")), ...Array.from({ length: 30 }, (_, i) => ticket(i + 101, "Outro assunto"))];
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf(tickets), { related: judge, semantic: semanticOf(Array.from({ length: 30 }, (_, i) => `t${i + 101}`)) });
    expect(judge.calls[0]!.candidates).toHaveLength(30);
    expect(found.triage).toMatchObject({ words: 30, vector: 30, sent: 30, onlyVector: 15 });
  });

  it("vizinho fora da árvore da procura é ignorado", async () => {
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, semantic: semanticOf(["fora", "t1"]) });
    expect(judge.calls[0]!.candidates.map((c) => c.id)).toEqual(["t1"]);
    expect(found.triage).toMatchObject({ vector: 1, both: 1, onlyVector: 0 });
  });

  it("o corte por tamanho continua tirando do fim da lista fundida", async () => {
    const huge = "x".repeat(5000);
    const tickets = [ticket(1, `Webhook webhook ${huge}`), ...Array.from({ length: 29 }, (_, i) => ticket(i + 2, `Saída ${huge}`)), ticket(200, `Vetor ${huge}`)];
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf(tickets), { related: judge, semantic: semanticOf(["t200"]) });
    const sent = judge.calls[0]!.candidates.map((c) => c.id);
    expect(sent.length).toBeLessThan(30);
    expect(sent[0]).toBe("t1");
    expect(found.triage?.sent).toBe(sent.length);
  });

  it("falha do passo de vetor: o mesmo resultado de só palavras, com o código no diagnóstico", async () => {
    const tickets = [ticket(1, "Webhook"), ticket(2, "Webhook saída")];
    const withFailure = new FakeRelatedJudge();
    const wordsOnly = new FakeRelatedJudge();
    const failing: SemanticSearch = () => Promise.resolve({ neighbours: [[]], diagnostics: { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "timeout" } });
    const a = await service.findRelated(draft, snapshotOf(tickets), { related: withFailure, semantic: failing });
    const b = await service.findRelated(draft, snapshotOf(tickets), { related: wordsOnly });
    expect(withFailure.calls[0]!.candidates).toEqual(wordsOnly.calls[0]!.candidates);
    expect(a.judged).toEqual(b.judged);
    expect(a.triage).toMatchObject({ vector: 0, onlyVector: 0, semantic: { failure: "timeout" } });
    expect(b.triage).toBeUndefined();
  });

  it("a fonte que lança nunca derruba a busca", async () => {
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, semantic: () => Promise.reject(new Error("boom")) });
    expect(found.failed).toBe(false);
    expect(judge.calls).toHaveLength(1);
    expect(found.triage?.semantic.failure).toBe("storage");
  });

  it("sem tempo para o passo de vetor (prazo da etapa curto): pula, sem chamar a fonte", async () => {
    const semantic = semanticOf(["t1"]);
    const judge = new FakeRelatedJudge();
    judge.hang = true;
    const found = await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, semantic, timeoutMs: 0 });
    expect(semantic.calls).toHaveLength(0);
    expect(found.failed).toBe(true);
  });

  it("o prazo da etapa vale para tudo: passo de vetor lento + Jev não passam do prazo total", async () => {
    const slow: SemanticSearch = (_queries, _k, options) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ neighbours: [[]], diagnostics: { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0 } }), 5000);
        options.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve({ neighbours: [[]], diagnostics: { synced: 0, embedded: 0, pending: 0, syncMs: 0, queryMs: 0, failure: "timeout" } })));
      });
    const judge = new FakeRelatedJudge();
    judge.hang = true;
    const started = Date.now();
    const found = await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, semantic: slow, timeoutMs: 300 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(found.failed).toBe(true);
  });

  it("o corte por tamanho tira primeiro os que vieram só do vetor, do fim para o começo, depois os demais", async () => {
    const huge = "x".repeat(5000);
    const words = Array.from({ length: 8 }, (_, i) => ticket(i + 1, `Webhook webhook ${huge}`));
    const vectorOnly = Array.from({ length: 8 }, (_, i) => ticket(i + 101, `Outro ${huge}`));
    const judge = new FakeRelatedJudge();
    await service.findRelated(draft, snapshotOf([...words, ...vectorOnly]), { related: judge, semantic: semanticOf(vectorOnly.map((t) => t.id)) });
    const sent = judge.calls[0]!.candidates.map((c) => c.id);
    expect(sent.length).toBeLessThan(16);
    // Todos os de palavras ficam enquanto houver só-vetor para cortar.
    const keptWords = sent.filter((id) => !id.startsWith("t10"));
    const keptVector = sent.filter((id) => id.startsWith("t10"));
    if (keptVector.length > 0) expect(keptWords).toHaveLength(8);
    // O que sobra do vetor é o começo da lista do vetor (corta do fim).
    expect(keptVector).toEqual(vectorOnly.slice(0, keptVector.length).map((t) => t.id));
  });

  it("sem candidato por palavras nem por vetor: nenhuma chamada ao Jev e failed false", async () => {
    const judge = new FakeRelatedJudge();
    const found = await service.findRelated({ ...draft, title: "Zzzz qqqq", description: "xxxx" }, snapshotOf([ticket(1, "Outro assunto")]), { related: judge, semantic: semanticOf([]) });
    expect(judge.calls).toHaveLength(0);
    expect(found).toMatchObject({ judged: [], failed: false });
  });

  it("fonte que trava: a busca segue só com palavras dentro do prazo do passo", async () => {
    const judge = new FakeRelatedJudge();
    const started = Date.now();
    const found = await service.findRelated(draft, snapshotOf([ticket(1, "Webhook")]), { related: judge, semantic: () => new Promise(() => undefined), timeoutMs: 20_000, semanticDeadlineMs: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(judge.calls[0]!.candidates.map((c) => c.id)).toEqual(["t1"]);
    expect(found.triage?.semantic.failure).toBe("timeout");
  });
});
