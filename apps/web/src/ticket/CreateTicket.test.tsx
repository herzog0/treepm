import { render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveValue("Falha no Safari.");
    expect(screen.getByRole("button", { name: "Criar" })).toBeEnabled();
  });

  it("opens empty without a draft, as before", () => {
    show({ projectId: "p1", parentId: null });
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Descrição" })).toHaveValue("");
  });
});
