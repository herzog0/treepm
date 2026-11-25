/**
 * Importação do Linear (ADR 0060, seções 3 e 4): o mapeamento puro do que vem do Linear para o que o TreePM guarda. Nada aqui lê
 * banco nem rede, e nada guarda o e-mail do Linear: ele só entra em `matchLinearAssignee` para casar uma pessoa e é descartado.
 */
import { mentionedKeys, mentionsPersonRaw, scanTicketRefs, withoutPersonLinksDeep } from "./mentions.js";
import type { TicketStatus } from "./tickets.js";

/** Limites dos esquemas de ticket (título 200, descrição 20.000 caracteres). */
export const LINEAR_TITLE_MAX = 200;
export const LINEAR_DESCRIPTION_MAX = 20_000;

/**
 * Situação pelo TIPO da situação do Linear (o nome é livre e muda de time para time). Tipo desconhecido (ou com outra caixa) vale
 * `todo`: melhor um item aberto a mais do que um concluído sem ser.
 */
export function mapLinearStatus(stateType: string): TicketStatus {
  switch (stateType) {
    case "started":
      return "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return "cancelled";
    default:
      // triage, backlog, unstarted e qualquer tipo novo.
      return "todo";
  }
}

/**
 * Texto do Linear que vai ao banco (ticket, retratos, nomes): sem byte nulo nem caracteres de controle (fica a quebra de linha, o
 * retorno e a tabulação) e sem meio par substituto, que o PostgreSQL recusa em texto e em JSONB.
 */
// eslint-disable-next-line no-control-regex -- é justamente o que se quer tirar
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function cleanLinearText(text: string): string {
  return text.replace(CONTROLS, "").replace(LONE_SURROGATE, "");
}
const sanitize = cleanLinearText;
const dropLoneHighSurrogate = (text: string): string => {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
};
const cutTo = (text: string, max: number): string => (text.length > max ? dropLoneHighSurrogate(text.slice(0, max)) : text);

/**
 * Troca por texto simples tudo o que o esquema de tickets recusaria como menção de pessoa: primeiro o elo `[@Nome](person:id)`
 * (vira `@Nome`), depois qualquer destino `person:` que tenha sobrado (referência, `href`, autolink), que ganha uma barra invertida
 * (`person\:`, que o markdown mostra como `person:`). Ninguém é marcado e `mentionsPersonRaw` dá falso no resultado.
 */
