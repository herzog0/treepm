import { describe, expect, it } from "vitest";
import { personLink } from "@treepm/domain";
import { makeTicket } from "../test/fakes.js";
import { chatDocFromText, chatTextFromDoc, neutralizePaste } from "./chatText.js";

const ID = "6f1c2c1e-3b0e-4a57-9f55-0d2a5c1f7a10";
const byKey = new Map([["ALFA-1", makeTicket("t1", "p1", 1, "Um", { key: "ALFA-1" })]]);

describe("chatDocFromText", () => {
  it("turns line breaks into hard breaks and the stored person link and #KEY of a visible ticket into mention items", () => {
    const text = `oi ${personLink(ID, "Bia")}\nveja #ALFA-1 e #UTF-8`;
    const doc = chatDocFromText(text, byKey);
    expect(doc.content?.[0]?.content?.map((node) => node.type)).toEqual(["text", "personMention", "hardBreak", "text", "ticketMention", "text"]);
    expect(chatTextFromDoc(doc)).toBe(text);
  });

  it("round-trips any text without mention syntax unchanged (property)", () => {
    for (const text of ["", "a", "a\n\nb", "  espaço  ", "@Bia #ALFA-1", "x\n", "\ncomeço"]) {
      expect(chatTextFromDoc(chatDocFromText(text, new Map()))).toBe(text);
    }
  });

  it("does not make an item of #KEY when the ticket is not visible", () => {
    const doc = chatDocFromText("#ALFA-1", new Map());
    expect(doc.content?.[0]?.content?.map((node) => node.type)).toEqual(["text"]);
  });
});

describe("neutralizePaste", () => {
  it("turns pasted person links into plain @Name so pasting never marks someone", () => {
    expect(neutralizePaste(`ver ${personLink(ID, "Bia")} e @Caio`)).toBe("ver @Bia e @Caio");
  });
});
