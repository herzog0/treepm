import type { Gabarito, GabaritoTicket } from "../scripts/placement-rebuild/core.js";

export const LONG = "palavra ".repeat(120); // 960 caracteres: o trecho da descrição corta em 600 e termina em "…"

export const node = (id: string, number: number, parentId: string | null, title: string, description = ""): GabaritoTicket => ({
  id: `ID-SENTINELA-${id}`,
  number,
  kind: "ticket",
  key: `SENTK-${number}`,
  title,
  description,
  status: "in_progress",
  parentId: parentId === null ? null : `ID-SENTINELA-${parentId}`,
  assigneeIds: [`PESSOA-SENTINELA-${id}`],
  depth: parentId === null ? 0 : 1,
});

/**
 * R1 Pagamentos (p1, p2 sem descrição, p3 com descrição longa), R2 Acesso (só a1), R3 Relatórios (r1, r2), R4 Solto (sem filhos).
 * Testados: p1 p2 p3 a1 r1 r2 (6). Pares: p1/p2/p3 = 6 cada, a1 = 4, r1/r2 = 5 cada → 32.
 */
export const tickets: GabaritoTicket[] = [
  node("R1", 1, null, "Pagamentos", "Cobrar e estornar"),
  node("R2", 2, null, "Acesso", "Entrar no sistema"),
  node("R3", 3, null, "Relatórios", ""),
  node("R4", 4, null, "Solto", "Sem filhos"),
  node("p1", 5, "R1", "Cobrar no cartão", "Cobrança por cartão de crédito"),
  node("p2", 6, "R1", "Estornar cobrança", ""),
  node("p3", 7, "R1", "Emitir recibo", LONG),
  node("a1", 8, "R2", "Entrar com senha", "Senha e e-mail"),
  node("r1", 9, "R3", "Relatório mensal", "Mês a mês"),
  node("r2", 10, "R3", "Relatório anual", "Ano a ano"),
];

export const gabarito = (list: GabaritoTicket[] = tickets): Gabarito => ({
  exportedAt: "2026-11-21T00:00:00Z",
  project: { id: "proj-sentinela", key: "SENT", name: "Projeto Sentinela" },
  tickets: list,
});
