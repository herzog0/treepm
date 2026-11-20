import { describe, expect, it } from "vitest";
import {
  buildImportTree,
  calibrationRows,
  classifyPlacement,
  compareTrees,
  computeDepths,
  computeStats,
  insertionOrder,
  judgmentBand,
  parseCliArgs,
  pendingTickets,
  removalOrder,
  renderReport,
  resumeState,
  withRetry503,
} from "../scripts/placement-rebuild/core.js";
import type { GabaritoTicket, RunRecord } from "../scripts/placement-rebuild/core.js";

const t = (
  id: string,
  number: number,
  parentId: string | null,
  extra: Partial<GabaritoTicket> = {},
): GabaritoTicket => ({
  id,
  number,
  key: `K-${number}`,
  title: `Título ${id}`,
  description: `Descrição ${id}`,
  status: "todo",
  parentId,
  assigneeIds: [],
  depth: 0,
  ...extra,
});

/** a(1) ─ b(2) ─ d(5)   e(6) raiz
 *       └ c(3)
 *  f(4) raiz com filho g(7) */
const sample = (): GabaritoTicket[] =>
  computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "a"), t("f", 4, null), t("d", 5, "b"), t("e", 6, null), t("g", 7, "f")]);

describe("computeDepths", () => {
  it("calcula a profundidade pela cadeia de pais, sem depender da ordem de entrada", () => {
    const shuffled = [t("d", 5, "b"), t("b", 2, "a"), t("a", 1, null)];
    const depths = Object.fromEntries(computeDepths(shuffled).map((x) => [x.id, x.depth]));
    expect(depths).toEqual({ a: 0, b: 1, d: 2 });
  });

  it("recusa pai que não existe na lista", () => {
    expect(() => computeDepths([t("x", 1, "fantasma")])).toThrow(/fantasma/);
  });
});

describe("insertionOrder", () => {
  it("ordena por profundidade e, dentro dela, pelo número original", () => {
    expect(insertionOrder(sample()).map((x) => x.id)).toEqual(["a", "f", "e", "b", "c", "g", "d"]);
  });

  it("não altera a lista de entrada", () => {
    const input = sample();
    const copy = input.map((x) => x.id);
    insertionOrder(input);
    expect(input.map((x) => x.id)).toEqual(copy);
  });
});

describe("removalOrder", () => {
  it("remove sempre os filhos antes do pai (das folhas para a raiz)", () => {
    const order = removalOrder([
      { id: "a", parentId: null },
      { id: "b", parentId: "a" },
      { id: "d", parentId: "b" },
      { id: "c", parentId: "a" },
      { id: "e", parentId: null },
    ]);
    expect(order).toHaveLength(5);
    const position = new Map(order.map((id, index) => [id, index]));
    expect(position.get("d")!).toBeLessThan(position.get("b")!);
    expect(position.get("b")!).toBeLessThan(position.get("a")!);
    expect(position.get("c")!).toBeLessThan(position.get("a")!);
    expect(order[0]).toBe("d"); // a folha mais funda sai primeiro
  });
});

describe("classifyPlacement", () => {
  // gabarito: a(raiz) > b > d ; e raiz
  const oldParents = new Map<string, string | null>([
    ["a", null],
    ["b", "a"],
    ["d", "b"],
    ["e", null],
  ]);
  const newToOld = new Map([
    ["na", "a"],
    ["nb", "b"],
    ["nd", "d"],
  ]);
  const classify = (expected: string | null, chosen: string | null) =>
    classifyPlacement({ expectedParentOldId: expected, chosenNewParentId: chosen, newToOld, oldParents });

  it("ticket de raiz que ficou na raiz é same_parent", () => {
    expect(classify(null, null)).toBe("same_parent");
  });
  it("pai escolhido que corresponde ao esperado é same_parent", () => {
    expect(classify("b", "nb")).toBe("same_parent");
  });
  it("pai esperado é ancestral do pai escolhido: deeper", () => {
    expect(classify("a", "nd")).toBe("deeper");
    expect(classify("b", "nd")).toBe("deeper");
  });
  it("ticket de raiz que desceu para qualquer ticket é deeper (a raiz é ancestral de tudo)", () => {
    expect(classify(null, "nb")).toBe("deeper");
  });
  it("pai mais raso que o esperado ou em outro ramo é elsewhere", () => {
    expect(classify("d", "nb")).toBe("elsewhere");
    expect(classify("b", "na")).toBe("elsewhere");
    expect(classify("e", "nb")).toBe("elsewhere");
  });
  it("esperava um pai mas ficou na raiz: elsewhere", () => {
    expect(classify("b", null)).toBe("elsewhere");
  });
  it("pai escolhido sem correspondência no gabarito: elsewhere", () => {
    expect(classify("a", "desconhecido")).toBe("elsewhere");
    expect(classify(null, "desconhecido")).toBe("elsewhere");
  });
});

