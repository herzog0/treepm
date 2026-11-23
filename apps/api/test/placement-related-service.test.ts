import { describe, expect, it } from "vitest";
import { PlacementService } from "../src/assistant/placement.service.js";
import type { PlacementSnapshot } from "../src/assistant/placement.service.js";
import { relatedInputFits } from "../src/assistant/jev-related-judge.js";
import { FakeRelatedJudge } from "./assistant-fakes.js";

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
