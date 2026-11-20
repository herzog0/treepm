import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusMark, progressFraction } from "./StatusMark.js";

const mark = (props: Parameters<typeof StatusMark>[0]) => {
  const { container } = render(<StatusMark {...props} />);
  return container.firstElementChild as HTMLElement;
};

describe("StatusMark", () => {
  it.each([
    ["todo", "0", "todo"],
    ["in_progress", "0.5", "in_progress"],
    ["in_review", "0.75", "in_review"],
    ["done", "1", "done"],
    ["cancelled", "0", "cancelled"],
  ] as const)("fills the square for %s", (status, fill, state) => {
    const element = mark({ status });
    expect(element).toHaveAttribute("data-state", state);
    expect(element).toHaveAttribute("data-fill", fill);
  });

  it("is decorative: hidden from assistive technology and without text", () => {
    const element = mark({ status: "done" });
    expect(element).toHaveAttribute("aria-hidden", "true");
    expect(element).toHaveTextContent("");
  });

  it("marks cancelled as dashed and unfilled, through its state", () => {
    expect(mark({ status: "cancelled" })).toHaveAttribute("data-state", "cancelled");
  });

  it("fills by the share of done leaves for progress", () => {
    const element = mark({ progress: { done: 3, total: 8, excluded: 0 } });
    expect(element).toHaveAttribute("data-state", "progress");
    expect(element).toHaveAttribute("data-fill", "0.375");
  });

  it("marks a progress of 0 de 0 as empty, so the stylesheet paints it with the neutral 'a fazer' color", () => {
    expect(mark({ progress: { done: 0, total: 0, excluded: 0 } })).toHaveAttribute("data-empty", "true");
    expect(mark({ progress: { done: 0, total: 1, excluded: 0 } })).not.toHaveAttribute("data-empty");
    expect(mark({ progress: { done: 0, total: 0, excluded: 2 } })).not.toHaveAttribute("data-empty");
    expect(mark({ status: "todo" })).not.toHaveAttribute("data-empty");
  });

  it("exposes the fill as a CSS variable the stylesheet reads", () => {
    expect(mark({ status: "in_review" }).style.getPropertyValue("--fill")).toBe("0.75");
  });

  it.each([
    [{ done: 0, total: 0, excluded: 0 }, 0],
    [{ done: 8, total: 8, excluded: 1 }, 1],
    [{ done: 9, total: 8, excluded: 0 }, 1],
    [{ done: 1, total: 4, excluded: 0 }, 0.25],
  ])("progressFraction(%j) is %s", (progress, expected) => {
    expect(progressFraction(progress)).toBe(expected);
  });
});
