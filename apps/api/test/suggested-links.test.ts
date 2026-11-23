import { describe, expect, it } from "vitest";
import { linkExistingSuggestions, SUGGESTED_CANDIDATES, SUGGESTED_LINK_MIN } from "../src/assistant/suggested-links.js";
import type { LookupTicket } from "../src/assistant/suggested-links.js";
import type { ElaborationLink, ElaborationSuggestion, RelatedInput, RelatedJudge, RelatedJudgment } from "../src/assistant/ports.js";
import { AssistantUnavailableError } from "../src/assistant/ports.js";

// ADR 0052, item 4 (R4): a tarefa sugerida que já existe na árvore vira ligação.
const tree: LookupTicket[] = [
  { id: "t1", number: 1, title: "Reimportar sem duplicar: guardar a origem de cada ticket", description: "Guardar o vínculo de cada ticket com o item externo, para não duplicar ao sincronizar." },
  { id: "t2", number: 2, title: "Tela de ajustes do projeto", description: "Preferências gerais." },
  { id: "t3", number: 3, title: "Importar tickets de Jira", description: "Importar por lista, uma vez." },
];
const task = (title: string, motivo = "o pedido precisa disto", description = "Guardar o vínculo com o item externo"): ElaborationSuggestion => ({ title, description, motivo });
const link = (dependeDe: string, de: ElaborationLink["de"] = "pai", motivo = "m"): ElaborationLink => ({ de, dependeDe, motivo });

class ByTitle implements RelatedJudge {
  readonly calls: RelatedInput[] = [];
  fail: ((input: RelatedInput) => boolean) | null = null;
  constructor(private readonly odds: Record<string, number>, private readonly onlyIf: (draftTitle: string) => boolean = () => true) {}
  async judge(input: RelatedInput): Promise<Record<string, RelatedJudgment>> {
    this.calls.push(structuredClone(input) as RelatedInput);
    if (this.fail?.(input)) throw new AssistantUnavailableError("fake");
    return Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0.5, sameRequest: this.onlyIf(input.draft.title) ? (this.odds[c.title] ?? 0) : 0 }]));
  }
}
const base = { tree, projectKey: "P", duplicateKey: null as string | null };
const REIMPORT = "Reimportar sem duplicar: guardar a origem de cada ticket";
const run = (judge: RelatedJudge, over: { links?: ElaborationLink[]; suggested?: ElaborationSuggestion[]; duplicateKey?: string | null; tree?: LookupTicket[]; signal?: AbortSignal } = {}) =>
  linkExistingSuggestions({ ...base, links: [], suggested: [task("Guardar o vínculo entre cada ticket e o item na plataforma externa")], judge, ...over });

describe("tarefa sugerida que já existe", () => {
  it("vira ligação do pai e sai das sugeridas, com o motivo da sugerida", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }), { suggested: [task("Guardar o vínculo externo", "sem vínculo não há diff")] });
    expect(out.links).toEqual([{ de: "pai", dependeDe: "P-1", motivo: "sem vínculo não há diff" }]);
    expect(out.suggested).toEqual([]);
    expect(out.titles.get("P-1")).toBe(REIMPORT);
  });

  it("sem equivalente na árvore, continua sugerida", async () => {
    const out = await run(new ByTitle({}));
    expect(out.links).toEqual([]);
    expect(out.suggested).toHaveLength(1);
  });

  it("o limiar é 0,7: 0,69 não liga, 0,7 liga", async () => {
    expect(SUGGESTED_LINK_MIN).toBe(0.7);
    expect((await run(new ByTitle({ [REIMPORT]: 0.69 }))).links).toEqual([]);
    expect((await run(new ByTitle({ [REIMPORT]: 0.7 }))).links).toHaveLength(1);
  });

  it("vale o candidato de maior sameRequest", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.75, "Importar tickets de Jira": 0.95 }), { suggested: [task("Importar e guardar o vínculo externo do Jira")] });
    expect(out.links.map((l) => l.dependeDe)).toEqual(["P-3"]);
  });

  it("o duplicado nunca é alvo: nem vai ao Jev nem recebe ligação", async () => {
    const judge = new ByTitle({ [REIMPORT]: 0.99 });
    const out = await run(judge, { duplicateKey: "P-1" });
    expect(out.links).toEqual([]);
    expect(out.suggested).toHaveLength(1);
    expect(JSON.stringify(judge.calls)).not.toContain("Reimportar");
  });

  it("ligação que já existe na resposta não duplica, e a sugerida sai mesmo assim", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }), { links: [link("P-1", "pai", "do modelo")] });
    expect(out.links).toEqual([link("P-1", "pai", "do modelo")]);
    expect(out.suggested).toEqual([]);
  });

  it("duas sugeridas para o mesmo ticket dão uma ligação só", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }), { suggested: [task("Guardar o vínculo externo A"), task("Guardar o vínculo externo B")] });
    expect(out.links).toHaveLength(1);
    expect(out.suggested).toEqual([]);
  });

  it("no limite de 5 ligações a sugerida é só descartada, não volta como tarefa", async () => {
    const full = ["P-5", "P-6", "P-7", "P-8", "P-9"].map((key) => link(key));
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }), { links: full });
    expect(out.links).toEqual(full);
    expect(out.suggested).toEqual([]);
  });

  it("só as que não existem continuam sugeridas, na ordem", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }, (title) => title.includes("vínculo")), {
      suggested: [task("Cadastrar o provedor externo"), task("Guardar o vínculo externo"), task("Escrever a documentação do diff")],
    });
    expect(out.suggested.map((s) => s.title)).toEqual(["Cadastrar o provedor externo", "Escrever a documentação do diff"]);
    expect(out.links).toHaveLength(1);
  });
});

