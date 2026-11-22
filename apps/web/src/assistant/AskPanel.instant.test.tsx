import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient, ApiResult, AskAnswer } from "../api/client.js";
import { makeClient, makeProject, failed, ok } from "../test/fakes.js";
import { AskPanel } from "./AskPanel.js";
import { REVEAL_MAX_MS, REVEAL_STEP_MS } from "./Reveal.js";

/** "O chat responde na hora" (TREEPM-194) na folha da pergunta sobre o projeto. */
const alfa = makeProject("p1", "ALFA", "Projeto Alfa");
const LONG = Array.from({ length: 30 }, (_, index) => `palavra${index + 1}`).join(" ");
const answer = (text: string): ApiResult<AskAnswer> => ok({ text, model: "m" });

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(askProject: ApiClient["askProject"]) {
  const client = makeClient({ projects: [alfa] });
  Object.assign(client, { askProject: vi.fn(askProject) });
  const onProgress = vi.fn();
  render(<AskPanel client={client} projects={[alfa]} initialProjectId="p1" incoming={null} tickets={{ p1: [] }} expanded onCollapse={vi.fn()} onNew={vi.fn()} onProgress={onProgress} onOpenTicket={vi.fn()} />);
  return client;
}
const sheet = () => screen.getByRole("region", { name: "Pergunta sobre o projeto" });
const field = () => screen.getByRole("textbox", { name: "Pergunte mais sobre este projeto" });
const list = () => within(sheet().querySelector<HTMLElement>(".assistant-scroll")!);
const skeleton = () => sheet().querySelector(".assistant-skeleton");
const live = () => screen.getByRole("status", { name: "Resposta do assistente" });
const submit = (text: string) => {
  fireEvent.change(field(), { target: { value: text } });
  fireEvent.submit(field().closest("form")!);
};
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const answerText = () => sheet().querySelector(".ask-answer")!;
const reducedMotion = () =>
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false, onchange: null }));

afterEach(() => {
  vi.useRealTimers();
});

describe("the question goes first", () => {
  it("shows the question and the skeleton while the answer is pending, and the field is empty", async () => {
    const pending = deferred<ApiResult<AskAnswer>>();
    setup(() => pending.promise);
    await userEvent.type(field(), "Como está?{Enter}");
    expect(list().getByText("Como está?")).toBeInTheDocument();
    expect(field()).toHaveValue("");
    expect(skeleton()).not.toBeNull();
    expect(skeleton()).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Consultando o projeto…")).toBeInTheDocument();
    await act(async () => pending.resolve(answer("Bem.")));
    await waitFor(() => expect(skeleton()).toBeNull());
  });
});

describe("the answer is revealed little by little", () => {
  it("shows the answer word by word, whole after at most 1,5 s", async () => {
    vi.useFakeTimers();
    setup(async () => answer(LONG));
    submit("Como está?");
    await flush();
    expect(answerText().textContent ?? "").not.toContain("palavra30");
    act(() => { vi.advanceTimersByTime(REVEAL_STEP_MS * 3); });
    expect(answerText().textContent).toContain("palavra3");
    expect(answerText().textContent).not.toContain("palavra4");
    act(() => { vi.advanceTimersByTime(REVEAL_MAX_MS); });
    expect(answerText().textContent).toContain("palavra30");
  });

  it("the screen reader gets the whole answer once; the partial text is hidden from it", async () => {
    vi.useFakeTimers();
    setup(async () => answer(LONG));
    submit("Como está?");
    await flush();
    expect(live()).toHaveTextContent(LONG);
    expect(answerText()).toHaveAttribute("aria-hidden", "true");
    act(() => { vi.advanceTimersByTime(REVEAL_MAX_MS); });
    expect(answerText()).not.toHaveAttribute("aria-hidden");
  });

  it("with reduced motion the answer appears whole at once", async () => {
    reducedMotion();
    vi.useFakeTimers();
    setup(async () => answer(LONG));
    submit("Como está?");
    await flush();
    expect(answerText().textContent).toContain("palavra30");
  });

  it("a key press or a click shows the rest at once", async () => {
    vi.useFakeTimers();
    setup(async () => answer(LONG));
    submit("Como está?");
    await flush();
    act(() => { vi.advanceTimersByTime(REVEAL_STEP_MS); });
    expect(answerText().textContent).not.toContain("palavra30");
    fireEvent.keyDown(field(), { key: "x" });
    expect(answerText().textContent).toContain("palavra30");
    submit("De novo?");
    await flush();
    expect(answerText()).toBeTruthy();
  });
});

describe("failure and cancel", () => {
  it("a failure keeps the question, marked as unanswered, with Tentar de novo", async () => {
    const askProject = vi.fn().mockResolvedValueOnce(failed("unavailable")).mockResolvedValue(answer("Bem."));
    setup(askProject);
    await userEvent.type(field(), "Como está?{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("O assistente não respondeu");
    expect(list().getByText("Como está?")).toBeInTheDocument();
    expect(list().getByText("Não respondida")).toBeInTheDocument();
    expect(skeleton()).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(askProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(list().getByText("Bem.")).toBeInTheDocument());
    expect(list().queryByText("Não respondida")).toBeNull();
    expect(list().getAllByText("Como está?")).toHaveLength(1);
  });

  it("Esc while waiting takes the skeleton away and hands the question back to the field", async () => {
    const pending = deferred<ApiResult<AskAnswer>>();
    setup(() => pending.promise);
    await userEvent.type(field(), "Como está?{Enter}");
    expect(skeleton()).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(skeleton()).toBeNull();
    expect(field()).toHaveValue("Como está?");
    expect(list().queryByText("Como está?")).toBeNull();
    await act(async () => pending.resolve(answer("Tarde demais.")));
    expect(screen.queryByText("Tarde demais.")).toBeNull();
  });
});
