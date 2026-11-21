import { describe, expect, it } from "vitest";
import {
  buildImportTree,
  calibrationRows,
  pendingGroups,
  rebuildOrder,
  resolveKinds,
  expectedChain,
  labelJudgment,
  labelStats,
  labeledJudgments,
  looTickets,
  looResumeAction,
  looView,
  otherScopeGroup,
  scopeCheckStats,
  pendingLoo,
  pendingMarks,
  rebuildView,
  recomputeGroups,
  resolveCurrentId,
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
import type { GabaritoTicket, JudgmentLabel, JudgmentRecord, LabeledRow, LiveTicket, LooMark, RunRecord } from "../scripts/placement-rebuild/core.js";

const t = (
  id: string,
  number: number,
  parentId: string | null,
  extra: Partial<GabaritoTicket> = {},
): GabaritoTicket => ({
  id,
  number,
  kind: "ticket",
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
const withoutKind = <T extends { kind?: unknown }>(item: T): Omit<T, "kind"> => {
  const copy = { ...item };
  delete copy.kind;
  return copy;
};

/** Gabarito antigo: sem `kind`, quem tem filhos é agrupador. */
const legacy = (tickets: readonly GabaritoTicket[]): GabaritoTicket[] =>
  resolveKinds(tickets.map(withoutKind)) as GabaritoTicket[];

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
  // gabarito: a(raiz) > b > d ; a > c ; e raiz. Ids novos: na, nb, nc, nd, ne.
  const newToOld = new Map([
    ["na", "a"],
    ["nb", "b"],
    ["nc", "c"],
    ["nd", "d"],
    ["ne", "e"],
  ]);
  const path = (...ids: string[]) => ids.map((id) => ({ id, title: id }));
  const classify = (expected: string | null, chosen: string | null, destination: string[]) =>
    classifyPlacement({ expectedParentOldId: expected, chosenNewParentId: chosen, destinationPath: path(...destination), newToOld });

  it("ticket de raiz que ficou na raiz é same_parent", () => {
    expect(classify(null, null, [])).toBe("same_parent");
  });
  it("pai escolhido que é o ticket novo do pai esperado é same_parent", () => {
    expect(classify("b", "nb", ["na", "nb"])).toBe("same_parent");
    expect(classify("b", "nb", ["nb"])).toBe("same_parent"); // mesmo sem o caminho passar pelo gabarito
  });
  it("caminho que passa pelo ticket novo do pai esperado e continua é deeper", () => {
    expect(classify("a", "nd", ["na", "nb", "nd"])).toBe("deeper");
    expect(classify("b", "nd", ["na", "nb", "nd"])).toBe("deeper");
  });
  it("pai escolhido que no gabarito era irmão sob o pai esperado, mas na árvore nova está fora dele, é elsewhere", () => {
    // esperado b; escolhido c (no gabarito c é filho de a, como b); na árvore nova c ficou na raiz
    expect(classify("b", "nc", ["nc"])).toBe("elsewhere");
    // esperado a; escolhido nd, mas o caminho novo é só [nb, nd]: não passa por na
    expect(classify("a", "nd", ["nb", "nd"])).toBe("elsewhere");
  });
  it("ticket que no gabarito é de raiz nunca é deeper: se não ficou na raiz, é elsewhere", () => {
    expect(classify(null, "nb", ["na", "nb"])).toBe("elsewhere");
    expect(classify(null, "ne", ["ne"])).toBe("elsewhere");
  });
  it("pai mais raso que o esperado ou em outro ramo é elsewhere", () => {
    expect(classify("d", "nb", ["na", "nb"])).toBe("elsewhere");
    expect(classify("b", "na", ["na"])).toBe("elsewhere");
    expect(classify("e", "nb", ["na", "nb"])).toBe("elsewhere");
  });
  it("esperava um pai mas ficou na raiz: elsewhere", () => {
    expect(classify("b", null, [])).toBe("elsewhere");
  });
  it("o caminho passa pelo pai esperado mesmo que o pai escolhido não tenha correspondência: deeper", () => {
    expect(classify("a", "desconhecido", ["na", "desconhecido"])).toBe("deeper");
    expect(classify("a", "desconhecido", ["desconhecido"])).toBe("elsewhere");
  });
  it("pai esperado sem ticket novo correspondente: elsewhere", () => {
    expect(classify("z", "nb", ["na", "nb"])).toBe("elsewhere");
  });
});

// ---- árvore viva, grupos recalculados, rótulos ----------------------------------------------------------------

describe("recomputeGroups", () => {
  const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "a"), t("d", 4, "b")]);
  const pathOf = (...ids: string[]) => ids.map((id) => ({ id, title: `Título ${id.slice(1)}` }));

  it("ignora o group gravado e recalcula pelo caminho do destino e pela correspondência dos registros", () => {
    const records = [
      makeRecord({ oldId: "a", newId: "na", expectedParentOldId: null, chosenParentNewId: null, group: "elsewhere" }),
      // gravado como deeper (regra antiga: c é irmão de b sob a), mas na árvore nova c ficou na raiz: elsewhere
      makeRecord({ oldId: "b", newId: "nb", expectedParentOldId: "a", chosenParentNewId: "na", destinationPath: pathOf("na"), group: "deeper" }),
      makeRecord({ oldId: "c", newId: "nc", expectedParentOldId: "a", chosenParentNewId: null, destinationPath: [], group: "deeper" }),
      // gravado como elsewhere; o caminho passa pelo pai esperado (b) e continua em c... não: passa por nb e termina em nc
      makeRecord({ oldId: "d", newId: "nd", expectedParentOldId: "a", chosenParentNewId: "nb", destinationPath: pathOf("na", "nb"), group: "elsewhere" }),
    ];
    const recomputed = recomputeGroups(records, rebuildView(gabarito, records));
    expect(recomputed.map((r) => [r.oldId, r.group])).toEqual([
      ["a", "same_parent"],
      ["b", "same_parent"],
      ["c", "elsewhere"],
      ["d", "deeper"],
    ]);
  });

  it("não altera os registros de entrada", () => {
    const records = [makeRecord({ oldId: "a", newId: "na", group: "deeper" })];
    recomputeGroups(records, rebuildView(gabarito, records));
    expect(records[0]!.group).toBe("deeper");
  });
});

