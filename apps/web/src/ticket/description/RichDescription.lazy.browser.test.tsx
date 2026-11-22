import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";
import "../../theme.css";
import "../../map/status-mark.css";
import { editorImport, forgetDescriptionEditor, RichDescription } from "./RichDescription.js";

let release!: () => void;

beforeEach(() => {
  forgetDescriptionEditor();
  const gate = new Promise<void>((resolve) => (release = resolve));
  const real = editorImport.run;
  vi.spyOn(editorImport, "run").mockImplementation(async () => {
    await gate;
    return real();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetDescriptionEditor();
});

describe("editor taking over from the plain text", () => {
  it("takes the focus and edits normally when it arrives, keeping the text", async () => {
    const onChange = vi.fn();
    await render(
      <div style={{ width: 300, font: "14px sans-serif" }}>
        <RichDescription value="início" editing canEdit autoFocus label="Descrição" placeholder="" onChange={onChange} />
      </div>,
    );
    expect(document.querySelector(".tiptap")).toBeNull();
    expect(document.querySelector(".description-plain")?.textContent).toBe("início");
    release();
    await vi.waitFor(() => expect(document.querySelector(".tiptap")).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(document.querySelector(".tiptap")));
    await userEvent.keyboard(" mais");
    expect(onChange).toHaveBeenLastCalledWith("início mais");
  });

  it("keeps the line height of the text, so the first line does not move when the editor arrives", async () => {
    await render(
      <div style={{ width: 300, font: "14px sans-serif" }}>
        <RichDescription value={"linha um\nlinha dois"} editing={false} canEdit={false} label="Descrição" placeholder="" />
      </div>,
    );
    const before = document.querySelector(".description-plain")!.getBoundingClientRect().height;
    release();
    await vi.waitFor(() => expect(document.querySelector(".tiptap")).not.toBeNull());
    const after = document.querySelector(".tiptap")!.getBoundingClientRect().height;
    expect(Math.abs(after - before)).toBeLessThan(2);
  });
});
