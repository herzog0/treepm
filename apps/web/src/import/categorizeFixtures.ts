import { makeLinearConnection } from "../test/fakes.js";
import type { FakeLinear, FakeLinearCategorize } from "../test/fakes.js";
import { LINKED } from "./importMount.js";

// Cenas de "Arrumar na árvore" para os testes de navegador (medidas e capturas).
const LONG = "Um título muito longo sem fim que precisa quebrar dentro do cartão sem estourar a largura da tela ".repeat(3).trim();
const WORD = "Supercalifragilisticexpialidocious".repeat(6);

export const arrangeLinear = (categorize: FakeLinearCategorize): FakeLinear => ({
  connection: makeLinearConnection(),
  projects: { p1: LINKED },
  run: { existing: { phase: "done", done: true, finishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), destinationTicketId: null, counts: { projectsCreated: 3, issuesCreated: 40 } } },
  categorize,
});
const path = (...titles: string[]) => titles.map((title, index) => ({ id: `n${index}`, title }));
export const CHECK_ITEMS = [
  { ticketId: "tk-1", key: "TREEPM-101", title: LONG, suggestedPath: path("Planejamento", "Mapa espacial", "Zoom e níveis de detalhe") },
  { ticketId: "tk-2", key: "TREEPM-102", title: WORD, suggestedPath: [] },
  { ticketId: "tk-3", key: "TREEPM-103", title: "Curto", suggestedPath: path(WORD) },
];
