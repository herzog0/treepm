import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parsePreferences, withPreferences } from "./model.js";

const stored = (preferences: unknown, extra: Record<string, unknown> = {}) => ({ treepm: { preferences, ...extra } });

describe("parsePreferences", () => {
  it("defaults to restoring the camera when nothing is stored", () => {
    expect(DEFAULT_PREFERENCES).toEqual({ camera: { onTicketClose: "restore" } });
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ treepm: null })).toEqual(DEFAULT_PREFERENCES);
  });

  it("reads a valid stored value", () => {
    expect(parsePreferences(stored({ v: 1, camera: { onTicketClose: "stay" } }))).toEqual({ camera: { onTicketClose: "stay" } });
  });

  it("falls back to the default for an invalid value, field by field", () => {
    expect(parsePreferences(stored({ v: 1, camera: { onTicketClose: "teleport" } }))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(stored({ v: 1, camera: "stay" }))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(stored("lixo"))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("lixo")).toEqual(DEFAULT_PREFERENCES);
  });

  it("ignores an unknown version", () => {
    expect(parsePreferences(stored({ v: 2, camera: { onTicketClose: "stay" } }))).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("withPreferences", () => {
  it("writes the versioned format and keeps every other key of unsafeMetadata", () => {
    const current = { tema: "x", treepm: { outra: 2, preferences: { v: 1, camera: { onTicketClose: "restore" } } } };
    expect(withPreferences(current, { camera: { onTicketClose: "stay" } })).toEqual({
      tema: "x",
      treepm: { outra: 2, preferences: { v: 1, camera: { onTicketClose: "stay" } } },
    });
    expect(current.treepm.preferences.camera.onTicketClose).toBe("restore");
  });

  it("creates the path when the user has no metadata yet", () => {
    expect(withPreferences({}, DEFAULT_PREFERENCES)).toEqual({ treepm: { preferences: { v: 1, camera: { onTicketClose: "restore" } } } });
  });
});
