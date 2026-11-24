import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyActAsRejected, readActAs, writeActAs } from "../api/actAs.js";
import { createApiClient } from "../api/client.js";
import type { ApiClient } from "../api/client.js";
import { ChatsProvider, useChats } from "../chat/ChatsContext.js";
import { lastIdeasProject, rememberIdeasProject } from "../ideas/session.js";
import { ActAsProvider, useActAs } from "./ActAs.js";

afterEach(() => window.sessionStorage.clear());

/** Uma "tela" que carrega dados ao montar e guarda estado local: o que a remontagem tem de zerar. */
function Screen({ load }: { load: (as: string | null) => void }) {
  const { acting, enter, leave } = useActAs();
  const [local, setLocal] = useState("");
  useEffect(() => load(acting?.id ?? null), []);
  return (
    <div>
      <input aria-label="rascunho" value={local} onChange={(event) => setLocal(event.target.value)} />
      <button type="button" onClick={() => enter({ id: "p-bia", displayName: "Bia" })}>entrar</button>
      <button type="button" onClick={leave}>sair</button>
      <p data-testid="quem">{acting?.id ?? "eu"}</p>
    </div>
  );
}

function mount(load = vi.fn()) {
  render(
    <StrictMode>
      <ActAsProvider>
        <Screen load={load} />
      </ActAsProvider>
    </StrictMode>,
  );
  return load;
}

