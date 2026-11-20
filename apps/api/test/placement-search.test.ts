import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type { BranchCandidate, BranchJudge, BranchJudgment } from "../src/assistant/ports.js";
import { searchPlacement } from "../src/assistant/placement-search.js";
import type { PlacementDeps } from "../src/assistant/placement-search.js";

const draft = { title: "Corrigir login", description: "O botão não responde" };
const cand = (id: string): BranchCandidate => ({ id, title: `Ramo ${id}`, summary: `Resumo ${id}` });

/** Árvore e juiz roteirizados: a chave é o id do ramo atual ("root" na raiz). */
function setup(
  tree: Record<string, string[]>,
  verdicts: Record<string, { belongs: number; choice: Record<string, number> }>,
  extra: Partial<PlacementDeps> = {},
) {
  const calls: { current: string; candidates: string[] }[] = [];
  const judge: BranchJudge = {
    async judge(input) {
      const current = input.current ? input.current.title.replace("Ramo ", "") : "root";
      calls.push({ current, candidates: input.candidates.map((c) => c.id) });
      const verdict = verdicts[current];
      if (!verdict) throw new Error(`sem veredito roteirizado para ${current}`);
      return verdict as BranchJudgment;
    },
  };
  const deps: PlacementDeps = {
    judge,
    candidates: async (parentId) => (tree[parentId ?? "root"] ?? []).map(cand),
    fits: () => true,
    ...extra,
  };
  return { deps, calls };
}
const ids = (target: { path: { id: string }[] }) => target.path.map((n) => n.id);

