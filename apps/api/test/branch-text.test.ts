import { describe, expect, it } from "vitest";
import { BRANCH_DESCENDANTS_MAX_CHARS, BRANCH_TEXT_MAX_CHARS, branchTexts } from "../src/assistant/branch-text.js";
import type { BranchNode } from "../src/assistant/branch-text.js";

let counter = 0;
const node = (id: string, parentId: string | null, title: string, extra: Partial<BranchNode> = {}): BranchNode => ({
  id,
  parentId,
  number: ++counter,
  title,
  description: "",
  status: "todo",
  ...extra,
});

describe("branchTexts: regra de montagem (ADR 0052, item 1)", () => {
  it("o texto traz o trecho da descrição, a nota da pessoa e os descendentes nível por nível", () => {
    const tree = [
      node("a", null, "Importar", { description: "Trazer tickets de fora." }),
      node("b", "a", "GitHub"),
      node("c", "a", "Jira"),
      node("d", "b", "Issues"),
    ];
    const text = branchTexts(tree, new Map([["a", "Nota da pessoa."]])).textOf("a");
    expect(text).toBe("Trazer tickets de fora.\nNota: Nota da pessoa.\nContém: GitHub; Jira\nDentro deles: Issues");
  });

  it("sem descrição nem nota o texto são só os descendentes", () => {
    const tree = [node("a", null, "A"), node("b", "a", "B")];
    expect(branchTexts(tree, new Map()).textOf("a")).toBe("Contém: B");
  });

  it("é determinística: a mesma árvore, em qualquer ordem de entrada, dá o mesmo texto", () => {
    const tree = [node("a", null, "A"), node("b", "a", "B"), node("c", "a", "C"), node("d", "c", "D")];
    const first = branchTexts(tree, new Map()).textOf("a");
    expect(branchTexts([...tree].reverse(), new Map()).textOf("a")).toBe(first);
    expect(branchTexts(tree, new Map()).textOf("a")).toBe(first);
  });

  it("filhos diretos entram todos antes de qualquer neto, e o corte é indicado com a contagem do que ficou de fora", () => {
    const many = Array.from({ length: 80 }, (_, i) => node(`k${i}`, "a", `Filho número ${String(i).padStart(3, "0")}`));
    const tree = [node("a", null, "A"), ...many, node("n", "k0", "Neto")];
    const text = branchTexts(tree, new Map()).textOf("a");
    expect(text).not.toContain("Neto");
    expect(text).not.toContain("Dentro deles");
    const shown = (text.match(/Filho número/g) ?? []).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(80);
    // O que ficou de fora: os filhos não mostrados mais o neto.
    expect(text.endsWith(`… e mais ${80 - shown + 1}`)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(BRANCH_DESCENDANTS_MAX_CHARS + "… e mais 99".length + 2);
  });

  it("com folga, os netos entram depois de todos os filhos", () => {
    const tree = [node("a", null, "A"), node("b", "a", "B"), node("c", "a", "C"), node("d", "b", "D"), node("e", "c", "E")];
    expect(branchTexts(tree, new Map()).textOf("a")).toBe("Contém: B; C\nDentro deles: D; E");
  });

  it("os níveis abaixo dos netos vão juntos num bloco só, 'Mais abaixo'", () => {
    const tree = [node("a", null, "A"), node("b", "a", "B"), node("c", "b", "C"), node("d", "c", "D"), node("e", "d", "E"), node("f", "e", "F")];
    expect(branchTexts(tree, new Map()).textOf("a")).toBe("Contém: B\nDentro deles: C\nMais abaixo: D; E; F");
  });

  it("o texto inteiro tem teto: trecho, nota e descendentes juntos, nessa prioridade", () => {
    const kids = Array.from({ length: 40 }, (_, i) => node(`k${i}`, "a", `Filho ${String(i).padStart(2, "0")} com título comprido`));
    const tree = [node("a", null, "A", { description: "d".repeat(2000) }), ...kids];
    const text = branchTexts(tree, new Map([["a", "n".repeat(1000)]])).textOf("a");
    expect(text.length).toBeLessThanOrEqual(BRANCH_TEXT_MAX_CHARS + "… e mais 99".length + 1);
    // O trecho vem inteiro (o corte dele já existe) e a nota é cortada com reticências.
    expect(text).toContain("Nota: nnn");
    expect(text).toContain("…");
    // Sem nota, sobra espaço para filhos.
    const noNote = branchTexts(tree, new Map()).textOf("a");
    expect(noNote).toContain("Contém: Filho 00");
    expect(noNote.length).toBeLessThanOrEqual(BRANCH_TEXT_MAX_CHARS + "… e mais 99".length + 1);
  });

  it("descendantsScale encolhe só a parte dos descendentes; 0 deixa só trecho e nota e a contagem", () => {
    const tree = [node("a", null, "A", { description: "Trecho." }), ...Array.from({ length: 30 }, (_, i) => node(`k${i}`, "a", `Filho ${String(i).padStart(2, "0")} com título comprido`))];
    const texts = branchTexts(tree, new Map([["a", "Nota."]]));
    const full = texts.textOf("a");
    const half = texts.textOf("a", 0.5);
    const none = texts.textOf("a", 0);
    expect(half.length).toBeLessThan(full.length);
    expect(half.startsWith("Trecho.\nNota: Nota.\nContém: ")).toBe(true);
    expect(none).toBe("Trecho.\nNota: Nota.\n… e mais 30");
    expect(texts.textOf("a", 1)).toBe(full);
  });

  it("não entram tickets cancelados nem o que está dentro deles", () => {
    const tree = [
      node("a", null, "A"),
      node("b", "a", "Vivo"),
      node("c", "a", "Cancelado", { status: "cancelled" }),
      node("d", "c", "Dentro do cancelado"),
      node("e", "b", "Neto vivo"),
    ];
    const text = branchTexts(tree, new Map()).textOf("a");
    expect(text).toContain("Vivo");
    expect(text).toContain("Neto vivo");
    expect(text).not.toContain("Cancelado");
    expect(text).not.toContain("Dentro do cancelado");
  });

  it("um ramo cujos filhos são todos cancelados fica só com o trecho da descrição", () => {
    const tree = [node("a", null, "A", { description: "Só isto." }), node("b", "a", "X", { status: "cancelled" })];
    expect(branchTexts(tree, new Map()).textOf("a")).toBe("Só isto.");
  });

  it("a nota de pessoa não vira descendente e uma nota vazia é ignorada", () => {
    const tree = [node("a", null, "A"), node("b", "a", "B")];
    expect(branchTexts(tree, new Map([["a", "  "]])).textOf("a")).toBe("Contém: B");
  });

  it("ticket sem filhos devolve só o trecho da descrição", () => {
    const tree = [node("a", null, "A", { description: "Descrição." })];
    expect(branchTexts(tree, new Map()).textOf("a")).toBe("Descrição.");
  });
});

// Gerador com semente (mulberry32): a mesma semente sempre sorteia a mesma árvore.
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomTree = (seed: number, size: number): BranchNode[] => {
  const next = rng(seed);
  const nodes: BranchNode[] = [];
  for (let i = 0; i < size; i++) {
    const parent = i === 0 || next() < 0.1 ? null : nodes[Math.floor(next() * nodes.length)]!.id;
    nodes.push(node(`n${i}`, parent, `Título único ${i}`, { status: next() < 0.1 ? "cancelled" : "todo" }));
  }
  return nodes;
};
const descendantsOf = (tree: readonly BranchNode[], id: string): Set<string> => {
  const out = new Set<string>();
  const walk = (parent: string) => {
    for (const child of tree.filter((n) => n.parentId === parent)) {
      out.add(child.id);
      walk(child.id);
    }
  };
  walk(id);
  return out;
};

describe("branchTexts: árvores sorteadas", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`semente ${seed}: todo título presente é de um descendente atual e vivo`, () => {
      const tree = randomTree(seed, 120);
      const texts = branchTexts(tree, new Map());
      const dead = new Set(tree.filter((n) => n.status === "cancelled").map((n) => n.id));
      for (const root of tree) {
        const allowed = [...descendantsOf(tree, root.id)].filter((id) => {
          for (let cursor: string | null = id; cursor !== null && cursor !== root.id; cursor = tree.find((n) => n.id === cursor)?.parentId ?? null) {
            if (dead.has(cursor)) return false;
          }
          return true;
        });
        const present = (texts.textOf(root.id).match(/Título único \d+/g) ?? []).map((title) => `n${title.split(" ").pop()}`);
        for (const id of present) expect(allowed, `${root.id} mostra ${id}`).toContain(id);
        expect(new Set(present).size).toBe(present.length);
      }
    });
  }

  it("mover um ticket muda o texto dos dois ramos na procura seguinte, sem nenhuma escrita", () => {
    const tree = [node("x", null, "Ramo X"), node("y", null, "Ramo Y"), node("m", "x", "Ticket movido"), node("o", "x", "Outro"), node("p", "y", "Parado")];
    const before = branchTexts(tree, new Map());
    expect(before.textOf("x")).toContain("Ticket movido");
    expect(before.textOf("y")).not.toContain("Ticket movido");
    const moved = tree.map((t) => (t.id === "m" ? { ...t, parentId: "y" } : t));
    const after = branchTexts(moved, new Map());
    expect(after.textOf("x")).not.toContain("Ticket movido");
    expect(after.textOf("y")).toContain("Ticket movido");
  });
});
