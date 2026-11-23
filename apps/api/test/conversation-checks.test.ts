import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  draftTexts,
  findClaims,
  findTicketKeys,
  normalizeText,
  checkMustMention,
  checkMustNotMention,
  checkDraft,
  checkElaboration,
  checkElaborationWithLookup,
} from "../scripts/conversation-checks.js";

describe("normalizeText", () => {
  it("tira acentos e diferença de maiúsculas", () => {
    expect(normalizeText("Repositório PAINEL Lateral Ção")).toBe("repositorio painel lateral cao");
  });
});

describe("checkMustMention", () => {
  const text = "O chat fica no Painel Lateral Esquerdo, plugado num repositório.";
  it("cobre quando ao menos um trecho aparece, sem diferenciar acento nem caixa", () => {
    const [a, b] = checkMustMention(text, [
      { label: "painel", anyOf: ["lateral esquerd"] },
      { label: "repo", anyOf: ["REPOSITORIO", "repo git"] },
    ]);
    expect(a).toEqual({ label: "painel", covered: true, matched: "lateral esquerd" });
    expect(b?.covered).toBe(true);
  });
  it("não cobre quando nenhum trecho aparece", () => {
    expect(checkMustMention(text, [{ label: "branch", anyOf: ["branch", "ramo"] }])[0]).toEqual({ label: "branch", covered: false, matched: null });
  });
});

