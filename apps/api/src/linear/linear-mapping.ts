import type { TicketStatus } from "@treepm/domain";
import { cleanLinearText, linearPreviousKeys, mapLinearDescription, mapLinearPriority, mapLinearStatus, mapLinearTitle } from "@treepm/domain";
import type { LinearIssueNode } from "./ports.js";

/** O que a gravação precisa de uma issue já mapeada: pura função da issue e da chave do projeto de destino (sem banco, sem rede). */
export type MappedIssue = {
  title: string;
  description: string;
  status: TicketStatus;
  priority: number;
  identifier: string;
  /** O que veio do Linear (retrato de origem), sem controles; o e-mail do responsável nunca entra. */
  source: { title: string; description: string | null; stateType: string; assigneeExternalId: string | null; priority: number };
  /** Os identificadores antigos, já limpos; e o criador sem e-mail (ADR 0061). */
  previousKeys: string[];
  creator: { id: string; name: string } | null;
};

export function mapLinearIssue(node: LinearIssueNode, projectKey: string): MappedIssue {
  const identifier = cleanLinearText(node.identifier).slice(0, 100);
  return {
    title: mapLinearTitle(node.title, node.identifier),
    description: mapLinearDescription(node.description, projectKey),
    status: mapLinearStatus(node.stateType),
    priority: mapLinearPriority(node.priority),
    identifier,
    previousKeys: linearPreviousKeys(node.previousIdentifiers, identifier),
    creator: node.creator ? { id: node.creator.id, name: node.creator.name } : null,
    source: {
      title: cleanLinearText(node.title),
      description: node.description === null ? null : cleanLinearText(node.description),
      stateType: cleanLinearText(node.stateType),
      assigneeExternalId: node.assignee ? cleanLinearText(node.assignee.id) : null,
      priority: node.priority,
    },
  };
}

/**
 * O mapeamento da página inteira, ANTES da transação de gravação (função pura sobre a página): a transação só grava o que já veio
 * pronto. As issues na lixeira não são gravadas e por isso nem são mapeadas.
 */
export function mapLinearIssuePage(nodes: readonly LinearIssueNode[], projectKey: string): Map<string, MappedIssue> {
  const mapped = new Map<string, MappedIssue>();
  for (const node of nodes) if (!node.trashed && !mapped.has(node.id)) mapped.set(node.id, mapLinearIssue(node, projectKey));
  return mapped;
}
