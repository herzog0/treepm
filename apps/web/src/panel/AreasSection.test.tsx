import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Me } from "../api/client.js";
import { failed, ok } from "../test/fakes.js";
import { AreasSection } from "./AreasSection.js";
import { makePanelClient, makePanelMe } from "./testing.js";

const areas = [
  { id: "a1", name: "Design" },
  { id: "a2", name: "Engenharia" },
];

function setup(client: ApiClient, me: Me = makePanelMe("admin")) {
  const onChanged = vi.fn();
  render(<AreasSection client={client} me={me} selectedProject={null} onChanged={onChanged} />);
  return { onChanged };
}

describe("AreasSection — leitura", () => {
  it("mostra carregamento e depois a lista", async () => {
    setup(makePanelClient({ areas }));
    expect(screen.getByRole("status")).toHaveTextContent("Carregando áreas");
    expect(await screen.findByText("Design")).toBeInTheDocument();
    expect(screen.getByText("Engenharia")).toBeInTheDocument();
  });

  it("mostra o estado vazio", async () => {
    setup(makePanelClient({ areas: [] }));
    expect(await screen.findByText("Nenhuma área cadastrada.")).toBeInTheDocument();
  });

  it("mostra o erro de carga e tenta de novo", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.listAreas).mockResolvedValueOnce(failed("unavailable"));
    setup(client);
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível.");
    await userEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Design")).toBeInTheDocument();
  });

  it("não oferece ações a quem não é administrador da organização", async () => {
    setup(makePanelClient({ areas }), makePanelMe("member"));
    await screen.findByText("Design");
    expect(screen.queryByRole("button", { name: /criar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /renomear|remover/i })).not.toBeInTheDocument();
  });
});

describe("AreasSection — administrador", () => {
  it("cria uma área, recarrega a lista e limpa o campo", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.createArea).mockResolvedValue(ok({ id: "a3", name: "Produto" }));
    setup(client);
    await screen.findByText("Design");
    const field = screen.getByRole("textbox", { name: "Nome da nova área" });
    await userEvent.type(field, "Produto");
    await userEvent.click(screen.getByRole("button", { name: "Criar área" }));
    expect(client.createArea).toHaveBeenCalledWith({ name: "Produto" });
    await waitFor(() => expect(client.listAreas).toHaveBeenCalledTimes(2));
    expect(field).toHaveValue("");
  });

  it("não envia nome vazio", async () => {
    const client = makePanelClient({ areas });
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Criar área" }));
    expect(client.createArea).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Informe o nome da área.");
  });

  it("mostra area_name_taken junto do campo e preserva o texto", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.createArea).mockResolvedValue(failed("conflict", "area_name_taken"));
    setup(client);
    await screen.findByText("Design");
    const field = screen.getByRole("textbox", { name: "Nome da nova área" });
    await userEvent.type(field, "Design");
    await userEvent.click(screen.getByRole("button", { name: "Criar área" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe uma área com esse nome.");
    expect(field).toHaveValue("Design");
    expect(client.listAreas).toHaveBeenCalledTimes(1);
  });

  it("desabilita o botão enquanto envia", async () => {
    const client = makePanelClient({ areas });
    let finish: (value: Awaited<ReturnType<ApiClient["createArea"]>>) => void = () => undefined;
    vi.mocked(client.createArea).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    setup(client);
    await screen.findByText("Design");
    await userEvent.type(screen.getByRole("textbox", { name: "Nome da nova área" }), "Produto");
    await userEvent.click(screen.getByRole("button", { name: "Criar área" }));
    expect(screen.getByRole("button", { name: "Criar área" })).toBeDisabled();
    finish(ok({ id: "a3", name: "Produto" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Criar área" })).toBeEnabled());
  });

  it("renomeia em linha", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.renameArea).mockResolvedValue(ok({ id: "a1", name: "UX" }));
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Renomear Design" }));
    const field = screen.getByRole("textbox", { name: "Novo nome de Design" });
    await userEvent.clear(field);
    await userEvent.type(field, "UX");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(client.renameArea).toHaveBeenCalledWith("a1", { name: "UX" });
    await waitFor(() => expect(client.listAreas).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("textbox", { name: "Novo nome de Design" })).not.toBeInTheDocument();
  });

  it("mostra erro de renomeação junto do campo e mantém a edição aberta", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.renameArea).mockResolvedValue(failed("conflict", "area_name_taken"));
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Renomear Design" }));
    const field = screen.getByRole("textbox", { name: "Novo nome de Design" });
    await userEvent.clear(field);
    await userEvent.type(field, "Engenharia");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Já existe uma área com esse nome.");
    expect(field).toHaveValue("Engenharia");
  });

  it("cancela a renomeação", async () => {
    const client = makePanelClient({ areas });
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Renomear Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.queryByRole("textbox", { name: "Novo nome de Design" })).not.toBeInTheDocument();
    expect(client.renameArea).not.toHaveBeenCalled();
  });

  it("remove só depois da confirmação", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.removeArea).mockResolvedValue(ok(undefined));
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Remover Design" }));
    expect(client.removeArea).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    expect(client.removeArea).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(client.listAreas).toHaveBeenCalledTimes(2));
  });

  it("cancela a remoção sem chamar a API", async () => {
    const client = makePanelClient({ areas });
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Remover Design" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(client.removeArea).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remover Design" })).toBeInTheDocument();
  });

  it("mostra erro de remoção na linha da área", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.removeArea).mockResolvedValue(failed("not_found"));
    setup(client);
    await screen.findByText("Design");
    await userEvent.click(screen.getByRole("button", { name: "Remover Design" }));
    await userEvent.click(screen.getByRole("button", { name: /^Confirmar/ }));
    const row = screen.getByText("Design").closest("li") as HTMLElement;
    expect(await within(row).findByRole("alert")).toHaveTextContent("Não encontramos esse item.");
    expect(client.listAreas).toHaveBeenCalledTimes(1);
  });
});

describe("AreasSection — cliente que lança", () => {
  it("trata a carga que lança como erro, sem rejeição", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.listAreas).mockRejectedValueOnce(new Error("boom"));
    setup(client);
    expect(await screen.findByRole("alert")).toHaveTextContent("API indisponível.");
  });

  it("trata a mutação que lança como erro e reabilita o botão", async () => {
    const client = makePanelClient({ areas });
    vi.mocked(client.createArea).mockRejectedValueOnce(new Error("boom"));
    setup(client);
    await screen.findByText("Design");
    await userEvent.type(screen.getByRole("textbox", { name: "Nome da nova área" }), "X");
    await userEvent.click(screen.getByRole("button", { name: "Criar área" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A API está indisponível.");
    expect(screen.getByRole("button", { name: "Criar área" })).toBeEnabled();
  });
});
