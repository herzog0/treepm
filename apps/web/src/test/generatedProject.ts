import { deriveParentStatuses, queuePlaces, ticketProgress } from "@treepm/domain";
import type { DependencyEdge, TicketNode } from "@treepm/domain";
import type { TicketStatus, TicketSummary } from "../api/client.js";
import { makeProject, makeTicket } from "./fakes.js";
import { seeded } from "./randomTree.js";

export const generatedProject = makeProject("gen", "GEN", "Projeto gerado");

/**
 * Projeto gerado com semente para a árvore explodida (ADR 0070): `count` tickets, um pai a cada ~9, uma corrente de `chain` passos
 * "para começar" entre folhas e dependências a mais (para começar e, às vezes, para entregar) sempre para tickets anteriores, então sem
 * ciclo. Lugar na fila, progresso e situação dos pais saem das funções do domínio.
 */
export function generatedTickets(count: number, chain: number, seed = 7): TicketSummary[] {
  const random = seeded(seed);
  const nodes: TicketNode[] = [];
  const leaves: number[] = [];
  let parent: number | null = null;
  for (let at = 0; at < count; at += 1) {
    if (at % 9 === 0) {
      parent = at;
      nodes.push({ id: `g${at}`, parentId: null, status: "todo" });
      continue;
    }
    const roll = random();
    const status: TicketStatus = roll < 0.25 ? "done" : roll < 0.35 ? "in_progress" : roll < 0.4 ? "in_review" : "todo";
    nodes.push({ id: `g${at}`, parentId: `g${parent}`, status });
    leaves.push(at);
  }
  const edges: DependencyEdge[] = [];
  const chainLeaves = leaves.filter((_, position) => position % Math.max(1, Math.floor(leaves.length / chain)) === 0).slice(0, chain);
  for (let step = 1; step < chainLeaves.length; step += 1) edges.push({ from: `g${chainLeaves[step]}`, to: `g${chainLeaves[step - 1]}`, need: "start" });
  const onChain = new Set(chainLeaves);
  for (const [position, at] of leaves.entries()) {
    if (onChain.has(at) || position === 0) continue;
    const extra = random() < 0.6 ? 1 : random() < 0.5 ? 2 : 0;
    for (let n = 0; n < extra; n += 1) {
      const target = leaves[Math.floor(random() * position)]!;
      const need = random() < 0.2 ? "deliver" : "start";
      if (!edges.some((edge) => edge.from === `g${at}` && edge.to === `g${target}`)) edges.push({ from: `g${at}`, to: `g${target}`, need });
    }
  }
  const parents = [...new Set(nodes.flatMap((node) => (node.parentId === null ? [] : [node.parentId])))];
  const derived = deriveParentStatuses(nodes, parents);
  const settled = nodes.map((node) => ({ ...node, status: derived.get(node.id) ?? node.status }));
  const places = queuePlaces(settled, edges);
  const progress = ticketProgress(settled);
  return settled.map((node, at) =>
    makeTicket(node.id, "gen", at + 1, at % 9 === 0 ? `Etapa ${at / 9 + 1}` : `Tarefa ${at + 1}`, {
      key: `GEN-${at + 1}`,
      parentId: node.parentId,
      status: node.status,
      blocked: at === 40,
      place: places.get(node.id) ?? null,
      progress: progress.get(node.id) ?? null,
      dependencies: edges.filter((edge) => edge.from === node.id).map((edge) => ({ id: edge.to, need: edge.need })),
    }),
  );
}
