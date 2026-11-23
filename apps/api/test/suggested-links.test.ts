import { describe, expect, it } from "vitest";
import { linkExistingSuggestions, SUGGESTED_CANDIDATES } from "../src/assistant/suggested-links.js";
import type { LookupTicket } from "../src/assistant/suggested-links.js";
import type { ElaborationLink, ElaborationSuggestion, ExistingMatchInput, ExistingMatchResult, ExistingMatcher } from "../src/assistant/ports.js";
import { AssistantUnavailableError } from "../src/assistant/ports.js";

// ADR 0052, item 4 (R6): quem decide se a tarefa sugerida já existe é o Claude, numa segunda chamada curta.
const tree: LookupTicket[] = [
  { id: "t1", number: 1, title: "Reimportar sem duplicar: guardar a origem de cada ticket", description: "Guardar o vínculo de cada ticket com o item externo, para não duplicar ao sincronizar.", status: "todo" },
  { id: "t2", number: 2, title: "Tela de ajustes do projeto", description: "Preferências gerais.", status: "todo" },
  { id: "t3", number: 3, title: "Importar tickets de Jira", description: "Importar por lista, uma vez.", status: "done" },
];
const task = (title: string, motivo = "o pedido precisa disto", description = "Guardar o vínculo com o item externo"): ElaborationSuggestion => ({ title, description, motivo });
const link = (dependeDe: string, de: ElaborationLink["de"] = "pai", motivo = "m"): ElaborationLink => ({ de, dependeDe, motivo });
const REIMPORT = "Reimportar sem duplicar: guardar a origem de cada ticket";

/** O Claude falso da segunda chamada: responde, por título da sugerida, a chave que o roteiro mandar (ou `null`). */
class Scripted implements ExistingMatcher {
  readonly calls: ExistingMatchInput[] = [];
  fail = false;
  constructor(private readonly byTitle: (title: string, input: ExistingMatchInput["tasks"][number]) => string | null = () => null) {}
  async matchExisting(input: ExistingMatchInput): Promise<ExistingMatchResult> {
    this.calls.push(structuredClone(input) as ExistingMatchInput);
    if (this.fail) throw new AssistantUnavailableError("fake");
    return { answers: input.tasks.map((entry) => ({ index: entry.index, existing: this.byTitle(entry.title, entry) })), model: "fake" };
  }
}
const pick = (key: string) => new Scripted(() => key);
const base = { tree, projectKey: "P", duplicateKey: null as string | null };
const run = (matcher: ExistingMatcher, over: { links?: ElaborationLink[]; suggested?: ElaborationSuggestion[]; duplicateKey?: string | null; tree?: LookupTicket[]; excludeIds?: ReadonlySet<string>; signal?: AbortSignal } = {}) =>
  linkExistingSuggestions({ ...base, links: [], suggested: [task("Guardar o vínculo entre cada ticket e o item na plataforma externa")], matcher, ...over });

