import { describe, expect, it } from "vitest";
import {
  DUPLICATE_REQUEST_MIN,
  RELATED_DESTINATIONS,
  RELATED_MAX,
  RELATED_SUBJECT_MIN,
  pickRelated,
  resolvePlacement,
} from "../src/assistant/related-placement.js";
import type { PlaceNode, ResolveInput } from "../src/assistant/related-placement.js";
import type { PlacementOutcome, PlacementTarget } from "../src/assistant/placement-search.js";

/**
 *   A ─ A1 ─ A1a ─ A1a1
 *         └ A1b
 *     └ A2
 *   B ─ B1 ─ B1a
 *   C
 */
const nodes: PlaceNode[] = [
  { id: "A", parentId: null, title: "A" },
  { id: "A1", parentId: "A", title: "A1" },
  { id: "A1a", parentId: "A1", title: "A1a" },
  { id: "A1a1", parentId: "A1a", title: "A1a1" },
  { id: "A1b", parentId: "A1", title: "A1b" },
  { id: "A2", parentId: "A", title: "A2" },
  { id: "B", parentId: null, title: "B" },
  { id: "B1", parentId: "B", title: "B1" },
  { id: "B1a", parentId: "B1", title: "B1a" },
  { id: "C", parentId: null, title: "C" },
];
const byId = new Map(nodes.map((n) => [n.id, n]));
const pathTo = (id: string | null) => {
  const out: { id: string; title: string }[] = [];
  for (let at = id === null ? undefined : byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) out.unshift({ id: at.id, title: at.title });
  return out;
};
const target = (id: string | null): PlacementTarget => ({ parentId: id, path: pathTo(id) });
const outcome = (destination: string | null, alternatives: string[] = [], uncertain = false): PlacementOutcome => ({
  destination: target(destination),
  alternatives: alternatives.map(target),
  discarded: [],
  uncertain,
  stoppedEarly: null,
  scope: null,
  trace: { steps: [], chosen: pathTo(destination).map((p) => p.id), alternatives: alternatives.map((a) => pathTo(a).map((p) => p.id)), stop: "below_low", scope: null },
});
const rel = (id: string, sameSubject = 0.9, sameRequest = 0.1) => ({ id, sameSubject, sameRequest });
const run = (over: Partial<ResolveInput> & { destination: string | null; alternatives?: string[]; uncertain?: boolean }) => {
  const { destination, alternatives, uncertain, ...rest } = over;
  const asked: string[][] = [];
  const input: ResolveInput = {
    outcome: outcome(destination, alternatives, uncertain),
    related: [],
    duplicateId: null,
    byId,
    scopeId: null,
    choose: async (options) => {
      asked.push([...options]);
      return Object.fromEntries(options.map((id, i) => [id, i === 0 ? 0.6 : 0.4]));
    },
    ...rest,
  };
  return resolvePlacement(input).then((result) => ({ ...result, asked }));
};
const dest = (r: { outcome: PlacementOutcome }) => r.outcome.destination.parentId;

