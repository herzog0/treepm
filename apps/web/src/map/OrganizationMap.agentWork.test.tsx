import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const SLOW = 8000;

describe("the map and the agent-work marker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("names the working ticket to a screen reader, and stops saying so when the marker expires", async () => {
    // Sem depender da velocidade da máquina: o relógio (`Date`) fica congelado e o temporizador de expiração do marcador
    // (o único com este atraso exato, `until` - agora) é guardado em vez de agendado; a expiração é provocada ao avançar o
    // relógio e disparar o que foi guardado. Antes, a janela era de 2,5 s reais e fechava antes da asserção sob carga.
    vi.useFakeTimers({ toFake: ["Date"] });
    const WINDOW = 2_345;
    const until = new Date(Date.now() + WINDOW).toISOString();
    const expiry: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, ms?: number, ...rest: unknown[]) => {
      if (ms === WINDOW) {
        expiry.push(() => callback());
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return (realSetTimeout as (...args: unknown[]) => ReturnType<typeof setTimeout>)(callback, ms, ...rest);
    }) as typeof setTimeout);
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
    await waitFor(() => expect(expiry.length).toBeGreaterThan(0), { timeout: SLOW });
    vi.setSystemTime(Date.now() + 3_000);
    act(() => expiry.forEach((fire) => fire()));
    await waitFor(() => expect(screen.getByRole("button", { name: /ALFA-1 · Escrever o teste/ })).not.toHaveAccessibleName(/Em trabalho pela IA/), { timeout: SLOW });
  }, 20_000);
});
