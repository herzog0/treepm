import { noul } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import {
  JEV_RULES,
  ROOT,
  bandCounts,
  choiceRanking,
  coverage,
  dDestination,
  destinationChanges,
  maxFitOf,
  median,
  rankingCoverage,
  renderCollectReport,
  ruleDestination,
  sampleOf,
  separation,
  signalsOf,
  spread,
  topOf,
  variation,
} from "../scripts/placement-rebuild/collect-core.js";
import type { CollectRecord, Sample } from "../scripts/placement-rebuild/collect-core.js";
import { CLAUDE_SYSTEM_PROMPT } from "../scripts/placement-rebuild/collect-texts.js";
import { buildClaudeProject, buildFitRequest, buildOutline, validateRanking } from "../scripts/placement-rebuild/collect-requests.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import type { GabaritoTicket } from "../scripts/placement-rebuild/core.js";
import { JEV_MODEL, JEV_SCOPE_FALSE, JEV_SCOPE_QUESTION, JEV_SCOPE_TRUE } from "../src/assistant/prompts.js";

const sample = (gate: number, choice: Record<string, number>, fit: Record<string, number> = {}): Sample => ({
  order: Object.keys(choice),
  gate,
  choice,
  fit,
});

/** `top` é "g1" com pTop = p; "g2" fica com o resto. */
const topG1 = (gate: number, p: number, fit: Record<string, number> = { g1: 0.5, g2: 0.5 }): Sample => sample(gate, { g1: p, g2: 1 - p }, fit);

describe("topOf, maxFitOf e choiceRanking", () => {
  it("top é a opção mais provável; empate fica com a primeira da ordem", () => {
    expect(topOf(sample(0.9, { g1: 0.2, g2: 0.8 }))).toEqual({ id: "g2", p: 0.8 });
    expect(topOf(sample(0.9, { g1: 0.5, g2: 0.5 }))).toEqual({ id: "g1", p: 0.5 });
  });
  it("maxFit é o maior Noul individual; empate fica com o primeiro da ordem", () => {
    expect(maxFitOf(sample(0.9, { g1: 0.5, g2: 0.5, g3: 0 }, { g1: 0.4, g2: 0.9, g3: 0.9 }))).toEqual({ id: "g2", value: 0.9 });
  });
  it("o ranking do Choice vai do mais ao menos provável, estável nos empates", () => {
    expect(choiceRanking(sample(0.9, { g1: 0.2, g2: 0.4, g3: 0.4 }))).toEqual(["g2", "g3", "g1"]);
  });
});

