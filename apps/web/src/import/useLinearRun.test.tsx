import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/client.js";
import { failed, makeClient, makeLinearConnection, makeLinearRun, makeProject, ok } from "../test/fakes.js";
import type { FakeLinearRun } from "../test/fakes.js";
import { useLinearRun } from "./useLinearRun.js";

const LINKED = { source: { workspace: { id: "ws-acme", name: "Acme" }, team: { id: "t1", key: "ENG", name: "Engenharia" }, linkedAt: "2026-11-24T10:00:00.000Z", linkedBy: { id: "person-1" } }, canLink: false, keyMatches: true };

function setup(run: FakeLinearRun = {}, options: { enabled?: boolean } = {}) {
  const client = makeClient({ projects: [makeProject("p1", "ENG", "Engenharia")], linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run } });
  const hook = renderHook(() => useLinearRun(client, "p1", { enabled: options.enabled ?? true }));
  return { client, hook };
}
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-24T12:00:00.000Z")); });
afterEach(() => { vi.useRealTimers(); });

describe("useLinearRun: o laço de passos", () => {
  it("sem rodada, lê a atual e não dá passo nenhum", async () => {
    const { client, hook } = setup();
    await flush();
    expect(client.getCurrentLinearRun).toHaveBeenCalledWith("p1");
    expect(hook.result.current.load).toEqual({ status: "ready" });
    expect(hook.result.current.run).toBeNull();
    expect(client.stepLinearRun).not.toHaveBeenCalled();
  });

  it("depois de abrir, anda pelas fases na ordem, um passo por vez, ", async () => {
    const phases: string[] = [];
    let running = 0;
    let overlapped = false;
    const { client, hook } = setup({ total: 12, pageSize: 5 });
    const step = client.stepLinearRun;
    client.stepLinearRun = vi.fn(async (...args: Parameters<ApiClient["stepLinearRun"]>) => {
      running += 1;
      if (running > 1) overlapped = true;
      await Promise.resolve();
      const result = await step(...args);
      running -= 1;
      if (result.ok) phases.push(result.data.phase);
      return result;
    });
    await flush();
    await act(async () => { await hook.result.current.open({ destinationTicketId: null }); });
    await advance(10);
    expect(phases).toEqual(["issues", "issues", "issues", "hierarchy", "mentions", "comments", "done"]);
    expect(overlapped).toBe(false);
    expect(hook.result.current.run?.done).toBe(true);
    expect(hook.result.current.loop).toEqual({ kind: "idle" });
  });

  it("ao abrir com uma rodada em aberto, retoma sozinho", async () => {
    const { client, hook } = setup({ existing: { phase: "issues", counts: { issuesSeen: 5 } } });
    await flush();
    await advance(10);
    expect(client.stepLinearRun).toHaveBeenCalled();
    expect(hook.result.current.run?.done).toBe(true);
  });

  it("não retoma quando desligado (chave que não serve)", async () => {
    const { client } = setup({ existing: { phase: "issues" } }, { enabled: false });
    await advance(100);
    expect(client.stepLinearRun).not.toHaveBeenCalled();
  });

  it("não dá passo numa rodada já concluída", async () => {
    const { client, hook } = setup({ existing: { phase: "done", done: true } });
    await advance(100);
    expect(client.stepLinearRun).not.toHaveBeenCalled();
    expect(hook.result.current.run?.done).toBe(true);
  });

  it("espera a hora do limite e só então chama de novo, com um temporizador só", async () => {
    const { client, hook } = setup({ existing: { phase: "issues" }, script: [{ waitSeconds: 30 }] });
    await flush();
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loop).toEqual({ kind: "waiting", until: "2026-11-24T12:00:30.000Z" });
    expect(vi.getTimerCount()).toBe(1);
    await advance(29_000);
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    await advance(1_100);
    expect(vi.mocked(client.stepLinearRun).mock.calls.length).toBeGreaterThan(1);
  });

  it.each(["linear_step_in_progress", "structure_busy"])("%s: espera 2 s e tenta de novo, sem alarme", async (code) => {
    const { client, hook } = setup({ existing: { phase: "issues" }, script: [{ error: ["conflict", code] }] });
    await flush();
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    expect(hook.result.current.loop.kind).toBe("busy");
    await advance(1_900);
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    await advance(200);
    expect(vi.mocked(client.stepLinearRun).mock.calls.length).toBeGreaterThan(1);
    expect(hook.result.current.loop.kind).not.toBe("stopped");
  });

  it("503: recua cada vez mais e desiste depois de 5 falhas seguidas", async () => {
    const script = Array.from({ length: 8 }, () => ({ error: ["unavailable", "linear_unavailable"] as ["unavailable", string] }));
    const { client, hook } = setup({ existing: { phase: "issues" }, script });
    await flush();
    const calls = () => (client.stepLinearRun as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls()).toBe(1);
    expect(hook.result.current.loop).toEqual({ kind: "retrying", failures: 1 });
    await advance(2_000); expect(calls()).toBe(2);
    await advance(3_900); expect(calls()).toBe(2);
    await advance(200); expect(calls()).toBe(3);
    await advance(8_000); expect(calls()).toBe(4);
    await advance(16_000); expect(calls()).toBe(5);
    expect(hook.result.current.loop).toEqual({ kind: "gave_up" });
    await advance(600_000);
    expect(calls()).toBe(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("'Tentar de novo' retoma depois de desistir; um sucesso zera a contagem", async () => {
    const script = Array.from({ length: 5 }, () => ({ error: ["unavailable", "linear_unavailable"] as ["unavailable", string] }));
    const { client, hook } = setup({ existing: { phase: "issues" }, script });
    await flush();
    await advance(40_000);
    expect(hook.result.current.loop).toEqual({ kind: "gave_up" });
    act(() => hook.result.current.resume());
    await advance(10);
    expect(hook.result.current.run?.done).toBe(true);
    expect((client.stepLinearRun as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5 + 6);
  });

  it("erro de chave para o laço e guarda o erro; 'Continuar' retoma", async () => {
    const { client, hook } = setup({ existing: { phase: "issues" }, script: [{ error: ["unavailable", "linear_key_invalid"] }] });
    await flush();
    expect(hook.result.current.loop).toEqual({ kind: "stopped", error: { kind: "unavailable", code: "linear_key_invalid" } });
    await advance(600_000);
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.resume());
    await advance(10);
    expect(hook.result.current.run?.done).toBe(true);
  });

  it("o limite que vem como erro 429 vira espera pelo prazo dito", async () => {
    const client = makeClient({ projects: [makeProject("p1", "ENG", "Engenharia")], linear: { connection: makeLinearConnection(), projects: { p1: LINKED }, run: { existing: { phase: "issues" } } } });
    const step = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: "unavailable", code: "linear_rate_limited", details: { retryAfterSeconds: 20 } } })
      .mockImplementation(client.stepLinearRun);
    client.stepLinearRun = step;
    const hook = renderHook(() => useLinearRun(client, "p1", { enabled: true }));
    await flush();
    expect(hook.result.current.loop).toEqual({ kind: "waiting", until: "2026-11-24T12:00:20.000Z" });
    await advance(19_000);
    expect(step).toHaveBeenCalledTimes(1);
    await advance(1_500);
    expect(step.mock.calls.length).toBeGreaterThan(1);
  });

  it("ao desmontar não sobra temporizador nem passo", async () => {
    const { client, hook } = setup({ existing: { phase: "issues" }, script: [{ waitSeconds: 60 }] });
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(600_000);
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
  });

  it("desmontar com um passo no ar não dispara o seguinte", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const { client, hook } = setup({ existing: { phase: "issues" }, script: [{ hold }] });
    await flush();
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    hook.unmount();
    release();
    await advance(600_000);
    expect(client.stepLinearRun).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("abrir com uma rodada já aberta (outra aba) devolve o erro e relê a atual", async () => {
    const { client, hook } = setup({ existing: { phase: "projects" } }, { enabled: false });
    await flush();
    const result = await act(async () => hook.result.current.open({ destinationTicketId: null }));
    expect(result).toEqual(failed("conflict", "linear_run_open"));
    expect(client.getCurrentLinearRun).toHaveBeenCalledTimes(2);
  });

  it("erro ao ler a rodada atual aparece como erro de carga e pode tentar de novo", async () => {
    const client = makeClient({ linear: { connection: makeLinearConnection() } });
    client.getCurrentLinearRun = vi.fn().mockResolvedValueOnce(failed("unavailable", "linear_unavailable")).mockResolvedValue(ok({ run: makeLinearRun({ phase: "done", done: true }) }));
    const hook = renderHook(() => useLinearRun(client, "p1", { enabled: true }));
    await flush();
    expect(hook.result.current.load).toEqual({ status: "error", error: { kind: "unavailable", code: "linear_unavailable" } });
    act(() => hook.result.current.reload());
    await flush();
    expect(hook.result.current.load).toEqual({ status: "ready" });
    expect(hook.result.current.run?.done).toBe(true);
  });
});

