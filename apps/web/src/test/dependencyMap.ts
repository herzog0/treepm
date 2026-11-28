import { deriveParentStatuses, queuePlaces, ticketProgress } from "@treepm/domain";
import type { DependencyEdge, TicketNode } from "@treepm/domain";
import type { TicketStatus, TicketSummary } from "../api/client.js";
import { makeProject, makeTicket } from "./fakes.js";

/**
 * Projeto determinístico de ~30 tickets para ver a ADR 0069 no mapa: pais, um habilitador, tickets livres, próximos e esperando, um
 * bloqueado, dependências "para começar" e "para entregar" (uma delas entre pais diferentes). O lugar na fila, o progresso e a situação
 * dos pais saem das funções do domínio, as mesmas regras do servidor.
 */
export const dependencyProject = makeProject("loja", "LOJA", "Loja");

type Row = { title: string; parent?: string; status?: TicketStatus; blocked?: boolean; start?: string[]; deliver?: string[] };
const ROWS: Row[] = [
  { title: "Checkout" },
  { title: "Casca do checkout", parent: "Checkout" },
  { title: "Carrinho", parent: "Checkout", start: ["Casca do checkout"] },
  { title: "Cupom", parent: "Checkout", start: ["Casca do checkout"] },
  { title: "Pagamento", parent: "Checkout", start: ["Carrinho"] },
  { title: "Resumo do pedido", parent: "Checkout", start: ["Pagamento"], deliver: ["Termos de uso"] },
  { title: "Acessibilidade do checkout", parent: "Checkout", deliver: ["Pagamento"] },
  { title: "Catálogo" },
  { title: "Busca", parent: "Catálogo", status: "done" },
  { title: "Filtros", parent: "Catálogo", status: "in_progress" },
  { title: "Página do produto", parent: "Catálogo", status: "in_review" },
  { title: "Fotos", parent: "Catálogo", blocked: true },
  { title: "Avaliações", parent: "Catálogo", start: ["Página do produto"] },
  { title: "Comparar", parent: "Catálogo", status: "done" },
  { title: "Conta" },
  { title: "Cadastro", parent: "Conta", status: "done" },
  { title: "Login", parent: "Conta", status: "done" },
  { title: "Termos de uso", parent: "Conta" },
  { title: "Recuperar senha", parent: "Conta", start: ["Login"] },
  { title: "Perfil", parent: "Conta" },
  { title: "Foto de perfil", parent: "Perfil", start: ["Fotos"] },
  { title: "Endereços", parent: "Perfil", start: ["Pagamento"] },
  { title: "Preferências", parent: "Perfil", status: "done" },
  { title: "Entrega" },
  { title: "Cálculo de frete", parent: "Entrega", start: ["Carrinho"] },
  { title: "Rastreio", parent: "Entrega", start: ["Cálculo de frete"] },
  { title: "Etiquetas", parent: "Entrega" },
  { title: "Transportadoras", parent: "Entrega", status: "in_progress" },
  { title: "Devolução", parent: "Entrega", start: ["Rastreio"], deliver: ["Termos de uso"] },
  { title: "Infra" },
  { title: "Monorepo", parent: "Infra", status: "done" },
  { title: "Deploy", parent: "Infra", status: "in_progress" },
  { title: "Monitoramento", parent: "Infra" },
];

/** O id de um ticket da fixture pelo título. */
export const dependencyTicketId = (title: string): string => `loja-${ROWS.findIndex((row) => row.title === title) + 1}`;

export function dependencyTickets(): TicketSummary[] {
  const id = (title: string) => {
    const at = ROWS.findIndex((row) => row.title === title);
    if (at < 0) throw new Error(`ticket "${title}" não existe na fixture`);
    return `loja-${at + 1}`;
  };
  const nodes: TicketNode[] = ROWS.map((row) => ({ id: id(row.title), parentId: row.parent === undefined ? null : id(row.parent), status: row.status ?? "todo" }));
  const parents = new Set(nodes.flatMap((node) => (node.parentId === null ? [] : [node.parentId])));
  const derived = deriveParentStatuses(nodes, [...parents]);
  const settled = nodes.map((node) => ({ ...node, status: derived.get(node.id) ?? node.status }));
  const edges: DependencyEdge[] = ROWS.flatMap((row) => [
    ...(row.start ?? []).map((to) => ({ from: id(row.title), to: id(to), need: "start" as const })),
    ...(row.deliver ?? []).map((to) => ({ from: id(row.title), to: id(to), need: "deliver" as const })),
  ]);
  const places = queuePlaces(settled, edges);
  const progress = ticketProgress(settled);
  return ROWS.map((row, at) => {
    const node = settled[at]!;
    return makeTicket(node.id, "loja", at + 1, row.title, {
      key: `LOJA-${at + 1}`,
      parentId: node.parentId,
      status: node.status,
      blocked: row.blocked === true,
      place: places.get(node.id) ?? null,
      progress: progress.get(node.id) ?? null,
      dependencies: edges.filter((edge) => edge.from === node.id).map((edge) => ({ id: edge.to, need: edge.need })),
    });
  });
}
