import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { answerByGabarito, curveMarkdown, doubtCurve, gabaritoAnswer, groupOf, responderSummaryMarkdown, simulate } from "../scripts/placement-rebuild/doubt.js";
import type { FINAL_KINDS, QuestionView } from "../scripts/placement-rebuild/doubt.js";
import { curveOfRound, expectedPathOf } from "../scripts/placement-rebuild/doubt-curve.js";
import type { GabaritoTicket, RunRecord } from "../scripts/placement-rebuild/core.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";

const q = (at: string | null, ids: string[]): QuestionView => ({ level: 1, kind: "fit", at: { id: at, path: at === null ? [] : [{ id: at }] }, options: ids.map((id) => ({ id })) });

describe("respondedor pelo gabarito (ADR 0054, item 9)", () => {
  it("branch com o ramo que contém o lugar esperado; stay se o lugar é o nó; senão none", () => {
    expect(gabaritoAnswer(q(null, ["A", "B"]), ["B", "B1"]).choice).toEqual({ kind: "branch", id: "B" });
    expect(gabaritoAnswer(q("A", ["A1"]), ["A"]).choice).toEqual({ kind: "stay" });
    expect(gabaritoAnswer(q(null, ["A"]), []).choice).toEqual({ kind: "stay" });
    expect(gabaritoAnswer(q("A", ["A1"]), ["B"]).choice).toEqual({ kind: "none" });
    expect(gabaritoAnswer(q(null, ["A"]), ["B"]).expectedInOptions).toBe(false);
  });

  it("responde até não haver pergunta: nova procura com `startId` = a opção; `stay` encerra no nó; sem opção certa, vai ao mapa", async () => {
    const outcome = (question: QuestionView | null, parentId: string | null) => ({ destination: { parentId }, question });
    const seq = async (steps: ReturnType<typeof outcome>[], expected: string[]) => {
      const bodies: unknown[] = [];
      const r = await answerByGabarito(async (body) => (bodies.push(structuredClone(body)), steps[bodies.length - 1] as ReturnType<typeof outcome>), expected);
      return { r, bodies };
    };
    const right = await seq([outcome(q(null, ["A"]), null), outcome(null, "A")], ["A"]);
    expect(right.r.run).toMatchObject({ result: "right_after_question", questions: [{ kind: "fit", expectedInOptions: true, answer: "branch", guessParentId: null }] });
    expect(right.bodies).toEqual([{}, { startId: "A" }]);
    expect(right.r.run.final.parentId).toBe("A");
    const map = await seq([outcome(q(null, ["A"]), null)], ["B"]);
    expect(map.r.run).toMatchObject({ result: "went_to_map", final: { parentId: "B", group: "same_parent" } });
    const stay = await seq([outcome(q("A", ["A1"]), null)], ["A"]);
    expect(stay.r.run).toMatchObject({ result: "right_after_question", questions: [{ answer: "stay" }] });
    expect(stay.r.run.final.parentId).toBe("A");
    expect((await seq([outcome(null, "A")], ["B"])).r.run.result).toBe("wrong_no_question");
    expect((await seq([outcome(null, "A")], ["A"])).r.run.result).toBe("right_no_question");
  });

  it("para em três perguntas e fica no ramo confirmado mais fundo: `parou no teto`", async () => {
    let calls = 0;
    const asked = (at: string) => ({ destination: { parentId: null }, question: { level: 1, kind: "fit" as const, at: { id: at, path: [{ id: at }] }, options: [{ id: "X" + (calls += 1) }] } });
    const steps = [asked("R"), asked("A"), asked("B"), asked("C")];
    const bodies: unknown[] = [];
    const { run } = await answerByGabarito(async (body) => (bodies.push(body), steps[bodies.length - 1] as ReturnType<typeof asked>), ["X1", "X2", "X3", "X4", "Z"]);
    expect(run).toMatchObject({ result: "stopped_at_limit" });
    expect(run.questions).toHaveLength(3);
    expect(bodies).toEqual([{}, { startId: "X1" }, { startId: "X2" }, { startId: "X3" }]);
    expect(run.final.parentId).toBe("X3");
  });
});

