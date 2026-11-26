import { describe, expect, it } from "vitest";
import { LABEL_NAME_CASES } from "./label-name-cases.js";
import {
  cleanLabelName,
  defaultLabelColor,
  groupedLabelName,
  isLabelColor,
  LABEL_COLORS,
  LABEL_NAME_KEY_MAX,
  LABEL_NAME_MAX,
  LABELS_PER_PROJECT,
  LABELS_PER_TICKET,
  labelNameKey,
  labelNameRefused,
  nearestLabelColor,
  sameLabelName,
} from "./labels.js";

// ADR 0065: etiquetas por projeto, com nome de até 60 caracteres (único sem diferenciar maiúsculas) e cor de uma paleta fixa de oito.
describe("limites e paleta", () => {
  it("tem os limites da ADR", () => {
    expect(LABEL_NAME_MAX).toBe(60);
    expect(LABELS_PER_TICKET).toBe(20);
    expect(LABELS_PER_PROJECT).toBe(200);
  });
  it("tem oito cores fixas, sem as cores de situação do mapa", () => {
    expect(LABEL_COLORS).toHaveLength(8);
    expect(new Set(LABEL_COLORS).size).toBe(8);
    for (const status of ["red", "green", "blue", "yellow", "teal"]) expect(LABEL_COLORS).not.toContain(status);
    expect(LABEL_COLORS).toContain("gray");
  });
  it("reconhece só as chaves da paleta", () => {
    for (const color of LABEL_COLORS) expect(isLabelColor(color)).toBe(true);
    for (const other of ["red", "", "GRAY", "#ff0000", null, 3]) expect(isLabelColor(other)).toBe(false);
  });
});

describe("cleanLabelName", () => {
  it("apara e junta espaços", () => {
    expect(cleanLabelName("  Bug   crítico  ")).toBe("Bug crítico");
  });
  it("troca quebra de linha, tabulação, nulo e controle por espaço", () => {
    expect(cleanLabelName("a\nb\r\nc\td\u0000e\u0007f\u2028g\u0085h")).toBe("a b c d e f g h");
  });
  it("só espaços, vazio ou controle vira nulo", () => {
    expect(cleanLabelName("   ")).toBeNull();
    expect(cleanLabelName("")).toBeNull();
    expect(cleanLabelName("\u0000\n\t")).toBeNull();
  });
  it("corta em 60 pontos de código, sem partir um emoji (o char_length do banco)", () => {
    const emoji = "🐛".repeat(70);
    const cut = cleanLabelName(emoji) as string;
    expect([...cut]).toHaveLength(60);
    expect(cut).toBe("🐛".repeat(60));
    expect(cleanLabelName("x".repeat(61))).toBe("x".repeat(60));
  });
  it("não deixa espaço no fim depois do corte", () => {
    expect(cleanLabelName(`${"a".repeat(59)} b`)).toBe("a".repeat(59));
  });
  it("normaliza para NFC (composto e decomposto são o mesmo nome)", () => {
    expect(cleanLabelName("Café")).toBe("Café");
  });
  it("roda em tempo linear com 100 mil caracteres", () => {
    const hostile = `${" \n".repeat(50_000)}nome`;
    const started = performance.now();
    expect(cleanLabelName(hostile)).toBe("nome");
    expect(cleanLabelName("x".repeat(100_000))).toBe("x".repeat(60));
    expect(performance.now() - started).toBeLessThan(200);
  });
  it("não é texto: nulo", () => {
    expect(cleanLabelName(undefined as unknown as string)).toBeNull();
    expect(cleanLabelName(42 as unknown as string)).toBeNull();
  });
});

describe("labelNameKey", () => {
  it("não diferencia maiúsculas", () => {
    expect(labelNameKey("Bug")).toBe(labelNameKey("BUG"));
    expect(labelNameKey("Ação")).toBe(labelNameKey("AÇÃO"));
  });
  it("junta formas de compatibilidade (largura total, ligaduras)", () => {
    expect(labelNameKey("Ｂｕｇ")).toBe(labelNameKey("bug"));
    expect(labelNameKey("ﬁx")).toBe(labelNameKey("fix"));
  });
  it("composto e decomposto dão a mesma chave", () => {
    expect(labelNameKey("Café")).toBe(labelNameKey("Café"));
  });
  it("sameLabelName compara pela chave", () => {
    expect(sameLabelName("Cliente X", "cliente x")).toBe(true);
    expect(sameLabelName("Cliente X", "Cliente Y")).toBe(false);
  });
});

describe("groupedLabelName", () => {
  it("põe o grupo na frente", () => {
    expect(groupedLabelName("Área", "Frontend")).toBe("Área: Frontend");
  });
  it("corta em 60 sem partir par substituto", () => {
    const name = groupedLabelName("🐛".repeat(40), "🔥".repeat(40)) as string;
    expect([...name]).toHaveLength(60);
    expect(name.startsWith("🐛".repeat(40))).toBe(true);
    expect(name.includes("�")).toBe(false);
  });
  it("grupo vazio: só o nome", () => {
    expect(groupedLabelName("  ", "Bug")).toBe("Bug");
  });
});

