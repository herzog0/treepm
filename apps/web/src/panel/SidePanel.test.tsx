import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeClient, makeMe, makeProject } from "../test/fakes.js";
import { SidePanel } from "./SidePanel.js";

function setup(props: Partial<Parameters<typeof SidePanel>[0]> = {}) {
  const parent = {
    pointerDown: vi.fn(),
    pointerMove: vi.fn(),
    pointerUp: vi.fn(),
    click: vi.fn(),
    keyDown: vi.fn(),
    wheel: vi.fn(),
  };
  const onClose = vi.fn();
  const onTabChange = vi.fn();
  const onChanged = vi.fn();
  const view = render(
    <div
      data-testid="map"
      onPointerDown={parent.pointerDown}
      onPointerMove={parent.pointerMove}
      onPointerUp={parent.pointerUp}
      onKeyDown={parent.keyDown}
      ref={(element) => element?.addEventListener("wheel", parent.wheel)}
    >
      <SidePanel
        client={makeClient({ areas: [{ id: "a1", name: "Design" }], projects: [makeProject("p1", "PRJ", "Projeto Um")] })}
        me={makeMe()}
        projects={[makeProject("p1", "PRJ", "Projeto Um")]}
        tab="areas"
        selectedProjectId={null}
        onTabChange={onTabChange}
        onClose={onClose}
        onChanged={onChanged}
        {...props}
      />
    </div>,
  );
  return { parent, onClose, onTabChange, onChanged, ...view };
}

describe("SidePanel", () => {
  it("is a labelled region with Áreas and Projetos tabs and a Fechar button", () => {
    setup();
    expect(screen.getByRole("complementary", { name: "Áreas e projetos" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Áreas" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Projetos" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: "Fechar" })).toBeInTheDocument();
  });

  it("switches tabs through the callback and renders the matching section", async () => {
    const { onTabChange, rerender } = setup();
    await userEvent.click(screen.getByRole("tab", { name: "Projetos" }));
    expect(onTabChange).toHaveBeenCalledWith("projects");
    expect(await screen.findByText("Design")).toBeInTheDocument();
    rerender(<div />);
  });

  it("shows the Projetos section when tab is projects", async () => {
    setup({ tab: "projects" });
    expect(await screen.findByText("Projeto Um")).toBeInTheDocument();
    expect(screen.getByText("PRJ")).toBeInTheDocument();
  });

  it("closes with the Fechar button", async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape when focus is inside, without reaching the map", async () => {
    const { onClose, parent } = setup();
    screen.getByRole("tab", { name: "Áreas" }).focus();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(parent.keyDown).not.toHaveBeenCalled();
  });

  it("does not close with Escape pressed outside the panel", async () => {
    const { onClose } = setup();
    expect(screen.getByRole("complementary")).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps pointer, click-gesture and wheel events away from the map", () => {
    const { parent } = setup();
    const panel = screen.getByRole("complementary", { name: "Áreas e projetos" });
    fireEvent.pointerDown(panel);
    fireEvent.pointerMove(panel);
    fireEvent.pointerUp(panel);
    fireEvent.wheel(panel, { deltaY: 120 });
    expect(parent.pointerDown).not.toHaveBeenCalled();
    expect(parent.pointerMove).not.toHaveBeenCalled();
    expect(parent.pointerUp).not.toHaveBeenCalled();
    expect(parent.wheel).not.toHaveBeenCalled();
  });

  it("keeps wheel events from child elements away from the map too", async () => {
    const { parent } = setup();
    fireEvent.wheel(await screen.findByText("Design"), { deltaY: 120 });
    expect(parent.wheel).not.toHaveBeenCalled();
  });

  it("keeps keystrokes (c, C, Escape) typed into a field away from the map", async () => {
    const { parent, onClose } = setup({ tab: "projects" });
    await screen.findByText("Projeto Um");
    const field = document.createElement("input");
    screen.getByRole("complementary").appendChild(field);
    field.focus();
    await userEvent.keyboard("cC{Escape}");
    expect(parent.keyDown).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