describe("curva da dúvida sobre julgamentos gravados", () => {
  const judgment = (currentId: string | null, belongs: number, choiceById: Record<string, number>) => ({ current: null, currentId, candidateIds: Object.keys(choiceById), choiceById, candidateCount: Object.keys(choiceById).length, belongs, choice: {} });
  it("o mesmo julgamento muda de tipo com a faixa; o respondedor leva ao ramo certo", () => {
    const record = { group: "same_parent" as const, destinationPath: [{ id: "A" }], judgments: [judgment(null, 0.5, { A: 0.9, B: 0.1 }), judgment("A", 0.1, { C: 1 })] };
    expect(simulate(record, ["A"], { low: 0.2, high: 0.8, choice: 0.5 })).toMatchObject({ result: "right_after_question", questions: [{ kind: "fit", expectedInOptions: true }] });
    expect(simulate(record, ["A"], { low: 0.6, high: 0.8, choice: 0.5 }).result).toBe("right_no_question");
    const wrong = { ...record, group: "elsewhere" as const };
    expect(simulate(wrong, ["B"], { low: 0.6, high: 0.8, choice: 0.5 }).result).toBe("wrong_no_question");
  });
  it("a linha de comando conhece doubt-curve, que só pede --dir", () => {
    expect(parseCliArgs(["doubt-curve", "--dir", "/x"])).toMatchObject({ ok: true, command: "doubt-curve" });
    expect(parseCliArgs(["doubt-curve"]).ok).toBe(false);
  });

  const root = join(homedir(), ".local/share/treepm-ops/medicao-0052");
  const real = existsSync(join(root, "fatia2")) && existsSync(join(root, "depois"));
  it.skipIf(!real)("rodadas gravadas (80 colocações): 0,2–0,8 com escolha 0,5 dá 48 com pergunta e 9 errados calados; sem a raiz, 0,3–0,7 com escolha 0 dá 20 e 17", () => {
    const rounds = ["fatia2", "depois"].map((name) => {
      const dir = join(root, name);
      const loo = readdirSync(dir).find((n) => /^loo-(?!map-|state-)[0-9a-f-]{36}\.jsonl$/.test(n)) as string;
      const records = readFileSync(join(dir, loo), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
      const tickets = (JSON.parse(readFileSync(join(dir, "gabarito.json"), "utf8")) as { tickets: GabaritoTicket[] }).tickets;
      const map = new Map(Object.entries(JSON.parse(readFileSync(join(dir, loo.replace("loo-", "loo-map-").replace(".jsonl", ".json")), "utf8")) as Record<string, string>));
      return records.map((record) => ({ record, expectedPath: expectedPathOf(record, tickets, map) }));
    });
    const rows = doubtCurve(rounds.flat());
    const at = (low: number, choice: number) => rows.find((r) => r.low === low && r.choice === choice) as (typeof rows)[number];
    expect(at(0.2, 0.5)).toMatchObject({ total: 80, withQuestion: 48, wrongSilent: 9 });
    expect(at(0.3, 0).withoutRoot).toEqual({ withQuestion: 20, wrongSilent: 17 });
  });
});


describe("Revisão 1 — respondedor, rótulos e primeira procura", () => {
  it("gabaritoAnswer: qualquer descendente no caminho; `stay` conta como resposta certa disponível; as duas contas à parte", () => {
    // O lugar esperado é B1a; a opção B1 está dois níveis abaixo do nó da pergunta (a raiz) e vale.
    expect(gabaritoAnswer(q(null, ["X", "B1a"]), ["B", "B1", "B1a"])).toEqual({ choice: { kind: "branch", id: "B1a" }, expectedInBranch: true, expectedInOptions: true });
    expect(gabaritoAnswer(q("B", ["B1"]), ["B", "B1"]).choice).toEqual({ kind: "branch", id: "B1" });
    // O próprio nó da pergunta no caminho não é descendente dele: não vira ramo.
    expect(gabaritoAnswer(q("B", ["B"]), ["B"])).toEqual({ choice: { kind: "stay" }, expectedInBranch: false, expectedInOptions: true });
    expect(gabaritoAnswer(q("B", ["B1"]), ["C"])).toEqual({ choice: { kind: "none" }, expectedInBranch: false, expectedInOptions: false });
  });

  it("groupOf compara na conta do classifyPlacement: mesmo pai, mais fundo, outro lugar", () => {
    expect(groupOf(["A"], ["A"])).toBe("same_parent");
    expect(groupOf([], [])).toBe("same_parent");
    expect(groupOf(["A", "A1"], ["A"])).toBe("deeper");
    expect(groupOf(["B"], ["A"])).toBe("elsewhere");
    expect(groupOf(["A"], [])).toBe("elsewhere");
  });

  it("os rótulos do resultado final: sem pergunta (certo, mais fundo, errado), depois de pergunta (certo, mais fundo, errado), teto, mapa", async () => {
    const out = (parentId: string | null, path: string[], extra = {}) => ({ destination: { parentId, path: path.map((id) => ({ id })) }, uncertain: false, question: null as QuestionView | null, ...extra });
    const run = async (steps: ReturnType<typeof out>[], expected: string[]) => (await answerByGabarito(async () => steps.shift() as ReturnType<typeof out>, expected)).run;
    expect((await run([out("A", ["A"])], ["A"])).result).toBe("right_no_question");
    expect((await run([out("A1", ["A", "A1"])], ["A"])).result).toBe("deeper_no_question");
    expect((await run([out("B", ["B"])], ["A"])).result).toBe("wrong_no_question");
    const asked = out("B", ["B"], { question: q(null, ["A"]) });
    expect((await run([asked, out("A", ["A"])], ["A"])).result).toBe("right_after_question");
    expect((await run([asked, out("A1", ["A", "A1"])], ["A"])).result).toBe("deeper_after_question");
    expect((await run([asked, out("C", ["C"])], ["A"])).result).toBe("wrong_after_question");
    expect((await run([asked], ["B"])).result).toBe("went_to_map");
  });

  it("guarda a primeira procura à parte do resultado final", async () => {
    const out = (parentId: string | null, path: string[], extra = {}) => ({ destination: { parentId, path: path.map((id) => ({ id })) }, uncertain: true, question: null as QuestionView | null, ...extra });
    const steps = [out("B", ["B"], { question: q(null, ["A"]) }), out("A", ["A"], { uncertain: false })];
    const { run } = await answerByGabarito(async () => steps.shift() as ReturnType<typeof out>, ["A"]);
    expect(run.first).toEqual({ parentId: "B", group: "elsewhere", uncertain: true });
    expect(run.final).toEqual({ parentId: "A", group: "same_parent" });
  });

  it("o resumo do respondedor lista os rótulos e soma o total", () => {
    const run = (result: (typeof FINAL_KINDS)[number]) => ({ doubt: { questions: [], result, first: { parentId: null, group: "same_parent" as const, uncertain: false }, final: { parentId: null, group: "same_parent" as const } } });
    const text = responderSummaryMarkdown([run("right_no_question"), run("right_no_question"), run("wrong_no_question"), run("stopped_at_limit"), run("went_to_map")]);
    expect(text).toContain("5 colocações");
    expect(text).toContain("certo sem pergunta 2");
    expect(text).toContain("errado sem pergunta 1");
    expect(text).toContain("parou no teto 1");
    expect(text).toContain("foi ao mapa 1");
  });
});

describe("curva sobre uma rodada pequena inventada (roda em qualquer máquina)", () => {
  const judgment = (currentId: string | null, belongs: number, choiceById: Record<string, number>) => ({ current: null, currentId, candidateIds: Object.keys(choiceById), choiceById, candidateCount: Object.keys(choiceById).length, belongs, choice: {} });
  // Gabarito: R (raiz) → A → A1; R → B. Quatro tickets medidos.
  const tickets = [
    { id: "a", parentId: null }, { id: "a1", parentId: "a" }, { id: "b", parentId: null },
  ] as unknown as GabaritoTicket[];
  const map = new Map([["a", "A"], ["a1", "A1"], ["b", "B"]]);
  const rec = (expectedParentOldId: string | null, group: "same_parent" | "deeper" | "elsewhere", path: string[], judgments: ReturnType<typeof judgment>[]) =>
    ({ expectedParentOldId, group, destinationPath: path.map((id) => ({ id })), judgments, resumed: false }) as unknown as RunRecord;
  const round: RunRecord[] = [
    rec("a", "same_parent", ["A"], [judgment(null, 0.95, { A: 0.9, B: 0.1 }), judgment("A", 0.1, { A1: 1 })]), // confiante e certo
    rec("a", "elsewhere", ["B"], [judgment(null, 0.95, { B: 0.9, A: 0.1 })]), // errado calado
    rec("a", "same_parent", ["A"], [judgment(null, 0.5, { A: 0.6, B: 0.4 }), judgment("A", 0.1, { A1: 1 })]), // na faixa do meio: pergunta
    rec(null, "elsewhere", ["A"], [judgment(null, 0.5, { A: 0.9, B: 0.1 })]), // o lugar é a raiz: stay
  ];

  it("cada linha soma o total e usa os rótulos; a primeira procura decide o grupo", () => {
    const rows = doubtCurve(round.map((record) => ({ record, expectedPath: expectedPathOf(record, tickets, map) })));
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const sum = Object.values(row.final).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.total);
      expect(row.total).toBe(4);
    }
    const mid = rows.find((r) => r.low === 0.2 && r.choice === 0.5) as (typeof rows)[number];
    expect(mid.withQuestion).toBe(2);
    expect(mid.final).toMatchObject({ right_no_question: 1, wrong_no_question: 1, right_after_question: 2 });
    expect(mid.expectedInBranch).toBe(1);
    expect(mid.expectedInOptions).toBe(2); // o ramo certo de um e o "fica aqui" certo do outro
  });

  it("curveOfRound e a tabela em markdown: rótulos novos, sem a palavra antiga", () => {
    const text = curveOfRound(round, tickets, map);
    for (const label of ["certo sem pergunta", "mais fundo sem pergunta", "errado sem pergunta", "certo depois de pergunta", "errado depois de pergunta", "sem julgamento gravado depois da resposta", "parou no teto", "foi ao mapa", "lugar certo entre os ramos", "resposta certa disponível"]) expect(text).toContain(label);
    expect(text).not.toContain("errado calado |");
    expect(text.split("\n").filter((l) => l.startsWith("| 0,")).length).toBe(10);
    expect(curveMarkdown(doubtCurve([]))).toContain("Curva da dúvida");
  });
});