describe("checkMustNotMention", () => {
  it("devolve o trecho encontrado com o texto em volta", () => {
    const hits = checkMustNotMention("Segue a Fase 2 do projeto, sem pressa.", ["fase", "sprint"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.phrase).toBe("fase");
    expect(hits[0]?.context).toContain("Fase 2");
  });
  it("não acusa a palavra quando ela só aparece no meio de outra (ênfase)", () => {
    expect(checkMustNotMention("Dê ênfase ao botão.", ["fase"])).toEqual([]);
  });
  it("acha 'critérios de aceite' mesmo sem acento e em maiúsculas", () => {
    expect(checkMustNotMention("CRITERIOS DE ACEITE: tudo", ["critérios de aceite"])).toHaveLength(1);
  });
  it("nada encontrado devolve lista vazia", () => {
    expect(checkMustNotMention("texto limpo", ["prazo"])).toEqual([]);
  });
});

describe("findTicketKeys", () => {
  it("acha chaves como TREEPM-195 e ignora o resto", () => {
    expect(findTicketKeys("veja TREEPM-195 e ABC-7, mas não UTF-8x nem a-1")).toEqual(["TREEPM-195", "ABC-7"]);
  });
  it("sem chave, lista vazia", () => {
    expect(findTicketKeys("nada aqui")).toEqual([]);
  });
});

describe("findClaims", () => {
  it.each([
    ["Criei os tickets para você.", true],
    ["Criamos o ticket e os filhos.", true],
    ["Já criei o rascunho no projeto.", true],
    ["Já dividi o trabalho.", true],
    ["Foram criados 4 tickets.", true],
    ["Foram abertos três tickets.", true],
    ["O ticket foi criado.", true],
    ["A tarefa foi dividida em partes.", true],
    ["Dividi o ticket ABC-12 em dois.", true],
    ["Separei em três tickets que já estão no projeto.", true],
    ["Abri os tickets no projeto.", true],
    ["Posso propor uma quebra em quatro tickets?", false],
    ["Proponho dividir em duas partes. Confirma?", false],
    ["Eu dividi o pedido em quatro partes.", false],
    ["Quebrei o trabalho em filhos.", false],
    ["Separei o pedido em partes: o botão com o drop-down, os templates de filtro, a navegação do modo play e o modo standup. Se preferir, posso juntar tudo num ticket só.", false],
    ["Montei o rascunho e separei em partes: o campo de prioridade, o botão e a regra. Se preferir, posso juntar tudo num ticket só.", false],
    ["Separei em duas partes, o campo de prioridade e o botão; se preferir, posso juntar tudo num ticket só.", false],
    ["Separei o pedido em três partes: a exportação em CSV pelo menu do projeto e as duas opções, cada uma num filho.", false],
  ])("%s -> %s", (message, expected) => {
    expect(findClaims(message).length > 0).toBe(expected);
  });
});

describe("draftTexts", () => {
  it("junta título e descrição do pai e dos filhos", () => {
    expect(draftTexts({ title: "P", description: "pd", children: [{ title: "F", description: "fd" }] })).toBe("P\npd\nF\nfd");
  });
});

describe("checkDraft", () => {
  const baseCase = { id: "x", messages: ["m"], expectChildren: true as const, minChildren: 2, maxChildren: 3, mustMention: [{ label: "a", anyOf: ["alfa"] }], mustNotMention: ["fase"] };
  const turn = { message: "Segue a proposta.", ready: true, draft: { title: "T", description: "alfa", children: [{ title: "a", description: "" }, { title: "b", description: "x" }] } };

  it("passa quando tudo confere", () => {
    const r = checkDraft(baseCase, turn);
    expect(r.passes).toBe(true);
    expect(r.childCount).toBe(2);
    expect(r.parentDescriptionLength).toBe(4);
    expect(r.childrenDescriptionLength).toBe(1);
  });
  it("falha sem rascunho", () => {
    const r = checkDraft(baseCase, { message: "Qual o prazo?", ready: false, draft: null });
    expect(r.hasDraft).toBe(false);
    expect(r.passes).toBe(false);
  });
  it("falha com número de filhos fora do intervalo", () => {
    expect(checkDraft(baseCase, { ...turn, draft: { ...turn.draft, children: [] } }).passes).toBe(false);
  });
  it("expectChildren false falha quando há filhos; 'either' aceita os dois", () => {
    expect(checkDraft({ ...baseCase, expectChildren: false, minChildren: undefined, maxChildren: undefined }, turn).passes).toBe(false);
    expect(checkDraft({ ...baseCase, expectChildren: "either", minChildren: undefined, maxChildren: undefined }, turn).passes).toBe(true);
  });
  it("falha com detalhe perdido, trecho inventado, chave ou 'criei'", () => {
    expect(checkDraft(baseCase, { ...turn, draft: { ...turn.draft, description: "beta" } }).missed).toEqual(["a"]);
    expect(checkDraft(baseCase, { ...turn, draft: { ...turn.draft, description: "alfa na fase 2" } }).invented).toHaveLength(1);
    expect(checkDraft(baseCase, { ...turn, message: "Veja TREEPM-1" }).ticketKeys).toEqual(["TREEPM-1"]);
    expect(checkDraft(baseCase, { ...turn, message: "Criei tudo." }).passes).toBe(false);
  });
});

describe("expectIdea (TREEPM-242)", () => {
  const base = { id: "x", messages: ["m"], expectChildren: "either" as const, mustMention: [], mustNotMention: [] };
  const draft = (idea?: boolean) => ({ message: "ok", ready: true, draft: { title: "T", description: "d", children: [], ...(idea === undefined ? {} : { idea }) } });

  it("expectIdea true: passa com idea verdadeiro e falha sem ele; relata o que veio", () => {
    expect(checkDraft({ ...base, expectIdea: true }, draft(true))).toMatchObject({ idea: true, ideaOk: true, passes: true });
    expect(checkDraft({ ...base, expectIdea: true }, draft(false))).toMatchObject({ idea: false, ideaOk: false, passes: false });
    expect(checkDraft({ ...base, expectIdea: true }, draft())).toMatchObject({ idea: false, ideaOk: false, passes: false });
  });

  it("expectIdea false: falha se idea vier verdadeiro", () => {
    expect(checkDraft({ ...base, expectIdea: false }, draft(true))).toMatchObject({ ideaOk: false, passes: false });
    expect(checkDraft({ ...base, expectIdea: false }, draft(false))).toMatchObject({ ideaOk: true, passes: true });
  });

  it("sem expectIdea, idea não é exigido nem proibido, mas é relatado", () => {
    expect(checkDraft(base, draft(true))).toMatchObject({ idea: true, ideaOk: true, passes: true });
    expect(checkDraft(base, draft())).toMatchObject({ idea: false, ideaOk: true, passes: true });
  });

  it("sem rascunho, idea é falso e nada passa", () => {
    expect(checkDraft({ ...base, expectIdea: true }, { message: "q", ready: false, draft: null })).toMatchObject({ idea: false, passes: false });
  });
});

describe("os casos da medição (TREEPM-242)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../scripts/conversation-cases");
  const cases = new Map(readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => { const c = JSON.parse(readFileSync(join(dir, n), "utf8")) as Record<string, unknown>; return [c["id"] as string, c]; }));

  it("ideia-declarada: pedido que começa com 'Ideia:', três peças, espera filhos e idea verdadeiro", () => {
    const c = cases.get("ideia-declarada") as { messages: string[]; expectChildren: unknown; expectIdea: unknown; minChildren: number; mustMention: unknown[] };
    expect(c).toBeDefined();
    expect(c.messages).toHaveLength(1);
    expect(c.messages[0]).toMatch(/^Ideia:/);
    expect(c.expectChildren).toBe(true);
    expect(c.expectIdea).toBe(true);
    expect(c.minChildren).toBeGreaterThanOrEqual(3);
    expect(c.mustMention.length).toBeGreaterThanOrEqual(3);
  });

  it("botao-play espera idea; ticket-simples e defeito-com-passos esperam que não; os outros não têm o campo", () => {
    expect(cases.get("botao-play")?.["expectIdea"]).toBe(true);
    expect(cases.get("ticket-simples")?.["expectIdea"]).toBe(false);
    expect(cases.get("defeito-com-passos")?.["expectIdea"]).toBe(false);
    for (const [id, c] of cases) if (!["ideia-declarada", "botao-play", "ticket-simples", "defeito-com-passos"].includes(id)) expect(c).not.toHaveProperty("expectIdea");
  });
});

