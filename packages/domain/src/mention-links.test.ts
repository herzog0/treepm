import { describe, expect, it } from "vitest";
import { hashTicketKeys, hasPersonLink, mentionsPersonRaw, withoutPersonLinksDeep, personIdsIn, personLink, scanPersonLinks, scanTicketRefs, withoutPersonLinks } from "./mentions.js";

const ID = "6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10";
const OTHER = "0b5a1c2e-7d3e-4f1a-8a55-3c2b1d9e4f22";

/** Gerador pseudoaleatório fixo: a mesma sequência em toda execução. */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe("personLink", () => {
  it("writes [@Name](person:id)", () => {
    expect(personLink(ID, "Bia Souza")).toBe(`[@Bia Souza](person:${ID})`);
  });

  it("escapes brackets, parentheses and backslashes in the name, and flattens line breaks", () => {
    expect(personLink(ID, "Bia [dev] (QA) \\ x\ny")).toBe(`[@Bia \\[dev\\] \\(QA\\) \\\\ x y](person:${ID})`);
  });
});

describe("scanPersonLinks", () => {
  it("finds the links with id, name and position", () => {
    const text = `Oi ${personLink(ID, "Bia")} e ${personLink(OTHER, "Caio")}!`;
    const found = scanPersonLinks(text);
    expect(found.map((link) => [link.id, link.name])).toEqual([[ID, "Bia"], [OTHER, "Caio"]]);
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(personLink(ID, "Bia"));
  });

  it("round-trips names with special characters", () => {
    for (const name of ["Bia", "Zé (QA)", "a]b", "a[b", "a)b(c", "back\\slash", "emoji 🙂", "[@x](person:y)", "  espaços  ", "a\\"]) {
      const text = `antes ${personLink(ID, name)} depois`;
      const [link] = scanPersonLinks(text);
      expect(link?.name).toBe(name.replace(/\s+/g, " ").trim());
      expect(link?.id).toBe(ID);
      expect(scanPersonLinks(text)).toHaveLength(1);
    }
  });

  it("does not count a normal link destination or an empty id", () => {
    expect(scanPersonLinks("[@Bia](https://exemplo.com)")).toEqual([]);
    expect(scanPersonLinks("[@Bia](person:)")).toEqual([]);
  });

  it("does not turn arbitrary text into a link (property)", () => {
    const next = random(7);
    const alphabet = ["@", "[", "]", "(", ")", "person:", "a", "B", " ", "\n", "`", "\\", "#", "TREEPM-1", "-", "é"];
    for (let round = 0; round < 500; round += 1) {
      let text = "";
      for (let i = 0, size = Math.floor(next() * 14); i < size; i += 1) text += alphabet[Math.floor(next() * alphabet.length)];
      const hasShape = /\[@[^\]]*\]\(person:[A-Za-z0-9_-]+\)/.test(text);
      if (!hasShape) expect(scanPersonLinks(text), JSON.stringify(text)).toEqual([]);
    }
  });

  it("builds and finds the same links in any text (property)", () => {
    const next = random(11);
    const names = ["Bia", "Zé (QA)", "a]b", "x)y", "[z", "a\\b", "Ana Maria"];
    for (let round = 0; round < 200; round += 1) {
      const links: { id: string; name: string }[] = [];
      let text = "";
      for (let i = 0, size = 1 + Math.floor(next() * 4); i < size; i += 1) {
        const id = `${Math.floor(next() * 1e9).toString(16)}-${i}`;
        const name = names[Math.floor(next() * names.length)]!;
        links.push({ id, name });
        text += `${next() < 0.5 ? "texto " : "\n"}${personLink(id, name)} `;
      }
      expect(scanPersonLinks(text).map(({ id, name }) => ({ id, name })), JSON.stringify(text)).toEqual(links);
    }
  });
});

describe("personIdsIn, hasPersonLink and withoutPersonLinks", () => {
  const text = `a ${personLink(ID, "Bia")} b ${personLink(OTHER, "Caio")} c ${personLink(ID, "Bia")}`;

  it("lists the ids without repetition, in order", () => {
    expect(personIdsIn(text)).toEqual([ID, OTHER]);
    expect(hasPersonLink(text)).toBe(true);
    expect(hasPersonLink("sem elo @Bia")).toBe(false);
  });

  it("turns each link into the plain @Name", () => {
    expect(withoutPersonLinks(text)).toBe("a @Bia b @Caio c @Bia");
  });

  it("can take out only some people", () => {
    expect(withoutPersonLinks(text, new Set([OTHER]))).toBe(`a ${personLink(ID, "Bia")} b @Caio c ${personLink(ID, "Bia")}`);
  });
});

