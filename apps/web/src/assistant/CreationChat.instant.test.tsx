import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, ApiResult, ConversationDetail } from "../api/client.js";
import { failed, makeClient, makeConversation, makeProject, ok } from "../test/fakes.js";
import { ChatHarness } from "../test/mountChat.js";
import { REVEAL_MAX_MS, REVEAL_STEP_MS } from "./Reveal.js";

/** "O chat responde na hora" (TREEPM-194): a mensagem aparece ao enviar, o esqueleto espera, a resposta é revelada aos poucos. */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const LONG = Array.from({ length: 30 }, (_, index) => `palavra${index + 1}`).join(" ");
const reply = (body: string, extra: Partial<ConversationDetail> = {}) =>
  makeConversation("c-new", "p1", {
    messages: [
      { id: "m1", author: "person", body: "Primeira", model: null, createdAt: "x" },
      { id: "m2", author: "assistant", body, model: "m", createdAt: "y" },
    ],
    ...extra,
  });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(extra: Partial<Record<keyof ApiClient, unknown>> = {}, props: Record<string, unknown> = {}) {
  const client = makeClient({ projects: [alfa] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([])),
    getConversation: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    openConversation: vi.fn(async () => ok(reply("Entendi."))),
    sendConversationMessage: vi.fn(async (id: string) => ok(makeConversation(id, "p1"))),
    getConversationPreview: vi.fn(async () => failed("unavailable")),
    ...extra,
  });
  render(
    <ChatHarness
      client={client}
      projects={[alfa]}
      initialProjectId="p1"
      tickets={{ p1: [] }}
      resume={false}


      onCreated={vi.fn()}
      onManualCreate={vi.fn()}
      onDraftChange={vi.fn()}
      onChanged={vi.fn()}
      registerPicker={vi.fn()}
      {...props}
    />,
  );
  return client;
}
const box = () => screen.getByRole("textbox", { name: "Mensagem para o assistente" });
const sheet = () => screen.getByRole("region", { name: "Novo ticket com o assistente" });
const list = () => within(sheet().querySelector<HTMLElement>(".assistant-scroll")!);
const skeleton = () => sheet().querySelector(".assistant-skeleton");
const live = () => screen.getByRole("status", { name: "Resposta do assistente" });
/** Digita sem o `userEvent` (que não anda com o relógio falso): muda o campo e envia o formulário. */
const submit = (text: string) => {
  fireEvent.change(box(), { target: { value: text } });
  fireEvent.submit(box().closest("form")!);
};
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const reducedMotion = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null }));

afterEach(() => {
  vi.useRealTimers();
});

describe("the message goes first", () => {
  it("shows the message in the conversation, empties the field and shows the skeleton while the request is pending", async () => {
    const pending = deferred<ApiResult<ConversationDetail>>();
    setup({ openConversation: vi.fn(() => pending.promise) });
    await userEvent.type(box(), "Minha primeira{Enter}");
    expect(list().getByText("Minha primeira")).toBeInTheDocument();
    expect(box()).toHaveValue("");
    expect(skeleton()).not.toBeNull();
    expect(skeleton()).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("O assistente está respondendo…")).toBeInTheDocument();
    expect(sheet().querySelector(".assistant-hint")).toBeNull();
    await act(async () => pending.resolve(ok(reply("Entendi."))));
  });

  it("scrolls the list down to the message at once", async () => {
    const pending = deferred<ApiResult<ConversationDetail>>();
    setup({ openConversation: vi.fn(() => pending.promise) });
    const scroller = sheet().querySelector<HTMLElement>(".assistant-scroll")!;
    Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 900 });
    await userEvent.type(box(), "Oi{Enter}");
    expect(scroller.scrollTop).toBe(900);
    await act(async () => pending.resolve(ok(reply("Entendi."))));
  });

  it("the skeleton goes away when the reply arrives, and the sent message is shown once", async () => {
    const pending = deferred<ApiResult<ConversationDetail>>();
    setup({ openConversation: vi.fn(() => pending.promise) });
    await userEvent.type(box(), "Primeira{Enter}");
    await act(async () => pending.resolve(ok(reply("Entendi."))));
    await waitFor(() => expect(skeleton()).toBeNull());
    expect(list().getAllByText("Primeira")).toHaveLength(1);
    await waitFor(() => expect(list().getByText("Entendi.")).toBeInTheDocument());
  });

  it("the next message of an open conversation also shows at once", async () => {
    const pending = deferred<ApiResult<ConversationDetail>>();
    setup({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(() => pending.promise),
    }, { resume: true });
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Sim, em todas{Enter}");
    expect(list().getByText("Sim, em todas")).toBeInTheDocument();
    expect(list().getByText("O login quebra no Safari")).toBeInTheDocument();
    expect(skeleton()).not.toBeNull();
    await act(async () => pending.resolve(ok(makeConversation("c1", "p1"))));
  });

  it("keeps the draft on screen while the next reply is pending", async () => {
    const pending = deferred<ApiResult<ConversationDetail>>();
    setup({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(() => pending.promise),
    }, { resume: true });
    expect(await screen.findByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
    await userEvent.type(box(), "Mais um detalhe{Enter}");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
    await act(async () => pending.resolve(ok(makeConversation("c1", "p1", { draft: { title: "Outro título", description: "x" } }))));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Outro título"));
  });
});

