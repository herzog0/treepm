import { Marked } from "marked";

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const EXTERNAL = /^https?:\/\//i;
const SAFE = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

/**
 * Texto legal estático e nosso, não conteúdo de usuário. Mesmo assim, HTML embutido no markdown nunca vira elemento
 * (aparece como texto), imagem não carrega e só endereços http(s), mailto, internos e âncoras viram link.
 */
const marked = new Marked({
  gfm: true,
  renderer: {
    html: ({ text }) => escapeHtml(text),
    image: ({ text }) => escapeHtml(text),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE.test(href.trim())) return label;
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      const external = EXTERNAL.test(href.trim()) ? ' target="_blank" rel="noopener noreferrer"' : "";
      return `<a href="${escapeHtml(href.trim())}"${titleAttribute}${external}>${label}</a>`;
    },
  },
});

export function renderLegalMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false });
}