describe("rebuildView e looView", () => {
  const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a")]);
  it("rebuildView: pais e títulos da árvore reconstruída vêm do que a procura escolheu", () => {
    const records = [
      makeRecord({ oldId: "a", newId: "na", chosenParentNewId: null }),
      makeRecord({ oldId: "b", newId: "nb", chosenParentNewId: "na" }),
    ];
    const view = rebuildView(gabarito, records);
    expect(view.oldToNew.get("b")).toBe("nb");
    expect(view.parentOfNew.get("nb")).toBe("na");
    expect(view.parentOfNew.get("na")).toBeNull();
    expect(view.titleOfNew.get("nb")).toBe("Título b");
  });
  it("looView: a árvore viva tem a forma do gabarito, com os ids novos", () => {
    const view = looView(gabarito, new Map([["a", "na"], ["b", "nb"]]));
    expect(view.parentOfNew.get("nb")).toBe("na");
    expect(view.parentOfNew.get("na")).toBeNull();
    expect(view.titleOfNew.get("na")).toBe("Título a");
  });
});

describe("rótulos dos julgamentos", () => {
  // árvore em que a procura rodou: n1 > n2 > n3 ; n1 > n4 ; n5 raiz
  const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "b"), t("d", 4, "a"), t("e", 5, null)]);
  const oldToNew = new Map([["a", "n1"], ["b", "n2"], ["c", "n3"], ["d", "n4"], ["e", "n5"]]);
  const view = looView(gabarito, oldToNew);
  const judgment = (extra: Partial<JudgmentRecord>): JudgmentRecord => ({
    current: null,
    currentId: null,
    candidateIds: ["n1", "n5"],
    candidateCount: 2,
    belongs: 0.9,
    choice: { "Título a": 0.7, "Título e": 0.3 },
    choiceById: { n1: 0.7, n5: 0.3 },
    ...extra,
  });

  it("expectedChain: o pai esperado e os ancestrais, na árvore da procura", () => {
    expect(expectedChain("c", view)).toMatchObject({ ids: ["n3", "n2", "n1"], expectedIsRoot: false });
    expect(expectedChain(null, view)).toMatchObject({ ids: [], expectedIsRoot: true });
  });

  it("deveria_descer: o pai esperado é um dos candidatos", () => {
    const labeled = labelJudgment(judgment({ candidateIds: ["n1", "n5"] }), expectedChain("a", view));
    expect(labeled.label).toBe("deveria_descer");
  });
  it("deveria_descer: o pai esperado está dentro de um dos candidatos", () => {
    const labeled = labelJudgment(judgment({}), expectedChain("c", view));
    expect(labeled.label).toBe("deveria_descer");
    expect(labeled.topChoiceRight).toBe(true); // o mais votado (n1) contém o esperado
  });
  it("deveria_descer: acerto do Choice é falso quando o mais votado não contém o esperado", () => {
    const labeled = labelJudgment(judgment({ choiceById: { n1: 0.2, n5: 0.8 } }), expectedChain("c", view));
    expect(labeled.topChoiceRight).toBe(false);
  });
  it("deveria_parar: o nó atual é o pai esperado", () => {
    const labeled = labelJudgment(judgment({ current: "Título b", currentId: "n2", candidateIds: ["n3"] }), expectedChain("b", view));
    expect(labeled.label).toBe("deveria_parar");
    expect(labeled.topChoiceRight).toBeNull();
  });
  it("deveria_parar: nó atual é a raiz e o pai esperado é a raiz", () => {
    expect(labelJudgment(judgment({}), expectedChain(null, view)).label).toBe("deveria_parar");
  });
  it("fora_do_caminho: o nó atual não é o pai esperado nem ancestral dele", () => {
    const labeled = labelJudgment(judgment({ current: "Título d", currentId: "n4", candidateIds: [] }), expectedChain("c", view));
    expect(labeled.label).toBe("fora_do_caminho");
  });
  it("fora_do_caminho: ticket de raiz, nó atual não é a raiz", () => {
    const labeled = labelJudgment(judgment({ current: "Título a", currentId: "n1", candidateIds: ["n2", "n4"] }), expectedChain(null, view));
    expect(labeled.label).toBe("fora_do_caminho");
  });
  it("registro antigo sem ids é rotulado por título", () => {
    const old: JudgmentRecord = {
      current: "Título b",
      candidateCount: 1,
      belongs: 0.2,
      choice: { "Título c": 1 },
    };
    const labeled = labelJudgment(old, expectedChain("b", view));
    expect(labeled).toMatchObject({ label: "deveria_parar", byTitle: true });
    const rootOld: JudgmentRecord = { current: null, candidateCount: 2, belongs: 0.9, choice: { "Título a": 0.6, "Título e [n5]": 0.4 } };
    expect(labelJudgment(rootOld, expectedChain("c", view))).toMatchObject({ label: "deveria_descer", byTitle: true, topChoiceRight: true });
  });
  it("labeledJudgments percorre os registros e usa o pai esperado de cada um", () => {
    const records = [
      makeRecord({ oldId: "c", expectedParentOldId: "b", judgments: [judgment({}), judgment({ current: "Título a", currentId: "n1", candidateIds: ["n2", "n4"], choiceById: { n2: 0.6, n4: 0.4 } })] }),
    ];
    const rows = labeledJudgments(records, view);
    expect(rows.map((r) => [r.oldId, r.label])).toEqual([["c", "deveria_descer"], ["c", "deveria_descer"]]);
  });
});

