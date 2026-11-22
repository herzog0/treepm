import { describe, expect, it } from "vitest";
import { toNeutralLabels, fromNeutralLabels, labelNumbers, parseLabel, labelOf } from "../src/assistant/ask-labels.js";

describe("toNeutralLabels (ida)", () => {
  it("troca a chave do projeto pelo rótulo, em qualquer ponto do texto", () => {
    expect(toNeutralLabels("Veja PRIV-47 e (PRIV-3), depois PRIV-47.", "PRIV")).toBe("Veja T47 e (T3), depois T47.");
  });

  it("não troca chave de outro projeto", () => {
    expect(toNeutralLabels("PRIV-1 depende de OPEN-2", "PRIV")).toBe("T1 depende de OPEN-2");
  });

  it("não troca no meio de palavra ou de outra chave", () => {
    expect(toNeutralLabels("XPRIV-1 PRIV-1a PRIV-1_x a-PRIV-1 PRIV-1-2", "PRIV")).toBe("XPRIV-1 PRIV-1a PRIV-1_x a-PRIV-1 PRIV-1-2");
  });

  it("projeto cuja chave é T: T-47 vira T47", () => {
    expect(toNeutralLabels("T-47 e X-1", "T")).toBe("T47 e X-1");
  });

  it("texto sem chave fica como está", () => {
    expect(toNeutralLabels("nada aqui", "PRIV")).toBe("nada aqui");
  });
});

describe("fromNeutralLabels (volta)", () => {
  const exists = new Set([47, 3]);

  it("troca T<número> de ticket que existe pela chave real", () => {
    expect(fromNeutralLabels("**T47** bloqueia T3.", "PRIV", exists)).toBe("**PRIV-47** bloqueia PRIV-3.");
  });

  it("deixa como veio o rótulo de ticket que não existe", () => {
    expect(fromNeutralLabels("T47 e T999", "PRIV", exists)).toBe("PRIV-47 e T999");
  });

  it("não troca rótulo no meio de palavra", () => {
    expect(fromNeutralLabels("RT47 T47x T47_a T-47 a-T47 T47-1 T047a", "PRIV", exists)).toBe("RT47 T47x T47_a T-47 a-T47 T47-1 T047a");
  });

  it("troca com pontuação em volta", () => {
    expect(fromNeutralLabels("(T47), T3; 'T47'", "PRIV", exists)).toBe("(PRIV-47), PRIV-3; 'PRIV-47'");
  });

  it("projeto cuja chave é T", () => {
    expect(fromNeutralLabels("T47", "T", exists)).toBe("T-47");
  });
});

describe("ida e volta", () => {
  it("devolve o texto original", () => {
    const original = "PRIV-47 depende de PRIV-3, veja OPEN-2 e T999.";
    const exists = new Set([47, 3]);
    expect(fromNeutralLabels(toNeutralLabels(original.replace("T999", "PRIV-999"), "PRIV"), "PRIV", new Set([47, 3, 999]))).toBe(original.replace("T999", "PRIV-999"));
    expect(fromNeutralLabels(toNeutralLabels("PRIV-47 e PRIV-3", "PRIV"), "PRIV", exists)).toBe("PRIV-47 e PRIV-3");
  });

  it("com a chave T", () => {
    expect(fromNeutralLabels(toNeutralLabels("T-47 e T-3", "T"), "T", new Set([47, 3]))).toBe("T-47 e T-3");
  });
});

describe("auxiliares", () => {
  it("labelNumbers: os números dos rótulos soltos, sem repetição", () => {
    expect(labelNumbers("T47, T3 e T47; RT9; T05")).toEqual([47, 3]);
  });
  it("parseLabel aceita só T<número>", () => {
    expect(parseLabel("T47")).toBe(47);
    for (const bad of ["47", "t47", "T-47", "PRIV-47", "T0", "T", "T47 ", " T47", "T1.5", "T99999999999"]) expect(parseLabel(bad), bad).toBeNull();
  });
  it("labelOf", () => expect(labelOf(47)).toBe("T47"));
});
