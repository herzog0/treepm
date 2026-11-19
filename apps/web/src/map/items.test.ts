import { describe, expect, it } from "vitest";
import type { Project } from "../api/client.js";
import { buildMapItems, projectColor } from "./items.js";

const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project = (id: string, key: string, name: string, archivedAt: string | null = null): Project => ({
  id,
  name,
  key,
  visibility: "organization",
  archivedAt,
  members: [],
  teamIds: [],
});

describe("buildMapItems", () => {
  it("makes the organization the root and projects its children, in API order", () => {
    const items = buildMapItems(org, [project("b", "BBB", "Segundo"), project("a", "AAA", "Primeiro")]);
    expect(items.map((item) => [item.id, item.parentId, item.label])).toEqual([
      ["org_1", null, "Equipe Alfa"],
      ["b", "org_1", "Segundo"],
      ["a", "org_1", "Primeiro"],
    ]);
    expect(items[1]).toMatchObject({ kind: "project", key: "BBB" });
    expect(items[0]).toMatchObject({ kind: "organization" });
  });

  it("drops archived projects", () => {
    const items = buildMapItems(org, [project("a", "AAA", "A"), project("b", "BBB", "B", "2026-01-01T00:00:00.000Z")]);
    expect(items.map((item) => item.id)).toEqual(["org_1", "a"]);
  });

  it("returns only the root for an organization without projects", () => {
    expect(buildMapItems(org, []).map((item) => item.id)).toEqual(["org_1"]);
  });
});

describe("projectColor", () => {
  it("is deterministic and stable across calls", () => {
    expect(projectColor("project-id-1")).toBe(projectColor("project-id-1"));
    expect(projectColor("project-id-1")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("varies across different seeds", () => {
    const colors = new Set(Array.from({ length: 40 }, (_, i) => projectColor(`project-${i}`)));
    expect(colors.size).toBeGreaterThan(3);
  });
});
