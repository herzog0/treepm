import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RECENT, createRecentPlaces } from "./recentPlaces.js";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("recent places", () => {
  it("keeps the most recent first and never repeats an id", () => {
    const recent = createRecentPlaces("o1", "u1");
    recent.record("p1", "a");
    recent.record("p1", "b");
    recent.record("p1", "c");
    recent.record("p1", "a");
    expect(recent.read("p1")).toEqual(["a", "c", "b"]);
  });

  it("keeps at most eight, dropping the oldest", () => {
    const recent = createRecentPlaces("o1", "u1");
    for (let i = 1; i <= MAX_RECENT + 3; i += 1) recent.record("p1", `t${i}`);
    const read = recent.read("p1");
    expect(read).toHaveLength(8);
    expect(read[0]).toBe("t11");
    expect(read.at(-1)).toBe("t4");
  });

  it("is separate by organization, project and person", () => {
    createRecentPlaces("o1", "u1").record("p1", "a");
    expect(createRecentPlaces("o1", "u1").read("p1")).toEqual(["a"]);
    expect(createRecentPlaces("o2", "u1").read("p1")).toEqual([]);
    expect(createRecentPlaces("o1", "u2").read("p1")).toEqual([]);
    expect(createRecentPlaces("o1", "u1").read("p2")).toEqual([]);
  });

  it("stores only ids", () => {
    createRecentPlaces("o1", "u1").record("p1", "a");
    const stored = Object.entries(window.localStorage);
    expect(stored).toHaveLength(1);
    expect(JSON.parse(stored[0]![1])).toEqual(["a"]);
  });

  it("works without storage when the accessor throws", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("blocked");
    });
    const recent = createRecentPlaces("o1", "u1");
    expect(() => recent.record("p1", "a")).not.toThrow();
    expect(recent.read("p1")).toEqual([]);
  });

  it("works when reading and writing throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("full");
    });
    const recent = createRecentPlaces("o1", "u1");
    expect(() => recent.record("p1", "a")).not.toThrow();
    expect(recent.read("p1")).toEqual([]);
  });

  it("ignores stored garbage", () => {
    const recent = createRecentPlaces("o1", "u1");
    recent.record("p1", "a");
    const key = Object.keys(window.localStorage)[0]!;
    window.localStorage.setItem(key, "{not json");
    expect(recent.read("p1")).toEqual([]);
    window.localStorage.setItem(key, JSON.stringify([1, "b", null, "b", "c"]));
    expect(recent.read("p1")).toEqual(["b", "c"]);
    recent.record("p1", "d");
    expect(recent.read("p1")).toEqual(["d", "b", "c"]);
  });
});
