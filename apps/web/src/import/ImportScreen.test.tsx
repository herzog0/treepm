import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { failed, makeClient, makeProject, ok } from "../test/fakes.js";
import { makePanelMe } from "../panel/testing.js";
import { ImportScreen } from "./ImportScreen.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const LIST = "- Pai\n  - [x] Filho um\n  - [/] Filho dois\n- [r] Solo";

function setup(options: { me?: ReturnType<typeof makePanelMe>; projects?: ReturnType<typeof makeProject>[]; projectId?: string; client?: ApiClient } = {}) {
  const client = options.client ?? makeClient({ projects: options.projects ?? [project] });
  const onExit = vi.fn();
  render(<ImportScreen client={client} me={options.me ?? makePanelMe("admin")} projectId={options.projectId ?? "p1"} onExit={onExit} />);
  return { client, onExit };
}
const box = () => screen.findByRole("textbox", { name: "Lista" });
async function paste(text: string) {
  const area = await box();
  await userEvent.click(area);
  await userEvent.paste(text);
  return area;
}

describe("ImportScreen", () => {
  it("shows the short path, the title, the explanation and the marker legend", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Importar lista", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("ALFA")).toBeInTheDocument();
    expect(screen.getByText("Projeto Alfa")).toBeInTheDocument();
    for (const marker of ["- [ ]", "- [/]", "- [r]", "- [x]", "- [-]"]) expect(screen.getByText(marker)).toBeInTheDocument();
    expect(screen.getByText("Prévia")).toBeInTheDocument();
  });

  it("marks an item with children as a group in the preview, and only that one", async () => {
    setup();
    await paste("- Fase\n  - [x] Passo\n  - Subfase\n    - Detalhe\n- [r] Solo");
    const tree = screen.getByRole("list", { name: "Prévia da árvore" });
    const row = (title: string) => within(tree).getByText(title).closest(".import-tree-row") as HTMLElement;
    expect(within(row("Fase")).getByText("Agrupador")).toBeInTheDocument();
    expect(within(row("Subfase")).getByText("Agrupador")).toBeInTheDocument();
    expect(within(row("Passo")).queryByText("Agrupador")).not.toBeInTheDocument();
    expect(within(row("Detalhe")).queryByText("Agrupador")).not.toBeInTheDocument();
    expect(within(row("Solo")).queryByText("Agrupador")).not.toBeInTheDocument();
  });

  it("explains that an item with children becomes a group", async () => {
    setup();
    expect(await screen.findByText(/item com filhos vira um agrupador/i)).toBeInTheDocument();
  });

  it("does not wrap long lines, so the indentation stays readable", async () => {
    setup();
    const area = await box();
    expect(area).toHaveAttribute("wrap", "off");
  });

  it("starts empty: no errors, nothing to import and the main action disabled", async () => {
    setup();
    await box();
    expect(screen.getByRole("button", { name: /^Importar/ })).toBeDisabled();
    expect(screen.queryByRole("list", { name: "Erros da lista" })).not.toBeInTheDocument();
  });

  it("previews the parsed tree while typing, with summary, statuses and sub-item counts", async () => {
    setup();
    await paste(LIST);
    expect(screen.getByText("4 tickets · 2 raízes · 3 folhas")).toBeInTheDocument();
    const tree = screen.getByRole("list", { name: "Prévia da árvore" });
    expect(within(tree).getByText("Pai")).toBeInTheDocument();
    expect(within(tree).getByText("2 subitens")).toBeInTheDocument();
    const filhoUm = within(tree).getByText("Filho um").closest("li")!;
    expect(within(filhoUm).getByText("Concluído")).toBeInTheDocument();
    expect(within(tree).getByText("Filho dois").closest("li")).toHaveTextContent("Em andamento");
    expect(within(tree).getByText("Solo").closest("li")).toHaveTextContent("Em revisão");
    expect(tree.querySelectorAll("[data-state]").length).toBe(3);
    expect(screen.getByRole("button", { name: "Importar 4 tickets" })).toBeEnabled();
  });

  it("uses singular forms for one ticket and one sub-item", async () => {
    setup();
    await paste("- A\n  - B");
    expect(screen.getByText("2 tickets · 1 raiz · 1 folha")).toBeInTheDocument();
    expect(screen.getByText("1 subitem")).toBeInTheDocument();
    await userEvent.clear(await box());
    await userEvent.paste("- Só");
    expect(screen.getByRole("button", { name: "Importar 1 ticket" })).toBeEnabled();
  });

  it("shows the warning above the tree and keeps the action enabled", async () => {
    setup();
    await paste("- [x] Pai\n  - Filho");
    const warning = screen.getByText(/^Linha 1: O marcador deste item não aparece/);
    const tree = screen.getByRole("list", { name: "Prévia da árvore" });
    expect(warning.compareDocumentPosition(tree) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("button", { name: "Importar 2 tickets" })).toBeEnabled();
  });

  it("shows one error per line in place of the preview and disables the action", async () => {
    setup();
    await paste("texto solto\n- Item\n  - ");
    const errors = screen.getByRole("list", { name: "Erros da lista" });
    const items = within(errors).getAllByRole("listitem");
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toHaveTextContent(/^Linha 1: /);
    expect(screen.queryByRole("list", { name: "Prévia da árvore" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Importar/ })).toBeDisabled();
  });

  it("sends the parsed tree to importTickets and leaves for the map on success", async () => {
    const client = makeClient({ projects: [project] });
    vi.mocked(client.importTickets).mockResolvedValue(ok([]));
    const { onExit } = setup({ client });
    await paste(LIST);
    await userEvent.click(screen.getByRole("button", { name: "Importar 4 tickets" }));
    await waitFor(() => expect(onExit).toHaveBeenCalledTimes(1));
    expect(client.importTickets).toHaveBeenCalledWith("p1", {
      items: [
        { title: "Pai", children: [{ title: "Filho um", status: "done" }, { title: "Filho dois", status: "in_progress" }] },
        { title: "Solo", status: "in_review" },
      ],
    });
  });

  it("disables the action while sending", async () => {
    const client = makeClient({ projects: [project] });
    let finish: (value: Awaited<ReturnType<ApiClient["importTickets"]>>) => void = () => undefined;
    vi.mocked(client.importTickets).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    setup({ client });
    await paste("- A");
    await userEvent.click(screen.getByRole("button", { name: "Importar 1 ticket" }));
    expect(await screen.findByRole("button", { name: "Importando…" })).toBeDisabled();
    finish(ok([]));
  });

  it("keeps the text and shows the API message next to the action on failure", async () => {
    const client = makeClient({ projects: [project] });
    vi.mocked(client.importTickets).mockResolvedValue(failed("unavailable"));
    const { onExit } = setup({ client });
    const area = await paste(LIST);
    await userEvent.click(screen.getByRole("button", { name: "Importar 4 tickets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A API está indisponível");
    expect(area).toHaveValue(LIST);
    expect(onExit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Importar 4 tickets" })).toBeEnabled();
  });

  it("Cancelar leaves without importing", async () => {
    const { client, onExit } = setup();
    await box();
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(client.importTickets).not.toHaveBeenCalled();
  });

  it("loads a .md or .txt file into the text area", async () => {
    setup();
    await box();
    const file = new File(["- Do arquivo\n- Outro"], "lista.md", { type: "text/markdown" });
    await userEvent.upload(screen.getByLabelText("Escolher arquivo"), file);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Lista" })).toHaveValue("- Do arquivo\n- Outro"));
    expect(screen.getByText("2 tickets · 2 raízes · 2 folhas")).toBeInTheDocument();
  });

  it.each([
    ["contributor", true],
    ["manager", true],
    ["reader", false],
  ] as const)("a project %s %s import", async (role, allowed) => {
    setup({ me: makePanelMe("member", [{ projectId: "p1", role }]) });
    if (allowed) expect(await box()).toBeInTheDocument();
    else {
      expect(await screen.findByText(/não tem permissão/i)).toBeInTheDocument();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Importar/ })).not.toBeInTheDocument();
    }
  });

  it("a member without a project role cannot import", async () => {
    setup({ me: makePanelMe("member") });
    expect(await screen.findByText(/não tem permissão/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("an archived project does not accept import", async () => {
    setup({ projects: [makeProject("p1", "ALFA", "Projeto Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" })] });
    expect(await screen.findByText(/arquivado/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("a project that does not exist or is invisible shows the message without the text area", async () => {
    setup({ projectId: "nope" });
    expect(await screen.findByText(/Projeto não encontrado/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("offers a way back from the unavailable states", async () => {
    const { onExit } = setup({ projectId: "nope" });
    await userEvent.click(await screen.findByRole("button", { name: "Voltar ao mapa" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("shows a load error with retry when the projects cannot be loaded", async () => {
    const client = makeClient({ projects: [project] });
    vi.mocked(client.listProjects).mockResolvedValueOnce(failed("unavailable"));
    setup({ client });
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await box()).toBeInTheDocument();
  });
});
