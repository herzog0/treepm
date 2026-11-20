import { describe, expect, it } from "vitest";
import { branchContentMark } from "../src/assistant/branch-mark.js";

const base = {
  title: "Autenticação",
  descriptionExcerpt: "Tudo sobre entrar no sistema",
  children: [
    { title: "Login", summary: "Tela de login" },
    { title: "Senha", summary: null },
  ],
};

describe("branchContentMark", () => {
  it("é estável para o mesmo conteúdo", () => {
    expect(branchContentMark(base)).toBe(branchContentMark(structuredClone(base)));
    expect(branchContentMark(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["o título", { ...base, title: "Autenticação 2" }],
    ["o trecho da descrição", { ...base, descriptionExcerpt: "Outro texto" }],
    ["o título de um filho", { ...base, children: [{ title: "Login!", summary: "Tela de login" }, base.children[1]!] }],
    ["o resumo de um filho", { ...base, children: [{ title: "Login", summary: "Outra" }, base.children[1]!] }],
    ["um filho a mais", { ...base, children: [...base.children, { title: "Sessão", summary: null }] }],
    ["resumo ausente versus vazio", { ...base, children: [base.children[0]!, { title: "Senha", summary: "" }] }],
  ])("muda quando muda %s", (_name, changed) => {
    expect(branchContentMark(changed)).not.toBe(branchContentMark(base));
  });

  it("não confunde fronteiras entre campos", () => {
    const a = branchContentMark({ title: "ab", descriptionExcerpt: "c", children: [] });
    const b = branchContentMark({ title: "a", descriptionExcerpt: "bc", children: [] });
    expect(a).not.toBe(b);
  });
});
