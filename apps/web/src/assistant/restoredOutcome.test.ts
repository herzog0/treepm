import { describe, expect, it } from "vitest";
import type { PlacementDecision, TicketSummary } from "../api/client.js";
import { makeTicket } from "../test/fakes.js";
import { outcomeFromDecision } from "./restoredOutcome.js";

const list: TicketSummary[] = [
  makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" }),
  makeTicket("t2", "p1", 2, "Login", { key: "ALFA-2", parentId: "t1" }),
  makeTicket("t3", "p1", 3, "Senha", { key: "ALFA-3", parentId: "t1" }),
];
const decision = (extra: Partial<PlacementDecision>): PlacementDecision => ({ chosenPath: [], related: [], duplicateTicketId: null, doubt: null, ...extra });
const project = { name: "Projeto Alfa" };

describe("o resultado da procura remontado da decisão guardada", () => {
  it("sem decisão, ou de antes da dúvida, não há o que remontar", () => {
    expect(outcomeFromDecision(null, list, project)).toBeNull();
    expect(outcomeFromDecision(decision({}), list, project)).toBeNull();
  });

  it("pergunta aberta: o nó da pergunta com o caminho, as opções com os títulos e o destino ainda não confirmado", () => {
    const outcome = outcomeFromDecision(decision({ doubt: { confirmed: false, question: { level: 2, kind: "which", parentId: "t1", options: [{ ticketId: "t2" }, { ticketId: "t3" }] } } as never }), list, project)!;
    expect(outcome.question).toEqual({
      level: 2,
      kind: "which",
      at: { id: "t1", title: "Acesso", path: [{ id: "t1", title: "Acesso" }] },
      options: [
        { id: "t2", title: "Login", path: [{ id: "t1", title: "Acesso" }, { id: "t2", title: "Login" }] },
        { id: "t3", title: "Senha", path: [{ id: "t1", title: "Acesso" }, { id: "t3", title: "Senha" }] },
      ],
    });
    expect(outcome.destinationConfirmed).toBe(false);
  });

  it("pergunta na raiz: o nó é o projeto", () => {
    const outcome = outcomeFromDecision(decision({ doubt: { confirmed: false, question: { level: 1, kind: "root", parentId: null, options: [{ ticketId: "t1" }] } } as never }), list, project)!;
    expect(outcome.question!.at).toEqual({ id: null, title: "Projeto Alfa", path: [] });
  });

  it("pergunta cujas opções sumiram da lista não vale", () => {
    expect(outcomeFromDecision(decision({ doubt: { confirmed: false, question: { level: 1, kind: "which", parentId: null, options: [{ ticketId: "x9" }] } } as never }), list, project)).toBeNull();
  });

  it("destino confirmado: o último do caminho escolhido, confirmado", () => {
    const outcome = outcomeFromDecision(decision({ chosenPath: ["t1", "t2"], doubt: { confirmed: true, question: null } as never }), list, project)!;
    expect(outcome.question).toBeNull();
    expect(outcome.destinationConfirmed).toBe(true);
    expect(outcome.destination).toEqual({ parentId: "t2", path: [{ id: "t1", title: "Acesso" }, { id: "t2", title: "Login" }] });
  });
});
