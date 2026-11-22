/**
 * Casos de concordância da menção (ADR 0037): o texto em markdown e as chaves que ele menciona, na ordem em que aparecem e sem
 * repetição. A mesma lista vale para o domínio (`mentionedKeys`) e para o editor da descrição (as etiquetas desenhadas), para
 * que a etiqueta na tela e a ligação gravada nunca discordem.
 */
export interface MentionCase {
  readonly name: string;
  readonly markdown: string;
  readonly keys: readonly string[];
}

export const mentionCases: readonly MentionCase[] = [
  { name: "paragraph", markdown: "Ver TREEPM-1 depois.", keys: ["TREEPM-1"] },
  { name: "heading", markdown: "# Plano de TREEPM-2\n\nTexto.", keys: ["TREEPM-2"] },
  { name: "list item", markdown: "- um item\n- TREEPM-3 no segundo", keys: ["TREEPM-3"] },
  { name: "task item", markdown: "- [ ] fazer TREEPM-4\n- [x] feito TREEPM-5", keys: ["TREEPM-4", "TREEPM-5"] },
  { name: "quote", markdown: "> como em TREEPM-6", keys: ["TREEPM-6"] },
  { name: "bold", markdown: "isto é **TREEPM-7** mesmo", keys: ["TREEPM-7"] },
  { name: "italic", markdown: "isto é _TREEPM-8_ mesmo", keys: ["TREEPM-8"] },
  { name: "inline code does not count", markdown: "use `TREEPM-9` aqui", keys: [] },
  { name: "inline code with a backtick pair does not count", markdown: "use ``TREEPM-9 ` TREEPM-10`` aqui, mas TREEPM-11 conta", keys: ["TREEPM-11"] },
  { name: "backtick fenced block does not count", markdown: "antes TREEPM-12\n\n```\nTREEPM-13\n```\n\ndepois TREEPM-14", keys: ["TREEPM-12", "TREEPM-14"] },
  { name: "tilde fenced block does not count", markdown: "~~~ts\nconst a = 'TREEPM-15';\n~~~\n\nTREEPM-16", keys: ["TREEPM-16"] },
  { name: "unclosed fenced block runs to the end", markdown: "TREEPM-17\n\n```\nTREEPM-18", keys: ["TREEPM-17"] },
  { name: "key in the middle of a word does not count", markdown: "aTREEPM-19 e TREEPM-190x e TREEPM-20y", keys: [] },
  { name: "key glued to a hyphen or an underscore does not count", markdown: "TREEPM-21-b e a-TREEPM-22 e _TREEPM-23_x e x_TREEPM-24", keys: [] },
  { name: "repeated key counts once", markdown: "TREEPM-25 e TREEPM-26 e de novo TREEPM-25", keys: ["TREEPM-25", "TREEPM-26"] },
  { name: "link text counts", markdown: "veja [o TREEPM-27](https://exemplo.com/a)", keys: ["TREEPM-27"] },
  { name: "link address does not count", markdown: "veja [a página](https://exemplo.com/TREEPM-28)", keys: [] },
  { name: "link address with a title does not count", markdown: "veja [TREEPM-29](https://exemplo.com/TREEPM-30 \"TREEPM-31\")", keys: ["TREEPM-29"] },
  { name: "key before punctuation", markdown: "(TREEPM-32), TREEPM-33.", keys: ["TREEPM-32", "TREEPM-33"] },
];
