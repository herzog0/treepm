import { describe, expect, it } from "vitest";
import { emptyQueueReason, workQueue } from "./work-queue.js";
import type { WorkTicket } from "./work-queue.js";
import type { TicketStatus } from "./tickets.js";
import { queuePlaces } from "./queue-place.js";
import type { DependencyEdge } from "./queue-place.js";
import { effectivePriorities } from "./priority.js";

const ME = "me";
const OTHER = "other";

/** Ticket de teste: só o que muda precisa ser dito; o resto é "a fazer, sem dono, sem prioridade, sem impedimento". */
function t(number: number, parentId: string | null, extra: Partial<WorkTicket> = {}): WorkTicket {
  return {
    id: `t${number}`,
    projectId: "p1",
    parentId,
    number,
    status: "todo",
    priority: 0,
    assigneeIds: [],
    blocked: false,
    place: null,
    idea: null,
    agentWork: null,
    ...extra,
  };
}
/** Preenche `place` (ADR 0068, seção 4) como o servidor faz, a partir da árvore e das dependências `edges`. */
function withPlaces(tickets: WorkTicket[], edges: readonly DependencyEdge[] = []): WorkTicket[] {
  const stage = (ticket: WorkTicket) => {
    const idea = ticket.idea as { root?: boolean; stage?: "new" } | null;
    return idea?.root ? (idea.stage ?? "new") : null;
  };
  const places = queuePlaces(tickets.map((ticket) => ({ id: ticket.id, parentId: ticket.parentId, status: ticket.status, ideaStage: stage(ticket) })), edges);
  return tickets.map((ticket) => ({ ...ticket, place: places.get(ticket.id) ?? null }));
}
const start = (from: number, to: number): DependencyEdge => ({ from: `t${from}`, to: `t${to}`, need: "start" });
const deliver = (from: number, to: number): DependencyEdge => ({ from: `t${from}`, to: `t${to}`, need: "deliver" });
const ids = (tickets: WorkTicket[], me = ME, scope = {}, edges: DependencyEdge[] = []) => workQueue(withPlaces(tickets, edges), me, scope);

describe("workQueue: quem entra", () => {
  it("só ticket a fazer; em andamento, em revisão, concluído e cancelado ficam fora", () => {
    const status = (s: TicketStatus, n: number) => t(n, null, { status: s });
    expect(ids([status("todo", 1), status("in_progress", 2), status("in_review", 3), status("done", 4), status("cancelled", 5)])).toEqual(["t1"]);
  });
  it("pai com filho aberto não entra; o filho entra", () => {
    expect(ids([t(1, null), t(2, "t1")])).toEqual(["t2"]);
  });
  it("pai não entra, mesmo com os filhos finalizados (ADR 0068: o trabalho dele é um filho)", () => {
    expect(ids([t(1, null), t(2, "t1", { status: "done" }), t(3, "t1", { status: "cancelled" })])).toEqual([]);
  });
  it("neto aberto também segura o avô", () => {
    expect(ids([t(1, null), t(2, "t1", { status: "done" }), t(3, "t2", { status: "todo" })])).toEqual(["t3"]);
  });
  it("ideia e o que está dentro dela ficam fora", () => {
    const idea = { root: true as const, stage: "new" as const };
    const inside = { root: false as const, rootId: "t1", rootKey: "ABC-1" };
    expect(ids([t(1, null, { idea }), t(2, "t1", { idea: inside }), t(3, null)])).toEqual(["t3"]);
  });
  it("só entra o ticket livre: dependência para começar aberta tira (próximo ou esperando); concluída deixa", () => {
    expect(ids([t(1, null), t(2, null), t(3, null), t(4, null, { status: "done" })], ME, {}, [start(1, 2), start(2, 3), start(3, 4)])).toEqual(["t3"]);
  });
  it("dependência para entregar aberta não tira o ticket", () => {
    expect(ids([t(1, null), t(2, null)], ME, {}, [deliver(1, 2)])).toEqual(["t1", "t2"]);
  });
  it("impedimento marcado (bloqueado) tira o ticket", () => {
    expect(ids([t(1, null, { blocked: true }), t(2, null)])).toEqual(["t2"]);
  });
  it("marcador de trabalho pela IA ligado tira; vencido (agentWork nulo) deixa", () => {
    const marker = { since: "2026-11-22T10:00:00.000Z", until: "2026-11-22T11:00:00.000Z", note: "" };
    expect(ids([t(1, null, { agentWork: marker }), t(2, null)])).toEqual(["t2"]);
  });
  it("ticket só de outra pessoa fica fora; da pessoa, de ninguém, ou dela com outra entram", () => {
    const queue = ids([t(1, null, { assigneeIds: [OTHER] }), t(2, null, { assigneeIds: [ME] }), t(3, null), t(4, null, { assigneeIds: [OTHER, ME] })]);
    expect(queue).toEqual(["t2", "t4", "t3"]);
  });
});

