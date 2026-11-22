import { describe, expect, it } from "vitest";
import { QUOTE_HEADER, buildRequestQuote, withRequestQuote } from "../src/assistant/request-quote.js";

const REFERENCE =
  "quero que a gente tenha uma interface tipo chat do slack no painel lateral esquerdo. quando uma pessoa tme um ticket um chat fica disponível pra ela trabalhar nele. a conversa é plugada num repositório do ticket e cria uma branch (se for uma tarefa que envolva código, claro) e o chat age essencialmente como uma harness. quebre a tarefa que eu vou pedir o design dela.";

describe("buildRequestQuote", () => {
  it("uma mensagem de uma linha: linha fixa, linha em branco e a citação, byte a byte", () => {
    expect(QUOTE_HEADER).toBe("Pedido original:");
    expect(buildRequestQuote([REFERENCE])).toBe(`Pedido original:\n\n> ${REFERENCE}`);
  });

  it("várias mensagens: ordem preservada, cada uma em sua citação, separadas por linha em branco", () => {
    expect(buildRequestQuote(["primeira", "segunda"])).toBe("Pedido original:\n\n> primeira\n\n> segunda");
  });

  it("várias linhas: cada linha ganha `> ` e a linha em branco vira `>`", () => {
    expect(buildRequestQuote(["a\n\nb\nc"])).toBe("Pedido original:\n\n> a\n>\n> b\n> c");
  });

  it("linha que já começa com `>` fica aninhada, sem se soltar da citação", () => {
    expect(buildRequestQuote(["> dela\n>> mais"])).toBe("Pedido original:\n\n> > dela\n> >> mais");
  });

  it("crases e cercas de código ficam dentro da citação, sem fechar nem abrir nada fora dela", () => {
    const text = "veja `isso` e\n```ts\nconst a = 1;\n```\nfim\n~~~\nsem fechar";
    const quote = buildRequestQuote([text]);
    expect(quote).toBe(
      "Pedido original:\n\n> veja `isso` e\n> ```ts\n> const a = 1;\n> ```\n> fim\n> ~~~\n> sem fechar",
    );
    expect(quote.split("\n").slice(2).every((line) => line.startsWith(">"))).toBe(true);
  });

  it("títulos, listas, linhas horizontais e marcas de setext ficam dentro da citação", () => {
    const quote = buildRequestQuote(["# Título\n- item\n---\ntexto\n==="]);
    for (const line of quote.split("\n").slice(2)) expect(line.startsWith(">")).toBe(true);
    expect(quote).toBe("Pedido original:\n\n> # Título\n> - item\n> ---\n> texto\n> ===");
  });

  it("não apara nem corrige: espaços e quebras por dentro ficam como estão", () => {
    expect(buildRequestQuote(["  oi   tudo  bem  \n   recuo "])).toBe("Pedido original:\n\n>   oi   tudo  bem  \n>    recuo ");
  });

  it("texto muito longo é mantido inteiro", () => {
    const long = "x".repeat(50_000);
    expect(buildRequestQuote([long])).toBe(`Pedido original:\n\n> ${long}`);
  });

  it("mensagem vazia ou só de espaços não vira citação; sem nenhuma mensagem, nada", () => {
    expect(buildRequestQuote(["", "   ", "ok"])).toBe("Pedido original:\n\n> ok");
    expect(buildRequestQuote([""])).toBe("");
    expect(buildRequestQuote([])).toBe("");
  });
});

describe("withRequestQuote", () => {
  it("a citação vem primeiro e a descrição da IA depois, separada por linha em branco", () => {
    expect(withRequestQuote(["oi"], "Descrição da IA.")).toBe("Pedido original:\n\n> oi\n\nDescrição da IA.");
  });

  it("descrição vazia: só a citação", () => {
    expect(withRequestQuote(["oi"], "")).toBe("Pedido original:\n\n> oi");
  });

  it("sem mensagens: só a descrição, como antes", () => {
    expect(withRequestQuote([], "Só a IA")).toBe("Só a IA");
  });
});
