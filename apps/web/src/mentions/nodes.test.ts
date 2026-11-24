import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { descriptionExtensions, prepareDescription, readMarkdown } from "../ticket/description/markdown.js";

const ID = "6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10";
const known = new Set(["TREEPM-1", "TREEPM-2"]);

const open = (markdown: string, exists: (key: string) => boolean = (key) => known.has(key)) => {
  const editor = new Editor({ extensions: descriptionExtensions({ ticketExists: exists, people: true }), content: prepareDescription(markdown, exists, true), contentType: "markdown" });
  return { editor, text: () => readMarkdown(editor) };
};
const types = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => void (node.isText || found.push(`${node.type.name}${node.attrs["key"] ? `:${node.attrs["key"]}` : node.attrs["id"] ? `:${node.attrs["id"]}` : ""}`)));
  return found;
};

describe("ticket mention node", () => {
  it("reads #KEY of an existing ticket as one inline node and writes it back as #KEY", () => {
    const { editor, text } = open("veja #TREEPM-1 agora");
    expect(types(editor)).toEqual(["paragraph", "ticketMention:TREEPM-1"]);
    expect(text()).toBe("veja #TREEPM-1 agora");
  });

  it("reads the old bare key of an existing ticket as a mention (once prepared) and saves it with #", () => {
    const { text, editor } = open("veja TREEPM-2.", (key) => known.has(key));
    expect(types(editor)).toContain("ticketMention:TREEPM-2");
    expect(text()).toBe("veja #TREEPM-2.");
  });

  it("leaves #KEY of a ticket that does not exist as plain text", () => {
    const { editor, text } = open("veja #UTF-8 e #OUTRO-9");
    expect(types(editor)).toEqual(["paragraph"]);
    expect(text()).toBe("veja #UTF-8 e #OUTRO-9");
  });

  it("does not read #KEY glued to a word, inside code or in a link destination", () => {
    const { editor } = open("a#TREEPM-1 `#TREEPM-1` [x](https://a.com/#TREEPM-1)\n\n```\n#TREEPM-1\n```");
    expect(types(editor).filter((name) => name.startsWith("ticketMention"))).toEqual([]);
  });

  it("is removed whole by one Backspace right after it and by one Delete right before it", () => {
    const { editor, text } = open("a #TREEPM-1 b");
    const pos = (after: boolean) => {
      let at = -1;
      editor.state.doc.descendants((node, p) => void (node.type.name === "ticketMention" && (at = after ? p + node.nodeSize : p)));
      return at;
    };
    editor.commands.setTextSelection(pos(true));
    expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);
    expect(text()).toBe("a  b");
    const again = open("a #TREEPM-1 b");
    let before = -1;
    again.editor.state.doc.descendants((node, p) => void (node.type.name === "ticketMention" && (before = p)));
    again.editor.commands.setTextSelection(before);
    expect(again.editor.commands.keyboardShortcut("Delete")).toBe(true);
    expect(again.text()).toBe("a  b");
  });
});

describe("person mention node", () => {
  it("reads [@Name](person:id) as one inline node and writes the same link back", () => {
    const markdown = `oi ${personLink(ID, "Bia (QA) [x]")} tudo`;
    const { editor, text } = open(markdown);
    expect(types(editor)).toEqual(["paragraph", `personMention:${ID}`]);
    expect(editor.state.doc.firstChild!.child(1).attrs["name"]).toBe("Bia (QA) [x]");
    expect(text()).toBe(markdown);
  });

  it("is removed whole by one Backspace", () => {
    const { editor, text } = open(`oi ${personLink(ID, "Bia")}`);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.commands.keyboardShortcut("Backspace")).toBe(true);
    expect(text()).toBe("oi ");
  });

  it("does not read a link inside code as a mention", () => {
    const { editor } = open(`\`${personLink(ID, "Bia")}\``);
    expect(types(editor).some((name) => name.startsWith("personMention"))).toBe(false);
  });

  it("round-trips a comment with a person and a ticket without any edit", () => {
    const markdown = `${personLink(ID, "Bia")} veja #TREEPM-1:\n\n- item com #TREEPM-2\n- ${personLink(ID, "Bia")}`;
    expect(open(markdown).text()).toBe(markdown);
  });
});

describe("a descrição não tem item de pessoa (ADR 0058, revisão 2)", () => {
  const link = personLink(ID, "Bia");
  const plain = (markdown: string) => {
    const editor = new Editor({ extensions: descriptionExtensions({ ticketExists: (key) => known.has(key) }), content: prepareDescription(markdown, (key) => known.has(key)), contentType: "markdown" });
    return { editor, text: () => readMarkdown(editor) };
  };

  it("um elo de pessoa que sobrou no texto aparece como @Nome simples, sem nó e sem id", () => {
    const { editor, text } = plain(`Veja com ${link}.`);
    expect(types(editor)).toEqual(["paragraph"]);
    expect(text()).toBe("Veja com @Bia.");
    expect(text()).not.toContain("person:");
  });

  it("elo aninhado no nome de outro também some", () => {
    const { text } = plain(`[@\\[@Bob\\]\\(person:${ID}\\)](person:${ID})`);
    expect(text()).not.toContain("person:");
  });

  it("HTML colado com item de pessoa vira texto @Nome", () => {
    const { editor } = plain("x");
    editor.commands.insertContent(`<span class="mention-person" data-person-id="${ID}" data-person-name="Bia">@Bia</span>`, { parseOptions: { preserveWhitespace: false } });
    expect(types(editor)).toEqual(["paragraph"]);
    expect(readMarkdown(editor)).toContain("@Bia");
    expect(readMarkdown(editor)).not.toContain("person:");
  });
});

describe("o texto da descrição aberta e salva sem mexer (endereços, revisão 2)", () => {
  it.each(["https://x/browse/TREEPM-1", "a#TREEPM-1", "v=TREEPM-1", "<https://x/TREEPM-1>", "[ver](https://x/TREEPM-1)"])("não muda: %s", (text) => {
    const first = open(text).text();
    expect(first).not.toContain("##");
    expect(first).not.toContain("/#TREEPM");
    // salvar de novo não acumula `#`
    expect(open(first).text()).toBe(first);
  });
});
