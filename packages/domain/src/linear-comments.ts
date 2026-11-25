/**
 * Comentários do Linear (ADR 0061, seções 4, 5 e 6; TREEPM-477): corpo, citação do pai e autor, puros (sem banco nem rede). O corpo
 * passa pela mesma neutralização da descrição: nada vira menção de pessoa nem de ticket do TreePM. O e-mail nunca chega aqui.
 */
import { COMMENT_BODY_MAX } from "./comments.js";
import { looksLikeEmail } from "./email-shape.js";
import { cleanLinearText, mapLinearMarkdown } from "./linear-import.js";

/** Tamanho do início do pai citado numa resposta. */
export const LINEAR_COMMENT_QUOTE_MAX = 140;
/** Teto do nome de exibição de quem não é pessoa do TreePM (o mesmo do criador). */
export const LINEAR_COMMENT_AUTHOR_MAX = 120;

const cutChars = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/**
 * O corpo do comentário: a linha de citação do pai (quando conhecido) e o corpo, montados ANTES da neutralização (o encaixe dos dois
 * não forma menção), cortados no limite do comentário. O caractere nulo vira U+FFFD (o PostgreSQL o recusa); os outros controles saem.
 * `null` quando não sobra texto, ou quando o corpo sozinho não tem texto (o comentário não é criado).
 */
export function mapLinearComment(body: string, projectKey: string, quote: string | null): string | null {
  // Sem texto próprio, a resposta seria só a citação do pai: não é criada (e a citação não teria como ser retirada se o pai sair).
  if (cleanLinearText(cutChars(body, COMMENT_BODY_MAX)).replaceAll("\u0000", "").trim() === "" && !body.includes("\u0000")) return null;
  const assembled = quote !== null && quote !== "" ? `> ${quote}\n\n${body}` : body;
  const text = mapLinearMarkdown(assembled.replaceAll("\u0000", "�"), projectKey, COMMENT_BODY_MAX).trim();
  return text === "" ? null : text;
}

/** O início do pai numa linha só: sem os marcadores de citação dele, sem quebras, até 140 caracteres (com reticências quando corta). */
export function linearCommentQuote(parentBody: string): string {
  // O texto é cortado antes de juntar as linhas: o trabalho fica limitado mesmo num pai enorme.
  const head = cleanLinearText(cutChars(parentBody, LINEAR_COMMENT_QUOTE_MAX * 20));
  const line = head
    .split(/\r?\n/)
    .map((piece) => piece.replace(/^\s*(?:>\s*)+/, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > LINEAR_COMMENT_QUOTE_MAX ? `${cutChars(line, LINEAR_COMMENT_QUOTE_MAX).trimEnd()}…` : line;
}

/**
 * O nome de exibição do Linear como o TreePM o guarda: limpo, numa linha, até 120 caracteres; vazio → `null`. Nome com forma de e-mail
 * (conferida ANTES do corte) também → `null`: e-mail do Linear nunca é guardado nem mostrado.
 */
export function linearCommentAuthorName(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const name = cleanLinearText(cutChars(raw, LINEAR_COMMENT_AUTHOR_MAX * 4)).replace(/\s+/g, " ").trim();
  if (looksLikeEmail(name)) return null;
  const cut = cutChars(name, LINEAR_COMMENT_AUTHOR_MAX).trim();
  return cut === "" ? null : cut;
}

export type LinearCommentAuthorColumns = { authorPersonId: string | null; externalAuthorName: string | null };

/**
 * O autor de um comentário do Linear (ADR 0061, seção 5; revisto no C2): função do usuário do Linear e do casamento ATUAL, nos dois
 * sentidos (pessoa ↔ nome ↔ outra pessoa). `author.name` já passou por `linearCommentAuthorName`. `emailReadable`: esta leitura pediu
 * e recebeu o e-mail; sem ele, o autor já gravado (`current`) não muda, exceto um nome em forma de e-mail, que é sempre zerado. Robô e
 * usuário de fora não têm e-mail: sempre o nome. Autor apagado no Linear (`author` nulo): os dois nulos. Nunca quem sincroniza.
 */
export function linearCommentAuthor(input: {
  author: { kind: "user" | "bot" | "external"; name: string | null } | null;
  emailReadable: boolean;
  matchedPersonId: string | null;
  current: LinearCommentAuthorColumns | null;
}): LinearCommentAuthorColumns {
  const { author, current } = input;
  if (author === null) return { authorPersonId: null, externalAuthorName: null };
  if (author.kind === "user" && !input.emailReadable && current !== null) {
    const name = current.externalAuthorName;
    return { authorPersonId: current.authorPersonId, externalAuthorName: name !== null && looksLikeEmail(name) ? null : name };
  }
  if (author.kind === "user" && input.emailReadable && input.matchedPersonId !== null) return { authorPersonId: input.matchedPersonId, externalAuthorName: null };
  return { authorPersonId: null, externalAuthorName: author.name };
}