describe("regras R0 a R5 (limites)", () => {
  it("R0: gate > 0,7 desce no top; 0,7 não passa", () => {
    expect(ruleDestination("R0", topG1(0.71, 0.5))).toBe("g1");
    expect(ruleDestination("R0", topG1(0.7, 0.9))).toBe(ROOT);
    expect(ruleDestination("R0", topG1(0.3, 0.9))).toBe(ROOT);
  });
  it("R1: gate ≥ 0,3 desce; 0,3 passa e abaixo disso é raiz", () => {
    expect(ruleDestination("R1", topG1(0.3, 0.5))).toBe("g1");
    expect(ruleDestination("R1", topG1(0.29, 0.5))).toBe(ROOT);
    expect(ruleDestination("R1", topG1(0.7, 0.5))).toBe("g1");
  });
  it("R2: gate e pTop precisam estar acima de 0,7", () => {
    expect(ruleDestination("R2", topG1(0.71, 0.71))).toBe("g1");
    expect(ruleDestination("R2", topG1(0.7, 0.9))).toBe(ROOT);
    expect(ruleDestination("R2", topG1(0.9, 0.7))).toBe(ROOT);
  });
  it("R3: maxFit > 0,7 vai para o argmaxFit; 0,7 não passa; empate fica com o primeiro", () => {
    expect(ruleDestination("R3", sample(0.1, { g1: 0.9, g2: 0.1 }, { g1: 0.2, g2: 0.71 }))).toBe("g2");
    expect(ruleDestination("R3", sample(0.1, { g1: 0.9, g2: 0.1 }, { g1: 0.2, g2: 0.7 }))).toBe(ROOT);
    expect(ruleDestination("R3", sample(0.1, { g1: 0.9, g2: 0.1 }, { g1: 0.8, g2: 0.8 }))).toBe("g1");
  });
  it("R4: o Noul individual do top decide; 0,7 não passa", () => {
    expect(ruleDestination("R4", topG1(0.1, 0.6, { g1: 0.71, g2: 0.99 }))).toBe("g1");
    expect(ruleDestination("R4", topG1(0.9, 0.6, { g1: 0.7, g2: 0.99 }))).toBe(ROOT);
  });
  it("R5: lista acima de 0,7 desce; na faixa do meio (0,3 a 0,7, extremos incluídos) o individual desempata", () => {
    expect(ruleDestination("R5", topG1(0.71, 0.5, { g1: 0, g2: 0 }))).toBe("g1");
    expect(ruleDestination("R5", topG1(0.7, 0.5, { g1: 0.71, g2: 0 }))).toBe("g1");
    expect(ruleDestination("R5", topG1(0.3, 0.5, { g1: 0.71, g2: 0 }))).toBe("g1");
    expect(ruleDestination("R5", topG1(0.5, 0.5, { g1: 0.7, g2: 0.99 }))).toBe(ROOT);
    expect(ruleDestination("R5", topG1(0.29, 0.5, { g1: 0.99, g2: 0 }))).toBe(ROOT);
  });
  it("sempre desce no top e sempre raiz", () => {
    expect(ruleDestination("desce", topG1(0, 0.5))).toBe("g1");
    expect(ruleDestination("raiz", topG1(1, 0.9))).toBe(ROOT);
  });
  it("as regras do Jev são as oito esperadas", () => {
    expect(JEV_RULES).toEqual(["R0", "R1", "R2", "R3", "R4", "R5", "desce", "raiz"]);
  });
});

const rec = (extra: Partial<CollectRecord> = {}): CollectRecord => ({
  oldId: "t1",
  number: 1,
  title: "T1",
  originalGroupId: "g1",
  groupIds: ["g1", "g2", "g3"],
  a: [{ gate: 0.9, choice: { g1: 0.6, g2: 0.3, g3: 0.1 }, ms: 10 }],
  aNeg: [{ gate: 0.4, choice: { g2: 0.7, g3: 0.3 }, ms: 12 }],
  b: [{ fit: { g1: 0.95, g2: 0.8, g3: 0.1 }, ms: 8 }],
  d: null,
  dNeg: null,
  ...extra,
});

describe("amostra do negativo", () => {
  it("o positivo usa a coleta A e todos os agrupadores", () => {
    expect(sampleOf(rec(), 0, false)).toEqual({
      order: ["g1", "g2", "g3"],
      gate: 0.9,
      choice: { g1: 0.6, g2: 0.3, g3: 0.1 },
      fit: { g1: 0.95, g2: 0.8, g3: 0.1 },
    });
  });
  it("o negativo vem da coleta A− e o fit ignora o agrupador original", () => {
    const s = sampleOf(rec(), 0, true) as Sample;
    expect(s.gate).toBe(0.4);
    expect(s.order).toEqual(["g2", "g3"]);
    expect(s.choice).toEqual({ g2: 0.7, g3: 0.3 });
    expect(s.fit).toEqual({ g2: 0.8, g3: 0.1 });
    expect(topOf(s).id).toBe("g2");
    // Sem o original, o maior fit passa a ser o do g2 (e não o 0,95 do original).
    expect(maxFitOf(s)).toEqual({ id: "g2", value: 0.8 });
  });
  it("sem coleta A− (um agrupador só) ou sem agrupador original não há amostra negativa", () => {
    expect(sampleOf(rec({ aNeg: null }), 0, true)).toBeNull();
    expect(sampleOf(rec({ originalGroupId: null }), 0, true)).toBeNull();
    expect(sampleOf(rec({ originalGroupId: null }), 0, false)).toBeNull();
  });
  it("a repetição pedida é a que sai", () => {
    const r = rec({ a: [rec().a[0] as never, { gate: 0.2, choice: { g1: 0.1, g2: 0.8, g3: 0.1 }, ms: 1 }], b: [rec().b[0] as never, rec().b[0] as never] });
    expect((sampleOf(r, 1, false) as Sample).gate).toBe(0.2);
  });
});

