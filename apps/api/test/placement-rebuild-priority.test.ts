import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";

// ADR 0047: `ticket-update --priority N` (aceita negativo) e a prioridade no `ticket-list` quando diferente de 0.
const base = ["--org", "org_X", "--user", "user_X", "--project", "p"];

describe("--priority na linha de comando", () => {
  it("ticket-update aceita inteiros de -999 a 999, inclusive negativo e zero, sozinho", () => {
    for (const value of ["5", "-3", "0", "999", "-999"]) {
      expect(parseCliArgs(["ticket-update", ...base, "--number", "1", "--priority", value])).toMatchObject({ ok: true, options: { number: 1, priority: Number(value) } });
    }
  });

  it("recusa fora do intervalo, fracionário e texto", () => {
    for (const value of ["1000", "-1000", "1.5", "alta", ""]) {
      const parsed = parseCliArgs(["ticket-update", ...base, "--number", "1", "--priority", value]);
      expect(parsed.ok, value).toBe(false);
    }
    const parsed = parseCliArgs(["ticket-update", ...base, "--number", "1", "--priority", "1000"]);
    expect(parsed.ok ? "" : parsed.error).toMatch(/--priority.*-999.*999/);
  });

  it("não existe no ticket-list nem no ticket-create (a criação sempre nasce com 0)", () => {
    expect(parseCliArgs(["ticket-list", ...base, "--priority", "1"]).ok).toBe(false);
    expect(parseCliArgs(["ticket-create", ...base, "--title", "T", "--priority", "1"]).ok).toBe(false);
  });

  it("a ajuda cita --priority", () => {
    const parsed = parseCliArgs(["ticket-update", ...base, "--bogus"]);
    expect(parsed.ok ? "" : parsed.error).toMatch(/--priority/);
  });
});

describe("--priority e as ações de ideia (do main)", () => {
  it("--idea-accept|discard|make não combinam com --priority; --priority sozinho segue valendo", () => {
    for (const action of ["--idea-accept", "--idea-discard", "--idea-make"]) {
      expect(parseCliArgs(["ticket-update", ...base, "--number", "1", action, "--priority", "2"]).ok, action).toBe(false);
      expect(parseCliArgs(["ticket-update", ...base, "--number", "1", action]).ok, action).toBe(true);
    }
    const none = parseCliArgs(["ticket-update", ...base, "--number", "1"]);
    expect(none.ok ? "" : none.error).toMatch(/--priority.*--idea-accept/);
  });
});
