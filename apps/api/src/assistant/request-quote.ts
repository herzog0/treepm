/**
 * A citação do pedido original (ADR 0044): as mensagens da pessoa naquela conversa, na ordem, exatamente como ela as
 * escreveu, montadas pela API na hora de criar. A IA nunca escreve nem altera este texto.
 */

/** Linha fixa que antecede a citação. */
export const QUOTE_HEADER = "Pedido original:";

/** Cada linha ganha `> ` e a linha vazia vira `>`: o que a pessoa escreveu (títulos, cercas, outro `>`) fica dentro da citação. */
const quoted = (message: string): string =>
  message
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");

/**
 * A linha fixa e uma citação (bloco `>`) por mensagem, separadas por linha em branco. Sem aparar, sem corrigir.
 * Mensagem vazia ou só de espaços não tem o que citar; sem nenhuma mensagem, devolve `""`.
 */
export function buildRequestQuote(messages: readonly string[]): string {
  const blocks = messages.filter((message) => message.trim() !== "").map(quoted);
  return blocks.length === 0 ? "" : `${QUOTE_HEADER}\n\n${blocks.join("\n\n")}`;
}

/** A descrição que será gravada: a citação primeiro, a descrição do rascunho depois. */
export function withRequestQuote(messages: readonly string[], description: string): string {
  const quote = buildRequestQuote(messages);
  if (quote === "") return description;
  return description === "" ? quote : `${quote}\n\n${description}`;
}

/**
 * Linha fixa que abre a descrição de uma tarefa sugerida pelo assistente (ADR 0052, item 4). É texto fixo em português, como
 * `QUOTE_HEADER`: não passa pelo catálogo de idiomas da tela porque é gravado no ticket. A tarefa nunca leva a citação do pedido
 * original: nada do que a pessoa não disse entra como se ela tivesse dito.
 */
export const SUGGESTED_LINE = "Sugerida pelo assistente, não pedida:";

/** A descrição gravada da tarefa sugerida: a linha fixa com o motivo e, depois de uma linha em branco, a descrição (se houver). */
export function suggestedDescription(motivo: string, description: string): string {
  const line = `${SUGGESTED_LINE} ${motivo.trim()}`;
  return description.trim() === "" ? line : `${line}\n\n${description.trim()}`;
}
