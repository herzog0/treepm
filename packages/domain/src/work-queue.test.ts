import { describe, expect, it } from "vitest";
import { emptyQueueReason, workQueue } from "./work-queue.js";
import type { WorkTicket } from "./work-queue.js";
import type { TicketStatus } from "./tickets.js";
import { ticketsOfTheTurn } from "./tickets.js";
import { effectivePriorities } from "./priority.js";

const ME = "me";
const OTHER = "other";

/** Ticket de teste: só o que muda precisa ser dito; o resto é "a fazer, sem dono, sem prioridade, livre". */
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
    progress: null,
    idea: null,
    agentWork: null,
    ...extra,
  };
}
/** Preenche `progress` dos pais a partir dos filhos, como o servidor faz (só o que `isTurn` lê: done === total). */
function withProgress(tickets: WorkTicket[]): WorkTicket[] {
  return tickets.map((ticket) => {
    const kids = tickets.filter((other) => other.parentId === ticket.id && other.idea === null);
    if (kids.length === 0) return ticket;
    const open = (other: WorkTicket): boolean => other.status !== "done" && other.status !== "cancelled";
    const descendantsOpen = (id: string): boolean => tickets.some((other) => other.parentId === id && other.idea === null && (open(other) || descendantsOpen(other.id)));
    const total = descendantsOpen(ticket.id) ? 1 : 0;
    return { ...ticket, progress: { done: 0, total, excluded: 0, ideas: 0 } };
  });
}
const ids = (tickets: WorkTicket[], me = ME, scope = {}) => workQueue(withProgress(tickets), me, scope);

describe("workQueue: quem entra", () => {
  it("só ticket a fazer; em andamento, em revisão, concluído e cancelado ficam fora", () => {
    const status = (s: TicketStatus, n: number) => t(n, null, { status: s });
    expect(ids([status("todo", 1), status("in_progress", 2), status("in_review", 3), status("done", 4), status("cancelled", 5)])).toEqual(["t1"]);
  });
  it("pai com filho aberto não entra; o filho entra", () => {
    expect(ids([t(1, null), t(2, "t1")])).toEqual(["t2"]);
  });
  it("pai cujos filhos terminaram é o ticket da vez e entra", () => {
    expect(ids([t(1, null), t(2, "t1", { status: "done" }), t(3, "t1", { status: "cancelled" })])).toEqual(["t1"]);
  });
  it("neto aberto também segura o avô", () => {
    expect(ids([t(1, null), t(2, "t1", { status: "done" }), t(3, "t2", { status: "todo" })])).toEqual(["t3"]);
  });
  it("ideia e o que está dentro dela ficam fora", () => {
    const idea = { root: true as const, stage: "new" as const };
    const inside = { root: false as const, rootId: "t1", rootKey: "ABC-1" };
    expect(ids([t(1, null, { idea }), t(2, "t1", { idea: inside }), t(3, null)])).toEqual(["t3"]);
  });
  it("dependência aberta tira o ticket; fechada (blocked falso) deixa", () => {
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
  it("só entra quem cumpre a regra, na ordem pedida, com os mesmos membros do 'ticket da vez' do domínio", () => {
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
      const tickets = withProgress(raw);
      const queue = workQueue(tickets, ME, {});
      const turn = ticketsOfTheTurn(tickets.map((x) => ({ id: x.id, parentId: x.parentId, status: x.status })));
      const eff = effectivePriorities(tickets);
      const expectedMembers = tickets
        .filter((x) => x.status === "todo" && turn.has(x.id) && !x.blocked && (x.assigneeIds.length === 0 || x.assigneeIds.includes(ME)))
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
    expect(emptyQueueReason(withProgress([t(1, null)]), ME, {})).toBeNull();
  });
  it("nada a fazer no alcance: 'none' (nenhum motivo único)", () => {
    expect(emptyQueueReason(withProgress([t(1, null, { status: "done" })]), ME, {})).toBe("none");
    expect(emptyQueueReason([], ME, {})).toBe("none");
  });
  it("tudo o que estaria pronto depende de outro ticket", () => {
    expect(emptyQueueReason(withProgress([t(1, null, { blocked: true }), t(2, null, { blocked: true })]), ME, {})).toBe("all_blocked");
  });
  it("tudo o que estaria pronto é de outra pessoa", () => {
    expect(emptyQueueReason(withProgress([t(1, null, { assigneeIds: [OTHER] }), t(2, null, { assigneeIds: [OTHER] })]), ME, {})).toBe("all_others");
  });
  it("um de cada: nenhum motivo único", () => {
    expect(emptyQueueReason(withProgress([t(1, null, { blocked: true }), t(2, null, { assigneeIds: [OTHER] })]), ME, {})).toBe("none");
  });
  it("não conta o que nem estaria pronto (ideia, pai com filho aberto, em andamento)", () => {
    const tickets = withProgress([t(1, null, { assigneeIds: [OTHER] }), t(2, "t1", { assigneeIds: [OTHER] }), t(3, null, { status: "in_progress" })]);
    expect(emptyQueueReason(tickets, ME, {})).toBe("all_others");
  });
});
