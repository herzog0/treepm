import { describe, expect, it } from "vitest";
import { AssistantUnavailableError } from "../src/assistant/ports.js";
import type { BranchCandidate, BranchJudge, BranchJudgment } from "../src/assistant/ports.js";
import { searchPlacement } from "../src/assistant/placement-search.js";
import type { PlacementDeps } from "../src/assistant/placement-search.js";

const draft = { title: "Corrigir login", description: "O botão não responde" };
const cand = (id: string): BranchCandidate => ({ id, title: `Ramo ${id}`, summary: `Resumo ${id}`, hasChildren: true });

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

describe("searchPlacement — folha como candidata (ADR 0030)", () => {
  it("o juiz escolhe uma folha: o destino é ela, com o caminho, e o juiz é chamado uma vez só nesse ramo", async () => {
    const { deps, calls } = setup(
      { root: ["A", "B"], A: ["F"], F: [] },
      {
        root: { belongs: 0.95, choice: { A: 0.9, B: 0.1 } },
        A: { belongs: 0.95, choice: { F: 1 } },
      },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination.parentId).toBe("F");
    expect(ids(out.destination)).toEqual(["A", "F"]);
    expect(calls.map((c) => c.current)).toEqual(["root", "A"]);
    expect(out.stoppedEarly).toBeNull();
  });
});

