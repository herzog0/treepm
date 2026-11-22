import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const SLOW = 8000;

describe("the map and the agent-work marker", () => {
  it("names the working ticket to a screen reader, and stops saying so when the marker expires", async () => {
    const until = new Date(Date.now() + 2_500).toISOString();
    const client = makeClient({
      projects: [makeProject("p1", "ALFA", "Projeto Alfa")],
      people: [makePerson("person-1", "Ana")],
      tickets: {
        p1: [
          makeTicket("t1", "p1", 1, "Escrever o teste", { key: "ALFA-1", agentWork: { since: new Date().toISOString(), until, note: null } }),
          makeTicket("t2", "p1", 2, "Publicar", { key: "ALFA-2" }),
        ],
      },
    });
    render(<OrganizationMap client={client} me={makePanelMe("admin")} />);
    await userEvent.click(await screen.findByRole("button", { name: /ALFA · Projeto Alfa/ }));
    await userEvent.click(within(screen.getByRole("complementary", { name: "Nó selecionado" })).getByRole("button", { name: "Explorar ramo" }));
    const working = await screen.findByRole("button", { name: /ALFA-1 · Escrever o teste/ }, { timeout: SLOW });
    expect(working).toHaveAccessibleName(/Em trabalho pela IA/);
    expect(await screen.findByRole("button", { name: /ALFA-2 · Publicar/ })).not.toHaveAccessibleName(/Em trabalho pela IA/);
    await waitFor(() => expect(screen.getByRole("button", { name: /ALFA-1 · Escrever o teste/ })).not.toHaveAccessibleName(/Em trabalho pela IA/), { timeout: SLOW });
  }, 20_000);
});
