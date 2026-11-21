import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeDescription, valueAfterEdit } from "./markdown.js";

// Formas das descrições que existem hoje (linhas soltas, "Critérios de aceite:" com "- ", crases, parágrafos) e o subconjunto da ADR 0036.
const STABLE: Record<string, string> = {
  "linhas soltas com quebra simples": "Linha um\nlinha dois\nlinha três",
  parágrafos: "Parágrafo um.\n\nParágrafo dois.",
  "dois níveis de título": "# Título\n\n## Subtítulo\n\ntexto",
  lista: "- a\n- b\n- c",
  "lista numerada": "1. a\n2. b",
  "lista de tarefas": "- [ ] a\n- [x] b",
  citação: "> citação\n> outra linha",
  "código em linha, negrito, itálico e link": "Use `código` aqui e **negrito** e *itálico* e [link](https://x.com).",
  "código em bloco": "```\nbloco\nde código\n```",
  "contexto com linha solta e parágrafos": "Contexto:\nHoje o CSV sempre traz cabeçalho.\n\nO que será feito:\nAdicionar uma opção.",
  "chave de ticket": "Depende de TREEPM-47 e de TREEPM-4.",
  "html como texto": "Texto <b>html</b> e <script>alert(1)</script> fim",
  "imagem como texto": "![imagem](a.png)",
  "tabela como texto": "| a | b |\n|---|---|\n| 1 | 2 |",
  "caracteres que o serializador escaparia": "Veja https://a.com/x_y?q=1&b=2 e snake_case_nome e a*b e [x] e R$ 10,00",
  riscado: "~~riscado~~ e https://auto.link",
};

describe("description markdown round trip", () => {
  for (const [name, text] of Object.entries(STABLE)) {
    it(`reads and writes back the same text: ${name}`, () => {
      expect(normalizeDescription(text)).toBe(text);
    });
  }

  it("does not change a text already normalized", () => {
    const once = normalizeDescription("Critérios de aceite:\n- um\n- dois");
    expect(normalizeDescription(once)).toBe(once);
  });

  it("puts a blank line between a paragraph and the list that follows it (declared difference)", () => {
    expect(normalizeDescription("Critérios de aceite:\n- um\n- dois")).toBe("Critérios de aceite:\n\n- um\n- dois");
  });

  it("drops the trailing blank lines the serializer adds", () => {
    expect(normalizeDescription("- a\n- b\n\n\n")).toBe("- a\n- b");
  });

  it("returns an empty string for an empty text", () => {
    expect(normalizeDescription("")).toBe("");
  });

  it("round-trips the forms of the real descriptions (sample with the same shapes)", () => {
    const samples = [
      "Permitir exportar tickets em CSV.\n\nResultado esperado: a pessoa baixa o arquivo.\n\nCritérios de aceite:\n- Existe uma forma de exportar.\n- O arquivo é um CSV válido.",
      "Contexto:\nHoje a exportação sempre inclui o cabeçalho.\n\nO que será feito:\nAdicionar à exportação uma opção para tirar a linha de cabeçalho.\n\nCritérios de aceite:\n- Existe a opção.\n- Sem a opção, o arquivo continua como hoje.",
      "Usar o campo `description` e o endpoint `/tickets`.\nNão mexer em `status`.",
    ];
    for (const sample of samples) {
      // Uma vez normalizado, o texto não muda mais; a única diferença da primeira passagem é a linha em branco antes da lista.
      expect(normalizeDescription(sample)).toBe(sample.replace(/:\n- /g, ":\n\n- "));
    }
  });
});

describe("valueAfterEdit", () => {
  const original = "Critérios de aceite:\n- um";
  const baseline = normalizeDescription(original);

  it("gives back the stored text when the serialization equals the baseline (no edit, nothing to rewrite)", () => {
    expect(valueAfterEdit(baseline, baseline, original)).toBe(original);
  });

  it("gives back the serialization when the person changed something", () => {
    expect(valueAfterEdit(`${baseline}\n- dois`, baseline, original)).toBe(`${baseline}\n- dois`);
  });
});

// Descrição real nunca é copiada para o repositório: este teste só roda quando o arquivo de gabarito existe na máquina.
const gabarito = `${process.env.HOME}/.local/share/treepm-ops/rebuild-2026-11-20/csv/gabarito.json`;
const real: string[] = (() => {
  try {
    return (JSON.parse(readFileSync(gabarito, "utf8")) as { tickets: { description?: string }[] }).tickets.map((entry) => entry.description ?? "").filter((text) => text !== "");
  } catch {
    return [];
  }
})();

describe.skipIf(real.length === 0)("round trip of the real descriptions (local file, optional)", () => {
  it("every description is stable once normalized and differs from the original only by the blank line before a list", () => {
    for (const text of real) {
      const normalized = normalizeDescription(text);
      expect(normalizeDescription(normalized)).toBe(normalized);
      expect(normalized.replace(/\n\n(?=- )/g, "\n")).toBe(text.replace(/\n+$/, ""));
    }
  });
});
