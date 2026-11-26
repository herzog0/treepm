import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, Label, Me, Project } from "../api/client.js";
import { makeProject, makeTicket } from "../test/fakes.js";
import type { FakeLabelStep } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

// ADR 0065: a lista de etiquetas nas configurações do projeto; renomear, trocar a cor e apagar são de quem administra.
const alpha = makeProject("p1", "ALFA", "Alfa");
const bug: Label = { id: "l-bug", name: "Bug", color: "rose" };
const front: Label = { id: "l-front", name: "Front", color: "cyan" };
const old: Label = { id: "l-old", name: "Velha", color: "gray" };
const tickets = [
  makeTicket("t1", "p1", 1, "Um", { labels: [bug, front] }),
  makeTicket("t2", "p1", 2, "Dois", { labels: [bug] }),
  makeTicket("t3", "p1", 3, "Três", { labels: [bug] }),
];
const admin = makePanelMe("admin");
const manager = makePanelMe("member", [{ projectId: "p1", role: "manager" }]);
const reader = makePanelMe("member", [{ projectId: "p1", role: "reader" }]);

function setup(me: Me, options: { labels?: Label[]; labelScript?: FakeLabelStep[]; project?: Project } = {}) {
  const project = options.project ?? alpha;
  const client = makePanelClient({ projects: [project], people: [makePerson("person-1", "Ana")], me, tickets: { p1: tickets.map((ticket) => ({ ...ticket })) }, labels: { p1: options.labels ?? [bug, front, old] }, labelScript: options.labelScript ?? [] });
  render(<ProjectsSection client={client} me={me} projects={[project]} selectedProject={project} onChanged={vi.fn()} />);
  return { client };
}
const section = () => screen.findByRole("region", { name: "Etiquetas" });
const rowOf = async (name: string) => {
  const list = await within(await section()).findByRole("list", { name: "Etiquetas do projeto" });
  return within(list).getAllByRole("listitem").find((item) => within(item).queryByText(name) !== null)!;
};
const user = () => userEvent.setup();

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("Detalhe do projeto › Etiquetas", () => {
  it("lista as etiquetas com a pastilha e quantos tickets usam cada uma, no plural certo", async () => {
    setup(reader);
    expect(within(await rowOf("Bug")).getByText("3 tickets")).toBeInTheDocument();
    expect(within(await rowOf("Front")).getByText("1 ticket")).toBeInTheDocument();
    expect(within(await rowOf("Velha")).getByText("Nenhum ticket")).toBeInTheDocument();
    expect((await rowOf("Bug")).querySelector(".label-pill[data-color='rose']")).not.toBeNull();
  });

  it("quem não administra vê a lista sem controles", async () => {
    setup(reader);
    const row = await rowOf("Bug");
    expect(within(row).queryAllByRole("button")).toEqual([]);
    expect(within(row).queryByRole("group", { name: "Cor da etiqueta Bug" })).toBeNull();
    expect(within(await section()).queryAllByRole("button")).toEqual([]);
  });

  it("lista vazia diz que não há etiquetas e onde se criam", async () => {
    setup(manager, { labels: [] });
    expect(await within(await section()).findByText("Nenhuma etiqueta neste projeto. As etiquetas são criadas na página do ticket.")).toBeInTheDocument();
  });

  it("renomeia em linha: Enter grava uma vez só, com o nome novo", async () => {
    const { client } = setup(manager);
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Renomear etiqueta Bug" }));
    const field = screen.getByRole("textbox", { name: "Novo nome da etiqueta Bug" });
    expect(field).toHaveFocus();
    await u.clear(field);
    await u.type(field, "Defeito");
    expect(client.updateProjectLabel).not.toHaveBeenCalled();
    await u.keyboard("{Enter}");
    expect(client.updateProjectLabel).toHaveBeenCalledTimes(1);
    expect(client.updateProjectLabel).toHaveBeenCalledWith("p1", "l-bug", { name: "Defeito" });
    expect(within(await rowOf("Defeito")).getByText("3 tickets")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Renomear etiqueta Defeito" })).toHaveFocus());
  });

  it("Esc cancela a edição sem gravar e devolve o foco", async () => {
    const { client } = setup(admin);
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Renomear etiqueta Bug" }));
    await u.type(screen.getByRole("textbox", { name: "Novo nome da etiqueta Bug" }), "zzz");
    await u.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "Novo nome da etiqueta Bug" })).toBeNull();
    expect(screen.getByRole("button", { name: "Renomear etiqueta Bug" })).toHaveFocus();
    expect(client.updateProjectLabel).not.toHaveBeenCalled();
  });

  it.each([
    ["Front", "Já existe uma etiqueta com esse nome neste projeto."],
    ["   ", "O nome da etiqueta não pode ficar vazio nem ser longo demais."],
  ])("renomear para «%s» mostra o erro e mantém a edição", async (name, message) => {
    setup(admin);
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Renomear etiqueta Bug" }));
    const field = screen.getByRole("textbox", { name: "Novo nome da etiqueta Bug" });
    await u.clear(field);
    await u.type(field, `${name}{Enter}`);
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("textbox", { name: "Novo nome da etiqueta Bug" })).toBeInTheDocument();
  });

  it("enquanto grava, o botão de salvar fica aria-disabled e não manda de novo, sem perder o foco", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client } = setup(admin, { labelScript: [{ hold }] });
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Renomear etiqueta Bug" }));
    const field = screen.getByRole("textbox", { name: "Novo nome da etiqueta Bug" });
    await u.clear(field);
    await u.type(field, "Defeito{Enter}");
    const save = screen.getByRole("button", { name: "Salvar" });
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).not.toBeDisabled();
    await u.click(save);
    await u.keyboard("{Enter}");
    expect(client.updateProjectLabel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(document.body);
    release();
    await rowOf("Defeito");
  });

  const colorsOf = async (name: string) => within(await rowOf(name)).getByRole("group", { name: `Cor da etiqueta ${name}` });

  it("troca a cor pelas oito opções (botões com aria-pressed), com o nome de cada cor", async () => {
    const { client } = setup(admin);
    const u = user();
    const colors = await colorsOf("Bug");
    const options = within(colors).getAllByRole("button");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual(["Cinza", "Marrom", "Laranja", "Oliva", "Ciano", "Anil", "Violeta", "Rosa"]);
    expect(within(colors).queryAllByRole("radio")).toEqual([]);
    expect(within(colors).getByRole("button", { name: "Rosa" })).toHaveAttribute("aria-pressed", "true");
    expect(options.filter((option) => option.getAttribute("aria-pressed") === "true")).toHaveLength(1);
    await u.click(within(colors).getByRole("button", { name: "Oliva" }));
    expect(client.updateProjectLabel).toHaveBeenCalledTimes(1);
    expect(client.updateProjectLabel).toHaveBeenCalledWith("p1", "l-bug", { color: "olive" });
    await waitFor(async () => expect((await rowOf("Bug")).querySelector(".label-pill[data-color='olive']")).not.toBeNull());
    expect(within(await colorsOf("Bug")).getByRole("button", { name: "Oliva" })).toHaveAttribute("aria-pressed", "true");
  });

  it("tabindex itinerante: só a cor atual entra no Tab; as setas movem o foco sem gravar", async () => {
    const { client } = setup(admin);
    const u = user();
    const colors = await colorsOf("Bug");
    const rose = within(colors).getByRole("button", { name: "Rosa" });
    expect(within(colors).getAllByRole("button").filter((option) => option.tabIndex === 0)).toEqual([rose]);
    rose.focus();
    await u.keyboard("{ArrowLeft}");
    expect(within(colors).getByRole("button", { name: "Violeta" })).toHaveFocus();
    await u.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(within(colors).getByRole("button", { name: "Ciano" })).toHaveFocus();
    expect(within(colors).getByRole("button", { name: "Ciano" }).tabIndex).toBe(0);
    expect(rose.tabIndex).toBe(-1);
    await u.keyboard("{ArrowRight}");
    expect(within(colors).getByRole("button", { name: "Anil" })).toHaveFocus();
    expect(client.updateProjectLabel).not.toHaveBeenCalled();
    expect(rose).toHaveAttribute("aria-pressed", "true");
    // Nas pontas a seta dá a volta.
    within(colors).getByRole("button", { name: "Rosa" }).focus();
    await u.keyboard("{ArrowRight}");
    expect(within(colors).getByRole("button", { name: "Cinza" })).toHaveFocus();
    expect(client.updateProjectLabel).not.toHaveBeenCalled();
  });

  it.each([["{Enter}"], [" "]])("%s grava a cor em foco uma vez e o foco fica no botão", async (key) => {
    const { client } = setup(admin);
    const u = user();
    within(await colorsOf("Bug")).getByRole("button", { name: "Rosa" }).focus();
    await u.keyboard("{ArrowLeft}");
    await u.keyboard(key);
    expect(client.updateProjectLabel).toHaveBeenCalledTimes(1);
    expect(client.updateProjectLabel).toHaveBeenCalledWith("p1", "l-bug", { color: "violet" });
    await waitFor(async () => expect((await rowOf("Bug")).querySelector(".label-pill[data-color='violet']")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Violeta", pressed: true })).toHaveFocus();
  });

  it("enquanto grava a cor, o grupo fica aria-disabled, nada fica disabled, não manda de novo e o foco fica no botão", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client } = setup(admin, { labelScript: [{ hold }] });
    const u = user();
    const colors = await colorsOf("Bug");
    await u.click(within(colors).getByRole("button", { name: "Oliva" }));
    const olive = within(colors).getByRole("button", { name: "Oliva" });
    expect(olive).toHaveAttribute("aria-pressed", "true");
    expect(olive).toHaveAttribute("aria-disabled", "true");
    for (const option of within(colors).getAllByRole("button")) expect(option).not.toBeDisabled();
    await u.click(within(colors).getByRole("button", { name: "Anil" }));
    within(colors).getByRole("button", { name: "Oliva" }).focus();
    await u.keyboard("{ArrowRight}{Enter}");
    expect(client.updateProjectLabel).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(document.body);
    release();
    await waitFor(async () => expect((await rowOf("Bug")).querySelector(".label-pill[data-color='olive']")).not.toBeNull());
    await waitFor(() => expect(within(colors).getByRole("button", { name: "Oliva" })).not.toHaveAttribute("aria-disabled"));
  });

  it("apagar pede confirmação dizendo de quantos tickets a etiqueta sai", async () => {
    const { client } = setup(admin);
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Apagar etiqueta Bug" }));
    expect(within(await rowOf("Bug")).getByText("Apagar a etiqueta Bug? Ela sai de 3 tickets.")).toBeInTheDocument();
    expect(client.removeProjectLabel).not.toHaveBeenCalled();
    await u.click(screen.getByRole("button", { name: "Confirmar: Apagar etiqueta Bug" }));
    expect(client.removeProjectLabel).toHaveBeenCalledWith("p1", "l-bug");
    await waitFor(async () => expect(within(await section()).queryByText("Bug")).toBeNull());
  });

  it.each([
    ["Front", "Apagar a etiqueta Front? Ela sai de 1 ticket."],
    ["Velha", "Apagar a etiqueta Velha? Nenhum ticket usa ela."],
  ])("confirmação de %s", async (name, message) => {
    setup(admin);
    await user().click(within(await rowOf(name)).getByRole("button", { name: `Apagar etiqueta ${name}` }));
    expect(within(await rowOf(name)).getByText(message)).toBeInTheDocument();
  });

  it("apagar: o foco vai para Confirmar, fica num botão durante a gravação e Cancelar devolve ao Apagar", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { client } = setup(admin, { labelScript: [{ hold }] });
    const u = user();
    await u.click(within(await rowOf("Front")).getByRole("button", { name: "Apagar etiqueta Front" }));
    await u.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("button", { name: "Apagar etiqueta Front" })).toHaveFocus();
    await u.click(screen.getByRole("button", { name: "Apagar etiqueta Front" }));
    const confirm = screen.getByRole("button", { name: "Confirmar: Apagar etiqueta Front" });
    expect(confirm).toHaveFocus();
    await u.click(confirm);
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(document.activeElement).not.toBe(document.body);
    await u.click(confirm);
    expect(client.removeProjectLabel).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(screen.getByRole("heading", { name: "Etiquetas" })).toHaveFocus());
  });

  it("clicar na cor deixa o foco no botão escolhido", async () => {
    setup(admin);
    const u = user();
    await u.click(within(await colorsOf("Bug")).getByRole("button", { name: "Oliva" }));
    await waitFor(async () => expect((await rowOf("Bug")).querySelector(".label-pill[data-color='olive']")).not.toBeNull());
    expect(screen.getByRole("button", { name: "Oliva", pressed: true })).toHaveFocus();
  });

  it("erro ao apagar aparece na linha", async () => {
    const { client } = setup(admin, { labelScript: [{ error: ["not_found", "label_not_found"] }] });
    const u = user();
    await u.click(within(await rowOf("Bug")).getByRole("button", { name: "Apagar etiqueta Bug" }));
    await u.click(screen.getByRole("button", { name: "Confirmar: Apagar etiqueta Bug" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Essa etiqueta não existe mais.");
    expect(document.activeElement).not.toBe(document.body);
    // A mensagem diz que a lista foi atualizada: ela é lida de novo.
    await waitFor(() => expect(client.listProjectLabels).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["en", "Labels", "Project labels", "3 tickets", "Delete label Bug", "Delete the label Bug? It will be removed from 3 tickets."],
    ["es-MX", "Etiquetas", "Etiquetas del proyecto", "3 tickets", "Borrar etiqueta Bug", "¿Borrar la etiqueta Bug? Se quitará de 3 tickets."],
  ] as const)("em %s", async (language, region, list, count, remove, message) => {
    await setTestLanguage(language);
    setup(admin);
    const listEl = await within(await screen.findByRole("region", { name: region })).findByRole("list", { name: list });
    const row = within(listEl).getAllByRole("listitem")[0]!;
    expect(within(row).getByText(count)).toBeInTheDocument();
    await user().click(within(row).getByRole("button", { name: remove }));
    expect(within(row).getByText(message)).toBeInTheDocument();
  });
});

describe("Detalhe do projeto › Etiquetas: erro de carga", () => {
  it("mostra o erro com texto", async () => {
    const me = admin;
    const client = makePanelClient({ projects: [alpha], people: [makePerson("person-1", "Ana")], me, labels: { p1: [bug] } });
    Object.assign(client, { listProjectLabels: vi.fn(async () => ({ ok: false, error: { kind: "unavailable" } })) });
    render(<ProjectsSection client={client as ApiClient} me={me} projects={[alpha]} selectedProject={alpha} onChanged={vi.fn()} />);
    expect(await within(await section()).findByRole("alert")).toBeInTheDocument();
    expect(within(await section()).queryByRole("list", { name: "Etiquetas do projeto" })).toBeNull();
  });
});

// Revisão E1 (TREEPM-466), item 5.
describe("Etiquetas nas configurações: revisão E1", () => {
  const calls = (fn: unknown) => (fn as { mock: { calls: unknown[][] } }).mock.calls;

  it("Renomear abre com o nome ATUAL (renomeada por outra pessoa e lista recarregada) e Enter sem mexer não grava", async () => {
    const { client } = setup(admin);
    const u = user();
    await rowOf("Bug");
    await (client as ApiClient).updateProjectLabel("p1", "l-bug", { name: "Defeito" }); // outra pessoa
    // Qualquer gravação desta tela recarrega a lista.
    await u.click(within(await rowOf("Front")).getByRole("button", { name: "Oliva" }));
    const row = await waitFor(async () => {
      const found = await rowOf("Defeito");
      expect(found).toBeTruthy();
      return found;
    });
    const before = calls(client.updateProjectLabel).length;
    await u.click(within(row).getByRole("button", { name: "Renomear etiqueta Defeito" }));
    const field = screen.getByRole("textbox", { name: "Novo nome da etiqueta Defeito" }) as HTMLInputElement;
    expect(field.value).toBe("Defeito");
    await u.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(client.updateProjectLabel).slice(before)).toEqual([]);
    // Espaços nas pontas também não são mudança.
    await u.click(within(await rowOf("Defeito")).getByRole("button", { name: "Renomear etiqueta Defeito" }));
    await u.type(screen.getByRole("textbox", { name: "Novo nome da etiqueta Defeito" }), "  {Enter}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls(client.updateProjectLabel).slice(before)).toEqual([]);
  });

  it("depois de apagar, enquanto a lista recarrega, um segundo clique em Confirmar não manda outro DELETE nem mostra erro", async () => {
    const { client } = setup(admin);
    const u = user();
    await rowOf("Front");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = client.listProjectLabels;
    client.listProjectLabels = vi.fn(async (projectId: string) => {
      await gate;
      return original(projectId);
    }) as ApiClient["listProjectLabels"];
    await u.click(within(await rowOf("Front")).getByRole("button", { name: "Apagar etiqueta Front" }));
    const confirm = screen.getByRole("button", { name: "Confirmar: Apagar etiqueta Front" });
    await u.click(confirm);
    await waitFor(() => expect(calls(client.removeProjectLabel).length).toBe(1));
    const still = screen.queryByRole("button", { name: "Confirmar: Apagar etiqueta Front" });
    if (still) await u.click(still);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const alert = screen.queryByRole("alert")?.textContent ?? null;
    release();
    expect({ deletes: calls(client.removeProjectLabel).length, alert }).toEqual({ deletes: 1, alert: null });
  });

  it("projeto arquivado: quem administra vê a lista, sem Renomear, Apagar nem as cores", async () => {
    setup(admin, { project: makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-11-01T00:00:00.000Z" }) });
    const list = await within(await section()).findByRole("list", { name: "Etiquetas do projeto" });
    expect({ botoes: within(list).queryAllByRole("button").length, linhas: within(list).getAllByRole("listitem").length }).toEqual({ botoes: 0, linhas: 3 });
  });
});