describe("the reply is revealed little by little", () => {
  it("shows the reply word by word, whole after at most 1,5 s", async () => {
    vi.useFakeTimers();
    setup({ openConversation: vi.fn(async () => ok(reply(LONG))) });
    submit("Primeira");
    await flush();
    expect(list().queryByText(LONG)).toBeNull();
    const bubble = () => sheet().querySelector(".assistant-reply")!;
    expect(bubble().textContent).toBe("");
    act(() => { vi.advanceTimersByTime(REVEAL_STEP_MS * 2); });
    expect(bubble().textContent).toBe("palavra1 palavra2 ");
    act(() => { vi.advanceTimersByTime(REVEAL_MAX_MS); });
    expect(bubble().textContent).toBe(LONG);
  });

  it("the screen reader gets the whole reply once, and the partial text is hidden from it", async () => {
    vi.useFakeTimers();
    setup({ openConversation: vi.fn(async () => ok(reply(LONG))) });
    submit("Primeira");
    await flush();
    expect(live()).toHaveTextContent(LONG);
    expect(sheet().querySelector(".assistant-reply")).toHaveAttribute("aria-hidden", "true");
    act(() => { vi.advanceTimersByTime(REVEAL_MAX_MS); });
    expect(sheet().querySelector(".assistant-reply")).not.toHaveAttribute("aria-hidden");
    expect(live()).toHaveTextContent(LONG);
  });

  it("with reduced motion the reply appears whole at once", async () => {
    reducedMotion();
    vi.useFakeTimers();
    setup({ openConversation: vi.fn(async () => ok(reply(LONG))) });
    submit("Primeira");
    await flush();
    expect(sheet().querySelector(".assistant-reply")!.textContent).toBe(LONG);
  });

  it("a key press shows the rest at once", async () => {
    vi.useFakeTimers();
    setup({ openConversation: vi.fn(async () => ok(reply(LONG))) });
    submit("Primeira");
    await flush();
    act(() => { vi.advanceTimersByTime(REVEAL_STEP_MS); });
    expect(sheet().querySelector(".assistant-reply")!.textContent).not.toBe(LONG);
    fireEvent.keyDown(box(), { key: "x" });
    expect(sheet().querySelector(".assistant-reply")!.textContent).toBe(LONG);
  });

  it("a click shows the rest at once", async () => {
    vi.useFakeTimers();
    setup({ openConversation: vi.fn(async () => ok(reply(LONG))) });
    submit("Primeira");
    await flush();
    fireEvent.pointerDown(sheet());
    expect(sheet().querySelector(".assistant-reply")!.textContent).toBe(LONG);
  });

  it("a resumed conversation shows its history whole, without revealing it", async () => {
    setup({ listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])) }, { resume: true });
    expect(await screen.findByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument();
    expect(sheet().querySelector(".assistant-reply")).not.toHaveAttribute("aria-hidden");
  });
});

describe("a failure keeps the message", () => {
  const unavailable = () => vi.fn().mockResolvedValueOnce(failed("unavailable", "assistant_unavailable")).mockResolvedValue(ok(makeConversation("c-new", "p1", { messages: [
    { id: "m1", author: "person", body: "Meu texto", model: null, createdAt: "x" },
    { id: "m2", author: "assistant", body: "Entendi.", model: "m", createdAt: "y" },
  ] })));

  it("the sent message stays in the conversation, marked as unanswered, with Tentar de novo", async () => {
    setup({ openConversation: unavailable() });
    await userEvent.type(box(), "Meu texto{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("O assistente não respondeu");
    expect(list().getByText("Meu texto")).toBeInTheDocument();
    expect(list().getByText("Não respondida")).toBeInTheDocument();
    expect(skeleton()).toBeNull();
    expect(box()).toHaveValue("");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("Tentar de novo sends the same message again and the mark goes away", async () => {
    const openConversation = unavailable();
    setup({ openConversation });
    await userEvent.type(box(), "Meu texto{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(openConversation).toHaveBeenCalledTimes(2));
    expect(openConversation).toHaveBeenLastCalledWith("p1", { message: "Meu texto", scopeId: null });
    await waitFor(() => expect(list().getByText("Entendi.")).toBeInTheDocument());
    expect(list().queryByText("Não respondida")).toBeNull();
    expect(list().getAllByText("Meu texto")).toHaveLength(1);
  });

  it("a failed message in an open conversation stays after the earlier ones", async () => {
    setup({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")),
    }, { resume: true });
    await screen.findByText("O login quebra no Safari");
    await userEvent.type(box(), "Sim{Enter}");
    expect(await screen.findByText("Não respondida")).toBeInTheDocument();
    expect(list().getByText("Entendi. Isso acontece em todas as versões?")).toBeInTheDocument();
    expect(list().getByText("Sim")).toBeInTheDocument();
  });

  it("the draft does not go away on a failure", async () => {
    setup({
      listConversations: vi.fn(async () => ok([{ ...makeConversation("c1", "p1"), messages: undefined }])),
      sendConversationMessage: vi.fn(async () => failed("unavailable", "assistant_unavailable")),
    }, { resume: true });
    await screen.findByRole("textbox", { name: "Título" });
    await userEvent.type(box(), "Sim{Enter}");
    await screen.findByText("Não respondida");
    expect(screen.getByRole("textbox", { name: "Título" })).toHaveValue("Corrigir o login");
  });
});
