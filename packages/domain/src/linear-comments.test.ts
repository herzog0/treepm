import { describe, expect, it } from "vitest";
import { COMMENT_BODY_MAX } from "./comments.js";
import { LINEAR_COMMENT_QUOTE_MAX, linearCommentAuthor, linearCommentAuthorName, linearCommentQuote, mapLinearComment } from "./linear-comments.js";
import { mentionedKeys, mentionsPersonRaw } from "./mentions.js";
import { looksLikeEmail } from "./email-shape.js";

// Comentários do Linear (ADR 0061, seções 4, 5 e 6; TREEPM-477): corpo, citação do pai e autor. Nada aqui vira menção do TreePM.

describe("mapLinearComment", () => {
  it("mantém o Markdown e apara as pontas", () => {
    expect(mapLinearComment("  **Feito.** Veja o `log`.\n", "KEY", null)).toBe("**Feito.** Veja o `log`.");
  });

  it("neutraliza menção de pessoa no formato do TreePM e o destino person: cru", () => {
    const body = mapLinearComment("Oi [@Ana](person:0190a0b0-0000-7000-8000-000000000001) e [x](person:abc) <person:y>", "KEY", null) as string;
    expect(mentionsPersonRaw(body)).toBe(false);
    expect(body).toContain("@Ana");
  });

  it("neutraliza a chave do projeto de destino (não cita ticket do TreePM)", () => {
    const body = mapLinearComment("ver KEY-12 e #KEY-3", "KEY", null) as string;
    expect(mentionedKeys(body).filter((key) => key.startsWith("KEY-"))).toEqual([]);
  });

  it("troca o caractere nulo em vez de falhar e tira os controles", () => {
    const body = mapLinearComment("a\u0000b\u0007c", "KEY", null) as string;
    expect(body).not.toContain("\u0000");
    expect(body).toBe("a�bc");
  });

  it("corta no limite do comentário", () => {
    const body = mapLinearComment("x".repeat(COMMENT_BODY_MAX + 500), "KEY", null) as string;
    expect(body.length).toBe(COMMENT_BODY_MAX);
  });

  it("corpo vazio (ou só espaços) não vira comentário", () => {
    expect(mapLinearComment("   \n ", "KEY", null)).toBeNull();
    expect(mapLinearComment("\u0007", "KEY", null)).toBeNull();
  });

  it("com o pai conhecido, começa por uma linha de citação", () => {
    expect(mapLinearComment("Concordo.", "KEY", "Proposta: mudar o fluxo")).toBe("> Proposta: mudar o fluxo\n\nConcordo.");
  });

  it("citação + corpo passam juntos pela neutralização (o encaixe não forma menção)", () => {
    const body = mapLinearComment("(person:abc)", "KEY", "[@Ana]") as string;
    expect(mentionsPersonRaw(body)).toBe(false);
    const keyed = mapLinearComment("-4 e mais", "KEY", "ver KEY") as string;
    expect(mentionedKeys(keyed).filter((key) => key.startsWith("KEY-"))).toEqual([]);
  });
});

describe("resposta sem texto próprio (C2, revisão)", () => {
  it("corpo vazio ou só controles não vira um comentário que é só a citação do pai", () => {
    expect(mapLinearComment("", "KEY", "texto do pai")).toBeNull();
    expect(mapLinearComment(" \u0001\u0002\n ", "KEY", "texto do pai")).toBeNull();
    expect(mapLinearComment("oi", "KEY", "texto do pai")).toBe("> texto do pai\n\noi");
  });
});

describe("linearCommentQuote", () => {
  it("uma linha só, aparada, sem quebras", () => {
    expect(linearCommentQuote("  Primeira linha\n\nsegunda\tlinha  ")).toBe("Primeira linha segunda linha");
  });
  it(`até ${LINEAR_COMMENT_QUOTE_MAX} caracteres, com reticências quando corta`, () => {
    const quote = linearCommentQuote("a".repeat(500));
    expect(quote.length).toBe(LINEAR_COMMENT_QUOTE_MAX + 1);
    expect(quote.endsWith("…")).toBe(true);
  });
  it("vazio continua vazio; a citação de outra citação não acumula o marcador", () => {
    expect(linearCommentQuote(" \n ")).toBe("");
    expect(linearCommentQuote("> avô\n\nresposta do pai")).toBe("avô resposta do pai");
  });
});

describe("linearCommentAuthorName", () => {
  it("limpa, junta as linhas e corta em 120", () => {
    expect(linearCommentAuthorName(" Ana\nSouza\r\n ")).toBe("Ana Souza");
    expect(linearCommentAuthorName("a\u0000b")).toBe("ab");
    expect(linearCommentAuthorName("n".repeat(300))?.length).toBe(120);
  });
  it("vazio ou ausente → nulo", () => {
    expect(linearCommentAuthorName("  ")).toBeNull();
    expect(linearCommentAuthorName(null)).toBeNull();
  });
});

describe("nome em forma de e-mail (C2, item 1)", () => {
  it("não é guardado: vale como nome ausente", () => {
    expect(linearCommentAuthorName("zed@linear.test")).toBeNull();
    expect(linearCommentAuthorName("  Zed <zed.sentinela@linear.test>\n")).toBeNull();
    // A forma é conferida antes do corte: um e-mail que só cabe inteiro depois dos 120 caracteres também não fica.
    expect(linearCommentAuthorName(`${"a".repeat(118)}@x.test`)).toBeNull();
    expect(looksLikeEmail("ana@exemplo.test")).toBe(true);
  });
  it("@ sem domínio com ponto continua sendo nome", () => {
    expect(linearCommentAuthorName("@ana")).toBe("@ana");
    expect(linearCommentAuthorName("ana @ casa")).toBe("ana @ casa");
    expect(looksLikeEmail("ana@local")).toBe(false);
  });
});

