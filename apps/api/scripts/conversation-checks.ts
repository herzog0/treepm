/**
 * Conferências puras da medição da conversa de novo ticket (ADR 0044, TREEPM-211). Sem rede, sem banco, sem provedor:
 * recebem o que o provedor devolveu e dizem o que se perdeu, o que foi inventado e o que a IA afirmou que fez.
 */
import { sanitizeElaboration } from "../src/assistant/elaboration.js";
import type { ConversationDraft, ElaborationLink, ElaborationRelated, ElaborationSuggestion, RelatedInput, RelatedJudge, RelatedJudgment } from "../src/assistant/ports.js";
import { linkExistingSuggestions } from "../src/assistant/suggested-links.js";

export type MustMention = { label: string; anyOf: readonly string[] };

export type ConversationCase = {
  id: string;
  messages: readonly string[];
  expectChildren: boolean | "either";
  /** A IA deve (`true`) ou não deve (`false`) ligar `idea`; ausente, não se confere (TREEPM-242). */
  expectIdea?: boolean | undefined;
  minChildren?: number | undefined;
  maxChildren?: number | undefined;
  mustMention: readonly MustMention[];
  mustNotMention: readonly string[];
  /**
   * Opcional (ADR 0052, fatia 3): a árvore pequena e inventada que o caso leva consigo. Presente (mesmo vazia), o caso também
   * mede a elaboração: ligações e tarefas sugeridas, à parte do que a conversa pode inventar.
   */
  related?: readonly ElaborationRelated[] | undefined;
  /** As chaves que a elaboração tem de propor como "depende de" (todas). */
  expectLinkKeys?: readonly string[] | undefined;
  /** Quantas tarefas sugeridas, depois do descarte do servidor, são aceitas. */
  minSuggested?: number | undefined;
  maxSuggested?: number | undefined;
  /**
   * Opcional (R4): a árvore inteira do caso, com tickets que o modelo NÃO recebeu como relacionados (`related`). A procura das
   * tarefas sugeridas roda sobre ela, com o Jev falso `sameRequestByTitle`.
   */
  tree?: readonly { key: string; title: string; excerpt: string; status: string }[] | undefined;
  /** O Jev falso da medição: o ticket (por título) "pede a mesma coisa" que a sugerida cujo texto cita pelo menos um dos trechos. */
  sameRequestByTitle?: readonly { ticketTitle: string; whenSuggestedMentions: readonly string[] }[] | undefined;
  /** Trechos que NÃO podem aparecer nos títulos das tarefas sugeridas que sobraram (a equivalente tem de virar ligação). */
  noSuggestedMention?: readonly string[] | undefined;
};

/** O que importa de um turno do provedor para a conferência. */
export type TurnLike = { message: string; draft: ConversationDraft | null; ready: boolean };

export type MentionResult = { label: string; covered: boolean; matched: string | null };
export type InventedHit = { phrase: string; context: string };

/** Minúsculas e sem acentos (decomposição Unicode sem as marcas). */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Texto normalizado e, para cada caractere dele, a posição no original (para recortar o contexto com o texto da pessoa). */
function normalizeWithMap(text: string): { normalized: string; origin: number[] } {
  let normalized = "";
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const piece = normalizeText(text[i] as string);
    normalized += piece;
    for (let k = 0; k < piece.length; k += 1) origin.push(i);
  }
  return { normalized, origin };
}

/** Pelo menos um trecho de cada item aparece (como pedaço de texto, não de palavra: "repositorio" cobre "repositórios"). */
export function checkMustMention(text: string, items: readonly MustMention[]): MentionResult[] {
  const haystack = normalizeText(text);
  return items.map((item) => {
    const matched = item.anyOf.find((phrase) => haystack.includes(normalizeText(phrase))) ?? null;
    return { label: item.label, covered: matched !== null, matched };
  });
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

/**
 * Trechos que a pessoa não disse e que apareceram. O trecho tem de começar numa palavra ("fase" acusa "fase" e "fases",
 * não "ênfase"); o fim é livre. Cada trecho é acusado uma vez, na primeira ocorrência, com 40 caracteres de cada lado.
 */
export function checkMustNotMention(text: string, phrases: readonly string[]): InventedHit[] {
  const { normalized, origin } = normalizeWithMap(text);
  const hits: InventedHit[] = [];
  for (const phrase of phrases) {
    const needle = normalizeText(phrase);
    if (needle === "") continue;
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(needle, from);
      if (at === -1) break;
      if (!isWordChar(normalized[at - 1])) {
        const start = Math.max(0, (origin[at] ?? 0) - 40);
        const end = Math.min(text.length, (origin[at + needle.length - 1] ?? text.length - 1) + 1 + 40);
        hits.push({ phrase, context: text.slice(start, end).replace(/\s+/g, " ").trim() });
        break;
      }
      from = at + 1;
    }
  }
  return hits;
}

