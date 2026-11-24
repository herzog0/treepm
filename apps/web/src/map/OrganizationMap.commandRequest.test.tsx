import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Me } from "../api/client.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import type { CommandRequest } from "./commandRequest.js";
import { OrganizationMap } from "./OrganizationMap.js";

const SLOW = 20_000;
const withAssistant = (me: Me, enabled = true): Me => ({ ...me, assistant: { enabled } });
const client = () => makeClient({ projects: [makeProject("p1", "ALFA", "Projeto Alfa")], tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" })] }, people: [makePerson("person-1", "Ana")] });

// A barra lateral (ADR 0055) pede "Novo ticket" e "Buscar" à barra de pedidos do mapa.
describe("requests from the sidebar to the command bar", () => {
  it("'search' puts the focus on the bar field and is handled once", async () => {
    const handled = vi.fn();
    const request: CommandRequest = { kind: "search", id: 1 };
    render(<OrganizationMap client={client()} me={withAssistant(makePanelMe("admin"))} commandRequest={request} onCommandHandled={handled} />);
    const field = await screen.findByRole("combobox", { name: "Peça qualquer coisa" }, { timeout: SLOW });
    await waitFor(() => expect(field).toHaveFocus(), { timeout: SLOW });
    expect(handled).toHaveBeenCalledTimes(1);
  }, SLOW);

  it("'new' without the assistant only takes the focus to the field", async () => {
    render(<OrganizationMap client={client()} me={withAssistant(makePanelMe("admin"), false)} commandRequest={{ kind: "new", id: 1 }} onCommandHandled={vi.fn()} />);
    const field = await screen.findByRole("combobox", { name: "Peça qualquer coisa" }, { timeout: SLOW });
    await waitFor(() => expect(field).toHaveFocus(), { timeout: SLOW });
  }, SLOW);
});
