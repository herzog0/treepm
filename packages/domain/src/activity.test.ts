import { describe, expect, it } from "vitest";
import { DESCRIPTION_MERGE_WINDOW_MS, mergeDescriptionEdits } from "./activity.js";
import type { MergeableEntry } from "./activity.js";

const MIN = 60_000;
const edit = (id: string, actorId: string | null, minutes: number): MergeableEntry & { id: string } => ({
  id,
  type: "description_changed",
  actorId,
  occurredAt: minutes * MIN,
});
const other = (id: string, minutes: number, actorId: string | null = "ana"): MergeableEntry & { id: string } => ({
  id,
  type: "status_changed",
  actorId,
  occurredAt: minutes * MIN,
});
const ids = (merged: { entry: { id: string }; oldest: { id: string } }[]) => merged.map((m) => `${m.entry.id}<${m.oldest.id}`);

describe("mergeDescriptionEdits (newest first)", () => {
  it("the window is ten minutes", () => {
    expect(DESCRIPTION_MERGE_WINDOW_MS).toBe(10 * MIN);
  });

  it("keeps an empty list and a single entry as they are", () => {
    expect(mergeDescriptionEdits([])).toEqual([]);
    const only = edit("a", "ana", 5);
    expect(mergeDescriptionEdits([only])).toEqual([{ entry: only, oldest: only }]);
  });

  it("merges consecutive edits by the same person, keeping the newest instant and the oldest identity", () => {
    const merged = mergeDescriptionEdits([edit("c", "ana", 8), edit("b", "ana", 4), edit("a", "ana", 0)]);
    expect(ids(merged)).toEqual(["c<a"]);
    expect(merged[0]?.entry.occurredAt).toBe(8 * MIN);
  });

  it("does not merge edits by different people", () => {
    expect(ids(mergeDescriptionEdits([edit("b", "bia", 4), edit("a", "ana", 0)]))).toEqual(["b<b", "a<a"]);
  });

  it("does not merge edits without an author", () => {
    expect(ids(mergeDescriptionEdits([edit("b", null, 1), edit("a", null, 0)]))).toEqual(["b<b", "a<a"]);
  });

  it("merges just under the limit and splits exactly at it", () => {
    expect(ids(mergeDescriptionEdits([edit("b", "ana", 10 - 0.001), edit("a", "ana", 0)]))).toEqual(["b<a"]);
    expect(ids(mergeDescriptionEdits([edit("b", "ana", 10), edit("a", "ana", 0)]))).toEqual(["b<b", "a<a"]);
  });

  it("measures the gap between one edit and the next, not from the start of the run", () => {
    const merged = mergeDescriptionEdits([edit("d", "ana", 27), edit("c", "ana", 18), edit("b", "ana", 9), edit("a", "ana", 0)]);
    expect(ids(merged)).toEqual(["d<a"]);
  });

  it("another entry in the middle breaks the run", () => {
    const merged = mergeDescriptionEdits([edit("c", "ana", 3), other("x", 2), edit("a", "ana", 1)]);
    expect(ids(merged)).toEqual(["c<c", "x<x", "a<a"]);
  });

  it("never merges other types, even close together by the same person", () => {
    expect(ids(mergeDescriptionEdits([other("b", 1), other("a", 0)]))).toEqual(["b<b", "a<a"]);
  });

  it("gives the same result however the list is cut, as long as the cut falls between merged entries", () => {
    const all = [edit("f", "ana", 40), edit("e", "ana", 35), other("d", 30), edit("c", "bia", 12), edit("b", "ana", 5), edit("a", "ana", 0)];
    const whole = ids(mergeDescriptionEdits(all));
    expect(whole).toEqual(["f<e", "d<d", "c<c", "b<a"]);
    const head = mergeDescriptionEdits(all.slice(0, 3));
    const tail = mergeDescriptionEdits(all.slice(3));
    expect([...ids(head), ...ids(tail)]).toEqual(whole);
  });
});

