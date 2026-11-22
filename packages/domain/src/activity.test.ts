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
