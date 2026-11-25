import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNNAMED_PERSON, mcpPersonRef } from "../src/mcp/person-name.js";

// ADR 0062 (revisão de segurança, TREEPM-494): e-mail e id do Clerk NUNCA saem pelo MCP, nem com o alcance de pessoas. O nome de
// exibição pode ser o e-mail ou o id (o Clerk cai neles quando a pessoa não tem nome), então toda saída passa por UMA função.
const person = (displayName: string, extra: { email?: string; clerkUserId?: string } = {}) => ({
  id: "p1",
  displayName,
  email: extra.email ?? "ana@exemplo.test",
  clerkUserId: extra.clerkUserId ?? "user_2abcDEF123",
});

describe("mcpPersonRef", () => {
  it("devolve o nome verdadeiro, aparado, sem mexer no que é nome", () => {
    expect(mcpPersonRef(person("  Ana Souza "))).toEqual({ id: "p1", name: "Ana Souza" });
    expect(mcpPersonRef(person("Ana"))).toEqual({ id: "p1", name: "Ana" });
  });
  it("troca pelo rótulo neutro o nome igual ao e-mail da pessoa, sem diferenciar maiúsculas nem espaços", () => {
    expect(mcpPersonRef(person("ana@exemplo.test")).name).toBe(UNNAMED_PERSON);
    expect(mcpPersonRef(person("  ANA@Exemplo.TEST  ")).name).toBe(UNNAMED_PERSON);
  });
  it("troca pelo rótulo o nome igual ao id externo da pessoa e o que tem a forma de um id do Clerk", () => {
    expect(mcpPersonRef(person("user_2abcDEF123")).name).toBe(UNNAMED_PERSON);
    expect(mcpPersonRef(person(" USER_2ABCdef123 ")).name).toBe(UNNAMED_PERSON);
    expect(mcpPersonRef(person("user_2zzzzzzzzzzzz")).name).toBe(UNNAMED_PERSON);
  });
  it("troca pelo rótulo o nome com forma de e-mail, mesmo de outra pessoa", () => {
    expect(mcpPersonRef(person("bia@outra.org")).name).toBe(UNNAMED_PERSON);
    expect(mcpPersonRef(person("Bia <bia@outra.org>")).name).toBe(UNNAMED_PERSON);
  });
  it("o rótulo é fixo, em inglês", () => {
    expect(UNNAMED_PERSON).toBe("Unnamed person");
    expect(mcpPersonRef(person("   ")).name).toBe(UNNAMED_PERSON);
  });
});

describe("estrutura: o nome de pessoa só sai por person-name.ts", () => {
  it("nenhum outro arquivo de apps/api/src/mcp/ lê o nome de exibição", () => {
    const dir = join(import.meta.dirname, "../src/mcp");
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && file !== "person-name.ts")
      .filter((file) => /\bdisplayName\b/.test(readFileSync(join(dir, file), "utf8")));
    expect(offenders, "leia o nome por mcpPersonRef (person-name.ts): comentários, histórico e conversas também").toEqual([]);
  });
});
