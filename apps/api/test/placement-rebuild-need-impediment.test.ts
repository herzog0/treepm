import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";

// ADR 0068: `--depends-on` continua "para começar"; `--depends-on-deliver` diz "para entregar"; `--impediment` e `--no-impediment` marcam e limpam.
const base = ["--org", "org_1", "--user", "user_1", "--project", "p"];

describe("ticket-update: tipo de dependência e impedimento (parse)", () => {
  it("--depends-on-deliver aceita o número de um ticket", () => {
    expect(parseCliArgs(["ticket-update", ...base, "--number", "2", "--depends-on-deliver", "1"])).toMatchObject({ ok: true, options: { number: 2, dependsOnDeliver: 1 } });
    expect(parseCliArgs(["ticket-update", ...base, "--number", "2", "--depends-on-deliver", "x"]).ok).toBe(false);
  });

  it("--depends-on-deliver não combina com --depends-on nem com --no-depends-on", () => {
    expect(parseCliArgs(["ticket-update", ...base, "--number", "3", "--depends-on", "1", "--depends-on-deliver", "2"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-update", ...base, "--number", "3", "--no-depends-on", "1", "--depends-on-deliver", "2"]).ok).toBe(false);
  });

  it("--impediment leva o motivo; --no-impediment vale sozinho como mudança; os dois não combinam", () => {
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--impediment", "Falta a chave"])).toMatchObject({ ok: true, options: { impediment: "Falta a chave" } });
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--no-impediment"])).toMatchObject({ ok: true, options: { noImpediment: true } });
    expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--impediment", "x", "--no-impediment"]).ok).toBe(false);
  });

  it("não existem fora do ticket-update", () => {
    expect(parseCliArgs(["ticket-list", ...base, "--impediment", "x"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-list", ...base, "--depends-on-deliver", "1"]).ok).toBe(false);
  });
});