describe("a elaboração na medição (ADR 0052, fatia 3)", () => {
  const related = [{ key: "T-1", title: "Guardar a origem de cada ticket", excerpt: "", status: "todo" }];
  const base = { id: "e", messages: ["m"], expectChildren: "either" as const, mustMention: [], mustNotMention: [], related, expectLinkKeys: ["T-1"], minSuggested: 1, maxSuggested: 2 };
  const draft = { title: "Sincronizar", description: "diff", children: [{ title: "Receber o diff", description: "" }] };
  const raw = (links: { de: "pai" | number; dependeDe: string; motivo: string }[], suggested: { title: string; description: string; motivo: string }[]) => ({ links, suggested });

  it("passa quando a ligação esperada aparece e o número de sugeridas está no intervalo; devolve o que ficou depois do descarte do servidor", () => {
    const r = checkElaboration(base, draft, raw([{ de: "pai", dependeDe: "T-1", motivo: "ok" }, { de: "pai", dependeDe: "T-9", motivo: "fora da lista" }], [{ title: "Guardar o cursor", description: "", motivo: "sem isso não há diff" }, { title: "receber o DIFF", description: "", motivo: "repete a parte" }]));
    expect(r).toMatchObject({ linkKeys: ["T-1"], linksMissing: [], suggestedCount: 1, suggestedOk: true, passes: true });
    expect(r.suggestedTitles).toEqual(["Guardar o cursor"]);
  });
  it("reprova a ligação que falta e a quantidade de sugeridas fora do intervalo", () => {
    expect(checkElaboration(base, draft, raw([], [{ title: "A", description: "", motivo: "m" }]))).toMatchObject({ linksMissing: ["T-1"], passes: false });
    expect(checkElaboration(base, draft, raw([{ de: "pai", dependeDe: "T-1", motivo: "ok" }], []))).toMatchObject({ suggestedOk: false, passes: false });
  });
  it("caso em que nada é implicado: listas vazias passam; sugerir ou ligar reprova", () => {
    const none = { ...base, related: [], expectLinkKeys: [], minSuggested: 0, maxSuggested: 0 };
    expect(checkElaboration(none, draft, raw([], []))).toMatchObject({ passes: true, suggestedCount: 0 });
    expect(checkElaboration(none, draft, raw([], [{ title: "Boas práticas", description: "", motivo: "m" }]))).toMatchObject({ suggestedOk: false, passes: false });
  });
  it("sugerida marcada não é inventada: o texto da sugerida não entra na checagem de invenção do rascunho", () => {
    const withBan = { ...base, mustNotMention: ["critérios de aceite"] };
    expect(checkDraft(withBan, { message: "ok", ready: true, draft }).invented).toEqual([]);
    expect(checkElaboration(withBan, draft, raw([{ de: "pai", dependeDe: "T-1", motivo: "x" }], [{ title: "Escrever critérios de aceite", description: "", motivo: "m" }])).suggestedCount).toBe(1);
  });
});

