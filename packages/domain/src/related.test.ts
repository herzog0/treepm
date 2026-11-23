import { describe, expect, it } from "vitest";
import { RELATED_SHORTLIST, stemOf, triageRelated, termsOf } from "./related.js";
import type { TriageTicket } from "./related.js";

const draft = (title: string, description = "", parts: string[] = []) => ({ title, description, partTitles: parts });
const t = (id: string, title: string, excerpt = ""): TriageTicket => ({ id, title, excerpt });

/** Gerador pseudoaleatório com semente (mulberry32): as árvores sorteadas são sempre as mesmas. */
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const VOCAB = ["painel", "relatorio", "grafico", "cor", "tema", "botao", "menu", "mapa", "zoom", "camada", "filtro", "ordem", "lista", "perfil", "equipe", "papel", "convite", "aviso", "cache", "fila"];
const invented = (count: number, seed = 7): TriageTicket[] => {
  const random = seeded(seed);
  const pick = () => VOCAB[Math.floor(random() * VOCAB.length)] as string;
  return Array.from({ length: count }, (_, i) => t(`inv-${i}`, `${pick()} ${pick()} ${i}`, `${pick()} ${pick()} ${pick()}`));
};

describe("termsOf: minúsculas, sem acento, sem palavras vazias, radical", () => {
  it("tira acento e maiúscula", () => {
    expect(termsOf("Configuração AÇÃO")).toEqual(termsOf("configuracao acao"));
  });
  it("descarta palavras vazias de português, inglês e espanhol", () => {
    expect(termsOf("de a o com para the and with para los las una")).toEqual([]);
  });
  it("junta as formas de importar e de sincronizar", () => {
    expect(new Set(["importar", "importação", "import", "importando"].map(stemOf)).size).toBe(1);
    expect(new Set(["sincronizar", "sincronização", "sync", "synchronize"].map(stemOf)).size).toBe(1);
  });
  it("tira o s final de plural antes do prefixo e completa as palavras vazias (revisão 1, ponto 11)", () => {
    expect(stemOf("mapas")).toBe(stemOf("mapa"));
    expect(stemOf("erros")).toBe(stemOf("erro"));
    expect(termsOf("what which how when also only after before new es lo le desde porque num numa nesse nessa dele dela qual quem ainda depois antes")).toEqual([]);
  });
  it("palavras curtas ficam inteiras e números não contam", () => {
    expect(stemOf("diff")).toBe("diff");
    expect(termsOf("v2 2026 123")).toEqual(["v2"]);
  });
});

describe("triageRelated", () => {
  const request = draft("Sincronizar tickets com Jira, GitHub, Linear recebendo o diff");
  const importar = t("importar", "Importar de GitHub, Jira e Linear, com categorização automática opcional");
  const reimportar = t("origem", "Reimportar sem duplicar: guardar a origem de cada ticket");

  it("acha os dois tickets do caso real entre os primeiros, numa árvore de 300", () => {
    const tree = [...invented(150), importar, ...invented(150, 11).map((x) => ({ ...x, id: `b-${x.id}` })), reimportar];
    expect(tree).toHaveLength(302);
    const found = triageRelated(request, tree).map((hit) => hit.id);
    expect(found.slice(0, 3)).toContain("importar");
    expect(found.slice(0, 3)).toContain("origem");
    expect(found[0]).toBe("importar");
  });

  it("termo comum não expulsa termo raro: o único ticket com 'faturamento' entra nos 30 (revisão 1, ponto 10)", () => {
    const common = "painel relatorio grafico filtro perfil equipe";
    const tree = Array.from({ length: 300 }, (_, i) => t(`c${i}`, `${common} ${i}`));
    tree[150] = t("rare", "Outro assunto qualquer", "cobra o faturamento mensal");
    const hits = triageRelated(draft(`${common} faturamento`), tree);
    expect(hits.map((hit) => hit.id)).toContain("rare");
    expect(hits[0]?.id).toBe("rare");
  });

  it("não exige todos os termos", () => {
    const hits = triageRelated(draft("Exportar relatório de vendas em pdf"), [t("a", "Relatório mensal"), t("b", "Cor do tema")]);
    expect(hits.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("termo raro pesa mais que termo comum", () => {
    const tree = [t("c1", "Cadastro de equipe"), t("c2", "Cadastro de perfil"), t("c3", "Cadastro de papel"), t("rare", "Webhook")];
    const hits = triageRelated(draft("Cadastro com webhook"), tree);
    expect(hits[0]?.id).toBe("rare");
  });

  it("termo no título pesa mais que no trecho", () => {
    const hits = triageRelated(draft("Webhook"), [t("excerpt", "Outro assunto", "fala de webhook"), t("title", "Webhook")]);
    expect(hits.map((hit) => hit.id)).toEqual(["title", "excerpt"]);
  });

  it("usa a descrição e os títulos das partes do rascunho", () => {
    const hits = triageRelated(draft("Coisa", "precisa de convite", ["Aviso por e-mail"]), [t("a", "Convite"), t("b", "Aviso"), t("c", "Cor")]);
    expect(hits.map((hit) => hit.id).sort()).toEqual(["a", "b"]);
  });

  it("devolve no máximo 30, em ordem de pontuação decrescente", () => {
    const tree = Array.from({ length: 100 }, (_, i) => t(`m${i}`, `Webhook ${"x".repeat(i % 3)}`, i % 2 === 0 ? "webhook" : ""));
    const hits = triageRelated(draft("Webhook"), tree);
    expect(hits).toHaveLength(RELATED_SHORTLIST);
    expect(RELATED_SHORTLIST).toBe(30);
    for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
  });

  it("é determinística: mesma entrada, mesma saída; empate segue a ordem de chegada", () => {
    const tree = [t("a", "Webhook"), t("b", "Webhook"), t("c", "Webhook")];
    expect(triageRelated(draft("Webhook"), tree).map((hit) => hit.id)).toEqual(["a", "b", "c"]);
    expect(triageRelated(draft("Webhook"), tree)).toEqual(triageRelated(draft("Webhook"), tree));
  });

  it("sem termos úteis ou sem tickets, devolve vazio", () => {
    expect(triageRelated(draft("de a o"), [t("a", "Webhook")])).toEqual([]);
    expect(triageRelated(draft("Webhook"), [])).toEqual([]);
  });

  it("árvores sorteadas: nunca passa de 30, só ids da entrada, sem repetição, ordenada", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const tree = invented(300, seed);
      const random = seeded(seed * 31);
      const words = Array.from({ length: 4 }, () => VOCAB[Math.floor(random() * VOCAB.length)]).join(" ");
      const hits = triageRelated(draft(words), tree);
      expect(hits.length).toBeLessThanOrEqual(30);
      expect(new Set(hits.map((hit) => hit.id)).size).toBe(hits.length);
      expect(hits.every((hit) => hit.id.startsWith("inv-"))).toBe(true);
      expect(hits).toEqual(triageRelated(draft(words), tree));
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it("a tela inteira de 3 000 tickets cabe com folga (linear)", () => {
    const tree = invented(3000, 9);
    const started = performance.now();
    triageRelated(request, tree);
    triageRelated(draft("painel mapa filtro cache fila"), tree);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