describe("scanTicketRefs", () => {
  it("finds the key with # and the bare key, saying which is which; the range includes the #", () => {
    const text = "veja #TREEPM-1 e TREEPM-2";
    const [first, second] = scanTicketRefs(text);
    expect(first).toEqual({ key: "TREEPM-1", start: 5, end: 14, hashed: true });
    expect(second).toEqual({ key: "TREEPM-2", start: 17, end: 25, hashed: false });
  });

  it("does not count the # glued to a word, another #, or a path", () => {
    expect(scanTicketRefs("a#TREEPM-1 ##TREEPM-2 a/#TREEPM-3").every((ref) => !ref.hashed)).toBe(true);
  });

  it("leaves out code and link destinations, like mentionedKeys", () => {
    expect(scanTicketRefs("`#TREEPM-1` [x](https://a.com/#TREEPM-2)\n\n```\n#TREEPM-3\n```")).toEqual([]);
  });
});

describe("hashTicketKeys", () => {
  const exists = (key: string) => key === "TREEPM-1" || key === "TREEPM-2";

  it("puts # on the bare keys of tickets that exist, and only on them", () => {
    expect(hashTicketKeys("TREEPM-1, TREEPM-9 e #TREEPM-2", exists)).toBe("#TREEPM-1, TREEPM-9 e #TREEPM-2");
  });

  it("does not touch code or link destinations, but does the text of a link (it counts as a mention, like in mentionedKeys)", () => {
    const text = "`TREEPM-1` [TREEPM-2](https://a.com/TREEPM-1)\n\n```\nTREEPM-1\n```";
    expect(hashTicketKeys(text, exists)).toBe("`TREEPM-1` [#TREEPM-2](https://a.com/TREEPM-1)\n\n```\nTREEPM-1\n```");
  });

  it.each([
    "https://x/browse/TREEPM-1",
    "a#TREEPM-1",
    "v=TREEPM-1",
    "<https://x/TREEPM-1>",
    "https://x/browse/TREEPM-2?x=TREEPM-1",
  ])("leaves addresses and glued keys alone: %s", (text) => {
    expect(hashTicketKeys(text, exists)).toBe(text);
    expect(hashTicketKeys(hashTicketKeys(text, exists), exists)).toBe(text);
  });

  it("is idempotent", () => {
    const once = hashTicketKeys("TREEPM-1 e TREEPM-2", exists);
    expect(hashTicketKeys(once, exists)).toBe(once);
  });
});

describe("mentionsPersonRaw (the strict test that refuses a person mention)", () => {
  const link = personLink(ID, "Bia");
  it.each([
    ["plain", link],
    ["inside inline code", `\`${link}\``],
    ["fence in a quote", `> \`\`\`\n> ${link}\n> \`\`\``],
    ["fence in a list item", `- \`\`\`\n  ${link}\n  \`\`\``],
    ["escaped backticks", `\\\`${link}\\\``],
    ["indented fence after a paragraph", `texto\n    \`\`\`\n${link}\n    \`\`\``],
    ["upper case scheme", `[@Bia](PERSON:${ID})`],
    ["spaces before the scheme", `[@Bia]( person:${ID})`],
    ["reference form", `[@Bia][1]\n\n[1]: person:${ID}`],
    ["html anchor", `<a href="person:${ID}">Bia</a>`],
    ["autolink", `<person:${ID}>`],
  ])("refuses %s", (_name, text) => {
    expect(mentionsPersonRaw(text)).toBe(true);
  });
  it.each(["sem elo @Bia", "[site](https://a.com)", "person: é uma palavra", "a ](https://person.com)"])("lets %j through", (text) => {
    expect(mentionsPersonRaw(text)).toBe(false);
  });
});

describe("raw scan of person links (messages are text, not markdown)", () => {
  it("counts a link between backticks or in a fence", () => {
    expect(personIdsIn(`\`${personLink(ID, "Bia")}\``)).toEqual([ID]);
    expect(personIdsIn(`\`\`\`\n${personLink(OTHER, "Caio")}\n\`\`\``)).toEqual([OTHER]);
    expect(personIdsIn(`[@Bia](PERSON:${ID})`)).toEqual([ID]);
  });
});

describe("withoutPersonLinksDeep", () => {
  it("leaves no link, even one nested in the name of another", () => {
    const nested = `[@\\[@Bob\\]\\(person:${OTHER}\\)](person:${ID})`;
    expect(withoutPersonLinks(nested)).toContain("person:");
    const clean = withoutPersonLinksDeep(nested);
    expect(clean).not.toContain("person:");
    expect(personIdsIn(clean)).toEqual([]);
  });
});