describe("labelStats", () => {
  const row = (label: JudgmentLabel, belongs: number, candidateCount: number, topChoiceRight: boolean | null): LabeledRow => ({
    label,
    byTitle: false,
    topChoiceRight,
    belongs,
    candidateCount,
    oldId: "x",
    title: "x",
    current: null,
  });
  it("conta por rótulo, distribui belongs nas faixas, tira a mediana e separa o acerto do Choice por tamanho da lista", () => {
    const stats = labelStats([
      row("deveria_descer", 0.9, 5, true),
      row("deveria_descer", 0.5, 10, false),
      row("deveria_descer", 0.2, 11, true),
      row("deveria_descer", 0.8, 30, false),
      row("deveria_parar", 0.1, 3, null),
      row("deveria_parar", 0.3, 3, null),
    ]);
    expect(stats.deveria_descer.count).toBe(4);
    expect(stats.deveria_descer.bands).toEqual({ low: 1, mid: 1, high: 2 });
    expect(stats.deveria_descer.medianBelongs).toBeCloseTo(0.65);
    expect(stats.deveria_descer.topChoice).toEqual({ upTo10: { right: 1, total: 2 }, over10: { right: 1, total: 2 } });
    expect(stats.deveria_parar).toMatchObject({ count: 2, bands: { low: 1, mid: 1, high: 0 } });
    expect(stats.deveria_parar.medianBelongs).toBeCloseTo(0.2);
    expect(stats.fora_do_caminho).toMatchObject({ count: 0, bands: { low: 0, mid: 0, high: 0 }, medianBelongs: 0 });
  });
});

