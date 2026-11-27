import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionArrows } from "./SelectionArrows.js";
import type { Arrow } from "./arrows.js";

const arrow = (extra: Partial<Arrow>): Arrow => ({ key: "waits:a", kind: "waits", need: "start", finished: false, x1: 0, y1: 0, x2: 10, y2: 10, ...extra });

// ADR 0069, seção 5: uma cor para o que ele espera, outra para o que ele libera; "para entregar" tracejada; nada sem seleção.
describe("SelectionArrows", () => {
  it("desenha uma linha por seta, com o tipo, a direção e a ponta", () => {
    const { container } = render(
      <SelectionArrows arrows={[arrow({}), arrow({ key: "unlocks:b", kind: "unlocks", need: "deliver", finished: true, x1: 5, y1: 6, x2: 7, y2: 8 })]} />,
    );
    const lines = [...container.querySelectorAll("line")];
    expect(lines.map((line) => [line.dataset.kind, line.dataset.need, line.dataset.finished])).toEqual([
      ["waits", "start", "false"],
      ["unlocks", "deliver", "true"],
    ]);
    expect(lines[1]).toHaveAttribute("x1", "5");
    expect(lines[1]).toHaveAttribute("y2", "8");
    expect(lines[0]!.getAttribute("marker-end")).toMatch(/^url\(#.+\)$/);
    expect(lines[0]!.getAttribute("marker-end")).not.toBe(lines[1]!.getAttribute("marker-end"));
  });

  it("é decorativa e não existe sem setas", () => {
    const { container, rerender } = render(<SelectionArrows arrows={[arrow({})]} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    rerender(<SelectionArrows arrows={[]} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