describe("pickRelated: limiares e limites", () => {
  it("as constantes são as do brief", () => {
    expect([RELATED_SUBJECT_MIN, RELATED_MAX, DUPLICATE_REQUEST_MIN, RELATED_DESTINATIONS]).toEqual([0.7, 8, 0.85, 3]);
  });
  it("relacionado é (a) >= 0,7, em ordem de probabilidade; 0,7 entra e 0,699 não", () => {
    const { related } = pickRelated([rel("a", 0.699), rel("b", 0.7), rel("c", 0.95), rel("d", 0.2)]);
    expect(related.map((r) => r.id)).toEqual(["c", "b"]);
  });
  it("no máximo 8", () => {
    const many = Array.from({ length: 12 }, (_, i) => rel(`t${i}`, 0.99 - i * 0.01));
    const { related } = pickRelated(many);
    expect(related).toHaveLength(8);
    expect(related[0]?.id).toBe("t0");
  });
  it("duplicado é o relacionado de maior (b), se (b) >= 0,85; 0,85 entra e 0,849 não", () => {
    expect(pickRelated([rel("a", 0.9, 0.849), rel("b", 0.8, 0.5)]).duplicate).toBeNull();
    expect(pickRelated([rel("a", 0.9, 0.85), rel("b", 0.8, 0.5)]).duplicate?.id).toBe("a");
    expect(pickRelated([rel("a", 0.9, 0.86), rel("b", 0.8, 0.99)]).duplicate?.id).toBe("b");
  });
  it("(b) alto gera o duplicado mesmo com (a) abaixo de 0,7 (revisão 1, ponto 5)", () => {
    const picked = pickRelated([rel("a", 0.5, 0.99)]);
    expect(picked.related).toEqual([]);
    expect(picked.duplicate?.id).toBe("a");
  });
  it("vazio dá vazio", () => {
    expect(pickRelated([])).toEqual({ related: [], duplicate: null });
  });
});