describe("useLinearRun: reimportação (ADR 0060, seção 5)", () => {
  const FIRST = { phase: "done" as const, done: true, finishedAt: "2026-11-22T12:00:00.000Z", destinationTicketId: "t9", counts: { issuesCreated: 12, projectsCreated: 3 } };

  it("lê a última rodada concluída como lastFinished", async () => {
    const { hook } = setup({ existing: FIRST });
    await flush();
    expect(hook.result.current.lastFinished).toMatchObject({ phase: "done", finishedAt: "2026-11-22T12:00:00.000Z" });
    expect(hook.result.current.run?.done).toBe(true);
  });

  it("sem importação concluída, lastFinished é nulo", async () => {
    const { hook } = setup();
    await flush();
    expect(hook.result.current.lastFinished).toBeNull();
  });

  it("abre sem destino (herda), anda pelas fases incluindo 'missing' e atualiza lastFinished ao concluir", async () => {
    const phases: string[] = [];
    const { client, hook } = setup({ existing: FIRST, total: 4, pageSize: 5, reimportCounts: { updated: 2, keptMoved: 1 } });
    const step = client.stepLinearRun;
    client.stepLinearRun = vi.fn(async (...args: Parameters<ApiClient["stepLinearRun"]>) => {
      const result = await step(...args);
      if (result.ok) phases.push(result.data.phase);
      return result;
    });
    await flush();
    let opened: Awaited<ReturnType<typeof hook.result.current.open>> | undefined;
    await act(async () => { opened = await hook.result.current.open({}); });
    expect(client.openLinearRun).toHaveBeenCalledWith("p1", {});
    expect(opened?.ok && opened.data).toMatchObject({ mode: "reimport", destinationTicketId: "t9" });
    await advance(10);
    expect(phases).toEqual(["issues", "hierarchy", "statuses", "mentions", "comments", "missing", "done"]);
    expect(hook.result.current.run).toMatchObject({ done: true, mode: "reimport", counts: { updated: 2, keptMoved: 1 } });
    expect(hook.result.current.lastFinished).toMatchObject({ mode: "reimport", id: hook.result.current.run?.id });
  });

  it("uma rodada abandonada não muda lastFinished", async () => {
    const { hook } = setup({ existing: FIRST }, { enabled: false });
    await flush();
    const before = hook.result.current.lastFinished;
    await act(async () => { await hook.result.current.open({}); });
    await act(async () => { await hook.result.current.abandon(); });
    expect(hook.result.current.run?.phase).toBe("failed");
    expect(hook.result.current.lastFinished).toEqual(before);
  });
});