describe("D", () => {
  const ok = { invalid: null, ms: 1, inputTokens: 1, outputTokens: 1 };
  it("o destino é o primeiro do ranking; ranking inválido não é destino", () => {
    expect(dDestination({ ...ok, ranking: ["g2", "root"] })).toBe("g2");
    expect(dDestination({ ...ok, ranking: [ROOT] })).toBe(ROOT);
    expect(dDestination({ ...ok, ranking: null, invalid: "repetido" })).toBe("inválido");
    expect(dDestination(null)).toBe("inválido");
  });
  it("cobertura de D: o original entre os dois (e três) primeiros", () => {
    expect(rankingCoverage(["g2", "g1", "root"], "g1", 2)).toBe(true);
    expect(rankingCoverage(["g2", "root", "g1"], "g1", 2)).toBe(false);
    expect(rankingCoverage(["g2", "root", "g1"], "g1", 3)).toBe(true);
    expect(rankingCoverage(null, "g1", 3)).toBe(false);
  });
});

describe("cobertura em duas e três opções (regras do Jev)", () => {
  const s = sample(0.9, { g1: 0.1, g2: 0.6, g3: 0.3 });
  it("o original entre o destino e a segunda opção do Choice", () => {
    expect(coverage("g2", s, "g3", 2)).toBe(true); // segunda opção é g3
    expect(coverage("g2", s, "g1", 2)).toBe(false); // g1 é só a terceira
    expect(coverage("g2", s, "g2", 2)).toBe(true); // o próprio destino
  });
  it("com três opções entra também a terceira", () => {
    expect(coverage("g2", s, "g1", 3)).toBe(true);
  });
  it("quando o destino é a raiz, vale a raiz e as opções seguintes do ranking", () => {
    expect(coverage(ROOT, s, "g3", 2)).toBe(true);
    expect(coverage(ROOT, s, "g2", 2)).toBe(false); // a primeira opção não é "segunda"
  });
});

describe("separação dos sinais", () => {
  it("fração dos pares em que o positivo é maior; empate conta meio", () => {
    // pares: 0,9>0,5 (1), 0,9>0,1 (1), 0,5=0,5 (0,5), 0,5>0,1 (1) → 3,5 / 4
    expect(separation([0.9, 0.5], [0.5, 0.1])).toBeCloseTo(0.875, 10);
  });
  it("positivo sempre menor dá 0; tudo empatado dá 0,5", () => {
    expect(separation([0.1], [0.9, 0.8])).toBe(0);
    expect(separation([0.4, 0.4], [0.4])).toBe(0.5);
  });
  it("sem pares não há fração", () => {
    expect(Number.isNaN(separation([], [0.2]))).toBe(true);
  });
  it("contagem nas três faixas, com 0,3 e 0,7 na do meio", () => {
    expect(bandCounts([0.29, 0.3, 0.5, 0.7, 0.71])).toEqual({ low: 1, mid: 3, high: 1 });
  });
  it("sinais de uma amostra, incluindo gate × pTop", () => {
    const sig = signalsOf(sample(0.5, { g1: 0.8, g2: 0.2 }, { g1: 0.6, g2: 0.9 }));
    expect(sig.gate).toBe(0.5);
    expect(sig.pTop).toBe(0.8);
    expect(sig.maxFit).toBe(0.9);
    expect(sig.fitTop).toBe(0.6);
    expect(sig.gateXpTop).toBeCloseTo(0.4, 10);
  });
});

