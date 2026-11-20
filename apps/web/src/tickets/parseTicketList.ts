import type { ImportItem, TicketStatus } from "../api/client.js";

/** Limites da importação (ADR 0024). */
const MAX_ITEMS = 500;
const MAX_DEPTH = 20;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 20_000;

export interface TicketListIssue {
  /** Número da linha no texto colado, a partir de 1. */
  line: number;
  code: string;
}

export type ParseTicketListResult =
  | { ok: true; items: ImportItem[]; warnings: TicketListIssue[] }
  | { ok: false; errors: TicketListIssue[] };

const STATUS_BY_MARKER: Record<string, TicketStatus | undefined> = {
  " ": undefined,
  "/": "in_progress",
  r: "in_review",
  x: "done",
  X: "done",
  "-": "cancelled",
};

interface Node {
  line: number;
  indent: number;
  title: string;
  status: TicketStatus | undefined;
  hasMarker: boolean;
  descriptionLines: { indent: number; text: string }[];
  children: Node[];
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 2;
    else break;
  }
  return width;
}

function toImportItem(node: Node, errors: TicketListIssue[]): ImportItem {
  const item: ImportItem = { title: node.title };
  const lines = node.descriptionLines;
  if (lines.length > 0) {
    const common = Math.min(...lines.filter((entry) => entry.text !== "").map((entry) => entry.indent));
    const description = lines.map((entry) => (entry.text === "" ? "" : " ".repeat(entry.indent - common) + entry.text)).join("\n");
    if (description.length > MAX_DESCRIPTION) errors.push({ line: node.line, code: "description_too_long" });
    item.description = description;
  }
  if (node.status !== undefined) item.status = node.status;
  if (node.children.length > 0) item.children = node.children.map((child) => toImportItem(child, errors));
  return item;
}

/**
 * Interpreta a lista de tarefas em Markdown colada pelo usuário (ADR 0024, "Formato da lista colada").
 * Função pura: devolve a árvore para a API ou todos os erros, cada um com a sua linha.
 */
export function parseTicketList(text: string): ParseTicketListResult {
  const errors: TicketListIssue[] = [];
  const warnings: TicketListIssue[] = [];
  const roots: Node[] = [];
  const stack: Node[] = [];
  let last: Node | null = null;
  let itemCount = 0;
  let overflowReported = false;
  let pendingBlanks = 0;

  text.split(/\r\n|\r|\n/).forEach((raw, position) => {
    const line = position + 1;
    const content = raw.trim();
    if (content === "") {
      pendingBlanks += 1;
      return;
    }
    const indent = indentOf(raw);
    const itemMatch = /^[-*](?: (.*))?$/.exec(content);

    if (itemMatch) {
      pendingBlanks = 0;
      let rest = (itemMatch[1] ?? "").trim();
      let status: TicketStatus | undefined;
      let hasMarker = false;
      const markerMatch = /^\[([ /rxX-])\](?: +(.*))?$/.exec(rest);
      if (markerMatch) {
        hasMarker = true;
        status = STATUS_BY_MARKER[markerMatch[1]!];
        rest = (markerMatch[2] ?? "").trim();
      }
      while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      const node: Node = { line, indent, title: rest, status, hasMarker, descriptionLines: [], children: [] };

      if (rest === "") errors.push({ line, code: "empty_title" });
      else if (rest.length > MAX_TITLE) errors.push({ line, code: "title_too_long" });
      itemCount += 1;
      if (itemCount > MAX_ITEMS && !overflowReported) {
        overflowReported = true;
        errors.push({ line, code: "too_many_items" });
      }
      if (stack.length + 1 > MAX_DEPTH) errors.push({ line, code: "depth_too_deep" });

      (parent ? parent.children : roots).push(node);
      stack.push(node);
      last = node;
      return;
    }

    if (last === null) {
      errors.push({ line, code: "text_before_first_item" });
      return;
    }
    if (indent <= last.indent) {
      pendingBlanks = 0;
      errors.push({ line, code: "stray_line" });
      return;
    }
    // Linhas em branco só entram na descrição quando há texto de descrição dos dois lados.
    if (last.descriptionLines.length > 0) {
      for (let blank = 0; blank < pendingBlanks; blank++) last.descriptionLines.push({ indent: 0, text: "" });
    }
    pendingBlanks = 0;
    last.descriptionLines.push({ indent, text: content });
  });

  if (roots.length === 0 && errors.length === 0) errors.push({ line: 1, code: "empty_list" });

  const items = roots.map((root) => toImportItem(root, errors));
  const flag = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.hasMarker && node.children.length > 0) warnings.push({ line: node.line, code: "marker_on_parent" });
      flag(node.children);
    }
  };
  flag(roots);
  warnings.sort((a, b) => a.line - b.line);

  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, items, warnings };
}

const MESSAGE_BY_CODE: Record<string, string> = {
  text_before_first_item: "Há texto antes do primeiro item. Comece a lista com “- ” ou “* ”.",
  stray_line: "Esta linha não é um item e não está recuada sob o item anterior, então não pertence a nenhuma descrição.",
  empty_title: "O item está sem título.",
  title_too_long: `O título passa de ${MAX_TITLE} caracteres.`,
  description_too_long: `A descrição passa de ${MAX_DESCRIPTION.toLocaleString("pt-BR")} caracteres.`,
  too_many_items: `A lista passa de ${MAX_ITEMS} itens. Importe em lotes menores.`,
  depth_too_deep: `A lista passa de ${MAX_DEPTH} níveis de profundidade.`,
  empty_list: "Não há nenhum item na lista.",
  marker_on_parent: "O marcador deste item não aparece: ticket com filhos não tem situação própria, e o progresso vem dos filhos.",
};

/** Traduz um erro ou aviso do interpretador em mensagem para a pessoa que colou a lista. */
export function describeTicketListIssue({ line, code }: TicketListIssue): string {
  return `Linha ${line}: ${MESSAGE_BY_CODE[code] ?? "a lista não pôde ser interpretada."}`;
}
