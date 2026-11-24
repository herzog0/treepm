import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { makeClient, makeProject, makeTicket } from "../test/fakes.js";
import { ChatsProvider, useChats } from "./ChatsContext.js";
import type { ChatsApi } from "./ChatsContext.js";
import { placement } from "./MentionList.js";

function setup(projects: Project[], tickets: Record<string, TicketSummary[]> = {}) {
  const client = makeClient({ projects, tickets });
  const seen: { api: ChatsApi | null } = { api: null };
  const Probe = () => {
    seen.api = useChats();
    return <p>{seen.api?.tickets.status}</p>;
  };
  render(
    <StrictMode>
      <ChatsProvider client={client} onShowTicket={() => {}}>
        <Probe />
      </ChatsProvider>
    </StrictMode>,
  );
  return { client, api: () => seen.api! };
}

describe("a lista de tickets do chat", () => {
  it("reaproveita os tickets que o mapa já leu: nenhuma requisição, e o mapa que sai devolve a lista própria", async () => {
    const project = makeProject("p1", "ALFA", "Alfa");
    const { client, api } = setup([project]);
    const list = { p1: [makeTicket("t1", "p1", 1, "Login", { key: "ALFA-1" })] };
    act(() => api().shareTickets(list));
    const pool = await api().loadTickets([project]);
    expect(pool).toEqual({ status: "ready", byProject: list, failed: [] });
    expect(client.listTickets).not.toHaveBeenCalled();
    // Quem precisa do "agora" (uma chave desconhecida no envio) lê de novo por conta própria.
    await act(async () => void (await api().loadTickets([project], "fresh")));
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    act(() => api().shareTickets(null));
    await waitFor(() => expect(screen.getByText("ready")).toBeInTheDocument());
  });

  it("lê poucos projetos por vez (no máximo 4) e aceita falha parcial", async () => {
    const projects = Array.from({ length: 9 }, (_, index) => makeProject(`p${index}`, `P${index}`, `Projeto ${index}`));
    const { client, api } = setup(projects);
    let running = 0;
    let peak = 0;
    client.listTickets = vi.fn(async (projectId: string) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return projectId === "p3" ? ({ ok: false, error: { kind: "unavailable" } } as never) : ({ ok: true, data: [] } as never);
    });
    const pool = await api().loadTickets(projects);
    expect(peak).toBeLessThanOrEqual(4);
    expect(pool).toMatchObject({ status: "ready", failed: ["p3"] });
  });

  it("só é erro quando todos os projetos falham, e a próxima carga recente tenta de novo", async () => {
    const projects = [makeProject("p1", "ALFA", "Alfa")];
    const { client, api } = setup(projects);
    client.listTickets = vi.fn(async () => ({ ok: false, error: { kind: "unavailable" } }) as never);
    expect((await api().loadTickets(projects)).status).toBe("error");
    expect((await api().loadTickets(projects, "once")).status).toBe("error");
    expect(client.listTickets).toHaveBeenCalledTimes(1);
    expect((await api().loadTickets(projects, "stale")).status).toBe("error");
    expect(client.listTickets).toHaveBeenCalledTimes(2);
  });
});

describe("onde a lista do seletor fica", () => {
  const viewport = { width: 800, height: 600 };
  const box = new DOMRect(100, 400, 500, 80);
  it("acima da linha do cursor quando cabe", () => {
    const style = placement({ left: 120, top: 420, bottom: 438 }, box, viewport);
    expect(style).toMatchObject({ position: "fixed", bottom: 600 - 420 + 6 });
    expect(style).not.toHaveProperty("top");
  });
  it("abaixo da linha quando em cima não cabe", () => {
    const style = placement({ left: 120, top: 40, bottom: 58 }, new DOMRect(100, 30, 500, 80), viewport);
    expect(style).toMatchObject({ position: "fixed", top: 58 + 6 });
    expect(style).not.toHaveProperty("bottom");
  });
});
