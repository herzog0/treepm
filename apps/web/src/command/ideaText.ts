/** O limite de título de um ticket na API (`ticketTitleSchema`). */
export const TITLE_MAX = 200;

/**
 * O texto da barra vira o título da ideia, até o limite; o que passa dele (contado em caracteres, não em unidades UTF-16) vai
 * para a descrição (ADR 0042). O título já vem sem espaços nas pontas; a descrição só existe quando sobra texto.
 */
export function splitIdeaText(text: string): { title: string; description?: string } {
  const chars = Array.from(text.trim());
  if (chars.length <= TITLE_MAX) return { title: chars.join("") };
  const description = chars.slice(TITLE_MAX).join("").trim();
  const title = chars.slice(0, TITLE_MAX).join("").trim();
  return description === "" ? { title } : { title, description };
}