/** Chaves de ticket (`TREEPM-195`), na ordem em que aparecem, sem repetir. */
export function findTicketKeys(text: string): string[] {
  const found = text.match(/(?<![A-Za-z0-9-])[A-Z][A-Z0-9]{1,9}-\d+(?![A-Za-z0-9-])/g) ?? [];
  return [...new Set(found)];
}

/**
 * Alegação de que algo passou a existir na plataforma. "Separei/dividi/quebrei o pedido (o rascunho) em partes" fala do
 * rascunho e não conta; conta quando o objeto é ticket ou tarefa, na mesma frase (sem pontuação no meio).
 */
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\b(?:criei|criamos|criou|abri|abrimos)\b/,
  /\bj[aá] (?:criei|dividi|separei|quebrei)\b/,
  /\b(?:dividi|dividimos|dividiu|separei|separamos|quebrei|quebramos)\b[^.:;!?,\n]{0,40}\b(?:tickets?|tarefas?)\b/,
  /\bforam (?:criad|abert)[oa]s\b/,
  /\bfo[i] (?:criad|abert)[oa]\b/,
  /\b(?:ticket|tickets|tarefa|tarefas) (?:foi|foram) (?:criad|dividid|separad|abert)[oa]s?\b/,
];

/** Frases em que a IA diz que criou ou dividiu algo (ela só propõe). Devolve os trechos encontrados. */
export function findClaims(message: string): string[] {
  const normalized = normalizeText(message);
  const found: string[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) found.push(match[0]);
  }
  return [...new Set(found)];
}

/** Título e descrição do pai e dos filhos, em ordem, separados por quebra de linha. */
export function draftTexts(draft: ConversationDraft): string {
  const parts = [draft.title, draft.description];
  for (const child of draft.children ?? []) parts.push(child.title, child.description);
  return parts.join("\n");
}

export type DraftCheck = {
  hasDraft: boolean;
  ready: boolean;
  childCount: number;
  parentTitle: string | null;
  childTitles: string[];
  mentions: MentionResult[];
  /** Rótulos dos detalhes perdidos. */
  missed: string[];
  /** Trechos que a pessoa não disse e que apareceram no rascunho. */
  invented: InventedHit[];
  /** Chaves de ticket no texto da IA (mensagem e rascunho). */
  ticketKeys: string[];
  /** Frases de "criei"/"dividi" na mensagem da IA. */
  claims: string[];
  parentDescriptionLength: number;
  childrenDescriptionLength: number;
  childrenOk: boolean;
  /** O `idea` que o rascunho trouxe (falso sem rascunho). */
  idea: boolean;
  /** `idea` bate com `expectIdea` (sempre verdadeiro quando o caso não o define). */
  ideaOk: boolean;
  passes: boolean;
};

/** Confere um turno contra um caso. Sem rascunho, nada passa: não há o que medir. */
export function checkDraft(testCase: ConversationCase, turn: TurnLike): DraftCheck {
  const draft = turn.draft;
  const children = draft?.children ?? [];
  const fullText = draft ? draftTexts(draft) : "";
  const mentions = checkMustMention(fullText, testCase.mustMention);
  const missed = mentions.filter((m) => !m.covered).map((m) => m.label);
  const invented = checkMustNotMention(fullText, testCase.mustNotMention);
  const ticketKeys = findTicketKeys(`${turn.message}\n${fullText}`);
  const claims = findClaims(turn.message);
  const childCount = children.length;
  const childrenOk =
    draft !== null &&
    (testCase.expectChildren === "either" || (testCase.expectChildren ? childCount > 0 : childCount === 0)) &&
    (testCase.minChildren === undefined || childCount >= testCase.minChildren) &&
    (testCase.maxChildren === undefined || childCount <= testCase.maxChildren);
  const idea = draft?.idea === true;
  const ideaOk = testCase.expectIdea === undefined || idea === testCase.expectIdea;
  return {
    hasDraft: draft !== null,
    ready: turn.ready,
    childCount,
    parentTitle: draft?.title ?? null,
    childTitles: children.map((c) => c.title),
    mentions: draft ? mentions : testCase.mustMention.map((m) => ({ label: m.label, covered: false, matched: null })),
    missed: draft ? missed : testCase.mustMention.map((m) => m.label),
    invented,
    ticketKeys,
    claims,
    parentDescriptionLength: draft?.description.length ?? 0,
    childrenDescriptionLength: children.reduce((sum, c) => sum + c.description.length, 0),
    childrenOk,
    idea,
    ideaOk,
    passes: draft !== null && childrenOk && ideaOk && missed.length === 0 && invented.length === 0 && ticketKeys.length === 0 && claims.length === 0,
  };
}