describe("workQueue: a ordem", () => {
  it("prioridade que vale, da maior para a menor; negativo vai para o fim", () => {
    expect(ids([t(1, null, { priority: -3 }), t(2, null), t(3, null, { priority: 5 }), t(4, null, { priority: 1 })])).toEqual(["t3", "t4", "t2", "t1"]);
  });
  it("a prioridade herdada do ramo vale para os filhos com 0, em vários níveis", () => {
    const queue = ids([t(1, null, { priority: 9 }), t(2, "t1"), t(3, "t2"), t(4, null, { priority: 3 }), t(5, "t1", { priority: -1 })]);
    // t3 (herda 9), t5 (própria -1), t4 (3): 9, 3, -1
    expect(queue).toEqual(["t3", "t4", "t5"]);
  });
  it("empate: os que já são da pessoa antes dos sem responsável; depois o número", () => {
    expect(ids([t(1, null), t(2, null, { assigneeIds: [ME] }), t(3, null), t(4, null, { assigneeIds: [ME] })])).toEqual(["t2", "t4", "t1", "t3"]);
  });
  it("prioridade vence a posse: um sem dono com prioridade maior vem antes do meu", () => {
    expect(ids([t(1, null, { assigneeIds: [ME] }), t(2, null, { priority: 1 })])).toEqual(["t2", "t1"]);
  });
});

describe("workQueue: o alcance", () => {
  const tree = [t(1, null), t(2, "t1"), t(3, "t1"), t(4, null), t(5, "t4"), t(6, null, { projectId: "p2" })];
  it("sem alcance, tudo o que a pessoa enxerga", () => {
    expect(ids(tree)).toEqual(["t2", "t3", "t5", "t6"]);
  });
  it("ramo de um ticket: ele e os descendentes", () => {
    expect(ids(tree, ME, { ticketId: "t1" })).toEqual(["t2", "t3"]);
    expect(ids(tree, ME, { ticketId: "t5" })).toEqual(["t5"]);
  });
  it("projeto: só os tickets dele", () => {
    expect(ids(tree, ME, { projectId: "p2" })).toEqual(["t6"]);
  });
  it("a prioridade herdada de fora do ramo continua valendo dentro dele", () => {
    const outer = [t(1, null, { priority: 4 }), t(2, "t1"), t(3, "t2"), t(4, null, { priority: 2 }), t(5, "t4")];
    expect(ids(outer, ME, { ticketId: "t2" })).toEqual(["t3"]);
    expect(ids(outer)).toEqual(["t3", "t5"]);
  });
});

