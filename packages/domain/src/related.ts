import { foldForSearch } from "./search.js";

/**
 * Triagem por palavras dos tickets que podem tratar do mesmo assunto de um rascunho (ADR 0052, item 2). Função pura, sem
 * banco nem provedor: a conversa a usa para escolher, entre todos os tickets da árvore, os poucos que o Jev vai julgar.
 *
 * Regra: o rascunho (título, descrição e títulos das partes) e cada ticket (título e trecho) viram termos: minúsculas, sem
 * acento, sem palavras vazias de português, inglês e espanhol, e com radical simples. A nota de um ticket é a soma, por
 * termo do rascunho que ele tem, do peso do termo: raro no projeto vale mais (`ln((total + 1) / tickets que o têm)`, que quase zera o termo presente em quase todos os tickets) e termo
 * no título vale o dobro do termo só no trecho. Não se exige que todos os termos apareçam. Empate segue a ordem de chegada.
 * Linear no número de tickets (cada um é lido uma vez; a lista dos melhores tem tamanho fixo).
 */

/** Quantos tickets a triagem entrega ao julgamento do Jev. */
export const RELATED_SHORTLIST = 30;
/** O radical é o prefixo do termo; palavras menores que isto ficam inteiras. "importar", "importação" e "import" viram "impor". */
export const STEM_LENGTH = 5;
const TITLE_WEIGHT = 2;

export type TriageDraft = { title: string; description: string; partTitles: readonly string[] };
export type TriageTicket = { id: string; title: string; excerpt: string };
export type TriageHit = { id: string; score: number };

const STOP_WORDS = new Set(
  (
    // português
    "a o as os um uma uns umas de do da dos das em no na nos nas por pelo pela pelos pelas para pra com sem sob sobre entre ate ao aos e ou mas que se como quando onde ja nao sim mais menos muito muita muitos muitas tambem so " +
    "num numa nesse nessa dele dela qual quem porque ainda depois antes eu tu ele ela nos eles elas me te lhe meu minha seu sua nosso nossa este esta estes estas esse essa esses essas isto isso aquilo aquele aquela cada todo toda todos todas outro outra outros outras mesmo mesma " +
    "ser sao era foi sera estar esta estao ter tem tinha ha fazer faz pode podem deve devem quero queremos preciso precisa poder " +
    // inglês
    "what which how when also only after before new the an and or but of to in on at by for from with without about into over under between as is are was were be been being it its this that these those there here do does did have has had will would can could should may might not no yes if then than so such each every all any some other same i you he she we they me him her us them my your his our their " +
    // espanhol
    "es lo le desde porque el la los las un una unos unas del al y o pero que en por para con sin sobre entre hasta como cuando donde ya si mas menos muy tambien yo tu usted nosotros ellos ellas mi su nuestro este esta estos estas ese esa esos esas eso esto cada todo toda todos todas otro otra otros otras mismo misma ser son era fue sera estar esta estan tener tiene hay hacer hace puede pueden debe deben"
  ).split(/\s+/),
);

/** Formas estrangeiras que o radical por prefixo não junta ao português: "sync" e "synchronize" são "sincronizar". */
const ALIASES: readonly [RegExp, string][] = [[/^(sync|synchron)/, "sincr"]];

/** O radical de uma palavra já sem acento nem maiúscula (ou não: a função normaliza). */
export function stemOf(word: string): string {
  let folded = foldForSearch(word);
  // Plural simples: "mapas" e "mapa", "erros" e "erro" dão o mesmo radical.
  if (folded.length >= 4 && folded.endsWith("s")) folded = folded.slice(0, -1);
  for (const [pattern, stem] of ALIASES) if (pattern.test(folded)) return stem;
  return folded.slice(0, STEM_LENGTH);
}

/** Os radicais de um texto, na ordem em que aparecem (com repetição): sem palavra vazia, sem número puro, sem palavra de uma letra. */
export function termsOf(text: string): string[] {
  const out: string[] = [];
  for (const word of foldForSearch(text).split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || /^\d+$/.test(word) || STOP_WORDS.has(word)) continue;
    out.push(stemOf(word));
  }
  return out;
}

export function triageRelated(draft: TriageDraft, tickets: Iterable<TriageTicket>, limit: number = RELATED_SHORTLIST): TriageHit[] {
  const wanted = new Set(termsOf([draft.title, draft.description, ...draft.partTitles].join("\n")));
  if (wanted.size === 0 || limit <= 0) return [];

  // Uma passada: de cada ticket guarda só os termos do rascunho que ele tem (e se estão no título).
  const rows: { id: string; found: Map<string, boolean> }[] = [];
  const document = new Map<string, number>();
  let total = 0;
  for (const ticket of tickets) {
    total += 1;
    const found = new Map<string, boolean>();
    for (const term of termsOf(ticket.excerpt)) if (wanted.has(term)) found.set(term, false);
    for (const term of termsOf(ticket.title)) if (wanted.has(term)) found.set(term, true);
    for (const term of found.keys()) document.set(term, (document.get(term) ?? 0) + 1);
    if (found.size > 0) rows.push({ id: ticket.id, found });
  }

  const best: TriageHit[] = [];
  for (const row of rows) {
    let score = 0;
    for (const [term, inTitle] of row.found) score += Math.log((total + 1) / (document.get(term) ?? total)) * (inTitle ? TITLE_WEIGHT : 1);
    // Inserção na lista dos melhores (tamanho fixo); empate fica depois de quem chegou antes.
    if (score <= 0) continue;
    let at = best.length;
    while (at > 0 && (best[at - 1] as TriageHit).score < score) at -= 1;
    if (at >= limit) continue;
    best.splice(at, 0, { id: row.id, score });
    if (best.length > limit) best.pop();
  }
  return best;
}