describe("searchPlacement — parada e descida", () => {
  it("sem candidatos na raiz: para na raiz sem chamar o juiz", async () => {
    const { deps, calls } = setup({ root: [] }, {});
    const out = await searchPlacement(draft, deps);
    expect(out.destination).toEqual({ parentId: null, path: [] });
    expect(out.alternatives).toEqual([]);
    expect(out.uncertain).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("belongs abaixo de 0,3: para na raiz e descarta todos os candidatos do nível", async () => {
    const { deps } = setup({ root: ["A", "B"] }, { root: { belongs: 0.1, choice: { A: 0.9, B: 0.1 } } });
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBeNull();
    expect(out.discarded.map((d) => [d.level, d.ticketId])).toEqual([[1, "A"], [1, "B"]]);
    expect(out.uncertain).toBe(false);
  });

  it("desce dois níveis e para onde os candidatos acabam", async () => {
    const { deps, calls } = setup(
      { root: ["A", "B"], A: ["C"], C: [] },
      {
        root: { belongs: 0.95, choice: { A: 0.9, B: 0.1 } },
        A: { belongs: 0.9, choice: { C: 1 } },
      },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBe("C");
    expect(ids(out.destination)).toEqual(["A", "C"]);
    expect(calls.map((c) => c.current)).toEqual(["root", "A"]);
    expect(out.uncertain).toBe(false);
    // B ainda cabe nos 3 caminhos: fica como alternativa, não como descartado
    expect(out.alternatives.map((t) => t.parentId)).toEqual(["B"]);
    expect(out.discarded).toEqual([]);
  });

  it("para no ramo atual quando belongs cai abaixo de 0,3 no segundo nível", async () => {
    const { deps } = setup(
      { root: ["A"], A: ["C", "D"] },
      { root: { belongs: 0.9, choice: { A: 1 } }, A: { belongs: 0.05, choice: { C: 0.5, D: 0.5 } } },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBe("A");
  });

  it("faixa do meio (0,3 a 0,7): mantém parar aqui e descer no mais provável, e marca incerto quando não se destacam", async () => {
    const { deps } = setup(
      { root: ["A", "B"], A: [] },
      { root: { belongs: 0.5, choice: { A: 0.9, B: 0.1 } } },
    );
    const out = await searchPlacement(draft, deps);
    const targets = [out.destination, ...out.alternatives].map((t) => t.parentId);
    expect(targets).toContain(null);
    expect(targets).toContain("A");
    expect(out.alternatives).toHaveLength(1);
    // parar na raiz (1,0) contra descer em A (0,9): razão 1,11 < 1,25
    expect(out.uncertain).toBe(true);
  });

  it("faixa do meio: parar e descer do mesmo nó são o par em disputa, sempre incerto, mesmo com a descida pouco provável", async () => {
    const { deps } = setup(
      { root: ["A", "B"], A: [] },
      { root: { belongs: 0.69, choice: { A: 0.79, B: 0.21 } } },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBeNull();
    expect(out.alternatives[0]?.parentId).toBe("A");
    // razão 1/0,79 = 1,27 > 1,25: só a regra do par parar/descer marca incerto
    expect(out.uncertain).toBe(true);
  });

  it("acima de 0,7 não há par parar/descer: um Choice claro não é incerto", async () => {
    const { deps } = setup(
      { root: ["A", "B"], A: [] },
      { root: { belongs: 0.71, choice: { A: 0.79, B: 0.21 } } },
    );
    expect((await searchPlacement(draft, deps)).uncertain).toBe(false);
  });

  it("um caminho mantido num nível e podado no seguinte vira descartado, com o nível em que saiu", async () => {
    const { deps } = setup(
      { root: ["A", "B", "C"], A: ["D", "E"], B: ["F"], C: ["G"] },
      {
        root: { belongs: 0.95, choice: { A: 0.5, B: 0.3, C: 0.2 } },
        A: { belongs: 0.95, choice: { D: 0.6, E: 0.4 } },
        B: { belongs: 0.95, choice: { F: 1 } },
        C: { belongs: 0.95, choice: { G: 1 } },
      },
    );
    const out = await searchPlacement(draft, deps);
    const kept = [out.destination, ...out.alternatives].map((t) => t.parentId);
    // 4 candidatos ao fim do nível 2 (D, E, F, G); só 3 ficam
    expect(kept).toHaveLength(3);
    const dropped = out.discarded.filter((d) => d.level === 2).map((d) => d.ticketId);
    expect(dropped).toHaveLength(1);
    expect(kept).not.toContain(dropped[0]);
  });

  it("empate entre dois ramos acima de 0,7: os dois caminhos ficam e o resultado é incerto", async () => {
    const { deps } = setup(
      { root: ["A", "B"] },
      { root: { belongs: 0.9, choice: { A: 0.5, B: 0.48 } } },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.uncertain).toBe(true);
    expect([out.destination.parentId, out.alternatives[0]?.parentId].sort()).toEqual(["A", "B"]);
  });

  it("ordena por média geométrica: um caminho forte em dois níveis vence um fraco", async () => {
    const { deps } = setup(
      { root: ["A", "B"], A: ["C"], B: ["D"] },
      {
        root: { belongs: 0.9, choice: { A: 0.6, B: 0.4 } },
        A: { belongs: 0.9, choice: { C: 0.9 } },
        B: { belongs: 0.9, choice: { D: 0.99 } },
        C: { belongs: 0, choice: {} },
        D: { belongs: 0, choice: {} },
      },
    );
    const out = await searchPlacement(draft, deps);
    // A→C: sqrt(0,6*0,9)=0,73; B→D: sqrt(0,4*0,99)=0,63
    expect(out.destination.parentId).toBe("C");
    expect(out.alternatives[0]?.parentId).toBe("D");
  });

  it("mantém no máximo 3 caminhos e devolve no máximo 2 alternativas", async () => {
    const { deps, calls } = setup(
      { root: ["A", "B", "C", "D", "E"] },
      { root: { belongs: 0.95, choice: { A: 0.3, B: 0.25, C: 0.2, D: 0.15, E: 0.1 } } },
    );
    const out = await searchPlacement(draft, deps);
    expect(calls).toHaveLength(1);
    expect(out.alternatives).toHaveLength(2);
    expect([out.destination, ...out.alternatives].map((t) => t.parentId)).toEqual(["A", "B", "C"]);
    expect(out.discarded.map((d) => d.ticketId).sort()).toEqual(["D", "E"]);
  });

  it("para no nível 20", async () => {
    const tree: Record<string, string[]> = { root: ["n1"] };
    const verdicts: Record<string, { belongs: number; choice: Record<string, number> }> = {
      root: { belongs: 1, choice: { n1: 1 } },
    };
    for (let i = 1; i <= 25; i++) {
      tree[`n${i}`] = [`n${i + 1}`];
      verdicts[`n${i}`] = { belongs: 1, choice: { [`n${i + 1}`]: 1 } };
    }
    const { deps, calls } = setup(tree, verdicts);
    const out = await searchPlacement(draft, deps);
    expect(calls).toHaveLength(20);
    expect(out.destination.path).toHaveLength(20);
    expect(out.stoppedEarly).toMatchObject({ reason: "max_levels" });
  });
});

describe("searchPlacement — limites", () => {
  it("candidatos demais para o limite de tokens: para no nível, explicita e não corta candidatos", async () => {
    const { deps, calls } = setup(
      { root: ["A"], A: ["C", "D", "E"] },
      { root: { belongs: 0.9, choice: { A: 1 } } },
      { fits: (input) => input.candidates.length < 3 },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBe("A");
    expect(out.stoppedEarly).toEqual({ reason: "candidates_too_large", level: 2, parentId: "A" });
    expect(calls.map((c) => c.current)).toEqual(["root"]);
  });

  it("sem estouro, stoppedEarly é nulo", async () => {
    const { deps } = setup({ root: ["A"] }, { root: { belongs: 0.1, choice: { A: 1 } } });
    expect((await searchPlacement(draft, deps)).stoppedEarly).toBeNull();
  });

  it("tempo máximo: aborta o juiz e responde indisponível", async () => {
    let aborted = false;
    const judge: BranchJudge = {
      judge: (_input, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("abortado"));
          });
        }),
    };
    const deps: PlacementDeps = { judge, candidates: async () => [cand("A")], fits: () => true, timeoutMs: 30 };
    await expect(searchPlacement(draft, deps)).rejects.toMatchObject({ reason: "placement_timeout" });
    await expect(searchPlacement(draft, deps)).rejects.toBeInstanceOf(AssistantUnavailableError);
    expect(aborted).toBe(true);
  });

  it("repassa o ramo atual (título e resumo) ao juiz", async () => {
    let seen: unknown = "nada";
    const { deps } = setup(
      { root: ["A"], A: ["C"] },
      { root: { belongs: 1, choice: { A: 1 } }, A: { belongs: 0, choice: { C: 1 } } },
    );
    const inner = deps.judge;
    deps.judge = {
      judge: async (input, options) => {
        if (input.current) seen = input.current;
        return inner.judge(input, options);
      },
    };
    await searchPlacement(draft, deps);
    expect(seen).toEqual({ title: "Ramo A", summary: "Resumo A" });
  });
});