describe("linearCommentAuthor (C2, item 3: o autor acompanha o casamento atual)", () => {
  const user = (name: string | null) => ({ kind: "user" as const, name });
  it("e-mail legível: casa → a pessoa; não casa → o nome (nos dois sentidos, inclusive trocando de pessoa)", () => {
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: true, matchedPersonId: "p1", current: null })).toEqual({ authorPersonId: "p1", externalAuthorName: null });
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: true, matchedPersonId: null, current: null })).toEqual({ authorPersonId: null, externalAuthorName: "Ana" });
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: true, matchedPersonId: null, current: { authorPersonId: "p1", externalAuthorName: null } })).toEqual({ authorPersonId: null, externalAuthorName: "Ana" });
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: true, matchedPersonId: "p2", current: { authorPersonId: "p1", externalAuthorName: null } })).toEqual({ authorPersonId: "p2", externalAuthorName: null });
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: true, matchedPersonId: "p1", current: { authorPersonId: null, externalAuthorName: "Ana" } })).toEqual({ authorPersonId: "p1", externalAuthorName: null });
  });
  it("e-mail ilegível: o autor já gravado não muda; comentário novo fica com o nome", () => {
    expect(linearCommentAuthor({ author: user("Outro"), emailReadable: false, matchedPersonId: null, current: { authorPersonId: "p1", externalAuthorName: null } })).toEqual({ authorPersonId: "p1", externalAuthorName: null });
    expect(linearCommentAuthor({ author: user("Outro"), emailReadable: false, matchedPersonId: null, current: { authorPersonId: null, externalAuthorName: "Ana" } })).toEqual({ authorPersonId: null, externalAuthorName: "Ana" });
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: false, matchedPersonId: null, current: null })).toEqual({ authorPersonId: null, externalAuthorName: "Ana" });
  });
  it("nome gravado em forma de e-mail é zerado mesmo com e-mail ilegível", () => {
    expect(linearCommentAuthor({ author: user("Ana"), emailReadable: false, matchedPersonId: null, current: { authorPersonId: null, externalAuthorName: "ana@exemplo.test" } })).toEqual({ authorPersonId: null, externalAuthorName: null });
  });
  it("robô e usuário de fora: sempre o nome; autor apagado no Linear: os dois nulos", () => {
    expect(linearCommentAuthor({ author: { kind: "bot", name: "GitHub" }, emailReadable: false, matchedPersonId: null, current: null })).toEqual({ authorPersonId: null, externalAuthorName: "GitHub" });
    expect(linearCommentAuthor({ author: { kind: "external", name: "Zé" }, emailReadable: true, matchedPersonId: null, current: { authorPersonId: null, externalAuthorName: "Zé antigo" } })).toEqual({ authorPersonId: null, externalAuthorName: "Zé" });
    expect(linearCommentAuthor({ author: null, emailReadable: false, matchedPersonId: null, current: { authorPersonId: "p1", externalAuthorName: null } })).toEqual({ authorPersonId: null, externalAuthorName: null });
  });
});

/** Repete `unit` até o tamanho dado. */
const fill = (size: number, unit: string, prefix = "", suffix = ""): string => `${prefix}${unit.repeat(Math.ceil(size / unit.length))}`.slice(0, size - suffix.length) + suffix;
/** Os padrões hostis de `mentions-linear.test.ts`, mais os do formato de menção do TreePM. */
const HOSTILE: Record<string, (size: number) => string> = {
  "]: + espaços": (n) => fill(n, " ", "]:", "x"),
  "]: + < + espaços": (n) => fill(n, " ", "]:<", "x"),
  "href= + aspas + espaços": (n) => fill(n, " ", 'href="', "x"),
  "](  + espaços": (n) => fill(n, " ", "](", "x"),
  "< repetido com espaços": (n) => fill(n, "< "),
  "[ repetido": (n) => fill(n, "["),
  "menção do TreePM repetida": (n) => fill(n, "[@Ana](person:0190a0b0-0000-7000-8000-000000000001) "),
  "person: cru repetido": (n) => fill(n, "](person:"),
  "chave do projeto repetida": (n) => fill(n, "KEY-1 #KEY-2 "),
  "nulos e quebras": (n) => fill(n, "\u0000\n\r"),
};

function best(work: () => unknown): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i += 1) {
    const start = performance.now();
    work();
    min = Math.min(min, performance.now() - start);
  }
  return min;
}

describe("texto hostil em tempo linear", () => {
  it.each(Object.entries(HOSTILE))("%s: corpo e nome de 100.000 caracteres, sem menção no resultado", (_name, make) => {
    const big = make(100_000);
    const small = make(10_000);
    const tBig = best(() => mapLinearComment(big, "KEY", big));
    const tSmall = best(() => mapLinearComment(small, "KEY", small));
    expect(tBig).toBeLessThan(1500);
    // Cresce no máximo umas 30 vezes de 10.000 para 100.000 (linear com folga; quadrático seria 100).
    expect(tBig / Math.max(tSmall, 1)).toBeLessThan(30);
    const body = mapLinearComment(big, "KEY", linearCommentQuote(big));
    if (body !== null) {
      expect(mentionsPersonRaw(body)).toBe(false);
      expect(mentionedKeys(body).filter((key) => key.startsWith("KEY-"))).toEqual([]);
      expect(body.length).toBeLessThanOrEqual(COMMENT_BODY_MAX);
    }
    const name = linearCommentAuthorName(big);
    expect(best(() => linearCommentAuthorName(big))).toBeLessThan(200);
    if (name !== null) for (const bad of ["\n", "\r", "\u0000"]) expect(name).not.toContain(bad);
  });
});
