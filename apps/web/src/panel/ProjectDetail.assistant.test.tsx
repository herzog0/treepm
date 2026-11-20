import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { makeProject } from "../test/fakes.js";
import { ProjectsSection } from "./ProjectsSection.js";
import { makePanelClient, makePanelMe, makePerson } from "./testing.js";

const alpha = makeProject("p1", "ALFA", "Alfa");

function setup(assistantAvailable: boolean) {
  const onCreateTicket = vi.fn();
  const client = makePanelClient({ projects: [alpha], people: [makePerson("person-1", "Ana")] });
  render(<ProjectsSection client={client} me={makePanelMe("admin")} projects={[alpha]} selectedProject={alpha} onChanged={vi.fn()} onCreateTicket={onCreateTicket} assistantAvailable={assistantAvailable} />);
  return { onCreateTicket };
}

describe("manual ticket creation next to the assistant button", () => {
  it("with the assistant on, the floating Novo ticket is the main action: this one becomes a secondary 'Criar sem o assistente'", async () => {
    const { onCreateTicket } = setup(true);
    const manual = await screen.findByRole("button", { name: "Criar sem o assistente" });
    expect(manual).not.toHaveClass("primary");
    expect(screen.queryByRole("button", { name: "Novo ticket" })).not.toBeInTheDocument();
    await userEvent.click(manual);
    expect(onCreateTicket).toHaveBeenCalledWith("p1", "ticket");
  });

  it("Novo agrupador is offered with the assistant on too, since the assistant only creates tickets", async () => {
    const { onCreateTicket } = setup(true);
    await userEvent.click(await screen.findByRole("button", { name: "Novo agrupador" }));
    expect(onCreateTicket).toHaveBeenCalledWith("p1", "group");
  });

  it("with the assistant off, it stays the primary 'Novo ticket'", async () => {
    setup(false);
    expect(await screen.findByRole("button", { name: "Novo ticket" })).toHaveClass("primary");
  });
});
