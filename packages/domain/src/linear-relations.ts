/**
 * Relações entre issues do Linear (ADR 0061, seções 3 e 4; TREEPM-478). No Linear a relação tem origem (`issue`) e alvo
 * (`relatedIssue`); `blocks` quer dizer "a origem bloqueia o alvo".
 *
 * - `blocks` → `depends_on` do alvo para a origem (se A bloqueia B, B depende de A).
 * - `related` e `duplicate` → `related`, simétrica: as pontas saem em ordem, para a mesma dupla dar sempre a mesma relação.
 * - `similar` (obsoleto), tipo desconhecido e a issue ligada a si mesma → `null` (ignorada).
 *
 * `from` e `to` são os ids das issues no Linear; quem grava troca pelos tickets e, em `related`, reordena pelos ids locais.
 */
export type LinearRelationMapped = { kind: "depends_on" | "related"; from: string; to: string };

export function mapLinearRelation(type: string, issueId: string, relatedIssueId: string): LinearRelationMapped | null {
  if (issueId === relatedIssueId) return null;
  if (type === "blocks") return { kind: "depends_on", from: relatedIssueId, to: issueId };
  if (type === "related" || type === "duplicate") {
    const [from, to] = relatedPair(issueId, relatedIssueId);
    return { kind: "related", from, to };
  }
  return null;
}

/** A dupla de uma relação simétrica na ordem canônica (o banco guarda `related` com o menor id primeiro). */
export function relatedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * A identidade da origem de uma relação: o id dela no Linear MAIS o que ela vira aqui (tipo do TreePM e pontas). O Linear deixa mudar
 * o tipo e as pontas de uma relação sem trocar o id; com a forma na chave, a relação trocada vira origem nova (criada aqui) e a antiga
 * deixa de ser vista (ganha `missing_since` e fica como está). `related` ↔ `duplicate` na mesma dupla não muda nada.
 */
export function linearRelationKey(relationId: string, mapped: LinearRelationMapped): string {
  return `${relationId}:${mapped.kind === "depends_on" ? "d" : "r"}:${mapped.from}:${mapped.to}`;
}

/** Os tickets das duas pontas de uma relação, AGORA: o da issue de origem e o da outra (ausente quando a issue não tem ticket vivo). */
export type LinearRelationEnds = { issueTicketId: string | undefined; relatedIssueTicketId: string | undefined };

/**
 * O que a origem de uma relação guarda em `applied`: o tipo do TreePM (`depends_on` ou `related`), o id da relação e das duas issues no
 * Linear e os tickets das duas pontas quando a origem foi gravada. Os tickets servem a "removida aqui não volta" (ADR 0061, seção 3): ela
 * vale enquanto os DOIS tickets são os mesmos; ticket apagado aqui e importado de novo é ticket novo, e a relação volta.
 */
export function linearRelationApplied(relationId: string, issueId: string, relatedIssueId: string, mapped: LinearRelationMapped, ends: { issueTicketId: string; relatedIssueTicketId: string }): {
  type: LinearRelationMapped["kind"];
  relationId: string;
  issueId: string;
  relatedIssueId: string;
  issueTicketId: string;
  relatedIssueTicketId: string;
} {
  return { type: mapped.kind, relationId, issueId, relatedIssueId, issueTicketId: ends.issueTicketId, relatedIssueTicketId: ends.relatedIssueTicketId };
}

/**
 * Os tickets guardados na origem (`applied`) são os de agora? Sem o que comparar (origem antiga, sem os tickets), vale como os mesmos:
 * na dúvida a remoção feita aqui continua valendo.
 */
export function sameRelationEnds(applied: unknown, now: LinearRelationEnds): boolean {
  if (typeof applied !== "object" || applied === null) return true;
  const stored = applied as Record<string, unknown>;
  if (typeof stored["issueTicketId"] !== "string" || typeof stored["relatedIssueTicketId"] !== "string") return true;
  return stored["issueTicketId"] === now.issueTicketId && stored["relatedIssueTicketId"] === now.relatedIssueTicketId;
}

/**
 * A forma nova de uma relação editada no Linear herda "removida aqui" de uma forma antiga? Só quando liga os MESMOS dois tickets
 * (inversão de sentido ou troca de tipo): a pessoa já disse que não quer esses dois ligados. Outro par é relação nova e entra. A forma
 * removida também precisa ter os tickets de quando foi gravada (`sameRelationEnds`): ticket apagado e importado de novo é ticket novo.
 */
export function removalCarriesOver(removedApplied: unknown, removedNow: LinearRelationEnds, fresh: LinearRelationEnds): boolean {
  if (!sameRelationEnds(removedApplied, removedNow)) return false;
  const pair = (ends: LinearRelationEnds): string | null =>
    ends.issueTicketId === undefined || ends.relatedIssueTicketId === undefined ? null : [ends.issueTicketId, ends.relatedIssueTicketId].sort().join(" ");
  const removedPair = pair(removedNow);
  return removedPair !== null && removedPair === pair(fresh);
}