describe("resumeState e pendingTickets", () => {
  const order = insertionOrder(sample());
  const record = (oldId: string): RunRecord => makeRecord({ oldId });

  it("pula os já registrados e mantém a ordem", () => {
    const state = resumeState([record("a"), record("f")], []);
    expect(pendingTickets(order, state).map((x) => x.id)).toEqual(["e", "b", "c", "g", "d"]);
  });

  it("ticket com conversa iniciada e sem registro continua pendente, devolvendo a conversa para reaproveitar", () => {
    const state = resumeState([record("a")], [{ oldId: "f", conversationId: "conv-f" }]);
    expect(pendingTickets(order, state).map((x) => x.id)[0]).toBe("f");
    expect(state.startedConversation.get("f")).toBe("conv-f");
    expect(state.done.has("f")).toBe(false);
  });

  it("registro concluído vence a marca de conversa iniciada", () => {
    const state = resumeState([record("a")], [{ oldId: "a", conversationId: "conv-a" }]);
    expect(pendingTickets(order, state).map((x) => x.id)).not.toContain("a");
  });

  it("mapeia o id novo para o do gabarito a partir dos registros", () => {
    const state = resumeState([makeRecord({ oldId: "a", newId: "na" })], []);
    expect(state.newToOld.get("na")).toBe("a");
  });

  it("--limit considera só os N primeiros da ordem inteira e depois pula os já feitos", () => {
    const state = resumeState([record("a")], []);
    expect(pendingTickets(order, state, 3).map((x) => x.id)).toEqual(["f", "e"]);
  });
});