describe("mergeDescriptionEdits with contribution text edits (ADR 0041)", () => {
  const text = (id: string, contributionId: string | null, minutes: number, actorId: string | null = "ana"): MergeableEntry & { id: string } => ({
    id,
    type: "contribution_text_changed",
    actorId,
    occurredAt: minutes * MIN,
    contributionId,
  });

  it("joins the same person's edits of the same contribution under ten minutes", () => {
    const [a, b, c] = [text("a", "c1", 12), text("b", "c1", 8), text("c", "c1", 1)] as const;
    expect(ids(mergeDescriptionEdits([a, b, c]))).toEqual(["a<c"]);
  });

  it("does not join edits of different contributions", () => {
    expect(ids(mergeDescriptionEdits([text("a", "c2", 5), text("b", "c1", 4)]))).toEqual(["a<a", "b<b"]);
  });

  it("never joins a contribution text edit with a description edit, in either order", () => {
    expect(ids(mergeDescriptionEdits([text("a", "c1", 5), edit("b", "ana", 4)]))).toEqual(["a<a", "b<b"]);
    expect(ids(mergeDescriptionEdits([edit("a", "ana", 5), text("b", "c1", 4)]))).toEqual(["a<a", "b<b"]);
  });

  it("another entry in the middle breaks the sequence", () => {
    expect(ids(mergeDescriptionEdits([text("a", "c1", 5), other("x", 4), text("b", "c1", 3)]))).toEqual(["a<a", "x<x", "b<b"]);
  });

  it("respects the ten minute limit, the person and a missing contribution id", () => {
    expect(ids(mergeDescriptionEdits([text("a", "c1", 20), text("b", "c1", 10)]))).toEqual(["a<a", "b<b"]);
    expect(ids(mergeDescriptionEdits([text("a", "c1", 5, "bia"), text("b", "c1", 4)]))).toEqual(["a<a", "b<b"]);
    expect(ids(mergeDescriptionEdits([text("a", null, 5), text("b", null, 4)]))).toEqual(["a<a", "b<b"]);
  });
});

// C2, item 6: os eventos "N comentários trazidos do Linear" de uma rodada são gravados um por página; a linha do tempo os soma.
describe("comments_imported da mesma rodada", () => {
  const imported = (id: string, runId: string, count: number, minutes: number): MergeableEntry & { id: string } => ({ id, type: "comments_imported", actorId: "ana", occurredAt: minutes * MIN, runId, count });
  it("vizinhos da mesma rodada viram uma entrada com a soma; outra rodada não junta, qualquer que seja a distância", () => {
    const merged = mergeDescriptionEdits([imported("c", "r2", 4, 300), imported("b", "r1", 50, 61), imported("a", "r1", 30, 1)]);
    expect(ids(merged)).toEqual(["c<c", "b<a"]);
    expect(merged.map((m) => m.count)).toEqual([4, 80]);
  });
  it("outra entrada no meio desfaz a sequência; sem rodada nunca junta", () => {
    const merged = mergeDescriptionEdits([imported("c", "r1", 1, 3), other("x", 2), imported("a", "r1", 2, 1)]);
    expect(ids(merged)).toEqual(["c<c", "x<x", "a<a"]);
    const noRun = { id: "n", type: "comments_imported", actorId: "ana", occurredAt: 0, count: 1 } as MergeableEntry & { id: string };
    expect(ids(mergeDescriptionEdits([{ ...noRun, id: "m" }, noRun]))).toEqual(["m<m", "n<n"]);
  });
});

// ADR 0061, fatia 3: "N relações trazidas do Linear" soma como os comentários, mas nunca junta com eles.
describe("relations_imported da mesma rodada", () => {
  const entry = (id: string, type: string, runId: string, count: number, minutes: number): MergeableEntry & { id: string } => ({ id, type, actorId: "ana", occurredAt: minutes * MIN, runId, count });
  it("vizinhos da mesma rodada viram uma entrada com a soma", () => {
    const merged = mergeDescriptionEdits([entry("b", "relations_imported", "r1", 3, 61), entry("a", "relations_imported", "r1", 2, 1)]);
    expect(ids(merged)).toEqual(["b<a"]);
    expect(merged.map((m) => m.count)).toEqual([5]);
  });
  it("relações e comentários da mesma rodada não se juntam", () => {
    const merged = mergeDescriptionEdits([entry("b", "relations_imported", "r1", 3, 2), entry("a", "comments_imported", "r1", 2, 1)]);
    expect(ids(merged)).toEqual(["b<b", "a<a"]);
    expect(merged.map((m) => m.count)).toEqual([3, 2]);
  });
});

// ADR 0061, fatia 4: "N registros do histórico trazidos do Linear" soma na leitura como os outros, sem juntar com eles.
describe("history_imported da mesma rodada", () => {
  const entry = (id: string, type: string, runId: string, count: number, minutes: number): MergeableEntry & { id: string } => ({ id, type, actorId: "ana", occurredAt: minutes * MIN, runId, count });
  it("vizinhos da mesma rodada viram uma entrada com a soma; com relações da mesma rodada, não", () => {
    const merged = mergeDescriptionEdits([entry("c", "history_imported", "r1", 4, 90), entry("b", "history_imported", "r1", 3, 61), entry("a", "relations_imported", "r1", 2, 1)]);
    expect(ids(merged)).toEqual(["c<b", "a<a"]);
    expect(merged.map((m) => m.count)).toEqual([7, 2]);
  });
});
