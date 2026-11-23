/**
 * O que o servidor aceita da elaboração do modelo (ADR 0052, item 4). Lógica pura: o modelo só propõe; nada do que ele
 * devolve é gravado sem passar por aqui, e nada é cortado em silêncio (o item fora do limite é descartado inteiro).
 */
import { mentionedKeys } from "@treepm/domain";
import { QUOTE_HEADER } from "./request-quote.js";
import { ELABORATION_MAX_LINKS, ELABORATION_MAX_SUGGESTED } from "./prompts.js";
import type { ElaborationLink, ElaborationSuggestion } from "./ports.js";

export const MAX_REASON_CHARS = 300;
export const MAX_SUGGESTED_TITLE_CHARS = 200;
export const MAX_SUGGESTED_DESCRIPTION_CHARS = 600;

/** Minúsculas, sem acento nem pontuação e com espaços colapsados: a comparação de títulos. */
export const normalizeTitle = (title: string): string =>
  title
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** O motivo é uma linha só: quebras e espaços repetidos viram um espaço. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Texto que forjaria a citação do pedido (ADR 0044): o cabeçalho fixo dela, ou uma linha que abre bloco de citação (`>`).
 * A citação é só do pai e só do que a pessoa escreveu.
 */
export const forbiddenQuoteText = (...texts: readonly string[]): boolean =>
  texts.some((text) => text.toLowerCase().includes(QUOTE_HEADER.toLowerCase()) || /^\s*>/m.test(text));

export type ElaborationContext = {
  draftTitle: string;
  /** Os títulos das partes do rascunho, na ordem. */
  partTitles: readonly string[];
  /** Os relacionados que foram ao modelo. */
  related: readonly { key: string; title: string }[];
  /** O relacionado apontado como o mesmo pedido: nenhuma ligação vai a ele. */
  duplicateKey: string | null;
  /** A chave do projeto (sem o número): sugerida que cita outro ticket do projeto além dos relacionados é descartada. */
  projectKey: string;
};

export function sanitizeElaboration(
  raw: { links: readonly ElaborationLink[]; suggested: readonly ElaborationSuggestion[] },
  ctx: ElaborationContext,
): { links: ElaborationLink[]; suggested: ElaborationSuggestion[] } {
  const keys = new Set(ctx.related.map((entry) => entry.key));
  const seenLinks = new Set<string>();
  const links: ElaborationLink[] = [];
  for (const entry of raw.links) {
    if (links.length >= ELABORATION_MAX_LINKS) break;
    const motivo = oneLine(entry.motivo);
    const fromOk = entry.de === "pai" || (Number.isInteger(entry.de) && entry.de >= 0 && entry.de < ctx.partTitles.length);
    if (!fromOk || !keys.has(entry.dependeDe) || entry.dependeDe === ctx.duplicateKey) continue;
    if (motivo === "" || motivo.length > MAX_REASON_CHARS) continue;
    const id = `${entry.de}>${entry.dependeDe}`;
    if (seenLinks.has(id)) continue;
    seenLinks.add(id);
    links.push({ de: entry.de, dependeDe: entry.dependeDe, motivo });
  }

  const taken = new Set([ctx.draftTitle, ...ctx.partTitles, ...ctx.related.map((entry) => entry.title)].map(normalizeTitle));
  const suggested: ElaborationSuggestion[] = [];
  for (const entry of raw.suggested) {
    if (suggested.length >= ELABORATION_MAX_SUGGESTED) break;
    const title = entry.title.trim();
    const motivo = oneLine(entry.motivo);
    const description = entry.description.trim();
    if (forbiddenQuoteText(title, motivo, description)) continue;
    if (mentionedKeys(`${title}\n${motivo}\n${description}`).some((key) => key.startsWith(`${ctx.projectKey}-`) && !keys.has(key))) continue;
    if (title === "" || title.length > MAX_SUGGESTED_TITLE_CHARS || motivo === "" || motivo.length > MAX_REASON_CHARS || description.length > MAX_SUGGESTED_DESCRIPTION_CHARS) continue;
    const normalized = normalizeTitle(title);
    if (normalized === "" || taken.has(normalized)) continue;
    taken.add(normalized); // também descarta a sugestão repetida entre si
    suggested.push({ title, description, motivo });
  }
  return { links, suggested };
}