describe("tarefa sugerida que já existe", () => {
  it("vira ligação do pai e sai das sugeridas, com o motivo da sugerida; o título vem da árvore", async () => {
    const out = await run(pick("P-1"), { suggested: [task("Guardar o vínculo externo", "sem vínculo não há diff")] });
    expect(out.links).toEqual([{ de: "pai", dependeDe: "P-1", motivo: "sem vínculo não há diff" }]);
    expect(out.suggested).toEqual([]);
    expect(out.titles.get("P-1")).toBe(REIMPORT);
  });

  it("null mantém a sugerida", async () => {
    const out = await run(new Scripted());
    expect(out.links).toEqual([]);
    expect(out.suggested).toHaveLength(1);
  });

  it("chave fora dos candidatos DAQUELA sugerida é ignorada (a sugerida continua)", async () => {
    const out = await run(pick("P-999"));
    expect(out.links).toEqual([]);
    expect(out.suggested).toHaveLength(1);
    expect(out.lookups[0]).toMatchObject({ outcome: "kept", chosen: false });
  });

  it("chave de candidato de OUTRA sugerida não vale", async () => {
    // A primeira só tem o Jira como candidato; o modelo responde a chave do ticket da segunda.
    const matcher = new Scripted(() => "P-1");
    const out = await run(matcher, { suggested: [task("Importar tickets do Jira", "m", "Importar por lista"), task("Zzzz qqqq xxxx", "m", "")] });
    // A segunda não tem candidatos: nunca entra na chamada, e a primeira só aceita P-1 se ele está entre os candidatos dela.
    const sentKeys = (matcher.calls[0] as ExistingMatchInput).tasks.map((entry) => entry.candidates.map((c) => c.key));
    expect(sentKeys).toHaveLength(1);
    expect(out.suggested.map((s) => s.title)).toContain("Zzzz qqqq xxxx");
  });

  it("o duplicado nunca é alvo: nem vai ao Claude nem recebe ligação", async () => {
    const matcher = pick("P-1");
    const out = await run(matcher, { duplicateKey: "P-1" });
    expect(out.links).toEqual([]);
    expect(out.suggested).toHaveLength(1);
    expect(JSON.stringify(matcher.calls)).not.toContain("Reimportar");
  });

  it("os ids excluídos (o lugar escolhido e seus ancestrais) não concorrem", async () => {
    const matcher = pick("P-1");
    const out = await run(matcher, { excludeIds: new Set(["t1"]) });
    expect(out.links).toEqual([]);
    expect(JSON.stringify(matcher.calls)).not.toContain("Reimportar");
  });

  it("ligação que já existe na resposta não duplica, e a sugerida sai mesmo assim", async () => {
    const out = await run(pick("P-1"), { links: [link("P-1", "pai", "do modelo")] });
    expect(out.links).toEqual([link("P-1", "pai", "do modelo")]);
    expect(out.suggested).toEqual([]);
  });

  it("duas sugeridas para o mesmo ticket dão uma ligação só", async () => {
    const out = await run(pick("P-1"), { suggested: [task("Guardar o vínculo externo A"), task("Guardar o vínculo externo B")] });
    expect(out.links).toHaveLength(1);
    expect(out.suggested).toEqual([]);
  });

  it("no limite de 5 ligações a sugerida é só descartada, não volta como tarefa", async () => {
    const full = ["P-5", "P-6", "P-7", "P-8", "P-9"].map((key) => link(key));
    const out = await run(pick("P-1"), { links: full });
    expect(out.links).toEqual(full);
    expect(out.suggested).toEqual([]);
  });

  it("só as que não existem continuam sugeridas, na ordem", async () => {
    const out = await run(new Scripted((title) => (title.includes("vínculo") ? "P-1" : null)), {
      suggested: [task("Cadastrar o provedor externo"), task("Guardar o vínculo externo"), task("Escrever a documentação do diff")],
    });
    expect(out.suggested.map((s) => s.title)).toEqual(["Cadastrar o provedor externo", "Escrever a documentação do diff"]);
    expect(out.links).toHaveLength(1);
  });
});

describe("o que vai ao Claude na segunda chamada", () => {
  it("UMA chamada para todas as sugeridas: índice, título, descrição e motivo; dos candidatos, chave, título, trecho e situação", async () => {
    const matcher = new Scripted();
    await run(matcher, { suggested: [task("Guardar o vínculo externo", "MOTIVO-1", "Descrição 1"), task("Importar tickets do Jira", "MOTIVO-2", "Importar por lista")] });
    expect(matcher.calls).toHaveLength(1);
    const sent = matcher.calls[0] as ExistingMatchInput;
    expect(sent.tasks.map((entry) => [entry.index, entry.title, entry.description, entry.motivo])).toEqual([
      [0, "Guardar o vínculo externo", "Descrição 1", "MOTIVO-1"],
      [1, "Importar tickets do Jira", "Importar por lista", "MOTIVO-2"],
    ]);
    for (const entry of sent.tasks) {
      expect(Object.keys(entry).sort()).toEqual(["candidates", "description", "index", "motivo", "title"]);
      for (const candidate of entry.candidates) expect(Object.keys(candidate).sort()).toEqual(["excerpt", "key", "status", "title"]);
    }
    const reimport = sent.tasks[0]!.candidates.find((c) => c.key === "P-1");
    expect(reimport).toEqual({ key: "P-1", title: REIMPORT, excerpt: expect.stringContaining("vínculo"), status: "todo" });
    expect(JSON.stringify(sent)).not.toMatch(/"t1"|"id"/);
  });

  it("até 10 candidatos por sugerida", async () => {
    expect(SUGGESTED_CANDIDATES).toBe(10);
    const many: LookupTicket[] = Array.from({ length: 40 }, (_, i) => ({ id: `m${i}`, number: i + 1, title: `Vínculo externo número ${i}`, description: "vínculo externo", status: "todo" }));
    const matcher = new Scripted();
    await run(matcher, { tree: many });
    expect((matcher.calls[0] as ExistingMatchInput).tasks[0]!.candidates).toHaveLength(10);
  });

  it("sem candidato na triagem, a sugerida não vai ao Claude; sem nenhuma com candidato, nem há chamada", async () => {
    const matcher = new Scripted();
    const out = await run(matcher, { suggested: [task("Zzzz qqqq xxxx", "m", "")] });
    expect(matcher.calls).toHaveLength(0);
    expect(out.suggested).toHaveLength(1);
    expect(out.lookups[0]).toEqual({ outcome: "kept", candidates: 0, chosen: false });
  });

  it("o índice enviado é o da posição na lista de sugeridas", async () => {
    const matcher = new Scripted();
    await run(matcher, { suggested: [task("Zzzz qqqq xxxx", "m", ""), task("Guardar o vínculo externo")] });
    expect((matcher.calls[0] as ExistingMatchInput).tasks.map((entry) => entry.index)).toEqual([1]);
  });
});

