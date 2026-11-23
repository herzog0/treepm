import { describe, expect, it } from "vitest";
import { PLAY_TEMPLATE_IDS, playTemplate, playTemplates } from "./play.js";
import type { PlayPerson } from "./play.js";
import type { WorkTicket } from "./work-queue.js";

const NOW = Date.parse("2026-11-22T12:00:00.000Z");
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

function t(number: number, parentId: string | null, extra: Partial<WorkTicket> = {}): WorkTicket {
  return { id: `t${number}`, projectId: "p1", parentId, number, status: "todo", priority: 0, assigneeIds: [], blocked: false, progress: null, idea: null, agentWork: null, ...extra };
}
const people: PlayPerson[] = [
  { id: "ana", displayName: "Ana" },
  { id: "bia", displayName: "bia" },
  { id: "caio", displayName: "Caio" },
];
const run = (tickets: WorkTicket[], me: string, scope = {}) => playTemplates({ tickets, people, me, scope, now: NOW });
const stepIds = (tickets: WorkTicket[], template: (typeof PLAY_TEMPLATE_IDS)[number], me = "ana", scope = {}) =>
  run(tickets, me, scope).find((entry) => entry.id === template)?.steps.map((step) => step.ticketId);

describe("playTemplates", () => {
  it("devolve os cinco modelos, na ordem da ADR 0048, mesmo vazios", () => {
    const result = run([], "ana");
    expect(result.map((entry) => entry.id)).toEqual(["next_to_work", "my_work", "in_progress", "standup", "agent_work"]);
    expect(result.every((entry) => entry.count === 0 && entry.steps.length === 0)).toBe(true);
    expect(PLAY_TEMPLATE_IDS).toEqual(result.map((entry) => entry.id));
  });

  it("playTemplate devolve um modelo só, igual ao da lista", () => {
    const tickets = [t(1, null), t(2, null, { status: "in_progress", assigneeIds: ["ana"] })];
    const input = { tickets, people, me: "ana", scope: {}, now: NOW };
    for (const entry of playTemplates(input)) expect(playTemplate(entry.id, input)).toEqual(entry);
  });

  describe("Próximos para trabalhar", () => {
    it("é a fila da ADR 0047, sem pessoa nos passos", () => {
      const tickets = [t(1, null, { priority: 1 }), t(2, null, { priority: 5 }), t(3, null, { assigneeIds: ["bia"] })];
      const entry = run(tickets, "ana")[0]!;
      expect(entry.steps).toEqual([{ ticketId: "t2", personId: null }, { ticketId: "t1", personId: null }]);
      expect(entry.count).toBe(2);
    });
  });

  describe("Meu trabalho", () => {
    it("meus a fazer e em andamento, fora ideias; em andamento primeiro, depois prioridade que vale, depois número", () => {
      const idea = { root: true };
      const tickets = [
        t(1, null, { assigneeIds: ["ana"], priority: 1 }),
        t(2, null, { assigneeIds: ["ana"], priority: 9 }),
        t(3, null, { assigneeIds: ["ana"], status: "in_progress" }),
        t(4, null, { assigneeIds: ["ana"], status: "in_progress", priority: 2 }),
        t(5, null, { assigneeIds: ["bia"], status: "in_progress" }),
        t(6, null, { assigneeIds: ["ana"], status: "done" }),
        t(7, null, { assigneeIds: ["ana"], status: "in_review" }),
        t(8, null, { assigneeIds: ["ana"], idea }),
        t(9, null),
      ];
      expect(stepIds(tickets, "my_work")).toEqual(["t4", "t3", "t2", "t1"]);
    });
    it("pai meu com filhos abertos também entra (não é só o ticket da vez)", () => {
      expect(stepIds([t(1, null, { assigneeIds: ["ana"] }), t(2, "t1")], "my_work")).toEqual(["t1"]);
    });
    it("a prioridade herdada conta na ordem", () => {
      const tickets = [t(1, null, { priority: 8 }), t(2, "t1", { assigneeIds: ["ana"] }), t(3, null, { assigneeIds: ["ana"], priority: 2 })];
      expect(stepIds(tickets, "my_work")).toEqual(["t2", "t3"]);
    });
  });

  describe("Em andamento", () => {
    const tickets = [
      t(1, null, { status: "in_progress", assigneeIds: ["caio"] }),
      t(2, null, { status: "in_progress" }),
      t(3, null, { status: "in_progress", assigneeIds: ["bia"] }),
      t(4, null, { status: "in_progress", assigneeIds: ["ana"] }),
      t(5, null, { status: "in_progress", assigneeIds: ["ana"] }),
      t(6, null, { status: "todo", assigneeIds: ["ana"] }),
      t(7, "t6", { status: "in_progress", assigneeIds: ["caio", "ana"] }),
    ];
    it("tudo em andamento, por pessoa responsável (ordem alfabética, sem responsável por último), depois o número", () => {
      // Com dois responsáveis vale o primeiro em ordem alfabética (t7: Ana).
      expect(stepIds(tickets, "in_progress")).toEqual(["t4", "t5", "t7", "t3", "t1", "t2"]);
    });
    it("respeita o alcance", () => {
      expect(stepIds(tickets, "in_progress", "ana", { ticketId: "t6" })).toEqual(["t7"]);
    });
  });

  describe("Stand-up", () => {
    const tickets = [
      t(1, null, { status: "in_progress", assigneeIds: ["caio"] }),
      t(2, null, { assigneeIds: ["caio"], priority: 2 }),
      t(3, null, { status: "in_progress", assigneeIds: ["ana"] }),
      t(4, null, { assigneeIds: ["ana"] }),
      t(5, null, { assigneeIds: ["ana"], priority: 3 }),
      t(6, null, { status: "in_progress", assigneeIds: ["bia"] }),
      t(7, null),
    ];
    it("por pessoa em ordem alfabética, quem conduz por último; em andamento e depois o próximo da fila dela", () => {
      const entry = run(tickets, "ana").find((x) => x.id === "standup")!;
      expect(entry.steps).toEqual([
        { ticketId: "t6", personId: "bia" },
        { ticketId: "t1", personId: "caio" },
        { ticketId: "t2", personId: "caio" },
        { ticketId: "t3", personId: "ana" },
        { ticketId: "t5", personId: "ana" },
      ]);
      expect(entry.count).toBe(5);
    });
    it("quem não tem nada fica de fora; sem ninguém com nada, vazio", () => {
      const entry = run([t(1, null, { status: "done" })], "ana").find((x) => x.id === "standup")!;
      expect(entry.steps).toEqual([]);
    });
    it("o ticket sem responsável não vira o 'próximo' de ninguém", () => {
      const only = run([t(7, null)], "ana").find((x) => x.id === "standup")!;
      expect(only.steps).toEqual([]);
    });
    it("a contagem é de tickets diferentes", () => {
      // Um ticket em andamento de duas pessoas aparece nos dois turnos, mas conta uma vez.
      const shared = [t(1, null, { status: "in_progress", assigneeIds: ["ana", "bia"] })];
      const entry = run(shared, "caio").find((x) => x.id === "standup")!;
      expect(entry.steps).toEqual([{ ticketId: "t1", personId: "ana" }, { ticketId: "t1", personId: "bia" }]);
      expect(entry.count).toBe(1);
    });
  });

  describe("Trabalho pela IA", () => {
    it("só marcador que ainda vale agora; os que vencem antes primeiro; depois o número", () => {
      const tickets = [
        t(1, null, { agentWork: { until: iso(30) } }),
        t(2, null, { agentWork: { until: iso(10) } }),
        t(3, null, { agentWork: { until: iso(-1) } }),
        t(4, null, { agentWork: { until: iso(10) } }),
        t(5, null),
      ];
      expect(stepIds(tickets, "agent_work")).toEqual(["t2", "t4", "t1"]);
    });
    it("o instante é o 'agora' recebido: o mesmo marcador vale ou não conforme o relógio", () => {
      const tickets = [t(1, null, { agentWork: { until: iso(10) } })];
      const later = playTemplates({ tickets, people, me: "ana", scope: {}, now: NOW + 11 * 60_000 });
      expect(later.find((x) => x.id === "agent_work")?.count).toBe(0);
    });
    it("respeita o alcance", () => {
      const tickets = [t(1, null), t(2, "t1", { agentWork: { until: iso(5) } }), t(3, null, { agentWork: { until: iso(5) } })];
      expect(stepIds(tickets, "agent_work", "ana", { ticketId: "t1" })).toEqual(["t2"]);
    });
  });

  it("o alcance vale para todos os modelos e a contagem confere com os passos", () => {
    const tickets = [t(1, null, { assigneeIds: ["ana"] }), t(2, null, { assigneeIds: ["ana"], status: "in_progress" })];
    for (const entry of run(tickets, "ana", { ticketId: "t1" })) {
      expect(entry.steps.every((step) => step.ticketId === "t1")).toBe(true);
      expect(entry.count).toBe(new Set(entry.steps.map((step) => step.ticketId)).size);
    }
  });
});
