import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { Workspace } from "../../Workspace.js";
import { editorImport, forgetDescriptionEditor, RichDescription } from "./RichDescription.js";

// O ponto de importação do editor ganha um espião: conta os downloads e deixa o teste segurar ou derrubar cada um.
const download = { gate: null as Promise<void> | null, fail: false };
let importEditor: MockInstance<typeof editorImport.run>;

beforeEach(async () => {
  download.gate = null;
  download.fail = false;
  const real = editorImport.run;
  importEditor = vi.spyOn(editorImport, "run").mockImplementation(async () => {
    if (download.gate) await download.gate;
    if (download.fail) throw new Error("Failed to fetch dynamically imported module");
    return real();
  });
  forgetDescriptionEditor();
});
afterEach(() => {
  vi.restoreAllMocks();
  forgetDescriptionEditor();
});

const props = { editing: false, canEdit: true, label: "Descrição", placeholder: "Clique para escrever." };

describe("RichDescription loading on demand", () => {
  it("does not import the editor when the map is mounted", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (input === "/api/me") return Response.json({ person: { id: "p", displayName: "Ana", email: "a@x.com", avatarUrl: null }, organization: { orgId: "org-1", name: "Org", slug: "org" }, roles: { clerk: "admin", teams: [], projects: [] } });
      if (input === "/api/projects") return Response.json([{ id: "p1", name: "Projeto", key: "PRJ", visibility: "organization", archivedAt: null, members: [], teamIds: [] }]);
      return Response.json([]);
    });
    render(<Workspace orgId="org-1" view="map" getToken={async () => "t"} fetch={fetchImpl} />);
    expect(await screen.findByRole("button", { name: /Projeto/ })).toBeInTheDocument();
    expect(importEditor.mock.calls.length).toBe(0);
  });

  it("shows the text as plain readable text, with line breaks, until the editor arrives, then hands over", async () => {
    let release!: () => void;
    download.gate = new Promise<void>((resolve) => (release = resolve));
    const { container } = render(<RichDescription {...props} value={"linha um\nlinha dois"} />);
    const plain = container.querySelector(".description")!;
    expect(plain.textContent).toBe("linha um\nlinha dois");
    expect(container.querySelector(".tiptap")).toBeNull();
    expect(importEditor.mock.calls.length).toBe(1);
    await act(async () => release());
    await waitFor(() => expect(container.querySelector(".tiptap")).not.toBeNull());
    expect(container.querySelector(".tiptap")!.textContent).toBe("linha um\nlinha dois");
  });

  it("is not clickable to edit before the editor arrives, and is once it does", async () => {
    let release!: () => void;
    download.gate = new Promise<void>((resolve) => (release = resolve));
    const onRequestEdit = vi.fn();
    const { container } = render(<RichDescription {...props} value="texto" onRequestEdit={onRequestEdit} />);
    fireEvent.click(container.querySelector(".description")!);
    expect(onRequestEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Descrição" })).toBeNull();
    await act(async () => release());
    expect(await screen.findByRole("group", { name: "Descrição" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("group", { name: "Descrição" }), { key: "Enter" });
    expect(onRequestEdit).toHaveBeenCalledTimes(1);
  });

  it("keeps the text readable on a failed download and downloads again on Try again", async () => {
    download.fail = true;
    const { container } = render(<RichDescription {...props} value="texto que fica" />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Não foi possível carregar o editor.");
    expect(container).toHaveTextContent("texto que fica");
    download.fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(container.querySelector(".tiptap")).not.toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders at once, without the plain text step, when the editor was already downloaded", async () => {
    const first = render(<RichDescription {...props} value="um" />);
    await waitFor(() => expect(first.container.querySelector(".tiptap")).not.toBeNull());
    first.unmount();
    const second = render(<RichDescription {...props} value="dois" />);
    expect(second.container.querySelector(".tiptap")).not.toBeNull();
    expect(importEditor.mock.calls.length).toBe(1);
  });
});