describe("os casos com relacionados (ADR 0052, fatia 3)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../scripts/conversation-cases");
  const load = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as { related: { key: string; title: string }[]; expectLinkKeys: string[]; minSuggested: number; maxSuggested: number; messages: string[] };
  it("com-relacionados: uma parte implicada já existe (ligação) e outra não (tarefa sugerida)", () => {
    const c = load("com-relacionados");
    expect(c.related.length).toBeGreaterThanOrEqual(2);
    expect(c.expectLinkKeys.length).toBeGreaterThanOrEqual(1);
    for (const key of c.expectLinkKeys) expect(c.related.map((r) => r.key)).toContain(key);
    expect(c.minSuggested).toBeGreaterThanOrEqual(1);
  });
  it("nada-implicado: pedido completo em si, sem relacionados, espera listas vazias", () => {
    const c = load("nada-implicado");
    expect(c.expectLinkKeys).toEqual([]);
    expect(c.maxSuggested).toBe(0);
    expect(c.related).toEqual([]);
  });
});

describe("a procura das tarefas sugeridas na árvore da medição (R4)", () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../scripts/conversation-cases");
  const testCase = JSON.parse(readFileSync(join(dir, "tarefa-implicada-existe.json"), "utf8"));
  const draft = { title: "Sincronizar tickets com Jira, GitHub e Linear", description: "Só o diff", children: [] };
  const vinculo = { title: "Guardar o vínculo entre cada ticket daqui e o item correspondente na plataforma externa", description: "Registrar o identificador externo", motivo: "sem vínculo não há diff" };
  const cursor = { title: "Guardar o cursor da última sincronização", description: "Para saber o que mudou", motivo: "sem cursor não há diff" };

  it("o caso leva a tarefa implicada na árvore, fora da lista de relacionados, com título diferente do que o modelo escreve", () => {
    const keys = (testCase.related as { key: string }[]).map((r) => r.key);
    expect(keys).not.toContain("DEMO-10");
    expect((testCase.tree as { key: string }[]).map((r) => r.key)).toContain("DEMO-10");
    expect(testCase.expectLinkKeys).toEqual(["DEMO-10"]);
  });
  it("a sugerida equivalente vira ligação e a conferência passa", async () => {
    const r = await checkElaborationWithLookup(testCase, draft, { links: [], suggested: [vinculo] });
    expect(r).toMatchObject({ linkKeys: ["DEMO-10"], suggestedCount: 0, equivalentSuggested: [], passes: true });
  });
  it("sem a procura (o modelo sugerindo e nada convertido), o caso reprova: faltou a ligação e sobrou a equivalente", async () => {
    const r = checkElaboration(testCase, draft, { links: [], suggested: [vinculo] });
    expect(r).toMatchObject({ linksMissing: ["DEMO-10"], passes: false });
    expect(r.equivalentSuggested.length).toBeGreaterThan(0);
  });
  it("uma sugerida que não é a mesma coisa continua sugerida", async () => {
    const r = await checkElaborationWithLookup(testCase, draft, { links: [], suggested: [vinculo, cursor] });
    expect(r.suggestedTitles).toEqual([cursor.title]);
    expect(r.linkKeys).toEqual(["DEMO-10"]);
  });
});