describe("ActAsProvider", () => {
  it("entrar remonta a árvore: os dados são pedidos de novo como a outra pessoa e o estado local some; voltar também", async () => {
    const user = userEvent.setup();
    const load = mount();
    const initial = load.mock.calls.length;
    await user.type(screen.getByLabelText("rascunho"), "texto do administrador");
    await user.click(screen.getByText("entrar"));
    expect(screen.getByLabelText("rascunho")).toHaveValue("");
    expect(load.mock.calls.length).toBeGreaterThan(initial);
    expect(load.mock.calls.at(-1)).toEqual(["p-bia"]);
    expect(screen.getByRole("status")).toHaveTextContent("Você está vendo como Bia (teste)");
    const afterEnter = load.mock.calls.length;
    await user.type(screen.getByLabelText("rascunho"), "texto da Bia");
    await user.click(screen.getByText("sair"));
    expect(screen.getByLabelText("rascunho")).toHaveValue("");
    expect(load.mock.calls.length).toBeGreaterThan(afterEnter);
    expect(load.mock.calls.at(-1)).toEqual([null]);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("começa no modo guardado na aba", () => {
    writeActAs({ id: "p-bia", displayName: "Bia" });
    mount();
    expect(screen.getByTestId("quem")).toHaveTextContent("p-bia");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("quando o servidor recusa, sai do modo sozinha e avisa", async () => {
    writeActAs({ id: "p-bia", displayName: "Bia" });
    mount();
    act(() => notifyActAsRejected("p-bia"));
    await waitFor(() => expect(screen.getByTestId("quem")).toHaveTextContent("eu"));
    expect(readActAs()).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível continuar como Bia");
    await userEvent.setup().click(screen.getByRole("button", { name: "Dispensar" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sem sessionStorage (lança) a aplicação continua funcionando como a própria pessoa", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    mount();
    expect(screen.getByTestId("quem")).toHaveTextContent("eu");
    spy.mockRestore();
  });
});

describe("sobras fora da árvore", () => {
  it("o último projeto de Ideias (estado de módulo) é zerado ao entrar e ao voltar", async () => {
    const user = userEvent.setup();
    mount();
    rememberIdeasProject("projeto-do-admin");
    await user.click(screen.getByText("entrar"));
    expect(lastIdeasProject()).toBeNull();
    rememberIdeasProject("projeto-da-bia");
    await user.click(screen.getByText("sair"));
    expect(lastIdeasProject()).toBeNull();
  });
});

describe("uma fonte só: o cliente da árvore", () => {
  const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
  const headerOf = (fetch: ReturnType<typeof respond>, call: number) =>
    new Headers((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].headers).get("x-treepm-act-as");

  it("manda o cabeçalho que lhe foi dado na criação, em todo pedido, e nenhum sem pessoa", async () => {
    const fetch = respond(200, []);
    await createApiClient({ getToken: async () => "tok", fetch }).listPeople();
    expect(headerOf(fetch, 0)).toBeNull();
    const client = createApiClient({ getToken: async () => "tok", fetch, actAsId: "p-bia" });
    await client.listPeople();
    await client.listTicketsIfChanged("p1", null);
    expect(headerOf(fetch, 1)).toBe("p-bia");
    expect(headerOf(fetch, 2)).toBe("p-bia");
  });

  it("não depende do sessionStorage: item apagado no meio, o cabeçalho continua o mesmo", async () => {
    writeActAs({ id: "p-bia", displayName: "Bia" });
    const fetch = respond(200, []);
    const client = createApiClient({ getToken: async () => "tok", fetch, actAsId: "p-bia" });
    window.sessionStorage.clear();
    await client.listPeople();
    expect(headerOf(fetch, 0)).toBe("p-bia");
  });

  it("setItem que lança: a faixa aparece e os pedidos da árvore saem com o cabeçalho (a faixa e o cabeçalho têm a mesma fonte)", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("cota");
    });
    const fetch = respond(200, []);
    function Probe() {
      const { acting, enter } = useActAs();
      const client = useMemo(() => createApiClient({ getToken: async () => "tok", fetch, actAsId: acting?.id ?? null }), [acting?.id]);
      return (
        <div>
          <button type="button" onClick={() => enter({ id: "p-bia", displayName: "Bia" })}>entrar</button>
          <button type="button" onClick={() => void client.listPeople()}>pedir</button>
        </div>
      );
    }
    render(<ActAsProvider><Probe /></ActAsProvider>);
    const user = userEvent.setup();
    await user.click(screen.getByText("entrar"));
    expect(screen.getByRole("status")).toHaveTextContent("vendo como Bia");
    await user.click(screen.getByText("pedir"));
    expect(headerOf(fetch, 0)).toBe("p-bia");
    spy.mockRestore();
  });

  it("recarregar a página mantém o modo: o sessionStorage só restaura", async () => {
    writeActAs({ id: "p-bia", displayName: "Bia" });
    mount();
    expect(screen.getByTestId("quem")).toHaveTextContent("p-bia");
    expect(screen.getByRole("status")).toHaveTextContent("Bia");
  });

  it("pedido em andamento ao sair: sai com o cabeçalho de quando nasceu, e a recusa tardia dele não derruba o modo seguinte", async () => {
    const user = userEvent.setup();
    const fetchSpy = respond(403, { error: { code: "act_as_not_allowed", message: "x" } });
    let oldClient: ReturnType<typeof createApiClient> | null = null;
    function Probe() {
      const { acting, enter, leave } = useActAs();
      const client = useMemo(() => createApiClient({ getToken: async () => "tok", fetch: fetchSpy, actAsId: acting?.id ?? null }), [acting?.id]);
      useEffect(() => {
        if (acting?.id === "p-bia") oldClient = client;
      }, [acting?.id, client]);
      return (
        <div>
          <button type="button" onClick={() => enter({ id: "p-bia", displayName: "Bia" })}>entrar</button>
          <button type="button" onClick={() => enter({ id: "p-caio", displayName: "Caio" })}>entrar2</button>
          <button type="button" onClick={leave}>sair</button>
          <p data-testid="quem">{acting?.id ?? "eu"}</p>
        </div>
      );
    }
    render(<ActAsProvider><Probe /></ActAsProvider>);
    await user.click(screen.getByText("entrar"));
    await user.click(screen.getByText("sair"));
    await user.click(screen.getByText("entrar2"));
    // Um pedido que a árvore da Bia ainda tinha no ar volta recusado: o modo é o do Caio e continua.
    await act(async () => void (await oldClient!.listPeople()));
    expect(headerOf(fetchSpy, 0)).toBe("p-bia");
    expect(screen.getByTestId("quem")).toHaveTextContent("p-caio");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("avisa, com a pessoa que o pedido levava, quando o servidor responde act_as_not_allowed", async () => {
    const rejected = vi.fn();
    const { onActAsRejected } = await import("../api/actAs.js");
    const off = onActAsRejected(rejected);
    const client = createApiClient({ getToken: async () => "tok", fetch: respond(403, { error: { code: "act_as_not_allowed", message: "x" } }), actAsId: "p-bia" });
    const result = await client.listPeople();
    off();
    expect(result.ok).toBe(false);
    expect(rejected).toHaveBeenCalledExactlyOnceWith("p-bia");
  });
});

describe("ActAsProvider e as conversas", () => {
  const client = { listConversationTree: async () => ({ ok: true, data: { items: [] } }), getMe: async () => ({ ok: false, error: { kind: "unavailable" } }) } as unknown as ApiClient;
  function Probe() {
    const chats = useChats()!;
    const { enter, leave } = useActAs();
    return (
      <div>
        <button type="button" onClick={() => { chats.setCreationMode(true); chats.markNewTicket("t1"); chats.creationMemory.write("thread-1", { notice: { ticketId: "t1", warnings: [] } }); }}>marcar</button>
        <button type="button" onClick={() => enter({ id: "p-bia", displayName: "Bia" })}>entrar</button>
        <button type="button" onClick={leave}>sair</button>
        <p data-testid="estado">{`${chats.creationMode}|${chats.newTickets.size}|${chats.creationMemory.read("thread-1") === undefined ? "sem memória" : "com memória"}`}</p>
      </div>
    );
  }

  it("entrar como outra pessoa, e voltar, zera o modo 'novo ticket', os tickets 'novos' e a memória das threads de criação", async () => {
    const user = userEvent.setup();
    render(
      <ActAsProvider>
        <ChatsProvider client={client} onShowTicket={() => undefined}>
          <Probe />
        </ChatsProvider>
      </ActAsProvider>,
    );
    await user.click(screen.getByText("marcar"));
    expect(screen.getByTestId("estado")).toHaveTextContent("true|1|com memória");
    await user.click(screen.getByText("entrar"));
    expect(screen.getByTestId("estado")).toHaveTextContent("false|0|sem memória");
    await user.click(screen.getByText("marcar"));
    await user.click(screen.getByText("sair"));
    expect(screen.getByTestId("estado")).toHaveTextContent("false|0|sem memória");
  });
});
