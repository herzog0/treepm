import { describe, expect, it } from "vitest";
import { MAX_RESULT_CHARS, fit } from "../src/mcp/mcp-tools.js";

describe("10. fit()", () => {
  it("termina quando o excesso não está em lista cortável (descrição e caminho nunca são cortados)", () => {
    const result = {
      description: "d".repeat(MAX_RESULT_CHARS + 10),
      path: Array.from({ length: 200 }, () => ({ title: "T".repeat(500) })),
      children: { tickets: [] as unknown[], truncated: false },
    };
    const out = fit(result, (value) => [value.children]);
    expect(out.description.length).toBeGreaterThan(MAX_RESULT_CHARS);
    expect(out.path).toHaveLength(200);
  });

  it("corta só as listas e para ao caber", () => {
    const tickets = Array.from({ length: 500 }, () => ({ title: "T".repeat(300) }));
    const result = { description: "ok", children: { tickets, truncated: false } };
    const out = fit(result, (value) => [value.children]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.children.truncated).toBe(true);
    expect(out.description).toBe("ok");
  });
});
