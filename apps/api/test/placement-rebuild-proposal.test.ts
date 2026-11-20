import { describe, expect, it } from "vitest";
import {
  affinityStats,
  flattenGabarito,
  looView,
  parseCliArgs,
  renderReport,
  resolveKinds,
} from "../scripts/placement-rebuild/core.js";
import type { AffinityRecord, GabaritoTicket, RunRecord } from "../scripts/placement-rebuild/core.js";

const node = (id: string, number: number, parentId: string | null, kind: "ticket" | "group", depth: number): GabaritoTicket => ({
  id,
  number,
  kind,
  key: `K-${number}`,
  title: `Título ${id}`,
  description: `Descrição ${id}`,
  status: kind === "group" ? null : "todo",
  parentId,
  assigneeIds: [],
  depth,
});

/** Dois agrupadores (ga com a1, a2, a3; gb com b1, b2), um ticket solto na raiz (r1) e um agrupador vazio (gv). */
const gabarito: GabaritoTicket[] = [
  node("ga", 1, null, "group", 0),
  node("a1", 2, "ga", "ticket", 1),
  node("a2", 3, "ga", "ticket", 1),
  node("a3", 4, "ga", "ticket", 1),
  node("gb", 5, null, "group", 0),
  node("b1", 6, "gb", "ticket", 1),
  node("b2", 7, "gb", "ticket", 1),
  node("r1", 8, null, "ticket", 0),
  node("gv", 9, null, "group", 0),
];
const parentOf = (id: string): string | null | undefined => gabarito.find((x) => x.id === id)?.parentId;
const titleOf = (id: string): string | undefined => gabarito.find((x) => x.id === id)?.title;
const ticketsOf = (group: string): string[] => gabarito.filter((x) => x.parentId === group && x.kind === "ticket").map((x) => x.id);

describe("flattenGabarito", () => {
  it("fica só com os tickets, todos na raiz, sem agrupadores, na ordem do número", () => {
    const flat = flattenGabarito(gabarito);
    expect(flat.map((x) => x.id)).toEqual(["a1", "a2", "a3", "b1", "b2", "r1"]);
    expect(flat.every((x) => x.parentId === null && x.depth === 0 && x.kind === "ticket")).toBe(true);
  });

  it("não altera o gabarito de entrada e mantém o resto dos campos", () => {
    const before = JSON.stringify(gabarito);
    const flat = flattenGabarito(gabarito);
    expect(JSON.stringify(gabarito)).toBe(before);
    expect(flat[0]).toMatchObject({ id: "a1", title: "Título a1", description: "Descrição a1", status: "todo", number: 2 });
  });

  it("o resultado é um gabarito válido: nenhum ticket tem filhos", () => {
    expect(() => resolveKinds(flattenGabarito(gabarito))).not.toThrow();
  });
});

const record = (oldId: string, affinity: AffinityRecord | undefined, flat = true): RunRecord =>
  ({
    oldId,
    oldNumber: 1,
    title: `Título ${oldId}`,
    newId: `n-${oldId}`,
    newKey: "K-1",
    conversationId: "c",
    resumed: false,
    expectedParentOldId: flat ? null : (parentOf(oldId) ?? null),
    chosenParentNewId: null,
    chosenParentOldId: null,
    group: "same_parent",
    uncertain: false,
    stoppedEarly: null,
    destinationPath: [],
    alternatives: [],
    judgments: [],
    claude: { draftTitle: "x", ready: true, message: "" },
    timingsMs: { open: 1, draft: 1, placement: 1, ticket: 1 },
    attempts: { open: 1, draft: 1, placement: 1, ticket: 1 },
    ...(flat ? { flat: true } : {}),
    ...(affinity ? { affinity } : {}),
  }) as RunRecord;
const pair = (ticketOldId: string, noul: number) => ({ ticketOldId, title: `Título ${ticketOldId}`, noul });

// a1 vê todos os outros; a2 também; b1 não teve proposta (nenhum passou); r1 não foi verificado.
const records: RunRecord[] = [
  record("a1", {
    pairs: [pair("a2", 0.9), pair("a3", 0.8), pair("b1", 0.5), pair("b2", 0.1), pair("r1", 0.75)],
    proposal: { title: "Grupo A", ticketOldIds: ["a2", "a3", "r1"] },
    skipped: null,
  }),
  record("a2", {
    pairs: [pair("a1", 0.2), pair("a3", 0.95), pair("b1", 0.05), pair("b2", 0.3), pair("r1", 0.1)],
    proposal: { title: "Grupo A de novo", ticketOldIds: ["a3"] },
    skipped: null,
  }),
  record("b1", { pairs: [pair("a1", 0.1), pair("b2", 0.7)], proposal: null, skipped: null }),
  record("r1", { pairs: [], proposal: null, skipped: "too_large" }),
  record("b2", undefined),
];

