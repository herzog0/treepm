import { describe, expect, it } from "vitest";
import { queuePlaces } from "./queue-place.js";
import type { DependencyEdge } from "./queue-place.js";
import type { TicketNode, TicketStatus } from "./tickets.js";

// ADR 0068, seção 4: o lugar na fila de cada ticket aberto, sem filhos e que não é ideia.
const t = (id: string, status: TicketStatus = "todo", parentId: string | null = null, ideaStage: TicketNode["ideaStage"] = null): TicketNode => ({ id, parentId, status, ideaStage });
const start = (from: string, to: string): DependencyEdge => ({ from, to, need: "start" });
const deliver = (from: string, to: string): DependencyEdge => ({ from, to, need: "deliver" });
const places = (tickets: TicketNode[], edges: DependencyEdge[]) => Object.fromEntries(queuePlaces(tickets, edges));

describe("queuePlaces: livre, próximo, esperando", () => {
  it("sem dependência: livre", () => {
    expect(places([t("a")], [])).toEqual({ a: "free" });
  });

  it("dependência para começar concluída ou cancelada: livre", () => {
    expect(places([t("a"), t("b", "done"), t("c", "cancelled")], [start("a", "b"), start("a", "c")])).toEqual({ a: "free" });
  });

  it("dependência para começar aberta num ticket livre: próximo", () => {
    expect(places([t("a"), t("b", "in_progress")], [start("a", "b")])).toEqual({ a: "next", b: "free" });
  });

  it("dependência aberta num ticket que espera outro: esperando", () => {
    expect(places([t("a"), t("b"), t("c")], [start("a", "b"), start("b", "c")])).toEqual({ a: "waiting", b: "next", c: "free" });
  });

  it("próximo só quando TODAS as abertas são livres", () => {
    expect(places([t("a"), t("b"), t("c"), t("d")], [start("a", "b"), start("a", "c"), start("c", "d")])).toMatchObject({ a: "waiting" });
  });

  it("dependência para entregar não conta para o lugar", () => {
    expect(places([t("a"), t("b"), t("c")], [deliver("a", "b"), start("b", "c"), deliver("c", "a")])).toEqual({ a: "free", b: "next", c: "free" });
  });

  // Decisão da coordenação (revisão 1): "livre" só existe para ticket com lugar na fila; alvo sem lugar não é livre.
  it("dependência aberta num pai (sem lugar na fila): esperando, mesmo com o pai sem dependências", () => {
    expect(places([t("a"), t("p"), t("k", "todo", "p")], [start("a", "p")])).toEqual({ a: "waiting", k: "free" });
  });

  it("dependência aberta numa ideia (a raiz ou dentro dela): esperando", () => {
    const tickets = [t("a"), t("b"), t("i", "todo", null, "new"), t("j", "todo", "i")];
    expect(places(tickets, [start("a", "i"), start("b", "j")])).toEqual({ a: "waiting", b: "waiting" });
  });

  it("pai cujo único filho é uma ideia continua com lugar e conta como livre", () => {
    expect(places([t("a"), t("p"), t("i", "todo", "p", "new")], [start("a", "p")])).toEqual({ a: "next", p: "free" });
  });
});

describe("queuePlaces: quem não tem lugar", () => {
  it("concluído e cancelado não têm lugar", () => {
    expect(places([t("a", "done"), t("b", "cancelled")], [])).toEqual({});
  });

  it("em andamento e em revisão têm lugar", () => {
    expect(places([t("a", "in_progress"), t("b", "in_review")], [])).toEqual({ a: "free", b: "free" });
  });

  it("ticket com filho não tem lugar, mesmo com os filhos concluídos", () => {
    expect(places([t("p"), t("k", "done", "p")], [])).toEqual({});
  });

  it("ticket cujo único filho é uma ideia continua com lugar; a ideia e o que está dentro dela não têm", () => {
    expect(places([t("p"), t("i", "todo", "p", "new"), t("j", "todo", "i")], [])).toEqual({ p: "free" });
  });
});