describe("robustez", () => {
  it("falha da chamada devolve as sugeridas e as ligações intactas (lookup_failed)", async () => {
    const matcher = pick("P-1");
    matcher.fail = true;
    const suggested = [task("Guardar o vínculo externo")];
    const out = await run(matcher, { suggested, links: [link("P-2")] });
    expect(out.suggested).toEqual(suggested);
    expect(out.links).toEqual([link("P-2")]);
    expect(out.failed).toBe(1);
    expect(out.lookups.map((l) => l.outcome)).toEqual(["lookup_failed"]);
  });

  it("sinal abortado antes do fim devolve as sugeridas como vieram", async () => {
    const controller = new AbortController();
    const hang: ExistingMatcher = { matchExisting: () => new Promise<never>(() => undefined) };
    const pending = run(hang, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const out = await pending;
    expect(out.suggested).toHaveLength(1);
    expect(out.links).toEqual([]);
    expect(out.failed).toBe(1);
  });

  it("resposta repetida ou com índice desconhecido não derruba: vale a primeira por índice, o resto é ignorado", async () => {
    const matcher: ExistingMatcher = {
      matchExisting: async () => ({ answers: [{ index: 7, existing: "P-1" }, { index: 0, existing: "P-1" }, { index: 0, existing: null }], model: "x" }),
    };
    const out = await run(matcher);
    expect(out.links).toHaveLength(1);
  });
});

describe("desfechos por sugerida (diagnostics)", () => {
  const outcomes = async (matcher: ExistingMatcher, over: Parameters<typeof run>[1] = {}) => (await run(matcher, over)).lookups.map((l) => l.outcome);
  it("converted, com candidatos e chosen", async () => {
    const out = await run(pick("P-1"));
    expect(out.lookups[0]).toMatchObject({ outcome: "converted", chosen: true });
    expect(out.lookups[0]!.candidates).toBeGreaterThan(0);
  });
  it("kept: null, e sem candidato nenhum", async () => {
    expect(await outcomes(new Scripted())).toEqual(["kept"]);
  });
  it("dropped_duplicate: o modelo já tinha proposto a mesma ligação", async () => {
    expect(await outcomes(pick("P-1"), { links: [link("P-1")] })).toEqual(["dropped_duplicate"]);
  });
  it("dropped_repeated_link: outra sugerida desta etapa já ligou ao mesmo ticket", async () => {
    expect(await outcomes(pick("P-1"), { suggested: [task("Guardar o vínculo externo A"), task("Guardar o vínculo externo B")] })).toEqual(["converted", "dropped_repeated_link"]);
  });
  it("dropped_limit: já há 5 ligações", async () => {
    expect(await outcomes(pick("P-1"), { links: ["P-5", "P-6", "P-7", "P-8", "P-9"].map((k) => link(k)) })).toEqual(["dropped_limit"]);
  });
});
