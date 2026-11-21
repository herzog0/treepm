// Texto visível não fica escrito em componente (ADR 0035): vem do catálogo de traduções.
// Acusa texto dentro de JSX, literais de texto em `{...}` dentro de JSX e os atributos aria-label, title, placeholder e alt.

const VISIBLE_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);
/** Só o que tem letra é texto para a pessoa; "·", "…" e "/" ficam de fora. */
const hasLetters = (text) => /\p{L}/u.test(text);

const isStringLike = (node) =>
  node && ((node.type === "Literal" && typeof node.value === "string") || (node.type === "TemplateLiteral" && node.expressions.length === 0));
const textOf = (node) => (node.type === "Literal" ? node.value : node.quasis.map((quasi) => quasi.value.cooked ?? "").join(""));

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      literal: "Texto visível deve vir do catálogo de traduções (apps/web/src/i18n/README.md), não ficar escrito no componente: {{text}}",
    },
  },
  create(context) {
    const report = (node, text) => context.report({ node, messageId: "literal", data: { text: JSON.stringify(text.trim().slice(0, 40)) } });
    return {
      JSXText(node) {
        if (hasLetters(node.value)) report(node, node.value);
      },
      JSXExpressionContainer(node) {
        if (node.parent.type === "JSXAttribute") return;
        if (isStringLike(node.expression) && hasLetters(textOf(node.expression))) report(node, textOf(node.expression));
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !VISIBLE_ATTRIBUTES.has(node.name.name) || !node.value) return;
        const value = node.value.type === "JSXExpressionContainer" ? node.value.expression : node.value;
        if (isStringLike(value) && hasLetters(textOf(value))) report(node, textOf(value));
      },
    };
  },
};
