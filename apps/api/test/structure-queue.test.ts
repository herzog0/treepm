import { HttpException } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructureQueueAborted, structureKey, structureQueue, structureQueueKeys, withStructureSlot } from "../src/tickets/structure-queue.js";

/**
 * Fila em memória das mudanças de estrutura (ADR 0045, adendo 1). Só tempo falso e promessas controladas: nenhum banco.
 * Cada teste nomeia o que a fila deve fazer; nenhum espera "por sorte".
 */
const gate = () => {
  let open!: () => void;
  let fail!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { promise, open, fail };
};
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("fila de estrutura por chave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("deixa no máximo 2 em voo por chave e os demais entram na ordem de chegada", async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof gate>>();
    const run = (name: string) => {
      const g = gate();
      gates.set(name, g);
      return withStructureSlot("p1", async () => {
        order.push(name);
        await g.promise;
      });
    };
    const all = ["a", "b", "c", "d", "e"].map(run);
    await flush();
    expect(order).toEqual(["a", "b"]);
    gates.get("a")!.open();
    await flush();
    expect(order).toEqual(["a", "b", "c"]); // c, não d: a ordem de chegada vale, e quem chega depois não fura
    gates.get("c")!.open();
    await flush();
    expect(order).toEqual(["a", "b", "c", "d"]);
    gates.get("b")!.open();
    gates.get("d")!.open();
    await flush();
    gates.get("e")!.open();
    await Promise.all(all);
    expect(order).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("chaves diferentes não esperam umas pelas outras", async () => {
    const started: string[] = [];
    const g = gate();
    const held = ["p1", "p1", "p2"].map((key, i) => withStructureSlot(key, async () => (started.push(`${key}#${i}`), g.promise)));
    const third = withStructureSlot("p1", async () => started.push("p1#fila"));
    await flush();
    expect(started).toEqual(["p1#0", "p1#1", "p2#2"]); // p2 passou direto; o terceiro de p1 espera
    g.open();
    await Promise.all([...held, third]);
    expect(started).toContain("p1#fila");
  });

  it("quem espera mais de 3 s recebe 409 structure_busy e não ocupa a vaga depois", async () => {
    expect(structureQueue.waitMs).toBe(3000);
    const g = gate();
    const inFlight = [1, 2].map(() => withStructureSlot("p1", () => g.promise));
    const waiter = withStructureSlot("p1", async () => "nunca");
    const caught = waiter.then(() => null, (error: unknown) => error);
    await vi.advanceTimersByTimeAsync(2999);
    let settled = false;
    void caught.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await caught) as HttpException;
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(409);
    expect((error.getResponse() as { code: string }).code).toBe("structure_busy");
    // a vaga que o desistente não chegou a ter não é entregue a ninguém: o próximo que chegar ainda espera a liberação real
    let next = false;
    const after = withStructureSlot("p1", async () => (next = true));
    await flush();
    expect(next).toBe(false);
    g.open();
    await Promise.all([...inFlight, after]);
    expect(next).toBe(true);
  });

  it("devolve a vaga quando o trabalho falha", async () => {
    await expect(withStructureSlot("p1", async () => Promise.reject(new Error("falhou")))).rejects.toThrow("falhou");
    await expect(withStructureSlot("p1", async () => Promise.reject(new Error("falhou 2")))).rejects.toThrow("falhou 2");
    const done: string[] = [];
    await Promise.all(["a", "b"].map((n) => withStructureSlot("p1", async () => void done.push(n))));
    expect(done).toEqual(["a", "b"]);
    expect(structureQueueKeys()).toBe(0);
  });

  it("requisição abortada enquanto espera sai da fila sem levar a vaga; a em voo só devolve a sua ao terminar", async () => {
    const g = gate();
    const inFlight = [1, 2].map(() => withStructureSlot("p1", () => g.promise));
    const controller = new AbortController();
    const waiter = withStructureSlot("p1", async () => "nunca", controller.signal);
    const caught = waiter.then(() => null, (error: unknown) => error);
    await flush();
    controller.abort();
    expect(await caught).toBeInstanceOf(Error);
    let next = false;
    const after = withStructureSlot("p1", async () => (next = true));
    await flush();
    expect(next).toBe(false); // abortar não abriu uma terceira vaga
    g.open();
    await Promise.all([...inFlight, after]);
    expect(next).toBe(true);
  });

  it("já abortada antes de chegar: nem entra na fila", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = false;
    await expect(withStructureSlot("p1", async () => (ran = true), controller.signal)).rejects.toBeInstanceOf(Error);
    expect(ran).toBe(false);
    expect(structureQueueKeys()).toBe(0);
  });

  it("chave que ficou vazia não fica na memória (sucesso, erro, estouro de prazo e aborto)", async () => {
    await withStructureSlot("ok", async () => 1);
    await withStructureSlot("erro", async () => Promise.reject(new Error("x"))).catch(() => undefined);
    const g = gate();
    const held = [1, 2].map(() => withStructureSlot("prazo", () => g.promise));
    const late = withStructureSlot("prazo", async () => 1).catch(() => "busy");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await late).toBe("busy");
    g.open();
    await Promise.all(held);
    const controller = new AbortController();
    const h = gate();
    const aborted = [1, 2].map(() => withStructureSlot("aborto", () => h.promise));
    const w = withStructureSlot("aborto", async () => 1, controller.signal).catch(() => "aborted");
    controller.abort();
    expect(await w).toBe("aborted");
    h.open();
    await Promise.all(aborted);
    expect(structureQueueKeys()).toBe(0);
  });

  it("o limite e a espera ficam num objeto exportado, para os testes de integração reduzirem", () => {
    expect(structureQueue).toEqual({ limit: 2, waitMs: 3000 });
  });

  it("a chave é organização + projeto, com o projeto em minúsculas; id fora do formato não entra na fila", () => {
    const id = "0195A3B2-7C4D-7E21-8F00-1234567890AB";
    expect(structureKey("org_1", id)).toBe(`org_1:${id.toLowerCase()}`);
    expect(structureKey("org_1", id.toLowerCase())).toBe(structureKey("org_1", id));
    expect(structureKey("org_2", id)).not.toBe(structureKey("org_1", id));
    expect(structureKey("org_1", "nao-e-uuid")).toBeUndefined();
    expect(structureKey("org_1", "")).toBeUndefined();
    expect(structureKey("org_1", undefined)).toBeUndefined();
  });

  it("quem desiste na fila (aborto) recebe StructureQueueAborted, uma exceção própria que não é erro de verdade", async () => {
    const g = gate();
    const held = [1, 2].map(() => withStructureSlot("p1", () => g.promise));
    const controller = new AbortController();
    const waiter = withStructureSlot("p1", async () => "nunca", controller.signal).catch((e: unknown) => e);
    await flush();
    controller.abort();
    expect(await waiter).toBeInstanceOf(StructureQueueAborted);
    g.open();
    await Promise.all(held);
  });

  it("o relógio de espera não segura o encerramento do processo (timer com unref)", async () => {
    const unref = vi.fn();
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const timer = real(fn, ms) as unknown as { unref: () => void };
      const original = timer.unref.bind(timer);
      timer.unref = () => (unref(), original());
      return timer;
    }) as unknown as typeof setTimeout);
    try {
      const g = gate();
      const held = [1, 2].map(() => withStructureSlot("p1", () => g.promise));
      const waiter = withStructureSlot("p1", async () => 1);
      await flush();
      expect(unref).toHaveBeenCalled();
      g.open();
      await Promise.all([...held, waiter]);
    } finally {
      spy.mockRestore();
    }
  });
});