describe("resolvePlacement: a regra do lugar", () => {
  it("sem relacionado: o resultado é exatamente o da descida", async () => {
    const original = outcome("B1", ["C"], true);
    const r = await run({ destination: "B1", alternatives: ["C"], uncertain: true });
    expect(r.outcome).toEqual(original);
    expect(r.rule).toBe("descent");
    expect(r.asked).toEqual([]);
  });

  it("o destino da descida é o pai de um relacionado: fica o da descida", async () => {
    const r = await run({ destination: "A1", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1");
    expect(r.rule).toBe("related_within");
    expect(r.asked).toEqual([]);
  });

  it("o destino da descida está dentro do relacionado: fica o da descida", async () => {
    const r = await run({ destination: "A1a1", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1a1");
    expect(r.rule).toBe("related_within");
  });

  it("o destino da descida É o relacionado: fica o da descida", async () => {
    const r = await run({ destination: "A1a", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1a");
    expect(r.rule).toBe("related_within");
  });

  it("a descida ficou na raiz: vence o pai do relacionado", async () => {
    const r = await run({ destination: null, related: [rel("A1a")], uncertain: true });
    expect(dest(r)).toBe("A1");
    expect(r.outcome.destination.path.map((p) => p.id)).toEqual(["A", "A1"]);
    expect(r.rule).toBe("related_ancestor");
    expect(r.outcome.uncertain).toBe(true); // a incerteza que a descida já tinha não se apaga
    expect(r.outcome.trace.chosen).toEqual(["A", "A1"]);
    expect((await run({ destination: null, related: [rel("A1a")] })).outcome.uncertain).toBe(false);
    expect(r.asked).toEqual([]);
  });

  it("a descida parou acima (ancestral do pai do relacionado): vence o pai do relacionado", async () => {
    const r = await run({ destination: "A", related: [rel("A1a1")] });
    expect(dest(r)).toBe("A1a");
    expect(r.rule).toBe("related_ancestor");
  });

  it("vários relacionados sob o destino da descida: vence o pai do mais provável deles", async () => {
    const r = await run({ destination: "A", related: [rel("A2", 0.95), rel("A1a", 0.9)] });
    expect(dest(r)).toBe("A"); // o pai de A2 é o próprio A: a descida já estava lá
    expect(r.rule).toBe("related_within");
    const r2 = await run({ destination: null, related: [rel("A1a", 0.95), rel("B1a", 0.9)] });
    expect(dest(r2)).toBe("A1");
    expect(r2.rule).toBe("related_ancestor");
  });

  it("a descida foi para outro ramo: pergunta de escolha ao Jev entre o destino dela e o pai do relacionado", async () => {
    const r = await run({ destination: "B1", related: [rel("A1a")], choose: async (options) => ({ [options[0] as string]: 0.3, [options[1] as string]: 0.7 }) });
    expect(dest(r)).toBe("A1");
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual(["B1"]);
    expect(r.outcome.uncertain).toBe(true);
    expect(r.rule).toBe("related_choice");
    expect(r.outcome.trace.chosen).toEqual(["A", "A1"]);
  });

  it("a escolha pode manter o destino da descida; o pai do relacionado vira alternativa", async () => {
    const r = await run({ destination: "B1", related: [rel("A1a")], choose: async (options) => ({ [options[0] as string]: 0.8, [options[1] as string]: 0.2 }) });
    expect(dest(r)).toBe("B1");
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual(["A1"]);
    expect(r.outcome.uncertain).toBe(true);
    expect(r.rule).toBe("related_choice");
  });

  it("a escolha oferece o destino da descida e o pai de até 3 relacionados, sem repetir pai", async () => {
    const r = await run({ destination: "C", related: [rel("A1a", 0.99), rel("A1b", 0.98), rel("B1a", 0.97), rel("A2", 0.96)] });
    expect(r.asked).toEqual([["C", "A1", "B1"]]);
    expect(r.outcome.alternatives.length).toBeLessThanOrEqual(2);
  });

  it("a escolha nunca sobe: o pai do relacionado é ancestral do destino da descida, fica o destino (revisão 1, ponto 4)", async () => {
    const r = await run({ destination: "A1b", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1b");
    expect(r.rule).toBe("related_within");
    expect(r.asked).toEqual([]);
  });

  it("a escolha falhou: fica o destino da descida, incerto, com o pai do relacionado como alternativa", async () => {
    const r = await run({ destination: "B1", related: [rel("A1a")], choose: async () => Promise.reject(new Error("fora do ar")) });
    expect(dest(r)).toBe("B1");
    expect(r.outcome.uncertain).toBe(true);
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual(["A1"]);
    expect(r.rule).toBe("choice_unavailable");
  });

  it("relacionado na raiz não gera destino: nada muda", async () => {
    const r = await run({ destination: "B1", related: [rel("C")] });
    expect(dest(r)).toBe("B1");
    expect(r.rule).toBe("descent");
    expect(r.asked).toEqual([]);
  });
});

describe("resolvePlacement: escopo e duplicado", () => {
  it("relacionado fora do escopo não gera destino", async () => {
    const r = await run({ destination: "A1", scopeId: "A1", related: [rel("B1a")] });
    expect(dest(r)).toBe("A1");
    expect(r.rule).toBe("descent");
    expect(r.asked).toEqual([]);
  });

  it("relacionado dentro do escopo gera destino", async () => {
    const r = await run({ destination: "A1", scopeId: "A1", related: [rel("A1a1")] });
    expect(dest(r)).toBe("A1a");
    expect(r.rule).toBe("related_ancestor");
  });

  it("o pai do relacionado ser o próprio escopo vale; o relacionado ser o escopo, não", async () => {
    expect(dest(await run({ destination: "A1", scopeId: "A1", related: [rel("A1a")] }))).toBe("A1");
    const r = await run({ destination: "A1a", scopeId: "A1a", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1a");
    expect(r.rule).toBe("descent");
  });

  it("a descida parou dentro do duplicado: o destino vira o pai do duplicado", async () => {
    const r = await run({ destination: "A1a1", related: [rel("A1a")], duplicateId: "A1a" });
    expect(dest(r)).toBe("A1");
    expect(r.rule).toBe("related_within");
  });

  it("o próprio duplicado nunca é destino, nem as alternativas dentro dele", async () => {
    const r = await run({ destination: "A1a", alternatives: ["A1a1", "B1"], related: [rel("A1a")], duplicateId: "A1a", uncertain: true });
    expect(dest(r)).toBe("A1");
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual(["B1"]);
  });

  it("duplicado na raiz: a descida dentro dele volta para a raiz do projeto", async () => {
    const r = await run({ destination: "A1", duplicateId: "A", related: [rel("A")] });
    expect(dest(r)).toBeNull();
    expect(r.outcome.destination.path).toEqual([]);
  });

  it("relacionado dentro do duplicado não gera destino", async () => {
    const r = await run({ destination: "B1", related: [rel("A1a", 0.9), rel("A1a1", 0.95)], duplicateId: "A1a" });
    // A1a (pai A1) gera destino; A1a1 (pai A1a, o duplicado) não.
    expect(r.asked).toEqual([["B1", "A1"]]);
  });

  it("sem duplicado e sem relacionado, o duplicado dentro do destino não muda nada", async () => {
    const r = await run({ destination: "B1", related: [], duplicateId: null });
    expect(dest(r)).toBe("B1");
  });
});

describe("resolvePlacement: revisão 1", () => {
  it("o escopo nunca é violado: o duplicado é o próprio escopo, o destino fica dentro dele (ponto 1)", async () => {
    const r = await run({ destination: "A1a", scopeId: "A1", duplicateId: "A1", related: [rel("A1a")] });
    expect(dest(r)).toBe("A1a");
    const inside = await run({ destination: "A1", scopeId: "A1", duplicateId: "A1" });
    expect(dest(inside)).toBe("A1");
  });

  it("quem decide é o relacionado mais provável: o forte em outro ramo vence o fraco que bate com a descida (ponto 2)", async () => {
    const r = await run({ destination: "A1", related: [rel("B1a", 0.95), rel("A1a", 0.71)] });
    expect(r.asked).toEqual([["A1", "B1"]]);
    expect(r.rule).toBe("related_choice");
  });

  it("o relacionado mais provável bate com a descida: os pais dos outros viram alternativas; um forte em outro ramo torna incerto", async () => {
    const strong = await run({ destination: "A1", related: [rel("A1a", 0.95), rel("B1a", 0.9)] });
    expect(dest(strong)).toBe("A1");
    expect(strong.outcome.alternatives.map((a) => a.parentId)).toEqual(["B1"]);
    expect(strong.outcome.uncertain).toBe(true);
    const weak = await run({ destination: "A1", related: [rel("A1a", 0.95), rel("B1a", 0.8)] });
    expect(weak.outcome.alternatives.map((a) => a.parentId)).toEqual(["B1"]);
    expect(weak.outcome.uncertain).toBe(false);
  });

  it("descida na raiz: relacionado abaixo de 0,85 vence, mas incerto, com a raiz como alternativa (ponto 3)", async () => {
    const r = await run({ destination: null, related: [rel("A1a", 0.75)] });
    expect(dest(r)).toBe("A1");
    expect(r.outcome.uncertain).toBe(true);
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual([null]);
  });

  it("descida em nível intermediário: abaixo de 0,85 fica a descida, com o pai do relacionado como alternativa e incerto", async () => {
    const weak = await run({ destination: "A", related: [rel("A1a", 0.75)] });
    expect(dest(weak)).toBe("A");
    expect(weak.outcome.uncertain).toBe(true);
    expect(weak.outcome.alternatives.map((a) => a.parentId)).toEqual(["A1"]);
    expect(weak.rule).toBe("descent");
    const strong = await run({ destination: "A", related: [rel("A1a", 0.9)] });
    expect(dest(strong)).toBe("A1");
    expect(strong.rule).toBe("related_ancestor");
    expect(strong.outcome.alternatives.map((a) => a.parentId)).toEqual(["A"]);
    expect(strong.outcome.uncertain).toBe(false);
    expect((await run({ destination: "A", uncertain: true, related: [rel("A1a", 0.9)] })).outcome.uncertain).toBe(true);
  });

  it("as alternativas originais da descida não se perdem na escolha (até 2 no total)", async () => {
    const r = await run({ destination: "B1", alternatives: ["C"], related: [rel("A1a")], choose: async (o) => ({ [o[0] as string]: 0.8, [o[1] as string]: 0.2 }) });
    expect(r.outcome.alternatives.map((a) => a.parentId)).toEqual(["A1", "C"]);
  });
});
