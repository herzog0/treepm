import { describe, expect, it } from "vitest";
import { disabledMessage, formatCheckReport } from "../src/github/check-report.js";

describe("saída do github:check", () => {
  it("imprime só o slug do app, o nome das permissões e a quantidade de instalações", () => {
    const text = formatCheckReport({
      slug: "treepm-dev",
      permissions: { metadata: "read", contents: "read", pull_requests: "read" },
      installationCount: 2,
    });
    expect(text).toBe(["App: treepm-dev", "Permissões: contents, metadata, pull_requests", "Instalações: 2"].join("\n"));
  });

  it("não imprime o nível das permissões nem nada além dos três campos", () => {
    const text = formatCheckReport({ slug: "x", permissions: { contents: "write" }, installationCount: 0 });
    expect(text).not.toContain("write");
    expect(text.split("\n")).toHaveLength(3);
    expect(text).toContain("Instalações: 0");
  });

  it("sem permissões, diz nenhuma", () => {
    expect(formatCheckReport({ slug: "x", permissions: {}, installationCount: 1 })).toContain("Permissões: nenhuma");
  });

  it("com o GitHub desligado, diz isso e nomeia só as variáveis que faltam", () => {
    const text = disabledMessage(["GITHUB_APP_ID", "GITHUB_APP_SLUG"]);
    expect(text).toContain("desligada");
    expect(text).toContain("GITHUB_APP_ID, GITHUB_APP_SLUG");
  });
});
