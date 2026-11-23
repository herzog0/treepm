import { describe, expect, it } from "vitest";
import { normalizeTitle, sanitizeElaboration } from "../src/assistant/elaboration.js";

// ADR 0052, fatia 3: o servidor nunca confia na saída do modelo.
const ctx = {
  draftTitle: "Sincronizar tickets com o Jira",
  partTitles: ["Receber o diff", "Mostrar o estado da sincronização"],
  related: [{ key: "TREEPM-144", title: "Guardar a origem de cada ticket" }, { key: "TREEPM-139", title: "Importar de GitHub, Jira e Linear" }, { key: "TREEPM-7", title: "Tela de ajustes" }],
  duplicateKey: "TREEPM-7",
  projectKey: "TREEPM",
};
const link = (de: "pai" | number, dependeDe: string, motivo = "porque sim") => ({ de, dependeDe, motivo });
const task = (title: string, motivo = "sem isso não funciona", description = "Detalhe") => ({ title, description, motivo });

describe("ligações", () => {
  it("fica o que cita chave da lista, pai ou parte existente, com motivo", () => {
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-144"), link(1, "TREEPM-139")], suggested: [] }, ctx);
    expect(out.links).toEqual([link("pai", "TREEPM-144"), link(1, "TREEPM-139")]);
  });
  it("descarta chave fora da lista, em qualquer caixa que não seja a da lista", () => {
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-999"), link("pai", "treepm-144"), link("pai", "OUTRO-144")], suggested: [] }, ctx);
    expect(out.links).toEqual([]);
  });
  it("descarta o duplicado, ligações repetidas e parte que não existe", () => {
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-7"), link("pai", "TREEPM-144"), link("pai", "TREEPM-144", "outro motivo"), link(2, "TREEPM-139"), link(-1, "TREEPM-139"), link(0.5, "TREEPM-139")], suggested: [] }, ctx);
    expect(out.links).toEqual([link("pai", "TREEPM-144")]);
  });
  it("a mesma chave pode ligar o pai e uma parte: são ligações diferentes", () => {
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-144"), link(0, "TREEPM-144")], suggested: [] }, ctx);
    expect(out.links).toHaveLength(2);
  });
  it("descarta motivo vazio ou longo demais (o texto do modelo nunca é cortado) e fica com no máximo cinco", () => {
    const many = { ...ctx, partTitles: Array.from({ length: 8 }, (_, i) => `Parte ${i}`) };
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-144", "  "), link("pai", "TREEPM-139", "x".repeat(301)), ...Array.from({ length: 8 }, (_, i) => link(i, "TREEPM-144"))], suggested: [] }, many);
    expect(out.links.map((l) => l.de)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("tarefas sugeridas", () => {
  it("ficam as que não repetem parte, pedido nem relacionado, com o texto aparado", () => {
    const out = sanitizeElaboration({ links: [], suggested: [task("  Guardar o cursor da última sincronização ", " sem cursor não há diff ")] }, ctx);
    expect(out.suggested).toEqual([task("Guardar o cursor da última sincronização", "sem cursor não há diff")]);
  });
  it("descarta a que repete uma parte, o título do pedido ou um relacionado (comparação normalizada)", () => {
    const out = sanitizeElaboration(
      { links: [], suggested: [task("receber o DIFF!"), task("Sincronizar  tickets com o JIRA"), task("Guardar a origem de cada ticket"), task("Importar de Github, Jira e Linear"), task("Mostrar o estado da sincronizaçao"), task("Outra coisa")] },
      ctx,
    );
    expect(out.suggested.map((s) => s.title)).toEqual(["Outra coisa"]);
  });
  it("descarta repetidas entre si, as sem título, sem motivo ou longas demais, e limita a cinco", () => {
    const out = sanitizeElaboration(
      { links: [], suggested: [task("A"), task("a"), task(""), task("B", ""), task("x".repeat(201)), task("C", "x".repeat(301)), task("D", "ok", "x".repeat(2001)), task("E"), task("F"), task("G"), task("H"), task("I")] },
      ctx,
    );
    expect(out.suggested.map((s) => s.title)).toEqual(["A", "E", "F", "G", "H"]);
  });
  it("normalizar tira acento, caixa e pontuação", () => {
    expect(normalizeTitle("  Sincronizaçao — do  JIRA! ")).toBe("sincronizacao do jira");
  });
});

describe("revisão 1: motivo de uma linha, texto proibido, chaves e tamanho", () => {
  it("quebras de linha no motivo viram espaço, nas ligações e nas sugeridas", () => {
    const out = sanitizeElaboration({ links: [link("pai", "TREEPM-144", "linha um\n\n  linha dois")], suggested: [task("Guardar o cursor", "um\r\ndois")] }, ctx);
    expect(out.links[0]!.motivo).toBe("linha um linha dois");
    expect(out.suggested[0]!.motivo).toBe("um dois");
  });
  it("descarta a sugerida que cita ticket fora da lista; a que cita um da lista fica", () => {
    const out = sanitizeElaboration({ links: [], suggested: [task("A tarefa", "usa TREEPM-999"), task("B tarefa", "ok", "Veja TREEPM-3"), task("C tarefa", "depois de TREEPM-144")] }, ctx);
    expect(out.suggested.map((s) => s.title)).toEqual(["C tarefa"]);
  });
  it("descarta a sugerida com o cabeçalho da citação ou que abre bloco de citação, em qualquer campo", () => {
    const out = sanitizeElaboration(
      { links: [], suggested: [task("Pedido original: x"), task("Outra", "ok", "Pedido original:\nfoo"), task("Mais uma", "ok", "texto\n> citado"), task("Ainda", "> começa com bloco"), task("Boa tarefa")] },
      ctx,
    );
    expect(out.suggested.map((s) => s.title)).toEqual(["Boa tarefa"]);
  });
  it("a descrição da sugerida passa até 600 caracteres e não mais", () => {
    const out = sanitizeElaboration({ links: [], suggested: [task("Cabe", "ok", "x".repeat(600)), task("Estoura", "ok", "x".repeat(601))] }, ctx);
    expect(out.suggested.map((s) => s.title)).toEqual(["Cabe"]);
  });
});

describe("contagem do que o descarte tirou (diagnostics)", () => {
  const raw = (links: ReturnType<typeof link>[], suggested: ReturnType<typeof task>[]) => sanitizeElaboration({ links, suggested }, ctx);
  it("uma contagem por regra, só números", () => {
    const out = raw(
      [
        link("pai", "TREEPM-144"),
        link("pai", "TREEPM-144"), // repetida
        link("pai", "TREEPM-999"), // fora da lista
        link("pai", "TREEPM-7"), // o duplicado
        link(9, "TREEPM-139"), // parte inexistente
        { de: "pai", dependeDe: "TREEPM-139", motivo: "   " }, // motivo vazio
      ],
      [task("Tarefa nova", "m"), task("Tarefa nova", "m"), task("   ", "m"), { title: "Com citação", description: "> forjada", motivo: "m" }, task("Cita TREEPM-5000 que não existe", "m")],
    );
    expect(out.dropped.links).toMatchObject({ outsideList: 1, duplicateTarget: 1, invalidPart: 1, badReason: 1, repeated: 1, limit: 0 });
    expect(out.dropped.suggested).toMatchObject({ repeatedTitle: 1, size: 1, forbiddenText: 1, keyInText: 1, limit: 0 });
  });
  it("o que passa do limite é contado como limite", () => {
    const many = (["pai", 0, 1] as const).flatMap((de) => ["TREEPM-144", "TREEPM-139"].map((dependeDe) => ({ de, dependeDe, motivo: "m" })));
    expect(raw(many, []).dropped.links.limit).toBe(1);
    const tasks = Array.from({ length: 8 }, (_, i) => task(`Tarefa ${String.fromCharCode(65 + i)}`, "m"));
    expect(raw([], tasks).dropped.suggested.limit).toBe(3);
  });
});