describe("o que vai ao Jev", () => {
  it("título e descrição da sugerida e título e trecho dos candidatos, sem ids nem motivo", async () => {
    const judge = new ByTitle({});
    await run(judge, { suggested: [task("Guardar o vínculo externo", "MOTIVO-SECRETO", "Descrição escrita pelo modelo")] });
    expect(judge.calls).toHaveLength(1);
    const call = judge.calls[0] as RelatedInput;
    expect(call.draft).toEqual({ title: "Guardar o vínculo externo", description: "Descrição escrita pelo modelo" });
    for (const candidate of call.candidates) expect(Object.keys(candidate).sort()).toEqual(["excerpt", "id", "title"]);
    const text = JSON.stringify(call);
    expect(text).not.toContain("MOTIVO-SECRETO");
    expect(text).not.toContain("P-1");
  });

  it("até 10 candidatos por sugerida", async () => {
    expect(SUGGESTED_CANDIDATES).toBe(10);
    const many: LookupTicket[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, number: i + 1, title: `Vínculo externo número ${i}`, description: "vínculo externo" }));
    const judge = new ByTitle({});
    await run(judge, { tree: many });
    expect((judge.calls[0] as RelatedInput).candidates).toHaveLength(10);
  });

  it("uma chamada por sugerida (até 5 em paralelo)", async () => {
    const judge = new ByTitle({});
    await run(judge, { suggested: [1, 2, 3].map((n) => task(`Guardar vínculo externo ${n}`)) });
    expect(judge.calls).toHaveLength(3);
  });

  it("sem candidato na triagem, não chama o Jev", async () => {
    const judge = new ByTitle({});
    const out = await run(judge, { suggested: [task("Zzzz qqqq xxxx", "m", "")] });
    expect(judge.calls).toHaveLength(0);
    expect(out.suggested).toHaveLength(1);
  });
});

describe("robustez", () => {
  it("falha do Jev devolve as sugeridas e as ligações intactas", async () => {
    const judge = new ByTitle({ [REIMPORT]: 0.9 });
    judge.fail = () => true;
    const suggested = [task("Guardar o vínculo externo")];
    const out = await run(judge, { suggested, links: [link("P-2")] });
    expect(out.suggested).toEqual(suggested);
    expect(out.links).toEqual([link("P-2")]);
    expect(out.failed).toBe(1);
  });

  it("falha numa sugerida não impede a conversão da outra", async () => {
    const judge = new ByTitle({ [REIMPORT]: 0.9 });
    judge.fail = (input) => input.draft.title.includes("quebra");
    const out = await run(judge, { suggested: [task("Guardar o vínculo externo"), task("Guardar o vínculo que quebra")] });
    expect(out.links).toHaveLength(1);
    expect(out.suggested.map((s) => s.title)).toEqual(["Guardar o vínculo que quebra"]);
  });

  it("sinal abortado antes do fim devolve as sugeridas como vieram", async () => {
    const controller = new AbortController();
    const hang: RelatedJudge = { judge: () => new Promise<never>(() => undefined) };
    const pending = run(hang, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const out = await pending;
    expect(out.suggested).toHaveLength(1);
    expect(out.links).toEqual([]);
    expect(out.failed).toBe(1);
  });
});

describe("desfechos por sugerida (diagnostics)", () => {
  const outcomes = async (judge: RelatedJudge, over: Parameters<typeof run>[1] = {}) => (await run(judge, over)).lookups.map((l) => l.outcome);
  it("converted, com candidatos e maior sameRequest", async () => {
    const out = await run(new ByTitle({ [REIMPORT]: 0.9 }));
    expect(out.lookups).toHaveLength(1);
    expect(out.lookups[0]).toMatchObject({ outcome: "converted", maxSameRequest: 0.9 });
    expect(out.lookups[0]!.candidates).toBeGreaterThan(0);
  });
  it("kept: sem equivalente, e sem candidato nenhum", async () => {
    expect(await outcomes(new ByTitle({ [REIMPORT]: 0.2 }))).toEqual(["kept"]);
    const none = await run(new ByTitle({}), { suggested: [task("Zzzz qqqq xxxx", "m", "")] });
    expect(none.lookups[0]).toEqual({ outcome: "kept", candidates: 0, maxSameRequest: null });
  });
  it("dropped_duplicate: o modelo já tinha proposto a mesma ligação", async () => {
    expect(await outcomes(new ByTitle({ [REIMPORT]: 0.9 }), { links: [link("P-1")] })).toEqual(["dropped_duplicate"]);
  });
  it("dropped_repeated_link: outra sugerida desta etapa já ligou ao mesmo ticket", async () => {
    expect(await outcomes(new ByTitle({ [REIMPORT]: 0.9 }), { suggested: [task("Guardar o vínculo externo A"), task("Guardar o vínculo externo B")] })).toEqual(["converted", "dropped_repeated_link"]);
  });
  it("dropped_limit: já há 5 ligações", async () => {
    expect(await outcomes(new ByTitle({ [REIMPORT]: 0.9 }), { links: ["P-5", "P-6", "P-7", "P-8", "P-9"].map((k) => link(k)) })).toEqual(["dropped_limit"]);
  });
  it("lookup_failed: o Jev falhou", async () => {
    const judge = new ByTitle({ [REIMPORT]: 0.9 });
    judge.fail = () => true;
    expect(await outcomes(judge)).toEqual(["lookup_failed"]);
  });
});
