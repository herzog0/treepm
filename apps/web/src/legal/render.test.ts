import { describe, expect, it } from "vitest";
import { renderLegalMarkdown } from "./render.js";

describe("renderLegalMarkdown", () => {
  it("turns a table into a table", () => {
    const html = renderLegalMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
  });

  it("opens external links in another tab, safely", () => {
    const html = renderLegalMarkdown("Veja [a página](https://example.com/x?a=1&b=2) e <https://example.org/y>.");
    expect(html).toMatch(/<a href="https:\/\/example\.com\/x\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">a página<\/a>/);
    expect(html).toMatch(/<a href="https:\/\/example\.org\/y" target="_blank" rel="noopener noreferrer">/);
  });

  it("keeps internal links in the same tab", () => {
    const html = renderLegalMarkdown("[outro](/privacidade) e [seção](#s1)");
    expect(html).toContain('<a href="/privacidade">outro</a>');
    expect(html).toContain('<a href="#s1">seção</a>');
    expect(html).not.toContain("_blank");
  });

  it("does not accept HTML embedded in the markdown", () => {
    const html = renderLegalMarkdown('<script>alert(1)</script>\n\ntexto <img src=x onerror="alert(1)"> e <b>negrito</b>\n\n<div onclick="x()">bloco</div>\n');
    const dom = new DOMParser().parseFromString(html, "text/html");
    expect(dom.querySelector("script, img, b, div")).toBeNull();
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
  });

  it("does not turn a script URL into a link", () => {
    const html = renderLegalMarkdown("[x](javascript:alert(1)) e [y](JaVaScRiPt:alert(2)) e [z](data:text/html;base64,AAAA)");
    expect(html).not.toMatch(/href=["']?\s*(javascript|data):/i);
  });

  it("does not load images", () => {
    expect(renderLegalMarkdown("![logo](https://example.com/a.png)")).not.toContain("<img");
  });

  it("renders both real documents, with their headings, tables and external links", async () => {
    const { LEGAL_MARKDOWN } = await import("./content.js");
    for (const markdown of Object.values(LEGAL_MARKDOWN)) {
      const html = renderLegalMarkdown(markdown);
      expect(html).toContain("<h1>");
      expect(html).not.toMatch(/<(script|img|iframe)/);
    }
    const privacy = renderLegalMarkdown(LEGAL_MARKDOWN.privacy);
    expect(privacy).toContain("<table>");
    expect(privacy).toContain('href="https://www.anthropic.com/legal/commercial-terms" target="_blank" rel="noopener noreferrer"');
  });
});