describe("resolveCurrentId", () => {
  const seen = [
    { id: "n1", title: "A", summary: "resumo A" },
    { id: "n2", title: "B", summary: "resumo B" },
    { id: "n3", title: "B", summary: "outro resumo" },
  ];
  it("raiz: null", () => {
    expect(resolveCurrentId(null, seen)).toBeNull();
  });
  it("acha o candidato já visto pelo título e pelo resumo (distingue títulos repetidos)", () => {
    expect(resolveCurrentId({ title: "B", summary: "outro resumo" }, seen)).toBe("n3");
    expect(resolveCurrentId({ title: "A", summary: "resumo A" }, seen)).toBe("n1");
  });
  it("sem correspondência: undefined (o relatório cai no título)", () => {
    expect(resolveCurrentId({ title: "Z", summary: "" }, seen)).toBeUndefined();
  });
});

// ---- leave-one-out --------------------------------------------------------------------------------------------

describe("leave-one-out: ordem, seleção e retomada", () => {
  const tickets = computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "a"), t("f", 4, null), t("d", 5, "b"), t("e", 6, null)]);
  it("só os tickets sem filhos, na ordem do número original", () => {
    expect(looTickets(legacy(tickets)).map((x) => x.id)).toEqual(["c", "f", "d", "e"]); // a, b e f... só tickets
  });
  it("--limit vale para a lista inteira e depois pula os já registrados", () => {
    const leaves = looTickets(legacy(tickets));
    expect(pendingLoo(leaves, new Set(["c"]), 2).map((x) => x.id)).toEqual(["f"]);
    expect(pendingLoo(leaves, new Set()).map((x) => x.id)).toEqual(["c", "f", "d", "e"]);
    expect(pendingLoo(leaves, new Set(["c", "f", "d", "e"])).map((x) => x.id)).toEqual([]);
  });
  const mark = (oldId: string, extra: Partial<LooMark> = {}): LooMark => ({ oldId, title: `Título ${oldId}`, ticketId: `n${oldId}`, expectedParentNewId: "na", ...extra });
  it("marca sem resultado é pendente; vale a última marca de cada ticket", () => {
    const pending = pendingMarks([mark("c"), mark("d"), mark("c", { conversationId: "conv-c" })], new Set(["d"]));
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ oldId: "c", conversationId: "conv-c" });
  });
  it("marca com resultado não é pendente", () => {
    expect(pendingMarks([mark("c")], new Set(["c"]))).toEqual([]);
  });
  const live = (id: string, title: string, parentId: string | null): LiveTicket => ({ id, title, parentId, status: "todo" });
  it("retomada: ticket ainda no projeto com o mesmo id", () => {
    expect(looResumeAction(mark("c"), [live("nc", "Título c", "na")])).toEqual({ kind: "present", ticketId: "nc" });
  });
  it("retomada: ticket recriado (mesmo título e pai, outro id)", () => {
    expect(looResumeAction(mark("c"), [live("novo", "Título c", "na")])).toEqual({ kind: "recreated", ticketId: "novo" });
  });
  it("retomada: ticket sumiu (título igual em outro pai não conta)", () => {
    expect(looResumeAction(mark("c"), [live("outro", "Título c", "nb"), live("na", "Título a", null)])).toEqual({ kind: "missing" });
  });
  it("retomada: ticket de raiz recriado na raiz", () => {
    expect(looResumeAction(mark("e", { expectedParentNewId: null }), [live("novo", "Título e", null)])).toEqual({ kind: "recreated", ticketId: "novo" });
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

  it("guarda os dados do Claude da marca de conversa iniciada, para o registro retomado não perdê-los", () => {
    const claude = { draftTitle: "Proposta do Claude", ready: false, message: "Qual é o escopo?" };
    const state = resumeState([], [{ oldId: "f", conversationId: "conv-f", claude }]);
    expect(state.startedMarks.get("f")?.claude).toEqual(claude);
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
    const { items, order } = buildImportTree(legacy(tickets));
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
  it("aceita as opções ocultas de ensaio (--retry-delays-ms, --fake-503-first, --fake-503-judge-at, --role)", () => {
    const parsed = parseCliArgs([
      "rebuild", "--org", "o", "--user", "u", "--project", "p", "--dir", "d",
      "--retry-delays-ms", "1,2,3", "--fake-503-first", "2", "--fake-503-judge-at", "3", "--role", "org:member",
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      options: { retryDelaysMs: [1, 2, 3], fake503First: 2, fake503JudgeAt: 3, role: "org:member" },
    });
  });
  it("limit inválido é erro", () => {
    expect(parseCliArgs(["rebuild", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--limit", "x"]).ok).toBe(false);
  });
});

describe("parseCliArgs: comandos de ticket", () => {
  const base = ["--org", "o", "--user", "u", "--project", "p"];
  it("ticket-list, ticket-create e ticket-update não pedem --dir", () => {
    expect(parseCliArgs(["ticket-list", ...base])).toMatchObject({ ok: true, command: "ticket-list" });
    expect(parseCliArgs(["ticket-list", ...base, "--json"])).toMatchObject({ ok: true, options: { json: true } });
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T"])).toMatchObject({ ok: true, command: "ticket-create", options: { title: "T" } });
    expect(parseCliArgs(["ticket-update", ...base, "--number", "3", "--status", "done"])).toMatchObject({ ok: true, options: { number: 3, status: "done" } });
  });
  it("exigem --org, --user e --project", () => {
    for (const command of ["ticket-list", "ticket-create", "ticket-update"]) {
      const parsed = parseCliArgs([command, "--org", "o", "--title", "T", "--number", "1", "--status", "done"]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(/--user.*--project/);
    }
  });
  it("ticket-create exige --title; ticket-update exige --number e ao menos um campo", () => {
    expect(parseCliArgs(["ticket-create", ...base]).ok).toBe(false);
    expect(parseCliArgs(["ticket-update", ...base, "--status", "done"]).ok).toBe(false);
    const none = parseCliArgs(["ticket-update", ...base, "--number", "1"]);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toMatch(/ao menos um/i);
  });
  it("--parent junto com --root é inválido; números e situações são validados", () => {
    const both = parseCliArgs(["ticket-update", ...base, "--number", "1", "--parent", "2", "--root"]);
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.error).toMatch(/--parent.*--root/);
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--root"])).toMatchObject({ ok: true, options: { root: true } });
    expect(parseCliArgs(["ticket-update", ...base, "--number", "x", "--root"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-update", ...base, "--number", "0", "--root"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--parent", "-1"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--status", "feito"]).ok).toBe(false);
  });
  it("as opções de ticket só existem nos comandos de ticket", () => {
    expect(parseCliArgs(["export", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--title", "T"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-list", ...base, "--title", "T"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--number", "1"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--root"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-list", ...base, "--json"]).ok).toBe(true);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--json"]).ok).toBe(false);
  });
  it("a lista de comandos do erro inclui os de ticket", () => {
    const parsed = parseCliArgs(["nada"]);
    if (!parsed.ok) expect(parsed.error).toMatch(/ticket-list.*ticket-create.*ticket-update/s);
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

  it("registro retomado fica fora das medianas de tempo e não tem caminho escolhido registrado", () => {
    const withResumed = computeStats(gabarito, [
      ...records,
      makeRecord({
        oldId: "e",
        resumed: true,
        group: "elsewhere",
        expectedParentOldId: "b",
        destinationPath: [],
        timingsMs: { open: 0, draft: 0, placement: 0, ticket: 5 },
      }),
    ]);
    expect(withResumed.timing.open).toEqual(stats.timing.open);
    expect(withResumed.timing.ticket.median).toBe(stats.timing.ticket.median);
    expect(withResumed.misplaced.find((m) => m.oldId === "e")?.chosenPath).toBeNull();
    expect(withResumed.resumed).toBe(1);
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

describe("tipo dos nós no gabarito (ADR 0031)", () => {
  const raw = (id: string, parentId: string | null, kind?: "ticket" | "group") => ({ id, parentId, ...(kind ? { kind } : {}) });

  it("gabarito antigo, sem kind: quem tem filhos é group", () => {
    const out = resolveKinds([raw("a", null), raw("b", "a"), raw("c", "a"), raw("d", null)]);
    expect(out.map((x) => [x.id, x.kind])).toEqual([["a", "group"], ["b", "ticket"], ["c", "ticket"], ["d", "ticket"]]);
  });

  it("o kind declarado em gabarito antigo é ignorado: o rótulo vem de ter filhos (ADR 0034)", () => {
    const out = resolveKinds([raw("g", null, "group"), raw("e", null, "group"), raw("t", "g", "ticket")]);
    expect(out.map((x) => x.kind)).toEqual(["group", "ticket", "ticket"]);
  });

  it("ticket declarado com filhos não é mais inválido: vira group", () => {
    expect(resolveKinds([raw("t", null, "ticket"), raw("c", "t", "ticket")]).map((x) => x.kind)).toEqual(["group", "ticket"]);
  });

  const mixed = () =>
    computeDepths([
      t("g1", 1, null, { kind: "group", status: null }),
      t("g2", 2, "g1", { kind: "group", status: null }),
      t("t1", 3, "g2"),
      t("e", 4, null, { kind: "group", status: null }),
      t("t2", 5, null),
      t("t3", 6, "g1"),
    ]);

  it("looTickets mede só nós do tipo ticket, na ordem do número", () => {
    expect(looTickets(mixed()).map((x) => x.id)).toEqual(["t1", "t2", "t3"]);
  });

  it("rebuildOrder: agrupadores primeiro, do mais raso ao mais fundo, e os tickets à parte, em ordem de inserção", () => {
    const order = rebuildOrder(mixed());
    expect(order.groups.map((x) => x.id)).toEqual(["g1", "e", "g2"]);
    expect(order.tickets.map((x) => x.id)).toEqual(["t2", "t3", "t1"]);
    expect(order.groups.every((x) => x.kind === "group")).toBe(true);
    expect(order.tickets.every((x) => x.kind === "ticket")).toBe(true);
  });

  it("pendingGroups pula os agrupadores já criados", () => {
    const { groups } = rebuildOrder(mixed());
    expect(pendingGroups(groups, new Map([["g1", "n1"]])).map((x) => x.id)).toEqual(["e", "g2"]);
  });

  it("buildImportTree não leva kind (a API não o aceita mais) e só dá situação a quem tem uma no gabarito", () => {
    const { items } = buildImportTree(mixed());
    expect(items.map((x) => x.title)).toEqual(["Título g1", "Título e", "Título t2"]);
    for (const item of items) expect(item).not.toHaveProperty("kind");
    expect(items[0]!.status).toBeUndefined();
    expect(items[1]!.children).toBeUndefined();
    expect(items[0]!.children!.map((x) => x.title).length).toBe(2);
  });

  it("compareTrees acusa kind diferente quando os dois lados informam", () => {
    const g = mixed();
    const live = g.map((x) => ({ id: x.id, title: x.title, parentId: x.parentId, status: x.status, kind: x.kind }));
    expect(compareTrees(g, live)).toEqual([]);
    expect(compareTrees(g, live.map((x) => (x.id === "t2" ? { ...x, kind: "group" } : x))).join()).toContain("tipo diferente");
    expect(compareTrees(g, live.map(withoutKind))).toEqual([]);
  });

  it("rebuildView com o mapa dos agrupadores: o pai esperado que é agrupador novo conta como same_parent", () => {
    const g = mixed();
    const groupMap = new Map([["g1", "ng1"], ["g2", "ng2"], ["e", "ne"]]);
    const record = makeRecord({ oldId: "t1", expectedParentOldId: "g2", chosenParentNewId: "ng2", destinationPath: [{ id: "ng1", title: "g1" }, { id: "ng2", title: "g2" }], group: "elsewhere" });
    const view = rebuildView(g, [record], groupMap);
    expect(view.oldToNew.get("g2")).toBe("ng2");
    expect(view.parentOfNew.get("ng2")).toBe("ng1");
    expect(recomputeGroups([record], view)[0]!.group).toBe("same_parent");
  });

  it("o relatório conta tickets pela procura e agrupadores criados sem procura, separados", () => {
    const g = mixed();
    const md = renderReport(g, [makeRecord({ oldId: "t1", expectedParentOldId: "g2" })], "PROJ", { groupsCreated: 3 });
    expect(md).toContain("Tickets no gabarito: 3");
    expect(md).toContain("Agrupadores no gabarito: 3");
    expect(md).toMatch(/Agrupadores criados sem procura: 3/);
    expect(md).toMatch(/Tickets reinseridos pela procura: 1/);
  });
});

describe("renderReport", () => {
  it("mostra 'não registrado' no caminho escolhido de um registro retomado", () => {
    const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a")]);
    const markdown = renderReport(gabarito, [makeRecord({ oldId: "b", resumed: true, group: "elsewhere", expectedParentOldId: "a" })], "PROJ");
    expect(markdown).toContain("não registrado");
  });

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

describe("renderReport: grupos recalculados e rótulos", () => {
  const gabarito = computeDepths([t("a", 1, null), t("b", 2, "a"), t("c", 3, "a")]);
  const records = [
    makeRecord({ oldId: "a", newId: "na", chosenParentNewId: null }),
    // gravado como same_parent, mas o caminho do destino não é o pai esperado: o relatório recalcula
    makeRecord({
      oldId: "b",
      newId: "nb",
      expectedParentOldId: "a",
      chosenParentNewId: null,
      destinationPath: [],
      group: "same_parent",
      judgments: [
        { current: null, currentId: null, candidateIds: ["na"], candidateCount: 1, belongs: 0.2, choice: { "Título a": 1 }, choiceById: { na: 1 } },
      ],
    }),
    makeRecord({
      oldId: "c",
      newId: "nc",
      expectedParentOldId: "a",
      chosenParentNewId: "na",
      destinationPath: [{ id: "na", title: "Título a" }],
      group: "same_parent",
      judgments: [
        { current: null, currentId: null, candidateIds: ["na"], candidateCount: 1, belongs: 0.9, choice: { "Título a": 1 }, choiceById: { na: 1 } },
        { current: "Título a", candidateCount: 1, belongs: 0.1, choice: { "Título b": 1 } }, // registro antigo, sem ids
      ],
    }),
  ];

  it("recalcula o grupo do arquivo de execução em vez de usar o gravado", () => {
    const markdown = renderReport(gabarito, records, "PROJ");
    expect(markdown).toMatch(/\| same_parent \| 2 \|/);
    expect(markdown).toMatch(/\| elsewhere \| 1 \|/);
    expect(markdown).toMatch(/\| Título b \| elsewhere \|/);
  });

  it("traz a seção de rótulos com contagem, faixas, mediana e acerto do Choice por tamanho da lista", () => {
    const markdown = renderReport(gabarito, records, "PROJ");
    expect(markdown).toContain("## Rótulos dos julgamentos");
    expect(markdown).toMatch(/\| deveria_descer \| 2 \|/);
    expect(markdown).toMatch(/\| deveria_parar \| 1 \|/);
    expect(markdown).toContain("até 10 candidatos");
    expect(markdown).toContain("mais de 10 candidatos");
  });

  it("avisa quando algum julgamento foi rotulado por título (execução antiga, sem ids)", () => {
    expect(renderReport(gabarito, records, "PROJ")).toMatch(/sem ids.*título/i);
    const clean = renderReport(gabarito, [records[1] as RunRecord], "PROJ");
    expect(clean).not.toMatch(/sem ids/i);
  });

  it("a tabela de calibração ganha a coluna do rótulo", () => {
    expect(renderReport(gabarito, records, "PROJ")).toMatch(/\| Rótulo \|/);
  });

  it("modo leave-one-out: título próprio e árvore viva", () => {
    const view = looView(gabarito, new Map([["a", "na"], ["b", "nb"], ["c", "nc"]]));
    const markdown = renderReport(gabarito, records, "PROJ", { view, loo: true });
    expect(markdown).toContain("# Relatório do leave-one-out — PROJ");
  });
});

describe("parseCliArgs: leave-one-out e report --loo", () => {
  it("leave-one-out exige org, user, project e dir e aceita --limit", () => {
    expect(parseCliArgs(["leave-one-out", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--limit", "4"])).toMatchObject({
      ok: true,
      command: "leave-one-out",
      options: { limit: 4 },
    });
    expect(parseCliArgs(["leave-one-out", "--org", "o", "--user", "u", "--dir", "d"]).ok).toBe(false);
  });
  it("report aceita --loo (sem valor)", () => {
    expect(parseCliArgs(["report", "--project", "p", "--dir", "d", "--loo"])).toMatchObject({ ok: true, options: { loo: true } });
  });
});

describe("leave-one-out --scope-check: o outro agrupador", () => {
  const g = (id: string, number: number, parentId: string | null) => t(id, number, parentId, { kind: "group" });
  /** Raiz: A(1), B(2), C(3). Dentro de A: A1(4), A2(5). Tickets e um agrupador fundo misturados. */
  const tree = computeDepths([g("A", 1, null), g("B", 2, null), g("C", 3, null), g("A1", 4, "A"), g("A2", 5, "A"), t("x", 6, "A"), g("A1a", 7, "A1")]);

  it("é o agrupador seguinte do mesmo nível, na ordem do número", () => {
    expect(otherScopeGroup(tree, "A")?.id).toBe("B");
    expect(otherScopeGroup(tree, "B")?.id).toBe("C");
    expect(otherScopeGroup(tree, "A1")?.id).toBe("A2");
  });

  it("o último do nível volta ao primeiro", () => {
    expect(otherScopeGroup(tree, "C")?.id).toBe("A");
    expect(otherScopeGroup(tree, "A2")?.id).toBe("A1");
  });

  it("ignora tickets e agrupadores de outros níveis, mesmo com número intermediário", () => {
    const mixed = computeDepths([g("A", 1, null), t("tk", 2, null), g("Z", 3, "A"), g("B", 4, null)]);
    expect(otherScopeGroup(mixed, "A")?.id).toBe("B");
  });

  it("é a ordem do número, não a do vetor", () => {
    const shuffled = [...tree].reverse();
    expect(otherScopeGroup(shuffled, "A")?.id).toBe("B");
    expect(otherScopeGroup(shuffled, "C")?.id).toBe("A");
  });

  it("sem outro agrupador no nível: nulo", () => {
    expect(otherScopeGroup(tree, "A1a")).toBeNull();
    expect(otherScopeGroup(tree, "inexistente")).toBeNull();
  });
});

describe("leave-one-out --scope-check: os números e a seção do relatório", () => {
  const check = (scopeOldId: string, fit: number | null) => ({
    scopeOldId,
    scopeTitle: `Título ${scopeOldId}`,
    fit,
    outOfScope: fit !== null && fit < 0.3,
  });
  const recs = [
    makeRecord({ oldId: "a", scopeChecks: { original: check("P", 0.95), other: check("Q", 0.1) } }),
    makeRecord({ oldId: "b", scopeChecks: { original: check("P", 0.3), other: check("Q", 0.29) } }),
    makeRecord({ oldId: "c", scopeChecks: { original: check("P", 0.7), other: check("Q", 0.71) } }),
    makeRecord({ oldId: "d", scopeChecks: { original: check("P", 0.2), other: null } }),
    makeRecord({ oldId: "e", scopeChecks: { original: check("P", null), other: null } }),
    makeRecord({ oldId: "raiz" }),
  ];

  it("conta, para cada tipo de escopo, os fora do escopo e as três faixas do Noul", () => {
    expect(scopeCheckStats(recs)).toEqual({
      original: { total: 5, outOfScope: 1, bands: { low: 1, mid: 2, high: 1 }, unknown: 1 },
      other: { total: 3, outOfScope: 2, bands: { low: 2, mid: 0, high: 1 }, unknown: 0 },
    });
  });

  it("sem nenhum registro com conferência: tudo zero", () => {
    const zero = { total: 0, outOfScope: 0, bands: { low: 0, mid: 0, high: 0 }, unknown: 0 };
    expect(scopeCheckStats([makeRecord()])).toEqual({ original: zero, other: zero });
  });

  it("o relatório ganha a seção Conferência do escopo só quando há conferência", () => {
    const gabarito = computeDepths([t("a", 1, null)]);
    const without = renderReport(gabarito, [makeRecord({ oldId: "a" })], "PROJ", { loo: true });
    expect(without).not.toContain("Conferência do escopo");
    const markdown = renderReport(gabarito, recs.slice(0, 3), "PROJ", { loo: true });
    expect(markdown).toContain("## Conferência do escopo");
    expect(markdown).toMatch(/\| Agrupador original \| 3 \| 0 \| 0 \| 2 \| 1 \| 0 \|/);
    expect(markdown).toMatch(/\| Outro agrupador \| 3 \| 2 \| 2 \| 0 \| 1 \| 0 \|/);
  });
});

describe("parseCliArgs: --scope-check", () => {
  it("leave-one-out aceita --scope-check (sem valor)", () => {
    expect(parseCliArgs(["leave-one-out", "--org", "o", "--user", "u", "--project", "p", "--dir", "d", "--scope-check"])).toMatchObject({
      ok: true,
      options: { scopeCheck: true },
    });
  });
});
