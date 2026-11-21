import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeClient, makeProject } from "../test/fakes.js";
import { CreateTicket } from "./CreateTicket.js";

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const show = (request: Parameters<typeof CreateTicket>[0]["request"]) =>
  render(<CreateTicket client={makeClient()} project={project} request={request} onChanged={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} />);

describe("CreateTicket initial values", () => {
  it("opens with the draft title and description already filled in", () => {
    show({ projectId: "p1", parentId: null, draft: { title: "Corrigir o login", description: "Falha no Safari." } });
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveTextContent("Falha no Safari.");
    expect(screen.getByRole("button", { name: "Criar" })).toBeEnabled();
  });

  it("opens empty without a draft, as before", () => {
    show({ projectId: "p1", parentId: null });
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveTextContent("");
  });
});

describe("CreateTicket has no type (ADR 0034)", () => {
  it("is a single 'Novo ticket' form, without a type choice", () => {
    show({ projectId: "p1", parentId: null });
    expect(screen.getByRole("heading", { level: 1, name: "Novo ticket" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/agrupador/i)).not.toBeInTheDocument();
  });

  it("says where it goes without naming a type, inside a ticket and at the root", () => {
    const { unmount } = show({ projectId: "p1", parentId: "t1" });
    expect(screen.getByText("Em Projeto Alfa, dentro do ticket aberto.")).toBeInTheDocument();
    unmount();
    show({ projectId: "p1", parentId: null });
    expect(screen.getByText("Em Projeto Alfa, na raiz do projeto.")).toBeInTheDocument();
  });

  it("sends the title, the description and the parent, and no `kind`", async () => {
    const createTicket = vi.fn(async () => ({ ok: false as const, error: { kind: "unavailable" as const } }));
    const client = { ...makeClient(), createTicket } as unknown as ReturnType<typeof makeClient>;
    render(<CreateTicket client={client} project={project} request={{ projectId: "p1", parentId: "t1", draft: { title: "Corrigir", description: "Texto" } }} onChanged={vi.fn()} onCreated={vi.fn()} onCancel={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect(createTicket).toHaveBeenCalledTimes(1);
    const [, body] = createTicket.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(body).toEqual({ title: "Corrigir", description: "Texto", parentId: "t1" });
    expect("kind" in body).toBe(false);
  });
});

describe("CreateTicket warns that a concluded parent is reopened (ADR 0034)", () => {
  const warning = "«ALFA-7» está concluído e volta para \"A fazer\" ao receber este ticket.";

  it("warns, naming the parent, when the new ticket goes inside a concluded ticket", () => {
    show({ projectId: "p1", parentId: "t7", parent: { key: "ALFA-7", status: "done" } });
    expect(screen.getByText(warning)).toBeInTheDocument();
  });

  it.each(["todo", "in_progress", "in_review", "cancelled"] as const)("does not warn when the parent is %s", (status) => {
    show({ projectId: "p1", parentId: "t7", parent: { key: "ALFA-7", status } });
    expect(screen.queryByText(/volta para/)).not.toBeInTheDocument();
  });

  it("does not warn at the root of the project", () => {
    show({ projectId: "p1", parentId: null });
    expect(screen.queryByText(/volta para/)).not.toBeInTheDocument();
  });
});
