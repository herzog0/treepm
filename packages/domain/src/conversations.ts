/**
 * Conversas em níveis (ADR 0055): a regra de quem lê o quê, em funções puras. É a ÚNICA regra de visibilidade: a API a aplica em
 * toda rota de conversa (`conversation-access.ts`) e os testes de árvores ao acaso a conferem contra um modelo independente.
 *
 * A regra inteira:
 *  - lê uma conversa quem participa dela, e só;
 *  - os participantes de uma thread incluem os da conversa de cima (a invariante), logo o conjunto do que uma pessoa lê é fechado
 *    para baixo (quem lê uma conversa lê todas as de dentro) e os ancestrais que ela lê são os mais próximos, sem buracos;
 *  - o que está acima do ponto em que a pessoa entra não existe para ela: nem id, nem título, nem contagem, nem prévia.
 */

/**
 * Dez níveis de thread, contados a partir da conversa mais alta que QUEM ABRE consegue ler (o tamanho da trilha visível dela, não a
 * profundidade absoluta: quem foi marcado fundo na árvore não pode descobrir quantos níveis há acima).
 */
export const CONVERSATION_MAX_DEPTH = 10;
/** Teto técnico guardado pelo banco (`CHECK`) e pelas consultas recursivas; bater nele responde igual ao limite normal. */
export const CONVERSATION_TECHNICAL_MAX_DEPTH = 40;
/** Participantes de uma conversa, contando quem a abriu. Vale em cada conversa da árvore. */
export const CONVERSATION_MAX_PARTICIPANTS = 25;

export type ConversationKind = "ticket" | "general" | "thread";

/** O que a regra precisa saber de uma conversa. */
export interface ConversationNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly participantIds: ReadonlySet<string>;
}

/** Lê a conversa quem participa dela. Nenhum papel entra aqui, de propósito: administrador e gestor não leem conversa de ninguém. */
/**
 * Onde o assistente fala (ADR 0056): nas conversas principais e nas threads de assunto, que só têm quem as abriu. Em thread com
 * pessoas e na de criação ele não fala. UMA regra: o serviço recusa o turno com ela e a ferramenta que abre um rascunho de ticket só
 * é oferecida ao provedor onde ela vale.
 */
export const assistantSpeaksIn = (conversation: { kind: ConversationKind; purpose: "people" | "topic" | "creation" | null }): boolean =>
  conversation.kind !== "thread" || conversation.purpose === "topic";

export const canReadConversation = (viewerPersonId: string, node: Pick<ConversationNode, "participantIds">): boolean => node.participantIds.has(viewerPersonId);

/** O pai de `node` para esta pessoa: o id do pai só se ela participa dele; senão `null` (ela não sabe que o pai existe). */
export function visibleParentId(viewerPersonId: string, node: ConversationNode, byId: ReadonlyMap<string, ConversationNode>): string | null {
  if (node.parentId === null) return null;
  const parent = byId.get(node.parentId);
  return parent && canReadConversation(viewerPersonId, parent) ? parent.id : null;
}

/** Os ids das conversas que a pessoa lê. */
export function visibleIds(viewerPersonId: string, nodes: Iterable<ConversationNode>): Set<string> {
  const out = new Set<string>();
  for (const node of nodes) if (canReadConversation(viewerPersonId, node)) out.add(node.id);
  return out;
}

/**
 * A trilha de uma conversa que a pessoa lê: os ancestrais que ELA lê, do mais externo ao mais próximo, sem a própria conversa. Para
 * no primeiro ancestral que ela não lê (acima dele a pessoa não sabe de nada). Com a invariante, quem lê um ancestral lê tudo o que
 * está abaixo dele, então a trilha é sempre contínua.
 */
export function visibleTrail(viewerPersonId: string, id: string, byId: ReadonlyMap<string, ConversationNode>): string[] {
  const trail: string[] = [];
  let current = byId.get(id);
  while (current) {
    const parentId = visibleParentId(viewerPersonId, current, byId);
    if (parentId === null) break;
    trail.unshift(parentId);
    current = byId.get(parentId);
  }
  return trail;
}

/** O que a pessoa lê, aninhado: para cada conversa que ela lê, o pai que ela também lê (ou `null`: é uma ponta de baixo da árvore dela). */
export function visibleTree(viewerPersonId: string, nodes: readonly ConversationNode[]): Map<string, string | null> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, string | null>();
  for (const node of nodes) if (canReadConversation(viewerPersonId, node)) out.set(node.id, visibleParentId(viewerPersonId, node, byId));
  return out;
}

/** Os ids de todas as conversas abaixo de `id` (filhas, netas…), sem `id`. */
export function descendantIds(id: string, nodes: readonly ConversationNode[]): string[] {
  const children = new Map<string, string[]>();
  for (const n of nodes) if (n.parentId !== null) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id]);
  const out: string[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    out.push(next);
    stack.push(...(children.get(next) ?? []));
  }
  return out;
}

/** A invariante da ADR: em toda thread, os participantes incluem os da conversa de cima. Devolve as threads que a quebram. */
export function invariantViolations(nodes: readonly ConversationNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const broken: string[] = [];
  for (const node of nodes) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent && [...parent.participantIds].some((p) => !node.participantIds.has(p))) broken.push(node.id);
  }
  return broken;
}

/** Quem participa de uma thread nova: a dona, todos os participantes da conversa de cima e os marcados (sem repetir). */
export function newThreadParticipants(ownerPersonId: string, parentParticipantIds: Iterable<string>, mentionedPersonIds: Iterable<string>): string[] {
  return [...new Set([ownerPersonId, ...parentParticipantIds, ...mentionedPersonIds])];
}

/**
 * Dá para abrir uma thread dentro de uma conversa? `visibleLevel` é o tamanho da trilha visível de quem abre (0 = a conversa mais alta que
 * ela lê); `absoluteDepth` é o nível real, só para o teto técnico. Dez níveis; abrir o décimo primeiro é recusado.
 */
export const canOpenThreadBelow = (visibleLevel: number, absoluteDepth: number = visibleLevel): boolean =>
  visibleLevel < CONVERSATION_MAX_DEPTH && absoluteDepth < CONVERSATION_TECHNICAL_MAX_DEPTH;

/** Quantas pessoas ficam na conversa depois de somar as novas (as que já participam não contam). */
export function participantCountAfter(current: ReadonlySet<string>, added: Iterable<string>): number {
  const all = new Set(current);
  for (const person of added) all.add(person);
  return all.size;
}