describe("workQueue: árvores geradas", () => {
  it("só entra quem cumpre a regra (a fazer, sem filhos, livre, sem impedimento, da pessoa ou de ninguém), na ordem pedida", () => {
    let seed = 99;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const statuses: TicketStatus[] = ["todo", "todo", "in_progress", "in_review", "done", "cancelled"];
    for (let round = 0; round < 40; round += 1) {
      const raw: WorkTicket[] = [];
      const size = 1 + Math.floor(rand() * 30);
      for (let i = 1; i <= size; i += 1) {
        const parentId = i === 1 || rand() < 0.2 ? null : `t${1 + Math.floor(rand() * (i - 1))}`;
        raw.push(
          t(i, parentId, {
            status: statuses[Math.floor(rand() * statuses.length)] as TicketStatus,
            priority: rand() < 0.5 ? 0 : Math.floor(rand() * 7) - 3,
            assigneeIds: rand() < 0.3 ? [OTHER] : rand() < 0.4 ? [ME] : [],
            blocked: rand() < 0.15,
          }),
        );
      }
      const edges: DependencyEdge[] = [];
      for (let i = 2; i <= size; i += 1) if (rand() < 0.3) edges.push({ from: `t${i}`, to: `t${1 + Math.floor(rand() * (i - 1))}`, need: rand() < 0.5 ? "start" : "deliver" });
      const tickets = withPlaces(raw, edges);
      const queue = workQueue(tickets, ME, {});
      const eff = effectivePriorities(tickets);
      const statusOf = new Map(tickets.map((x) => [x.id, x.status] as const));
      const openStart = (id: string) => edges.some((e) => e.from === id && e.need === "start" && !["done", "cancelled"].includes(statusOf.get(e.to) as string));
      const expectedMembers = tickets
        .filter((x) => x.status === "todo" && !tickets.some((y) => y.parentId === x.id) && !openStart(x.id) && !x.blocked && (x.assigneeIds.length === 0 || x.assigneeIds.includes(ME)))
        .map((x) => x.id)
        .sort();
      expect([...queue].sort()).toEqual(expectedMembers);
      const key = (id: string) => {
        const x = tickets.find((y) => y.id === id) as WorkTicket;
        return [-(eff.get(id)?.value ?? 0), x.assigneeIds.includes(ME) ? 0 : 1, x.number];
      };
      for (let i = 1; i < queue.length; i += 1) {
        const a = key(queue[i - 1] as string);
        const b = key(queue[i] as string);
        const cmp = a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
        expect(cmp).toBeLessThan(0);
      }
    }
  });
});

describe("emptyQueueReason", () => {
  it("fila com gente: sem motivo", () => {
    expect(emptyQueueReason(withPlaces([t(1, null)]), ME, {})).toBeNull();
  });
  it("nada a fazer no alcance: 'none' (nenhum motivo único)", () => {
    expect(emptyQueueReason(withPlaces([t(1, null, { status: "done" })]), ME, {})).toBe("none");
    expect(emptyQueueReason([], ME, {})).toBe("none");
  });
  it("tudo o que estaria pronto espera outro ticket (próximo ou esperando): 'all_waiting'", () => {
    expect(emptyQueueReason(withPlaces([t(1, null), t(2, null), t(3, null, { status: "in_progress" })], [start(1, 3), start(2, 1)]), ME, {})).toBe("all_waiting");
  });
  it("tudo o que estaria pronto é de outra pessoa", () => {
    expect(emptyQueueReason(withPlaces([t(1, null, { assigneeIds: [OTHER] }), t(2, null, { assigneeIds: [OTHER] })]), ME, {})).toBe("all_others");
  });
  it("um de cada: nenhum motivo único", () => {
    expect(emptyQueueReason(withPlaces([t(1, null), t(2, null, { assigneeIds: [OTHER] }), t(3, null, { status: "in_progress" })], [start(1, 3)]), ME, {})).toBe("none");
  });
  it("tudo com impedimento: nenhum motivo único", () => {
    expect(emptyQueueReason(withPlaces([t(1, null, { blocked: true })]), ME, {})).toBe("none");
  });
  it("não conta o que nem estaria pronto (ideia, pai, em andamento)", () => {
    const tickets = withPlaces([t(1, null, { assigneeIds: [OTHER] }), t(2, "t1", { assigneeIds: [OTHER] }), t(3, null, { status: "in_progress" })]);
    expect(emptyQueueReason(tickets, ME, {})).toBe("all_others");
  });
});