describe("withRetry503", () => {
  it("tenta de novo em 503 com espera crescente e devolve o sucesso com a contagem de tentativas", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry503(
      async () => ({ status: ++calls < 3 ? 503 : 200, body: { ok: true } }),
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(result.attempts).toBe(3);
    expect(result.response.status).toBe(200);
    expect(waits).toEqual([2000, 5000]);
  });

  it("para depois de 3 retentativas (4 chamadas) e devolve o último 503", async () => {
    const waits: number[] = [];
    let calls = 0;
    const result = await withRetry503(
      async () => {
        calls += 1;
        return { status: 503, body: null };
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(calls).toBe(4);
    expect(result.attempts).toBe(4);
    expect(result.response.status).toBe(503);
    expect(waits).toEqual([2000, 5000, 10000]);
  });

  it("não repete respostas que não são 503", async () => {
    let calls = 0;
    const result = await withRetry503(
      async () => {
        calls += 1;
        return { status: 409, body: null };
      },
      { sleep: async () => {} },
    );
    expect(calls).toBe(1);
    expect(result.attempts).toBe(1);
  });
});

describe("compareTrees", () => {
  const gabarito = sample();
  const live = () =>
    gabarito.map((x) => ({ id: x.id, title: x.title, parentId: x.parentId, status: x.status === "todo" ? "todo" : x.status }));

  it("confere quando ids, títulos, pais e situações são iguais", () => {
    expect(compareTrees(gabarito, live())).toEqual([]);
  });
  it("aponta ticket a mais, a menos, título, pai e situação diferentes", () => {
    const changed = live().filter((x) => x.id !== "c");
    changed.push({ id: "z", title: "novo", parentId: null, status: "todo" });
    const b = changed.find((x) => x.id === "b")!;
    b.title = "outro";
    b.parentId = null;
    changed.find((x) => x.id === "d")!.status = "done";
    const problems = compareTrees(gabarito, changed).join("\n");
    expect(problems).toMatch(/c.*falta/);
    expect(problems).toMatch(/z.*a mais/);
    expect(problems).toMatch(/b.*título/);
    expect(problems).toMatch(/b.*pai/);
    expect(problems).toMatch(/d.*situação/);
  });
});

describe("buildImportTree", () => {
  it("monta a árvore aninhada, irmãos por número, e devolve os ids antigos na pré-ordem da importação", () => {
    const tickets = computeDepths([
      t("a", 1, null, { status: null }),
      t("c", 3, "a", { status: "done", description: "dc" }),
      t("b", 2, "a", { status: "in_progress" }),
      t("e", 4, null, { status: "cancelled" }),
    ]);
    const { items, order } = buildImportTree(tickets);
    expect(order).toEqual(["a", "b", "c", "e"]);
    expect(items).toHaveLength(2);
    expect(items[0]!.children!.map((x) => x.title)).toEqual(["Título b", "Título c"]);
    expect(items[0]!.status).toBeUndefined(); // pai não tem situação própria
    expect(items[0]!.children![1]).toEqual({ title: "Título c", description: "dc", status: "done" });
    expect(items[1]!.children).toBeUndefined();
  });
});

describe("parseCliArgs", () => {
  it("lê comando e opções", () => {
    expect(parseCliArgs(["export", "--org", "org_1", "--user", "user_1", "--project", "p1", "--dir", "/tmp/x"])).toEqual({
      ok: true,
      command: "export",
      options: { org: "org_1", user: "user_1", project: "p1", dir: "/tmp/x" },
    });
  });
  it("aceita --fake-providers e --limit como número", () => {
    const parsed = parseCliArgs(["rebuild", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--fake-providers", "--limit", "5"]);
    expect(parsed).toMatchObject({ ok: true, options: { fakeProviders: true, limit: 5 } });
  });
  it("comando desconhecido, opção desconhecida e opção faltando dão erro que lista os comandos", () => {
    for (const argv of [
      ["nada"],
      [],
      ["export", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--zzz", "1"],
      ["export", "--org", "o", "--user", "u", "--project", "p"],
    ]) {
      const parsed = parseCliArgs(argv);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/export.*check.*wipe.*rebuild.*restore-state.*report.*restore-original.*create-project.*archive-project/s);
    }
  });
  it("wipe exige --confirm; create-project exige --key e --name; report não exige org nem user", () => {
    expect(parseCliArgs(["wipe", "--org", "o", "--user", "u", "--project", "p", "--dir", "d"]).ok).toBe(false);
    expect(parseCliArgs(["wipe", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--confirm", "TREEPM"]).ok).toBe(true);
    expect(parseCliArgs(["create-project", "--org", "o", "--user", "u", "--dir", "d", "--key", "ENS"]).ok).toBe(false);
    expect(parseCliArgs(["create-project", "--org", "o", "--user", "u", "--dir", "d", "--key", "ENS", "--name", "Ensaio"]).ok).toBe(true);
    expect(parseCliArgs(["report", "--project", "p", "--dir", "d"]).ok).toBe(true);
  });
  it("limit inválido é erro", () => {
    expect(parseCliArgs(["rebuild", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--limit", "x"]).ok).toBe(false);
  });
});

// ---- relatório -------------------------------------------------------------------------------------------------

type RecordOverrides = Partial<RunRecord> & { oldId?: string };

function makeRecord(overrides: RecordOverrides = {}): RunRecord {
  const oldId = overrides.oldId ?? "a";
  return {
    oldId,
    oldNumber: 1,
    title: `Título ${oldId}`,
    newId: `n${oldId}`,
    newKey: "R-1",
    conversationId: `conv-${oldId}`,
    resumed: false,
    expectedParentOldId: null,
    chosenParentNewId: null,
    chosenParentOldId: null,
    group: "same_parent",
    uncertain: false,
    stoppedEarly: null,
    destinationPath: [],
    alternatives: [],
    judgments: [],
    claude: { draftTitle: "Rascunho", ready: true, message: "Mensagem" },
    timingsMs: { open: 100, draft: 10, placement: 200, ticket: 20 },
    attempts: { open: 1, draft: 1, placement: 1, ticket: 1 },
    ...overrides,
  };
}

describe("judgmentBand", () => {
  it("separa abaixo de 0,3, de 0,3 a 0,7 e acima de 0,7", () => {
    expect(judgmentBand(0.29)).toBe("low");
    expect(judgmentBand(0.3)).toBe("mid");
    expect(judgmentBand(0.7)).toBe("mid");
    expect(judgmentBand(0.71)).toBe("high");
  });
});

describe("computeStats", () => {
  const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "a"), t("d", 4, "b")]);
  const records: RunRecord[] = [
    makeRecord({ oldId: "a", group: "same_parent", timingsMs: { open: 100, draft: 10, placement: 200, ticket: 20 } }),
    makeRecord({
      oldId: "b",
      expectedParentOldId: "a",
      chosenParentNewId: "na",
      chosenParentOldId: "a",
      group: "same_parent",
      judgments: [{ current: null, candidateCount: 2, belongs: 0.9, choice: { "Título a": 0.8, "Título z": 0.2 } }],
      timingsMs: { open: 300, draft: 30, placement: 400, ticket: 40 },
    }),
    makeRecord({
      oldId: "c",
      expectedParentOldId: "a",
      chosenParentNewId: null,
      chosenParentOldId: null,
      group: "elsewhere",
      uncertain: true,
      destinationPath: [],
      alternatives: [{ parentNewId: "na", parentOldId: "a", path: [{ id: "na", title: "Título a" }] }],
      judgments: [{ current: null, candidateCount: 2, belongs: 0.2, choice: { "Título a": 0.6, "Título z": 0.4 } }],
      claude: { draftTitle: null, ready: false, message: "Pergunta?" },
      timingsMs: { open: 200, draft: 20, placement: 600, ticket: 30 },
    }),
    makeRecord({
      oldId: "d",
      expectedParentOldId: "b",
      chosenParentNewId: "na",
      chosenParentOldId: "a",
      group: "elsewhere",
      judgments: [{ current: "Título a", candidateCount: 3, belongs: 0.5, choice: { "Título b": 0.5, "Título c": 0.3, "Título x": 0.2 } }],
      destinationPath: [{ id: "na", title: "Título a" }],
    }),
  ];
  const stats = computeStats(gabarito, records);

  it("conta total e grupos, no geral e por profundidade", () => {
    expect(stats.total).toBe(4);
    expect(stats.groups).toEqual({ same_parent: 2, deeper: 0, elsewhere: 2 });
    expect(stats.byDepth[0]).toEqual({ same_parent: 1, deeper: 0, elsewhere: 0 });
    expect(stats.byDepth[1]).toEqual({ same_parent: 1, deeper: 0, elsewhere: 1 });
    expect(stats.byDepth[2]).toEqual({ same_parent: 0, deeper: 0, elsewhere: 1 });
  });

  it("lista os incertos e diz se alguma alternativa bateria com o gabarito", () => {
    expect(stats.uncertain).toHaveLength(1);
    expect(stats.uncertain[0]).toMatchObject({ oldId: "c", alternativeWouldMatch: true });
  });

  it("lista quem não ficou em same_parent com caminho esperado e escolhido", () => {
    expect(stats.misplaced.map((m) => m.oldId)).toEqual(["c", "d"]);
    expect(stats.misplaced[1]).toMatchObject({ expectedPath: ["Título a", "Título b"], chosenPath: ["Título a"] });
    expect(stats.misplaced[0]).toMatchObject({ expectedPath: ["Título a"], chosenPath: [] });
  });

  it("conta os rascunhos do Claude: prontos e sem rascunho", () => {
    expect(stats.claude).toEqual({ ready: 3, noDraft: 1 });
  });

  it("calcula tempo total e, por passo, mediana e máximo", () => {
    expect(stats.timing.open).toEqual({ median: 150, max: 300 });
    expect(stats.timing.placement).toEqual({ median: 300, max: 600 });
    expect(stats.timing.totalMs).toBe(
      records.reduce((sum, r) => sum + r.timingsMs.open + r.timingsMs.draft + r.timingsMs.placement + r.timingsMs.ticket, 0),
    );
  });

  it("cruza as faixas de belongs com acerto", () => {
    expect(stats.belongsByBand).toEqual({
      low: { hit: 0, miss: 1 },
      mid: { hit: 0, miss: 1 },
      high: { hit: 1, miss: 0 },
    });
  });
});

describe("calibrationRows", () => {
  it("uma linha por julgamento, com a maior probabilidade do choice, o que a procura fez e se o resultado bateu", () => {
    const rows = calibrationRows([
      makeRecord({
        oldId: "b",
        group: "same_parent",
        judgments: [
          { current: null, candidateCount: 2, belongs: 0.9, choice: { x: 0.8, y: 0.2 } },
          { current: "x", candidateCount: 1, belongs: 0.5, choice: { z: 1 } },
          { current: "z", candidateCount: 2, belongs: 0.1, choice: { p: 0.55, q: 0.45 } },
        ],
      }),
    ]);
    expect(rows.map((r) => [r.belongs, r.topChoice, r.action, r.hit])).toEqual([
      [0.9, 0.8, "descended", true],
      [0.5, 1, "band", true],
      [0.1, 0.55, "stopped", true],
    ]);
  });
});

describe("renderReport", () => {
  it("gera o markdown com as seções pedidas", () => {
    const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a")]);
    const records = [
      makeRecord({ oldId: "a" }),
      makeRecord({
        oldId: "b",
        expectedParentOldId: "a",
        group: "elsewhere",
        uncertain: true,
        judgments: [{ current: null, candidateCount: 1, belongs: 0.4, choice: { "Título a": 1 } }],
      }),
    ];
    const markdown = renderReport(gabarito, records, "PROJ");
    for (const heading of [
      "Resumo",
      "Por profundidade",
      "Incertos",
      "Fora do pai esperado",
      "Calibração",
      "Faixas de belongs",
      "Rascunhos do Claude",
      "Tempos",
    ]) {
      expect(markdown).toContain(`## ${heading}`);
    }
    expect(markdown).toContain("same_parent");
    expect(markdown).toContain("Título b");
  });
});