export function neutralizePersonMentions(text: string): string {
  let result = withoutPersonLinksDeep(text);
  for (let round = 0; round < 5 && mentionsPersonRaw(result); round += 1) {
    result = result
      .replace(/(\]\(\s*)person:/gi, "$1person\\:")
      .replace(/(\]:\s*<?\s*)person:/gi, "$1person\\:")
      .replace(/(href\s*=\s*["']?\s*)person:/gi, "$1person\\:")
      .replace(/(<\s*)person:/gi, "$1person\\:");
  }
  // As rodadas não bastaram (texto montado para driblá-las): tira o trecho `person:` até não sobrar menção. Cada volta encurta o texto.
  while (mentionsPersonRaw(result)) result = result.replace(/person:/gi, "");
  return result;
}

/** Título: sem espaços nas pontas, em até 200 caracteres, sem menção de pessoa; vazio → o identificador (`ENG-123`). */
export function mapLinearTitle(title: string, identifier: string): string {
  const cleaned = cutTo(neutralizePersonMentions(sanitize(title)).trim(), LINEAR_TITLE_MAX).trim();
  return cleaned === "" ? cutTo(sanitize(identifier).trim(), LINEAR_TITLE_MAX) : cleaned;
}

/**
 * Descrição em Markdown, na ordem que mantém tudo limitado: limpar → CORTAR em 20.000 → neutralizar menção de pessoa → neutralizar a
 * chave do projeto → conferir. Nada aqui roda sobre texto maior que 20.000 caracteres. `projectKey` é a chave do projeto do TreePM
 * de destino (a única que o detector de menções lê).
 */
export function mapLinearDescription(description: string | null, projectKey = ""): string {
  if (description === null || description === "") return "";
  const text = neutralizeOwnTicketKey(neutralizePersonMentions(cutTo(sanitize(description), LINEAR_DESCRIPTION_MAX)), projectKey);
  if (text.length <= LINEAR_DESCRIPTION_MAX) return text;
  // Escapes (`person\:`, `%2D`) alongaram o texto: corta de novo e confere de novo (o corte só tira o fim; a chave volta a ser conferida).
  return ensureNoOwnKey(cutTo(text, LINEAR_DESCRIPTION_MAX), projectKey);
}

/** Hífen inseparável (U+2011): mesma aparência e mesmo comprimento, é caractere comum (o editor o preserva) e o detector não o lê como hífen. */
const NON_BREAKING_HYPHEN = "\u2011";

/**
 * Texto do Linear nunca vira menção a ticket do TreePM (ADR 0060): "ver ENG-45" numa descrição importada citaria o ticket 45 do
 * projeto de chave `ENG`, que é outra coisa. O detector só lê a chave do PRÓPRIO projeto (`mentionedNumbers`), então só ela é
 * tocada: fora de código e de endereço de link, o hífen vira U+2011 (`ENG‑45`); dentro de endereço solto, `%2D`. Código e destino
 * de link Markdown (inclusive imagem) o detector já ignora: ficam como estão. Termina conferindo (`ensureNoOwnKey`).
 */
export function neutralizeOwnTicketKey(text: string, projectKey: string): string {
  if (projectKey === "" || !text.includes(`${projectKey}-`)) return text;
  const prefix = `${projectKey}-`;
  const pieces: string[] = [];
  let last = 0;
  for (const ref of scanTicketRefs(text)) {
    if (!ref.key.startsWith(prefix)) continue;
    const start = ref.end - ref.key.length;
    const before = start > 0 ? (text[start - 1] as string) : "";
    const inAddress = !ref.hashed && before !== "" && "/=?&#".includes(before);
    const dash = start + projectKey.length;
    pieces.push(text.slice(last, dash), inAddress ? "%2D" : NON_BREAKING_HYPHEN);
    last = dash + 1;
  }
  if (last === 0) return ensureNoOwnKey(text, projectKey);
  pieces.push(text.slice(last));
  return ensureNoOwnKey(pieces.join(""), projectKey);
}

/**
 * Garantia final: o detector não pode ver a chave do projeto no texto. Se ainda vê (cerca de código sem fecho por causa do corte,
 * link cortado, caso imprevisto), troca por U+2011 TODAS as ocorrências restantes `CHAVE-dígito` e confere de novo; em último caso,
 * toda `CHAVE-`. Só roda a leitura pesada quando o texto tem a chave.
 */
function ensureNoOwnKey(text: string, projectKey: string): string {
  const prefix = `${projectKey}-`;
  if (projectKey === "" || !text.includes(prefix)) return text;
  const seen = (value: string): boolean => mentionedKeys(value).some((key) => key.startsWith(prefix));
  if (!seen(text)) return text;
  const escaped = projectKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let result = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}-(?=\\d)`, "gu"), `${projectKey}${NON_BREAKING_HYPHEN}`);
  if (seen(result)) result = result.split(prefix).join(`${projectKey}${NON_BREAKING_HYPHEN}`);
  return result;
}

/** O endereço de origem só vale se for do Linear (`https://linear.app/`) e curto; senão o atalho some (nulo). */
export const LINEAR_URL_MAX = 500;
export function safeLinearUrl(url: string | null | undefined): string | null {
  return typeof url === "string" && url.length <= LINEAR_URL_MAX && url.startsWith("https://linear.app/") ? url : null;
}

/** Situação do projeto do Linear (`status.type`) para a do ticket que o representa: concluído, cancelado, em andamento; o resto fica a fazer. */
export function mapLinearProjectStatus(type: string | null | undefined): TicketStatus {
  switch (type) {
    case "completed":
      return "done";
    case "canceled":
      return "cancelled";
    case "started":
      return "in_progress";
    default:
      return "todo";
  }
}

/**
 * Prioridade do Linear (0 sem, 1 urgente, 2 alta, 3 média, 4 baixa) para a do TreePM (ADR 0047: -999 a 999, maior primeiro, 0 = sem
 * prioridade própria, que herda). Mantém a ordem do Linear (urgente > alta > média > baixa > sem) e deixa espaço entre os degraus
 * para quem quiser encaixar uma prioridade no meio à mão: urgente 400, alta 300, média 200, baixa 100. Valor fora de 0 a 4: 0.
 */
export function mapLinearPriority(priority: number): number {
  switch (priority) {
    case 1:
      return 400;
    case 2:
      return 300;
    case 3:
      return 200;
    case 4:
      return 100;
    default:
      return 0;
  }
}

/** O que o casamento de responsável precisa saber de uma pessoa do TreePM. */
export interface AssigneeCandidate {
  readonly id: string;
  readonly email: string;
  readonly active: boolean;
  readonly isTest: boolean;
}

/**
 * O responsável: a pessoa ATIVA, NÃO de teste, com e-mail não vazio igual (sem diferenciar maiúsculas) ao do Linear, só quando a
 * correspondência é ÚNICA; senão `null`. O e-mail do Linear não é guardado em lugar nenhum.
 */
export function matchLinearAssignee(email: string | null, people: readonly AssigneeCandidate[]): string | null {
  const wanted = email?.trim().toLowerCase() ?? "";
  if (wanted === "") return null;
  const eligible = people.filter((person) => person.active && !person.isTest && person.email.trim().toLowerCase() === wanted);
  return eligible.length === 1 ? (eligible[0] as AssigneeCandidate).id : null;
}

/** Limites do que se guarda do Linear na origem (ADR 0061): nome do criador, id do usuário e identificador antigo. */
export const LINEAR_CREATOR_NAME_MAX = 120;
export const LINEAR_EXTERNAL_ID_MAX = 200;
export const LINEAR_PREVIOUS_KEY_MAX = 100;
export const LINEAR_PREVIOUS_KEYS_MAX = 50;

/**
 * As colunas do criador na origem (ADR 0061, seção 5). O e-mail só serve para casar `matchedPersonId` e nunca chega aqui. Com pessoa
 * casada guarda a pessoa (o nome vem dela); sem ela, o nome de exibição cortado. `emailReadable` falso: o e-mail não veio nesta rodada,
 * então uma pessoa que já estava casada não é rebaixada a nome (como o responsável).
 */
export function linearCreatorColumns(input: {
  creator: { readonly id: string; readonly name: string } | null;
  emailReadable: boolean;
  matchedPersonId: string | null;
  existingPersonId: string | null;
}): { externalCreatorId: string | null; externalCreatorName: string | null; creatorPersonId: string | null } {
  if (input.creator === null) return { externalCreatorId: null, externalCreatorName: null, creatorPersonId: null };
  const person = input.emailReadable ? input.matchedPersonId : input.existingPersonId;
  const name = cutTo(sanitize(input.creator.name).trim(), LINEAR_CREATOR_NAME_MAX);
  return { externalCreatorId: cutTo(sanitize(input.creator.id), LINEAR_EXTERNAL_ID_MAX), externalCreatorName: person === null && name !== "" ? name : null, creatorPersonId: person };
}

/** Os identificadores antigos da issue, limpos, sem repetir, sem o de hoje e em número limitado. */
export function linearPreviousKeys(previous: readonly string[], current: string): string[] {
  const keys = previous.map((key) => cutTo(sanitize(key).trim(), LINEAR_PREVIOUS_KEY_MAX)).filter((key) => key !== "" && key !== current);
  return [...new Set(keys)].slice(0, LINEAR_PREVIOUS_KEYS_MAX);
}

/**
 * Onde o ticket de uma issue nasce, antes de o pai chegar (a fase `hierarchy` o leva para baixo do pai, se ele vier): o ticket do
 * projeto do Linear, se esse projeto virou ticket; senão o destino da rodada (`null` = raiz do projeto). O pai vence o projeto, mas
 * só a fase `hierarchy` sabe se o pai existe.
 */
export function linearInitialParent(
  issue: { readonly parentId: string | null; readonly projectId: string | null },
  projectTickets: ReadonlyMap<string, string>,
  destinationTicketId: string | null,
): string | null {
  if (issue.projectId !== null) {
    const projectTicket = projectTickets.get(issue.projectId);
    if (projectTicket !== undefined) return projectTicket;
  }
  return destinationTicketId;
}

export interface LinearParentMove {
  readonly id: string;
  readonly parentId: string;
  /** O pai pedido ficaria fundo demais: o ticket foi para o ancestral mais fundo permitido. */
  readonly flattened: boolean;
}

/**
 * Leva cada ticket para baixo do pai que o Linear indicou, em ordem, sem ciclo e dentro do limite de profundidade. `forest` é o
 * pai atual de cada ticket que a rodada pode mexer (nulo = raiz); pedido cujo ticket ou pai não está nela é ignorado (pai que não
 * foi importado: o ticket fica onde está). Quem já está sob o pai pedido é ignorado. Ciclo, ou subárvore que não cabe em nenhum
 * ancestral, vai para `skipped` e o ticket fica onde está. Não altera `forest`.
 */
export function planLinearParents(
  forest: ReadonlyMap<string, string | null>,
  requests: readonly { readonly id: string; readonly parentId: string }[],
  maxDepth: number,
): { moves: LinearParentMove[]; skipped: string[] } {
  const parents = new Map(forest);
  const children = new Map<string, Set<string>>();
  for (const [id, parent] of parents) {
    if (parent !== null) (children.get(parent) ?? children.set(parent, new Set()).get(parent)!).add(id);
  }
  /** A altura da subárvore (folha = 1). */
  const height = (id: string): number => {
    let best = 1;
    const stack: [string, number][] = [[id, 1]];
    while (stack.length > 0) {
      const [current, depth] = stack.pop() as [string, number];
      if (depth > best) best = depth;
      for (const child of children.get(current) ?? []) stack.push([child, depth + 1]);
    }
    return best;
  };
  const moves: LinearParentMove[] = [];
  const skipped: string[] = [];
  for (const { id, parentId } of requests) {
    if (!parents.has(id) || !parents.has(parentId) || parents.get(id) === parentId) continue;
    // De baixo para cima: o pai pedido e os seus ancestrais; se o próprio ticket aparece, seria ciclo.
    const chain: string[] = [];
    let cycle = id === parentId;
    for (let cursor: string | null | undefined = parentId; !cycle && cursor !== null && cursor !== undefined && chain.length <= parents.size; cursor = parents.get(cursor)) {
      if (cursor === id) cycle = true;
      else chain.push(cursor);
    }
    if (cycle) {
      skipped.push(id);
      continue;
    }
    const need = height(id);
    const fit = chain.findIndex((_ancestor, index) => chain.length - index + need <= maxDepth);
    if (fit < 0) {
      skipped.push(id);
      continue;
    }
    const target = chain[fit] as string;
    const old = parents.get(id) ?? null;
    if (old !== null) children.get(old)?.delete(id);
    parents.set(id, target);
    (children.get(target) ?? children.set(target, new Set()).get(target)!).add(id);
    if (old !== target) moves.push({ id, parentId: target, flattened: fit > 0 });
  }
  return { moves, skipped };
}
