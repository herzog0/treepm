import { describe, expect, it } from "vitest";
import { FakeRelated } from "../scripts/placement-rebuild/fakes.js";

// R4: o Jev falso do ensaio responde `sameRequest` por título do candidato.
const input = {
  draft: { title: "Guardar o vínculo externo", description: "" },
  candidates: [
    { id: "a", title: "Reimportar sem duplicar", excerpt: "" },
    { id: "b", title: "Tela de ajustes", excerpt: "" },
  ],
};

describe("FakeRelated por título", () => {
  it("o título do mapa responde o valor pedido; os outros caem na regra de palavras", async () => {
    const out = await new FakeRelated({ "Reimportar sem duplicar": 0.8 }).judge(input);
    expect(out["a"]?.sameRequest).toBe(0.8);
    expect(out["b"]?.sameRequest).toBe(0.1);
  });
  it("sem mapa, o comportamento de antes", async () => {
    const out = await new FakeRelated().judge(input);
    expect(out["a"]?.sameRequest).toBe(0.1);
  });
});
