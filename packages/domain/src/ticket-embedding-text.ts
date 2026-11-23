/**
 * O texto de um ticket que vai à busca por significado (ADR 0053, item 2). Função pura: só título e descrição entram;
 * situação, pai, prioridade, pessoas e o resto do ticket não fazem parte do texto. O resumo criptográfico dele
 * (`ticketEmbeddingHash`) vive na API, que tem `node:crypto`.
 *
 * Não há limpeza de menções a pessoas aqui, de propósito: a descrição de um ticket é markdown livre e o TreePM não guarda menção
 * a pessoa nela (as menções a pessoas existem só nas threads do chat, por id, e nunca chegam a este texto). Se a pessoa escrever
 * um nome na descrição, ele vai junto, como já vai ao Claude e ao Jev (ver o relatório da fatia 1).
 */

/** Tamanho máximo, em caracteres (pontos de código), do texto enviado por ticket. */
export const EMBEDDING_TEXT_MAX_CHARS = 8000;

/** O que o texto usa do ticket: só estes dois campos. */
export type TicketEmbeddingSource = { title: string; description: string };

/** Título, linha em branco e descrição, cortado em 8 000 caracteres sem partir um par substituto. Sem descrição, só o título. */
export function ticketEmbeddingText(ticket: TicketEmbeddingSource): string {
  const title = ticket.title.trim();
  const description = ticket.description.trim();
  const text = description === "" ? title : `${title}\n\n${description}`;
  if (text.length <= EMBEDDING_TEXT_MAX_CHARS) return text;
  let end = 0;
  let points = 0;
  while (points < EMBEDDING_TEXT_MAX_CHARS && end < text.length) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
    points += 1;
  }
  return text.slice(0, end);
}