describe("nearestLabelColor", () => {
  it("cada cor da paleta volta para ela mesma", async () => {
    const { LABEL_HEX } = await import("./labels.js");
    for (const color of LABEL_COLORS) expect(nearestLabelColor(LABEL_HEX[color])).toBe(color);
  });
  it("cores do Linear vão para a mais próxima", () => {
    expect(nearestLabelColor("#f2994a")).toBe("orange");
    expect(nearestLabelColor("#bec2c8")).toBe("gray");
    expect(nearestLabelColor("#26b5ce")).toBe("cyan");
    expect(nearestLabelColor("#5e6ad2")).toBe("indigo");
    expect(nearestLabelColor("#d18cf0")).toBe("violet");
    expect(nearestLabelColor("#eb5757")).not.toBe("gray");
  });
  it("aceita sem # e com três dígitos, sem diferenciar maiúsculas", () => {
    expect(nearestLabelColor("F2994A")).toBe("orange");
    expect(nearestLabelColor("#FFF")).toBe("gray");
  });
  it("hex inválido vira gray", () => {
    for (const bad of ["", "#12", "#gggggg", "laranja", null, undefined, 12, "#1234567"]) expect(nearestLabelColor(bad as unknown as string)).toBe("gray");
  });
});

describe("defaultLabelColor", () => {
  it("é determinística pelo nome, sem diferenciar maiúsculas, e da paleta", () => {
    expect(defaultLabelColor("Bug")).toBe(defaultLabelColor("bug"));
    expect(LABEL_COLORS).toContain(defaultLabelColor("qualquer coisa"));
  });
  it("espalha nomes diferentes por várias cores", () => {
    const colors = new Set(["bug", "dívida técnica", "cliente x", "precisa de decisão", "frontend", "backend", "design", "infra", "docs", "urgente", "pesquisa", "ux"].map(defaultLabelColor));
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });
});

// Revisão E1 (TREEPM-466), itens 1 e 2: o domínio decide antes do banco. A chave que passa do CHECK do banco e os caracteres invisíveis
// tornam o nome inválido; a mesma lista de casos é conferida contra o banco em `apps/api/test/label-name-cases.test.ts`.
describe("labelNameRefused e a lista compartilhada com o banco", () => {
  it("concorda com cada caso da lista (que tem dos dois lados)", () => {
    expect(LABEL_NAME_CASES.some((item) => item.refused) && LABEL_NAME_CASES.some((item) => !item.refused)).toBe(true);
    expect(LABEL_NAME_CASES.filter((item) => labelNameRefused(item.name) !== item.refused)).toEqual([]);
  });
  it("cleanLabelName nunca devolve um nome que o banco recusaria", () => {
    const inputs = [...LABEL_NAME_CASES.map((item) => item.name), "\ufdfa".repeat(14), "\ufdfa".repeat(70), `a${"\ufdfa".repeat(59)}`, "\u200b bug \u200b", " \u00ad ", "x".repeat(200)];
    for (const raw of inputs) {
      const name = cleanLabelName(raw);
      if (name !== null) expect(labelNameRefused(name), JSON.stringify(name)).toBe(false);
    }
  });
  it("nome cuja chave passa de 240 pontos de código é inválido (nulo), mesmo com 60 ou menos", () => {
    expect(LABEL_NAME_KEY_MAX).toBe(240);
    expect(cleanLabelName("\ufdfa".repeat(13))).toBe("\ufdfa".repeat(13));
    expect(cleanLabelName("\ufdfa".repeat(14))).toBeNull();
    expect(cleanLabelName("\ufdfa".repeat(20))).toBeNull();
    expect(groupedLabelName("\ufdfa".repeat(10), "\ufdfa".repeat(10))).toBeNull();
  });
});

describe("caracteres invisíveis", () => {
  const INVISIBLE = ["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff", "\u00ad", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069", "\u200e", "\u200f"];
  it("saem do nome: \"bug\", \"bug\\u200b\" e \"b\\u00adug\" são o mesmo nome guardado", () => {
    expect(cleanLabelName("bug\u200b")).toBe("bug");
    expect(cleanLabelName("b\u00adug")).toBe("bug");
    for (const char of INVISIBLE) expect(cleanLabelName(`b${char}u${char}g`), JSON.stringify(char)).toBe("bug");
  });
  it("nome feito só de invisíveis (e espaços) é inválido", () => {
    expect(cleanLabelName("\u200b")).toBeNull();
    expect(cleanLabelName("\u2060\u200d")).toBeNull();
    expect(cleanLabelName("\u00ad")).toBeNull();
    expect(cleanLabelName(` ${INVISIBLE.join(" ")} `)).toBeNull();
  });
  it("a chave também os ignora (a tela compara o texto digitado cru)", () => {
    expect(labelNameKey("bug\u200b")).toBe(labelNameKey("bug"));
    expect(labelNameKey("B\u00adUG")).toBe(labelNameKey("bug"));
    expect(sameLabelName("\u202ebug\u202c", "Bug")).toBe(true);
  });
  it("não juntam as palavras vizinhas a um espaço", () => {
    expect(cleanLabelName("a \u200b b")).toBe("a b");
    expect(cleanLabelName("\u200b a")).toBe("a");
  });
  it("tempo linear com 100 mil invisíveis", () => {
    const hostile = `${"\u200b\u00ad".repeat(50_000)}nome`;
    const started = performance.now();
    expect(cleanLabelName(hostile)).toBe("nome");
    expect(labelNameKey(hostile)).toBe("nome");
    expect(performance.now() - started).toBeLessThan(200);
  });
});
