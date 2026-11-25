import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { makeClient, makeLinearConnection, makeProject } from "../test/fakes.js";
import type { FakeLinearCategorize } from "../test/fakes.js";
import { useLinearCategorize } from "./useLinearCategorize.js";

const LINKED = { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true };

function setup(categorize: FakeLinearCategorize = {}, options: { enabled?: boolean } = {}) {
  const client = makeClient({ projects: [makeProject("p1", "ENG", "Engenharia")], linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, categorize: { candidates: 10, ...categorize } } });
  const hook = renderHook(() => useLinearCategorize(client, "p1", { enabled: options.enabled ?? true }));
  return { client, hook };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("useLinearCategorize: o laço de passos", () => {
  it("sem rodada, só lê a situação e não dá passo", async () => {
    const { client, hook } = setup();
    await flush();
    expect(client.getLinearCategorize).toHaveBeenCalledWith("p1");
    expect(hook.result.current.load).toEqual({ status: "ready" });
    expect(hook.result.current.overview).toMatchObject({ candidates: 10, available: true, reason: null });
    expect(hook.result.current.run).toBeNull();
    expect(client.stepLinearCategorize).not.toHaveBeenCalled();
  });

  it("depois de abrir, dá um passo por vez até acabar e então relê a situação", async () => {
    let running = 0;
    let overlapped = false;
    const { client, hook } = setup({ plan: { placed: 6, toCheck: 2, kept: 2 }, pageSize: 4 });
    const step = client.stepLinearCategorize;
    client.stepLinearCategorize = vi.fn(async (...args: Parameters<ApiClient["stepLinearCategorize"]>) => {
      running += 1;
      if (running > 1) overlapped = true;
      await Promise.resolve();
      const result = await step(...args);
      running -= 1;
      return result;
    });
    await flush();
    const readsBefore = vi.mocked(client.getLinearCategorize).mock.calls.length;
    await act(async () => { await hook.result.current.open(); });
    expect(hook.result.current.watched).toBe(true);
    await advance(10);
    expect(vi.mocked(client.stepLinearCategorize)).toHaveBeenCalledTimes(3);
    expect(overlapped).toBe(false);
    expect(hook.result.current.run).toMatchObject({ finished: true, phase: "done", placed: 6, toCheck: 2, kept: 2, done: 10 });
    expect(hook.result.current.loop).toEqual({ kind: "idle" });
    expect(vi.mocked(client.getLinearCategorize).mock.calls.length).toBeGreaterThan(readsBefore);
    expect(hook.result.current.overview?.candidates).toBe(0);
  });

  it("ao abrir com rodada aberta, retoma sozinho (e marca que viu a rodada andar)", async () => {
    const { client, hook } = setup({ existing: { total: 10, done: 4, placed: 4 } });
    await flush();
    await advance(10);
    expect(client.stepLinearCategorize).toHaveBeenCalled();
    expect(hook.result.current.run?.finished).toBe(true);
  });

  it("não retoma quando desligado, nem dá passo em rodada que já terminou", async () => {
    const off = setup({ existing: { total: 10, done: 4 } }, { enabled: false });
    await advance(100);
    expect(off.client.stepLinearCategorize).not.toHaveBeenCalled();
    const done = setup({ existing: { phase: "done", finished: true, total: 10, done: 10 } });
    await advance(100);
    expect(done.client.stepLinearCategorize).not.toHaveBeenCalled();
    expect(done.hook.result.current.run?.finished).toBe(true);
    expect(done.hook.result.current.watched).toBe(false);
  });

  it("espera a hora pedida e só então chama de novo, com um temporizador só", async () => {
    const { client, hook } = setup({ existing: { total: 10 }, script: [{ waitSeconds: 30 }] });
    await flush();
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loop).toEqual({ kind: "waiting", until: "2026-11-25T12:00:30.000Z" });
    expect(vi.getTimerCount()).toBe(1);
    await advance(29_000);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
    await advance(1_100);
    expect(vi.mocked(client.stepLinearCategorize).mock.calls.length).toBeGreaterThan(1);
  });

  it("erro do provedor (200 sem avançar): tenta de novo com recuo, mostra o erro em sequência e se recupera", async () => {
    const { client, hook } = setup({ existing: { total: 10 }, script: ["providerError", "providerError"] });
    await flush();
    expect(hook.result.current.run?.errorStreak).toBe(1);
    expect(hook.result.current.loop).toEqual({ kind: "retrying", failures: 1 });
    await advance(1_900);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
    await advance(200);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(2);
    expect(hook.result.current.run?.errorStreak).toBe(2);
    await advance(3_700);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(2);
    await advance(200);
    await advance(10);
    expect(hook.result.current.run?.finished).toBe(true);
    expect(hook.result.current.run?.errorStreak).toBe(0);
  });

  it.each([["forbidden", "assistant_consent_required"], ["unavailable", "assistant_not_configured"]] as const)("%s/%s: para com o erro e só segue ao continuar", async (kind, code) => {
    const { client, hook } = setup({ existing: { total: 10 }, script: [{ error: [kind, code] }] });
    await flush();
    await advance(60_000);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loop).toMatchObject({ kind: "stopped", error: { code } });
    act(() => hook.result.current.resume());
    await advance(10);
    expect(hook.result.current.run?.finished).toBe(true);
  });

  it.each(["linear_step_in_progress", "structure_busy"])("%s: espera 2 s e tenta de novo, sem alarme", async (code) => {
    const { client, hook } = setup({ existing: { total: 10 }, script: [{ error: ["conflict", code] }] });
    await flush();
    expect(hook.result.current.loop).toEqual({ kind: "busy" });
    await advance(1_900);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
    await advance(300);
    expect(vi.mocked(client.stepLinearCategorize).mock.calls.length).toBeGreaterThan(1);
  });

  it("cinco falhas de rede seguidas param o laço até 'Tentar de novo'", async () => {
    const { client, hook } = setup({ existing: { total: 10 }, script: Array.from({ length: 5 }, () => ({ error: ["unavailable"] as [string] })) as never });
    await flush();
    await advance(60_000);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(5);
    expect(hook.result.current.loop).toEqual({ kind: "gave_up" });
    act(() => hook.result.current.resume());
    await advance(10);
    expect(hook.result.current.run?.finished).toBe(true);
  });

  it("abandonar para o laço, deixa a rodada em 'failed' e relê a situação", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { client, hook } = setup({ existing: { total: 10, done: 2 }, script: [{ hold }] });
    await flush();
    release();
    await advance(0);
    await act(async () => { await hook.result.current.abandon(); });
    await advance(100);
    expect(hook.result.current.run).toMatchObject({ phase: "failed", finished: true });
    expect(client.abandonLinearCategorize).toHaveBeenCalledWith("p1", "cat-1");
    expect(hook.result.current.loop).toEqual({ kind: "idle" });
  });

  it("limpeza: ao desmontar no meio da espera, nenhum passo depois e nenhum temporizador vivo", async () => {
    const { client, hook } = setup({ existing: { total: 10 }, script: [{ waitSeconds: 30 }] });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(120_000);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
  });

  it("limpeza: a resposta de um passo no ar depois de desmontar é ignorada", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { client, hook } = setup({ existing: { total: 10 }, script: [{ hold }] });
    await flush();
    hook.unmount();
    release();
    await advance(1_000);
    expect(client.stepLinearCategorize).toHaveBeenCalledTimes(1);
  });

  it("abrir com erro devolve o erro e relê a situação quando outra aba já abriu", async () => {
    const { client, hook } = setup({ openError: ["conflict", "linear_categorize_open"] });
    await flush();
    const reads = vi.mocked(client.getLinearCategorize).mock.calls.length;
    let result: Awaited<ReturnType<typeof hook.result.current.open>> | undefined;
    await act(async () => { result = await hook.result.current.open(); });
    expect(result).toMatchObject({ ok: false, error: { code: "linear_categorize_open" } });
    await flush();
    expect(vi.mocked(client.getLinearCategorize).mock.calls.length).toBeGreaterThan(reads);
  });
});
