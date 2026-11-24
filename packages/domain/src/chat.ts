/** Chat de trabalho (ADR 0049 e 0055): limites do corpo, das menções e do histórico, em funções puras. A regra de quem lê o quê é de `conversations.ts`. */

/** Tamanho de uma mensagem do chat, depois de aparada. */
export const CHAT_BODY_MIN = 1;
export const CHAT_BODY_MAX = 4000;
/** Pessoas mencionadas numa mensagem. */
export const CHAT_MAX_MENTIONS = 10;
/** Mensagens de thread (abrir e responder) por pessoa por minuto: conversa entre pessoas, sem custo de IA, mas com teto contra enxurrada. */
export const CHAT_THREAD_PER_PERSON_PER_MINUTE = 30;
/** Mensagens ao assistente por pessoa por minuto (as de thread, entre pessoas, não contam). */
export const CHAT_ASSISTANT_PER_PERSON_PER_MINUTE = 10;
/** O teto do que vai ao provedor da conversa da própria pessoa: as mais recentes, até este número e este total de caracteres. */
export const CHAT_HISTORY_MAX_MESSAGES = 20;
export const CHAT_HISTORY_MAX_CHARS = 24_000;

/**
 * O que não entra num corpo: byte NUL (o PostgreSQL não o aceita em `text`), os demais caracteres de controle (menos tabulação, quebra
 * de linha e retorno) e substitutos soltos (UTF-16 inválido). Conferido antes de qualquer provedor, para não gastar a chamada.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const hasForbiddenChatChars = (text: string): boolean => FORBIDDEN.test(text);

/** Corpo aparado, ou `null` quando vazio, acima do limite ou com caractere proibido. */
export function chatBodyOf(raw: string): string | null {
  const body = raw.trim();
  return body.length >= CHAT_BODY_MIN && body.length <= CHAT_BODY_MAX && !hasForbiddenChatChars(body) ? body : null;
}

export type ChatTurn = { author: "person" | "assistant"; body: string };

/**
 * O histórico que vai ao provedor: as mensagens mais recentes que cabem nos tetos, a mais nova sempre dentro, começando por
 * uma da pessoa (o provedor exige que a conversa abra com a pessoa). O que sobra do começo fica de fora.
 */
export function trimChatHistory(history: readonly ChatTurn[]): ChatTurn[] {
  const kept: ChatTurn[] = [];
  let chars = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i] as ChatTurn;
    const fits = kept.length < CHAT_HISTORY_MAX_MESSAGES && chars + turn.body.length <= CHAT_HISTORY_MAX_CHARS;
    if (!fits && kept.length > 0) break;
    kept.unshift(turn);
    chars += turn.body.length;
  }
  while (kept.length > 0 && kept[0]?.author !== "person") kept.shift();
  return kept;
}