describe("affinityStats — execução com --flat", () => {
  const stats = affinityStats(records, parentOf, true, titleOf, ticketsOf);

  it("conta as procuras com afinidade, as propostas e cada motivo de falta de proposta", () => {
    expect(stats.searches).toBe(4);
    expect(stats.proposals).toBe(2);
    expect(stats.reasons).toEqual({
      none_passed: 1,
      not_settled: 0,
      no_loose_tickets: 0,
      too_large: 1,
      same_as_destination: 0,
      invalid_name: 0,
      unavailable: 0,
    });
  });

  it("rotula cada par pelo agrupador do gabarito e distribui o Noul nas três faixas (0,7 fica na do meio)", () => {
    expect(stats.pairs.labeled).toBe(true);
    // Mesmo agrupador: (a1,a2) 0,9 alto; (a1,a3) 0,8 alto; (a2,a1) 0,2 baixo; (a2,a3) 0,95 alto; (b1,b2) 0,7 meio.
    expect(stats.pairs.same_group).toEqual({ low: 1, mid: 1, high: 3, total: 5 });
    // Outro agrupador (ou ticket solto na raiz do gabarito): o resto, 7 dos 12 pares.
    expect(stats.pairs.other_group).toEqual({ low: 4, mid: 2, high: 1, total: 7 });
    expect(stats.pairs.unlabeled).toEqual({ low: 0, mid: 0, high: 0, total: 0 });
  });

  it("por ticket: houve proposta, quantos eram do mesmo agrupador, quantos não, e quantos do original ficaram de fora", () => {
    const a1 = stats.perTicket.find((x) => x.oldId === "a1");
    expect(a1).toMatchObject({ proposed: true, same: 2, other: 1, leftOut: 0, proposedTitle: "Grupo A", originalTitle: "Título ga" });
    const a2 = stats.perTicket.find((x) => x.oldId === "a2");
    expect(a2).toMatchObject({ proposed: true, same: 1, other: 0, leftOut: 1, proposedTitle: "Grupo A de novo" });
    const b1 = stats.perTicket.find((x) => x.oldId === "b1");
    expect(b1).toMatchObject({ proposed: false, same: 0, other: 0, leftOut: 1, proposedTitle: null, originalTitle: "Título gb" });
    const r1 = stats.perTicket.find((x) => x.oldId === "r1");
    expect(r1).toMatchObject({ proposed: false, originalTitle: null });
    expect(stats.perTicket.map((x) => x.oldId)).toEqual(["a1", "a2", "b1", "r1"]);
  });

  it("ticket solto na raiz do gabarito: tudo o que propõem junto é de outro agrupador", () => {
    const solo = affinityStats(
      [record("r1", { pairs: [pair("a1", 0.9)], proposal: { title: "X", ticketOldIds: ["a1"] }, skipped: null })],
      parentOf,
      true,
      titleOf,
      ticketsOf,
    );
    expect(solo.perTicket[0]).toMatchObject({ proposed: true, same: 0, other: 1, leftOut: 0 });
  });
});

describe("affinityStats — execução normal", () => {
  const normal = affinityStats(
    [
      record("a1", { pairs: [pair("a2", 0.9), pair("b1", 0.1)], proposal: { title: "G", ticketOldIds: ["a2"] }, skipped: null }, false),
      record("a2", { pairs: [], proposal: null, skipped: "same_as_destination" }, false),
    ],
    parentOf,
    false,
  );

  it("só as contagens de proposta e de motivos, e os pares sem rótulo", () => {
    expect(normal.searches).toBe(2);
    expect(normal.proposals).toBe(1);
    expect(normal.reasons.same_as_destination).toBe(1);
    expect(normal.pairs.labeled).toBe(false);
    expect(normal.pairs.unlabeled).toEqual({ low: 1, mid: 0, high: 1, total: 2 });
    expect(normal.pairs.same_group.total + normal.pairs.other_group.total).toBe(0);
    expect(normal.perTicket).toEqual([]);
  });
});

describe("renderReport — seção Proposta de agrupador", () => {
  const view = looView(gabarito, new Map(gabarito.map((x) => [x.id, `n-${x.id}`])));
  const flat = renderReport(gabarito, records, "KEY", { view, loo: true });

  it("na execução --flat traz pares rotulados, tickets, títulos propostos e motivos", () => {
    expect(flat).toContain("## Proposta de agrupador");
    expect(flat).toContain("| Mesmo agrupador no gabarito | 5 | 1 | 1 | 3 |");
    expect(flat).toContain("| Outro agrupador no gabarito | 7 | 4 | 2 | 1 |");
    expect(flat).toContain("| Título a1 | sim | 2 | 1 | 0 |");
    expect(flat).toContain("| Título b1 | não | 0 | 0 | 1 |");
    expect(flat).toContain("| Título a1 | Grupo A | Título ga |");
    expect(flat).toContain("| too_large | 1 |");
    expect(flat).toContain("| none_passed | 1 |");
  });

  it("na execução normal traz só as contagens e os pares sem rótulo", () => {
    const normalRecords = [
      record("a1", { pairs: [pair("a2", 0.9)], proposal: null, skipped: null }, false),
    ];
    const text = renderReport(gabarito, normalRecords, "KEY", { view, loo: true });
    expect(text).toContain("## Proposta de agrupador");
    expect(text).toContain("| Sem rótulo | 1 | 0 | 0 | 1 |");
    expect(text).not.toContain("Mesmo agrupador no gabarito");
    expect(text).not.toContain("| Título a1 | Grupo");
  });

  it("sem nenhum registro de afinidade (execução antiga) a seção diz que não há dados", () => {
    const text = renderReport(gabarito, [record("a1", undefined, false)], "KEY", { view, loo: true });
    expect(text).toContain("## Proposta de agrupador");
    expect(text).toContain("Nenhuma procura registrou a afinidade");
  });
});

describe("parseCliArgs — --flat", () => {
  const base = ["leave-one-out", "--org", "o", "--user", "u", "--dir", "d", "--project", "p"];
  it("aceita --flat no leave-one-out", () => {
    const parsed = parseCliArgs([...base, "--flat"]);
    expect(parsed).toMatchObject({ ok: true, options: { flat: true } });
  });
  it("não combina com --scope-check", () => {
    const parsed = parseCliArgs([...base, "--flat", "--scope-check"]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/--flat.*--scope-check/);
  });
  it("só existe no leave-one-out", () => {
    const parsed = parseCliArgs(["rebuild", "--org", "o", "--user", "u", "--dir", "d", "--project", "p", "--flat"]);
    expect(parsed.ok).toBe(false);
  });
});