describe("variação entre repetições", () => {
  const reps = (gates: number[], p: number[], g1fit: number[]): CollectRecord =>
    rec({
      a: gates.map((gate, i) => ({ gate, choice: { g1: p[i] as number, g2: 1 - (p[i] as number), g3: 0 }, ms: 1 })),
      b: g1fit.map((f) => ({ fit: { g1: f, g2: 0.1, g3: 0.1 }, ms: 1 })),
    });
  it("spread é maior menos menor", () => {
    expect(spread([0.2, 0.9, 0.5])).toBeCloseTo(0.7, 10);
    expect(spread([0.4])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
  it("mediana e máximo sobre os tickets, para gate, pTop e fit", () => {
    const rows = variation([reps([0.9, 0.8], [0.6, 0.6], [0.9, 0.9]), reps([0.9, 0.3], [0.9, 0.5], [0.2, 0.7])], false);
    const by = Object.fromEntries(rows.map((r) => [r.signal, r]));
    expect(by["gate"]?.max).toBeCloseTo(0.6, 10);
    expect(by["gate"]?.median).toBeCloseTo(0.35, 10);
    expect(by["pTop"]?.max).toBeCloseTo(0.4, 10);
    expect(by["fit"]?.max).toBeCloseTo(0.5, 10);
  });
  it("conta tickets cujo destino muda entre repetições, por regra", () => {
    const estavel = reps([0.9, 0.95], [0.6, 0.6], [0.9, 0.9]);
    const muda = reps([0.9, 0.5], [0.6, 0.6], [0.9, 0.9]);
    expect(destinationChanges([estavel, muda], "R0", false)).toBe(1);
    expect(destinationChanges([estavel, muda], "R1", false)).toBe(0);
    expect(destinationChanges([estavel, muda], "raiz", false)).toBe(0);
  });
});

describe("esboço do projeto para o Claude", () => {
  const groups = [
    { id: "gB", title: "Pagamentos", description: "Tudo de cobrança", tickets: ["Cobrar cartão", "Estornar"] },
    { id: "gA", title: "Login", description: "", tickets: [] },
    { id: "gC", title: "Relatórios", description: "Painéis", tickets: ["Exportar CSV"] },
  ];
  const input = { groups, excludeGroupId: null, newTicket: { title: "Novo", description: "Algo" } };
  it("opções g1… na ordem recebida, sem ids, tickets na ordem dada, sem descrição vazia", () => {
    const { content, optionIds } = buildClaudeProject(input);
    expect(optionIds).toEqual(["gB", "gA", "gC"]);
    expect(JSON.parse(content)).toEqual({
      project: {
        groups: [
          { option: "g1", title: "Pagamentos", description: "Tudo de cobrança", tickets: ["Cobrar cartão", "Estornar"] },
          { option: "g2", title: "Login", tickets: [] },
          { option: "g3", title: "Relatórios", description: "Painéis", tickets: ["Exportar CSV"] },
        ],
      },
      new_ticket: { title: "Novo", description: "Algo" },
    });
    expect(content).not.toMatch(/gA|gB|gC/);
    expect(content).not.toContain("name");
  });
  it("o negativo não leva o agrupador original e renumera as opções", () => {
    const { content, optionIds } = buildClaudeProject({ ...input, excludeGroupId: "gB" });
    expect(optionIds).toEqual(["gA", "gC"]);
    const parsed = JSON.parse(content) as { project: { groups: { option: string; title: string }[] } };
    expect(parsed.project.groups.map((g) => [g.option, g.title])).toEqual([
      ["g1", "Login"],
      ["g2", "Relatórios"],
    ]);
    expect(content).not.toContain("Pagamentos");
    expect(content).not.toContain("Cobrar cartão");
  });
  it("o ticket novo sem descrição não leva o campo", () => {
    const { content } = buildClaudeProject({ ...input, newTicket: { title: "Novo", description: "" } });
    expect(JSON.parse(content).new_ticket).toEqual({ title: "Novo" });
  });
});

describe("esboço do projeto a partir do gabarito", () => {
  const node = (id: string, number: number, parentId: string | null, kind: "ticket" | "group", description = ""): GabaritoTicket => ({
    id,
    number,
    kind,
    key: `K-${number}`,
    title: `Título ${id}`,
    description,
    status: kind === "group" ? null : "todo",
    parentId,
    assigneeIds: [],
    depth: parentId === null ? 0 : 1,
  });
  // Fora de ordem de propósito: o número manda, não a posição na lista.
  const gabarito = [
    node("t3", 9, "gb", "ticket"),
    node("gb", 5, null, "group", "Descrição B"),
    node("t1", 6, "ga", "ticket"),
    node("ga", 2, null, "group", "Descrição A"),
    node("t2", 4, "ga", "ticket"),
    node("solto", 1, null, "ticket"),
    node("sub", 7, "ga", "group"),
    node("t4", 3, "sub", "ticket"),
  ];
  it("agrupadores da raiz na ordem do número, com os tickets diretos na ordem do número", () => {
    expect(buildOutline(gabarito, "nenhum")).toEqual([
      { id: "ga", title: "Título ga", description: "Descrição A", tickets: ["Título t2", "Título t1"] },
      { id: "gb", title: "Título gb", description: "Descrição B", tickets: ["Título t3"] },
    ]);
  });
  it("o ticket de fora não aparece nem no agrupador dele", () => {
    const outline = buildOutline(gabarito, "t2");
    expect(outline.find((g) => g.id === "ga")?.tickets).toEqual(["Título t1"]);
    expect(JSON.stringify(outline)).not.toContain("Título t2");
  });
});

describe("validação do ranking do Claude", () => {
  const ids = ["gB", "gA", "gC"];
  it("traduz opções para ids e `root` fica `root`", () => {
    expect(validateRanking({ ranking: ["g2", "root", "g1"] }, ids)).toEqual({ ok: true, ranking: ["gA", "root", "gB"] });
    expect(validateRanking({ ranking: ["root"] }, ids)).toEqual({ ok: true, ranking: ["root"] });
  });
  it("recusa vazio, mais de três, repetido, opção inexistente e forma errada", () => {
    expect(validateRanking({ ranking: [] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: ["g1", "g2", "g3", "root"] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: ["g1", "g1"] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: ["g4"] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: ["g0"] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: [1] }, ids).ok).toBe(false);
    expect(validateRanking({ ranking: "g1" }, ids).ok).toBe(false);
    expect(validateRanking(null, ids).ok).toBe(false);
  });
  it("diz o motivo da recusa", () => {
    const bad = validateRanking({ ranking: ["g9"] }, ids);
    expect(!bad.ok && bad.reason).toMatch(/g9/);
  });
});

describe("prompt de sistema do Claude (coleta D)", () => {
  it("é o texto do brief, letra por letra", () => {
    expect(CLAUDE_SYSTEM_PROMPT).toBe(
      [
        "Você organiza tickets de um projeto de software. O projeto é uma árvore: na raiz há agrupadores, e cada agrupador reúne tickets de um mesmo assunto ou de uma mesma entrega.",
        "",
        "Você recebe o esboço do projeto (`project`) e um ticket novo (`new_ticket`). Diga onde o ticket novo deve ficar.",
        "",
        "As opções são os agrupadores listados em `project.groups`, pelo campo `option`, e a opção `root`, que significa deixar o ticket solto na raiz do projeto, fora de todos os agrupadores.",
        "",
        "Escolha `root` quando o ticket não pertence a nenhum dos agrupadores listados. Não force um agrupador só porque ele é o mais próximo.",
        "",
        "Responda com `ranking`: de uma a três opções, da mais adequada para a menos adequada, sem repetir. Não explique.",
      ].join("\n"),
    );
  });
});

describe("pergunta da coleta B", () => {
  const groups = [
    { id: "gB", title: "Pagamentos", summary: "Cobrança e estornos." },
    { id: "gA", title: "Login", summary: "" },
  ];
  it("uma pergunta Noul por agrupador, com as constantes do produto e o dado nomeado `scope`", () => {
    const { request, keys } = buildFitRequest({ title: "Novo", description: "Algo" }, groups);
    expect(request.model).toBe(JEV_MODEL);
    expect(request.state).toEqual({ draft: { title: "Novo", description: "Algo" } });
    expect(keys.map((k) => k.id)).toEqual(["gB", "gA"]);
    const [first, second] = keys as unknown as [{ key: string }, { key: string }];
    expect(request.questions[first.key]).toEqual(
      noul({ question: JEV_SCOPE_QUESTION, scope: { title: "Pagamentos", summary: "Cobrança e estornos." } }, { true: JEV_SCOPE_TRUE, false: JEV_SCOPE_FALSE }),
    );
    // Resumo vazio: o campo não vai.
    expect(request.questions[second.key]).toEqual(
      noul({ question: JEV_SCOPE_QUESTION, scope: { title: "Login" } }, { true: JEV_SCOPE_TRUE, false: JEV_SCOPE_FALSE }),
    );
    expect(Object.keys(request.questions)).toHaveLength(2);
  });
  it("as chaves são distintas e nenhum id sai na requisição", () => {
    const { request, keys } = buildFitRequest({ title: "Novo", description: "" }, groups);
    expect(new Set(keys.map((k) => k.key)).size).toBe(2);
    expect(JSON.stringify(request)).not.toMatch(/gA|gB/);
    expect(request.state).toEqual({ draft: { title: "Novo" } });
  });
});

describe("parseCliArgs — collect", () => {
  const base = ["--org", "o", "--user", "u", "--dir", "d", "--project", "p"];
  it("aceita collect com --limit e --repeats", () => {
    expect(parseCliArgs(["collect", ...base, "--limit", "5", "--repeats", "2"])).toMatchObject({
      ok: true,
      command: "collect",
      options: { limit: 5, repeats: 2 },
    });
  });
  it("--repeats precisa de inteiro positivo e só existe no collect", () => {
    expect(parseCliArgs(["collect", ...base, "--repeats", "0"]).ok).toBe(false);
    expect(parseCliArgs(["collect", ...base, "--repeats", "x"]).ok).toBe(false);
    expect(parseCliArgs(["rebuild", ...base, "--repeats", "2"]).ok).toBe(false);
  });
  it("report aceita --collect, mas não junto de --loo", () => {
    expect(parseCliArgs(["report", "--project", "p", "--dir", "d", "--collect"])).toMatchObject({ ok: true, options: { collect: true } });
    expect(parseCliArgs(["report", "--project", "p", "--dir", "d", "--collect", "--loo"]).ok).toBe(false);
  });
});

describe("relatório da coleta", () => {
  const ok = { invalid: null, ms: 5, inputTokens: 100, outputTokens: 7 };
  const records: CollectRecord[] = [
    rec({ oldId: "t1", number: 1, title: "Cobrar no cartão", originalGroupId: "g1", d: { ...ok, ranking: ["g1"] }, dNeg: { ...ok, ranking: ["root"] } }),
    rec({ oldId: "t2", number: 2, title: "Entrar com senha", originalGroupId: "g2", d: { ...ok, ranking: ["g3", "g2"] }, dNeg: { ...ok, ranking: ["g1"] } }),
  ];
  const text = renderCollectReport(records, { projectKey: "KEY", groupTitles: new Map([["g1", "Pagamentos"], ["g2", "Login"], ["g3", "Relatórios"]]) });
  it("traz a nota fixa no topo e as seis seções", () => {
    expect(text).toContain("No negativo, o agrupador certo foi retirado; um ticket pode caber de verdade em outro agrupador, então parte dos 'erros' do negativo é discutível.");
    expect(text.indexOf("No negativo, o agrupador certo")).toBeLessThan(text.indexOf("## "));
    for (const heading of ["## Tabela principal", "## Cobertura", "## Separação dos sinais", "## Variação do Jev", "## Por ticket", "## Custo e tempo"]) {
      expect(text).toContain(heading);
    }
  });
  it("a tabela principal tem uma linha por regra e a de D", () => {
    for (const rule of ["R0", "R1", "R2", "R3", "R4", "R5", "D", "Sempre desce", "Sempre raiz"]) expect(text).toMatch(new RegExp(`\\| ${rule} \\|`));
  });
  it("D no positivo: acerto do t1 (g1), erro do t2 (g3); no negativo: t1 acerta (root), t2 erra", () => {
    expect(text).toMatch(/\| D \| 1 \| 1 \| 2 \|/);
  });
  it("soma os tokens de D", () => {
    expect(text).toContain("400 de entrada");
    expect(text).toContain("28 de saída");
  });
});