export type ElaborationCheck = {
  /** As chaves ligadas e os títulos sugeridos DEPOIS do descarte que o servidor faz (o que a pessoa veria). */
  linkKeys: string[];
  links: ElaborationLink[];
  suggestedTitles: string[];
  suggested: ElaborationSuggestion[];
  suggestedCount: number;
  linksMissing: string[];
  suggestedOk: boolean;
  /** Trechos proibidos (`noSuggestedMention`) que apareceram nas sugeridas que sobraram. */
  equivalentSuggested: InventedHit[];
  passes: boolean;
};

const sanitize = (testCase: ConversationCase, draft: ConversationDraft, raw: { links: readonly ElaborationLink[]; suggested: readonly ElaborationSuggestion[] }) =>
  sanitizeElaboration(raw, {
    draftTitle: draft.title,
    partTitles: (draft.children ?? []).map((child) => child.title),
    related: testCase.related ?? [],
    duplicateKey: null,
    projectKey: "DEMO",
  });

function evaluate(testCase: ConversationCase, clean: { links: ElaborationLink[]; suggested: ElaborationSuggestion[] }): ElaborationCheck {
  const linkKeys = clean.links.map((link) => link.dependeDe);
  const linksMissing = (testCase.expectLinkKeys ?? []).filter((key) => !linkKeys.includes(key));
  const count = clean.suggested.length;
  const suggestedOk = (testCase.minSuggested === undefined || count >= testCase.minSuggested) && (testCase.maxSuggested === undefined || count <= testCase.maxSuggested);
  const equivalentSuggested = checkMustNotMention(clean.suggested.map((task) => task.title).join("\n"), testCase.noSuggestedMention ?? []);
  return {
    linkKeys,
    links: clean.links,
    suggestedTitles: clean.suggested.map((task) => task.title),
    suggested: clean.suggested,
    suggestedCount: count,
    linksMissing,
    suggestedOk,
    equivalentSuggested,
    passes: linksMissing.length === 0 && suggestedOk && equivalentSuggested.length === 0,
  };
}

/**
 * Confere a elaboração contra um caso. As tarefas sugeridas são contadas À PARTE de "inventadas": sugestão marcada não é
 * invenção (o texto dela nunca passa por `checkMustNotMention`); afirmação posta na boca da pessoa continua sendo, e quem
 * a mede é `checkDraft`. A saída do modelo passa pelo mesmo descarte da rota.
 */
export function checkElaboration(
  testCase: ConversationCase,
  draft: ConversationDraft,
  raw: { links: readonly ElaborationLink[]; suggested: readonly ElaborationSuggestion[] },
): ElaborationCheck {
  return evaluate(testCase, sanitize(testCase, draft, raw));
}

/** O Jev falso da medição: responde `sameRequest` por título do ticket, quando a sugerida cita um dos trechos do caso. Nunca chama provedor. */
export function titleKeyedJudge(testCase: ConversationCase): RelatedJudge {
  return {
    judge(input: RelatedInput): Promise<Record<string, RelatedJudgment>> {
      const text = normalizeText(`${input.draft.title}\n${input.draft.description}`);
      return Promise.resolve(
        Object.fromEntries(
          input.candidates.map((candidate) => {
            const rule = (testCase.sameRequestByTitle ?? []).find((entry) => entry.ticketTitle === candidate.title);
            const hit = rule?.whenSuggestedMentions.some((phrase) => text.includes(normalizeText(phrase))) ?? false;
            return [candidate.id, { sameSubject: hit ? 0.9 : 0.1, sameRequest: hit ? 0.9 : 0.1 }];
          }),
        ),
      );
    },
  };
}

/** Como `checkElaboration`, mas depois do descarte roda a procura das sugeridas na árvore do caso (`tree`), como a rota faz. */
export async function checkElaborationWithLookup(
  testCase: ConversationCase,
  draft: ConversationDraft,
  raw: { links: readonly ElaborationLink[]; suggested: readonly ElaborationSuggestion[] },
): Promise<ElaborationCheck> {
  const clean = sanitize(testCase, draft, raw);
  const tree = testCase.tree ?? [];
  if (tree.length === 0) return evaluate(testCase, clean);
  const numbered = tree.map((entry) => ({ id: entry.key, number: Number(entry.key.split("-").pop()), title: entry.title, description: entry.excerpt }));
  const found = await linkExistingSuggestions({ ...clean, tree: numbered, projectKey: "DEMO", duplicateKey: null, judge: titleKeyedJudge(testCase) });
  return evaluate(testCase, found);
}
