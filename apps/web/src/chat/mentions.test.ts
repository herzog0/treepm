import { describe, expect, it } from "vitest";
import { makeTicket } from "../test/fakes.js";
import { citedTickets, hashedKeys, liveTrigger, splitTicketRefs, typedTrigger, wantsTickets, withoutHashOfTickets, withoutToken, withTicketKey } from "./mentions.js";

const alfa1 = makeTicket("t1", "p1", 1, "Login", { key: "ALFA-1" });
const alfa2 = makeTicket("t2", "p1", 2, "Versão", { key: "ALFA-2" });
const byKey = new Map([alfa1, alfa2].map((ticket) => [ticket.key, ticket] as const));
const keys = new Set(["ALFA"]);

describe("typedTrigger", () => {
  it("vale digitado no começo, depois de espaço e depois de quebra de linha", () => {
    expect(typedTrigger("", "#", 1)).toEqual({ char: "#", start: 0 });
    expect(typedTrigger("oi ", "oi @", 4)).toEqual({ char: "@", start: 3 });
    expect(typedTrigger("oi\n", "oi\n#", 4)).toEqual({ char: "#", start: 3 });
  });
  it("não vale colado, no meio de palavra (`C#`) nem com outro caractere", () => {
    expect(typedTrigger("", "@Bia", 4)).toBeNull();
    expect(typedTrigger("C", "C#", 2)).toBeNull();
    expect(typedTrigger("a", "ab", 2)).toBeNull();
  });
  it("digitado sobre uma seleção, a substitui e abre", () => {
    expect(typedTrigger("olá mundo", "olá @", 5, { start: 4, end: 9 })).toEqual({ char: "@", start: 4 });
    expect(typedTrigger("olá mundo", "olá @", 5)).toBeNull();
  });
});

describe("o trecho do gatilho", () => {
  it("com o cursor no meio, a busca é até o cursor e confirmar troca o trecho inteiro", () => {
    const live = liveTrigger({ char: "@", start: 4 }, "olá @bia tchau", 7)!;
    expect(live.query).toBe("bi");
    expect(live.end).toBe(8);
    expect(withoutToken("olá @bia tchau", live)).toEqual({ text: "olá tchau", caret: 4 });
    expect(withTicketKey("olá #alf tchau", { ...live, char: "#", end: 8 }, "ALFA-1")).toEqual({ text: "olá #ALFA-1 tchau", caret: 12 });
  });
});

describe("as chaves citadas", () => {
  it("`#CHAVE` vale no começo do texto, depois de espaço e no começo da linha", () => {
    expect(citedTickets("#ALFA-1", byKey)).toEqual([alfa1]);
    expect(citedTickets("veja\n#ALFA-1 e (#ALFA-2)", byKey)).toEqual([alfa1, alfa2]);
  });
  it("a mesma chave repetida conta uma vez", () => {
    expect(citedTickets("#ALFA-1 de novo #ALFA-1", byKey)).toEqual([alfa1]);
    expect(hashedKeys("#ALFA-1 #ALFA-1", keys)).toEqual(["ALFA-1"]);
  });
  it("não vale dentro de endereço, de código, de destino de link nem colada em palavra", () => {
    for (const text of ["https://app/p#ALFA-1", "abc#ALFA-1", "`#ALFA-1`", "```\n#ALFA-1\n```", "[x](https://app/p#ALFA-1)", "[x](#ALFA-1)", "##ALFA-1", "a/b#ALFA-1"]) {
      expect(citedTickets(text, byKey), text).toEqual([]);
    }
  });
  it("sem `#` não é citação, e a chave de outro projeto (UTF-8, COVID-19) não pede a lista", () => {
    expect(citedTickets("ALFA-1", byKey)).toEqual([]);
    expect(wantsTickets("#UTF-8 e COVID-19 e GPT-4", keys, true)).toBe(false);
    expect(wantsTickets("#ALFA-1", keys)).toBe(true);
    expect(wantsTickets("ALFA-1", keys)).toBe(false);
    expect(wantsTickets("ALFA-1", keys, true)).toBe(true);
    expect(hashedKeys("#UTF-8 #ALFA-1", keys)).toEqual(["ALFA-1"]);
  });
});

describe("os elos", () => {
  it("a mesma regra de fronteira: o elo só onde há citação", () => {
    expect(splitTicketRefs("veja #ALFA-1 já", byKey)).toEqual(["veja ", { ticket: alfa1 }, " já"]);
    expect(splitTicketRefs("https://app/p#ALFA-1 e abc#ALFA-2", byKey)).toEqual(["https://app/p#ALFA-1 e abc#ALFA-2"]);
    expect(splitTicketRefs("veja ALFA-1", byKey, true)).toEqual(["veja ", { ticket: alfa1 }]);
  });
  it("tirar o `#` não mexe em código nem em destino de link", () => {
    expect(withoutHashOfTickets("veja #ALFA-1", byKey)).toBe("veja ALFA-1");
    expect(withoutHashOfTickets("[x](https://app/p#ALFA-1) e `#ALFA-2`", byKey)).toBe("[x](https://app/p#ALFA-1) e `#ALFA-2`");
  });
});
