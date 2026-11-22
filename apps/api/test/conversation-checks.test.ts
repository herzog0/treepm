import { describe, expect, it } from "vitest";
import {
  draftTexts,
  findClaims,
  findTicketKeys,
  normalizeText,
  checkMustMention,
  checkMustNotMention,
  checkDraft,
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
    ["Eu dividi o pedido em quatro partes.", true],
    ["Foram criados 4 tickets.", true],
    ["A tarefa foi dividida em partes.", true],
    ["Posso propor uma quebra em quatro tickets?", false],
    ["Proponho dividir em duas partes. Confirma?", false],
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
