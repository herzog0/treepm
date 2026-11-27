/** O que a escolha do foco lê de cada nó do mapa. */
export interface FocusNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: "organization" | "project" | "ticket" | "draft";
  /** O projeto do nó (o próprio, num projeto); nulo na organização. */
  readonly projectId: string | null;
}

/** O que a árvore explodida mostra: um projeto inteiro (`ticketId: null`) ou um ticket com filhos dele. */
export interface ExplodedFocus {
  readonly projectId: string;
  readonly ticketId: string | null;
}

/**
 * O foco da árvore explodida a partir do foco do mapa (ADR 0070, seção 2): um projeto, ou um ticket com filhos. Um ticket sem filhos
 * vale pelo pai dele (ou pelo projeto, na raiz). A organização não é um projeto: vale o projeto do ticket aberto, senão o primeiro
 * projeto da lista; sem projeto, nada.
 */
export function explodedFocus(input: {
  byId: ReadonlyMap<string, FocusNode>;
  hasChildren: (id: string) => boolean;
  mapFocus: string;
  openTicketId: string | null;
  projectIds: readonly string[];
}): ExplodedFocus | null {
  const { byId, hasChildren } = input;
  const node = byId.get(input.mapFocus);
  if (node?.kind === "project") return { projectId: node.id, ticketId: null };
  if (node?.kind === "ticket" && node.projectId !== null) {
    if (hasChildren(node.id)) return { projectId: node.projectId, ticketId: node.id };
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    return { projectId: node.projectId, ticketId: parent?.kind === "ticket" ? parent.id : null };
  }
  const open = input.openTicketId === null ? undefined : byId.get(input.openTicketId);
  const projectId = open?.projectId ?? input.projectIds[0] ?? null;
  return projectId === null ? null : { projectId, ticketId: null };
}
