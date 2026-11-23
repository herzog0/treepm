import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";

const base = ["--org", "o", "--user", "u", "--project", "p"];
const parse = (...argv: string[]) => parseCliArgs(argv);
const error = (...argv: string[]): string => {
  const parsed = parse(...argv);
  if (parsed.ok) throw new Error("era para recusar");
  return parsed.error;
};

describe("ticket-show", () => {
  it("pede --number", () => {
    expect(error("ticket-show", ...base)).toMatch(/Faltam opções para ticket-show: --number/);
    expect(parse("ticket-show", ...base, "--number", "7")).toMatchObject({ ok: true, command: "ticket-show", options: { number: 7 } });
  });
});

describe("ticket-update --depends-on / --no-depends-on", () => {
  it("valem como mudança e guardam o número do ticket", () => {
    expect(parse("ticket-update", ...base, "--number", "5", "--depends-on", "3")).toMatchObject({ ok: true, options: { number: 5, dependsOn: 3 } });
    expect(parse("ticket-update", ...base, "--number", "5", "--no-depends-on", "3")).toMatchObject({ ok: true, options: { noDependsOn: 3 } });
  });
  it("não combinam entre si e exigem número de ticket", () => {
    expect(error("ticket-update", ...base, "--number", "5", "--depends-on", "3", "--no-depends-on", "4")).toMatch(/--depends-on não combina com --no-depends-on/);
    expect(error("ticket-update", ...base, "--number", "5", "--depends-on", "x")).toMatch(/--depends-on deve ser o número de um ticket/);
  });
  it("não existem fora do ticket-update", () => {
    expect(error("ticket-list", ...base, "--depends-on", "3")).toMatch(/--depends-on não existe no ticket-list/);
  });
});

describe("summary-show e summary-regenerate", () => {
  it("summary-show pede --number", () => {
    expect(error("summary-show", ...base)).toMatch(/--number/);
    expect(parse("summary-show", ...base, "--number", "2")).toMatchObject({ ok: true, command: "summary-show" });
  });
  it("summary-regenerate pede exatamente um de --number, --subtree e --all", () => {
    expect(error("summary-regenerate", ...base)).toMatch(/exatamente um de --number, --subtree ou --all/);
    expect(error("summary-regenerate", ...base, "--number", "2", "--all")).toMatch(/exatamente um/);
    expect(parse("summary-regenerate", ...base, "--number", "2")).toMatchObject({ ok: true, options: { number: 2 } });
    expect(parse("summary-regenerate", ...base, "--subtree", "2", "--dir", "/tmp/x")).toMatchObject({ ok: true, options: { subtree: 2 } });
    expect(parse("summary-regenerate", ...base, "--all", "--dir", "/tmp/x")).toMatchObject({ ok: true, options: { all: true } });
  });
  it("--subtree e --all gravam o andamento em --dir (menos no --dry-run)", () => {
    expect(error("summary-regenerate", ...base, "--subtree", "2")).toMatch(/--dir/);
    expect(parse("summary-regenerate", ...base, "--subtree", "2", "--dry-run")).toMatchObject({ ok: true, options: { dryRun: true } });
  });
  it("--resume só com --subtree ou --all", () => {
    expect(error("summary-regenerate", ...base, "--number", "2", "--resume")).toMatch(/--resume só existe com --subtree ou --all/);
    expect(parse("summary-regenerate", ...base, "--all", "--dir", "/tmp/x", "--resume")).toMatchObject({ ok: true, options: { resume: true } });
  });
  it("--subtree e --all não existem em outros comandos", () => {
    expect(error("ticket-list", ...base, "--all")).toMatch(/--all não existe no ticket-list/);
  });
});

describe("conversation-dry-run", () => {
  it("pede --text-file e aceita --scope com número de ticket", () => {
    expect(error("conversation-dry-run", ...base)).toMatch(/--text-file/);
    expect(parse("conversation-dry-run", ...base, "--text-file", "pedido.md", "--scope", "9")).toMatchObject({ ok: true, options: { textFile: "pedido.md", scope: 9 } });
    expect(error("conversation-dry-run", ...base, "--text-file", "a", "--scope", "0")).toMatch(/--scope deve ser o número de um ticket/);
  });
});

describe("case-run", () => {
  const args = ["--org", "o", "--user", "u", "--dir", "d"];
  it("pede --case (e a pasta do gabarito); --project não existe porque o projeto é criado por ele", () => {
    expect(error("case-run", ...args)).toMatch(/Faltam opções para case-run: --case/);
    expect(parse("case-run", ...args, "--case", "c.json", "--repeats", "5", "--fake-providers")).toMatchObject({ ok: true, command: "case-run", options: { caseFile: "c.json", repeats: 5, fakeProviders: true } });
  });
  it("--repeats vale no case-run e continua recusado nos outros comandos", () => {
    expect(error("export", ...args, "--project", "p", "--repeats", "2")).toMatch(/--repeats só existe/);
  });
});
