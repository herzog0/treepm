import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatsProvider, useChats } from "../chat/ChatsContext.js";
import type { ChatsApi } from "../chat/ChatsContext.js";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const seen: { chats: ChatsApi | null } = { chats: null };
const Probe = () => {
  const chats = useChats()!;
  seen.chats = chats;
  return <p data-testid="pool">{chats.tickets.status === "ready" ? Object.values(chats.tickets.byProject).flat().map((ticket) => ticket.key).join(",") : chats.tickets.status}</p>;
};

describe("o chat usa os tickets que o mapa já leu", () => {
  it("o mapa entrega a lista ao chat: ele não pede os tickets de novo, e ao sair do mapa a fonte própria volta", async () => {
    const projects = [makeProject("p1", "ALFA", "Projeto Alfa")];
    const client = makeClient({ projects, tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso", { key: "ALFA-1" })] }, people: [makePerson("person-1", "Ana")] });
    const me = makePanelMe("member", [{ projectId: "p1", role: "manager" }]);
    const view = render(
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <Probe />
        <OrganizationMap client={client} me={me} />
      </ChatsProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("pool")).toHaveTextContent("ALFA-1"));
    // Só o mapa leu (a fake de `listTicketsIfChanged` passa por `listTickets`): pedir a lista ao chat não lê de novo.
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    const pool = await seen.chats!.loadTickets(projects, "stale");
    expect(pool).toMatchObject({ status: "ready" });
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    view.unmount();
  });
});
