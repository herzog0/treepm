import { describe, expect, it } from "vitest";
import { DEFAULT_PREFERENCES, parsePreferences, withPreferences } from "./model.js";

const stored = (preferences: unknown, extra: Record<string, unknown> = {}) => ({ treepm: { preferences, ...extra } });

describe("parsePreferences", () => {
  it("defaults the language to auto when nothing is stored", () => {
    expect(DEFAULT_PREFERENCES).toEqual({ language: "auto" });
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({})).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences({ treepm: null })).toEqual(DEFAULT_PREFERENCES);
  });

  it("falls back to the default for an invalid value", () => {
    expect(parsePreferences(stored("lixo"))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences("lixo")).toEqual(DEFAULT_PREFERENCES);
  });

  it.each(["auto", "pt-BR", "en", "es-MX"] as const)("reads the stored language %s", (language) => {
    expect(parsePreferences(stored({ v: 1, language })).language).toBe(language);
  });

  it("defaults the language to auto when it is absent or invalid", () => {
    expect(parsePreferences(stored({ v: 1 }))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(stored({ v: 1, language: "fr" }))).toEqual(DEFAULT_PREFERENCES);
    expect(parsePreferences(stored({ v: 1, language: 3 }))).toEqual(DEFAULT_PREFERENCES);
  });

  it("reads an old stored camera preference without error and ignores it", () => {
    expect(parsePreferences(stored({ v: 1, camera: { onTicketClose: "stay" } }))).toEqual({ language: "auto" });
    expect(parsePreferences(stored({ v: 1, camera: { onTicketClose: "restore" }, language: "en" }))).toEqual({ language: "en" });
    expect(parsePreferences(stored({ v: 1, camera: "lixo", language: "es-MX" }))).toEqual({ language: "es-MX" });
    expect("camera" in parsePreferences(stored({ v: 1, camera: { onTicketClose: "stay" } }))).toBe(false);
  });

  it("ignores an unknown version", () => {
    expect(parsePreferences(stored({ v: 2, language: "en" }))).toEqual(DEFAULT_PREFERENCES);
  });
});

describe("withPreferences", () => {
  it("writes the versioned format and keeps every other key of unsafeMetadata", () => {
    const current = { tema: "x", treepm: { outra: 2, preferences: { v: 1, language: "en" } } };
    expect(withPreferences(current, { language: "es-MX" })).toEqual({
      tema: "x",
      treepm: { outra: 2, preferences: { v: 1, language: "es-MX" } },
    });
    expect(current.treepm.preferences.language).toBe("en");
  });

  it("no longer writes the old camera key, dropping a stored one", () => {
    const current = { treepm: { preferences: { v: 1, camera: { onTicketClose: "stay" }, language: "en" } } };
    const written = withPreferences(current, { language: "en" });
    expect(written).toEqual({ treepm: { preferences: { v: 1, language: "en" } } });
    expect(current.treepm.preferences.camera.onTicketClose).toBe("stay");
  });

  it("creates the path when the user has no metadata yet", () => {
    expect(withPreferences({}, DEFAULT_PREFERENCES)).toEqual({ treepm: { preferences: { v: 1, language: "auto" } } });
  });
});