describe("searchPlacement — escopo pela seleção (ADR 0031)", () => {
  type Verdict = { belongs: number; choice: Record<string, number>; scopeFit?: number };
  const scopeNode = (hasChildren = true): BranchCandidate => ({ id: "S", title: "Ramo S", summary: "Resumo S", hasChildren });
  const ancestors = [{ id: "P", title: "Pai" }];

  /** Juiz roteirizado pelo ramo atual; no primeiro nível do escopo `current` é nulo e vale `scope`. */
  function scoped(tree: Record<string, string[]>, verdicts: Record<string, Verdict>, extra: Partial<PlacementDeps> = {}) {
    const calls: { at: string; candidates: string[]; scope: string | null; current: string | null }[] = [];
    const judge: BranchJudge = {
      async judge(input) {
        const at = input.scope ? input.scope.id : input.current ? input.current.title.replace("Ramo ", "") : "root";
        calls.push({ at, candidates: input.candidates.map((c) => c.id), scope: input.scope?.id ?? null, current: input.current?.title ?? null });
        const verdict = verdicts[at];
        if (!verdict) throw new Error(`sem veredito roteirizado para ${at}`);
        return verdict as BranchJudgment;
      },
    };
    const deps: PlacementDeps = {
      judge,
      candidates: async (parentId) => (tree[parentId ?? "root"] ?? []).map(cand),
      fits: () => true,
      scope: { node: scopeNode(), ancestors },
      ...extra,
    };
    return { deps, calls };
  }

  it("a descida começa no escopo: os candidatos do primeiro nível são os filhos dele, e a raiz nem é consultada", async () => {
    const { deps, calls } = scoped({ S: ["A", "B"], root: ["X"] }, { S: { belongs: 0.1, choice: { A: 0.5, B: 0.5 }, scopeFit: 0.9 } });
    await searchPlacement(draft, deps);
    expect(calls).toEqual([{ at: "S", candidates: ["A", "B"], scope: "S", current: null }]);
  });

  it("o caminho vem desde a raiz: ancestrais, escopo e o que a descida acrescenta", async () => {
    const { deps } = scoped(
      { S: ["A", "B"], A: ["C"] },
      { S: { belongs: 0.95, choice: { A: 0.9, B: 0.1 }, scopeFit: 0.9 }, A: { belongs: 0.95, choice: { C: 1 } } },
    );
    const out = await searchPlacement(draft, deps);
    expect(out.destination).toEqual({
      parentId: "C",
      path: [{ id: "P", title: "Pai" }, { id: "S", title: "Ramo S" }, { id: "A", title: "Ramo A" }, { id: "C", title: "Ramo C" }],
    });
    expect(out.alternatives.map((t) => ids(t))).toEqual([["P", "S", "B"]]);
  });

  it("depois do primeiro nível o juiz volta a receber current e não recebe mais scope", async () => {
    const { deps, calls } = scoped(
      { S: ["A"], A: ["C"] },
      { S: { belongs: 0.95, choice: { A: 1 }, scopeFit: 0.9 }, A: { belongs: 0.95, choice: { C: 1 } } },
    );
    await searchPlacement(draft, deps);
    expect(calls.map((c) => [c.scope, c.current])).toEqual([["S", null], [null, "Ramo A"]]);
  });

  it("nada serve dentro do escopo: o destino é o próprio escopo, com o caminho dos ancestrais", async () => {
    const { deps } = scoped({ S: ["A", "B"] }, { S: { belongs: 0.1, choice: { A: 0.5, B: 0.5 }, scopeFit: 0.9 } });
    const out = await searchPlacement(draft, deps);
    expect(out.destination).toEqual({ parentId: "S", path: [{ id: "P", title: "Pai" }, { id: "S", title: "Ramo S" }] });
    expect(out.discarded.map((d) => [d.level, d.parentId, d.ticketId])).toEqual([[1, "S", "A"], [1, "S", "B"]]);
  });

  it("não sobe: nenhum destino nem alternativa fica fora do escopo, mesmo na faixa do meio", async () => {
    const { deps } = scoped({ S: ["A", "B"], A: [] }, { S: { belongs: 0.5, choice: { A: 0.9, B: 0.1 }, scopeFit: 0.9 } });
    const out = await searchPlacement(draft, deps);
    for (const target of [out.destination, ...out.alternatives]) {
      expect(ids(target).slice(0, 2)).toEqual(["P", "S"]);
      expect(target.parentId).not.toBeNull();
    }
    expect([out.destination, ...out.alternatives].map((t) => t.parentId).sort()).toEqual(["A", "S"]);
  });

  it("escopo sem agrupadores filhos: o juiz é chamado só com a pergunta do escopo e o destino é o escopo", async () => {
    const { deps, calls } = scoped({ S: [] }, { S: { belongs: 0, choice: {}, scopeFit: 0.8 } }, { scope: { node: scopeNode(false), ancestors } });
    const out = await searchPlacement(draft, deps);
    expect(calls).toEqual([{ at: "S", candidates: [], scope: "S", current: null }]);
    expect(out.destination).toEqual({ parentId: "S", path: [{ id: "P", title: "Pai" }, { id: "S", title: "Ramo S" }] });
    expect(out.alternatives).toEqual([]);
    expect(out.scope).toEqual({ id: "S", title: "Ramo S", outOfScope: false, fit: 0.8 });
  });

  it("escopo na raiz do projeto (sem ancestrais): o caminho começa no escopo", async () => {
    const { deps } = scoped({ S: [] }, { S: { belongs: 0, choice: {}, scopeFit: 0.8 } }, { scope: { node: scopeNode(false), ancestors: [] } });
    expect((await searchPlacement(draft, deps)).destination.path).toEqual([{ id: "S", title: "Ramo S" }]);
  });

  it.each([
    [0.29, true],
    [0.3, false],
    [0.31, false],
    [0.95, false],
    [0, true],
  ])("Noul do escopo %s: fora do escopo = %s (abaixo de 0,3)", async (scopeFit, outOfScope) => {
    const { deps } = scoped({ S: ["A"] }, { S: { belongs: 0.95, choice: { A: 1 }, scopeFit } });
    const out = await searchPlacement(draft, deps);
    expect(out.scope).toEqual({ id: "S", title: "Ramo S", outOfScope, fit: scopeFit });
  });

  it("a procura não sobe sozinha quando está fora do escopo: o destino continua dentro dele", async () => {
    const { deps } = scoped({ S: ["A"], root: ["X"] }, { S: { belongs: 0.1, choice: { A: 1 }, scopeFit: 0.05 } });
    const out = await searchPlacement(draft, deps);
    expect(out.scope?.outOfScope).toBe(true);
    expect(out.destination.parentId).toBe("S");
  });

  it("sem escopo o resultado traz scope nulo", async () => {
    const { deps } = setup({ root: ["A"] }, { root: { belongs: 0.1, choice: { A: 1 } } });
    expect((await searchPlacement(draft, deps)).scope).toBeNull();
  });

  it("a requisição do escopo não cabe no limite: para no escopo, diz, e o aviso de fora do escopo não é dado", async () => {
    const { deps, calls } = scoped({ S: ["A"] }, {}, { fits: () => false });
    const out = await searchPlacement(draft, deps);
    expect(calls).toEqual([]);
    expect(out.destination.parentId).toBe("S");
    expect(out.stoppedEarly).toEqual({ reason: "candidates_too_large", level: 1, parentId: "S" });
    expect(out.scope).toEqual({ id: "S", title: "Ramo S", outOfScope: false, fit: null });
  });

  it("escopo sem filhos e requisição grande demais: para no escopo e diz", async () => {
    const { deps } = scoped({ S: [] }, {}, { fits: () => false, scope: { node: scopeNode(false), ancestors } });
    const out = await searchPlacement(draft, deps);
    expect(out.stoppedEarly).toEqual({ reason: "candidates_too_large", level: 1, parentId: "S" });
  });
});
