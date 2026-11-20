import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
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

const ticket = (id: string, projectId: string, number: number, title: string, parentId: string | null = null): TicketSummary => ({
  id,
  projectId,
  number,
  key: `K-${number}`,
  parentId,
  title,
  status: "todo",
  progress: null,
  assigneeIds: [],
});

describe("buildMapItems", () => {
  it("makes the organization the root and projects its children, in API order", () => {
    const items = buildMapItems(org, [project("b", "BBB", "Segundo"), project("a", "AAA", "Primeiro")], {});
    expect(items.map((item) => [item.id, item.parentId, item.label])).toEqual([
      ["org_1", null, "Equipe Alfa"],
      ["b", "org_1", "Segundo"],
      ["a", "org_1", "Primeiro"],
    ]);
    expect(items[1]).toMatchObject({ kind: "project", key: "BBB" });
    expect(items[0]).toMatchObject({ kind: "organization" });
  });

  it("drops archived projects", () => {
    const items = buildMapItems(org, [project("a", "AAA", "A"), project("b", "BBB", "B", "2026-01-01T00:00:00.000Z")], {});
    expect(items.map((item) => item.id)).toEqual(["org_1", "a"]);
  });

  it("returns only the root for an organization without projects", () => {
    expect(buildMapItems(org, [], {}).map((item) => item.id)).toEqual(["org_1"]);
  });
});

describe("buildMapItems with tickets", () => {
  const a = project("a", "AAA", "Alfa");
  const tickets = {
    a: [
      ticket("t1", "a", 1, "Raiz um"),
      ticket("t2", "a", 2, "Raiz dois"),
      ticket("t3", "a", 3, "Filho do um", "t1"),
      ticket("t4", "a", 4, "Neto", "t3"),
      ticket("t5", "a", 5, "Outro filho do um", "t1"),
    ],
  };

  it("hangs root tickets under the project and the others under their parent ticket", () => {
    const items = buildMapItems(org, [a], tickets);
    expect(items.filter((item) => item.kind === "ticket").map((item) => [item.id, item.parentId])).toEqual([
      ["t1", "a"],
      ["t2", "a"],
      ["t3", "t1"],
      ["t4", "t3"],
      ["t5", "t1"],
    ]);
  });

  it("keeps sibling order as in the listing (by number)", () => {
    const items = buildMapItems(org, [a], tickets);
    expect(items.filter((item) => item.parentId === "t1").map((item) => item.id)).toEqual(["t3", "t5"]);
    expect(items.filter((item) => item.parentId === "a").map((item) => item.id)).toEqual(["t1", "t2"]);
  });

  it("shows key and title, carries the summary and uses the color of the project", () => {
    const items = buildMapItems(org, [a], tickets);
    const node = items.find((item) => item.id === "t3");
    expect(node).toMatchObject({ kind: "ticket", key: "K-3", label: "Filho do um", color: projectColor("a") });
    expect(node?.ticket).toEqual(tickets.a[2]);
    expect(items.find((item) => item.id === "a")?.ticket).toBeNull();
  });

  it("drops tickets of archived projects and of unknown projects", () => {
    const archived = project("z", "ZZZ", "Velho", "2026-01-01T00:00:00.000Z");
    const items = buildMapItems(org, [a, archived], { ...tickets, z: [ticket("tz", "z", 1, "Fantasma")], nope: [ticket("tn", "nope", 1, "Órfão")] });
    expect(items.some((item) => item.id === "tz" || item.id === "tn")).toBe(false);
  });

  it("treats a project without an entry as having no tickets", () => {
    expect(buildMapItems(org, [a], {}).map((item) => item.id)).toEqual(["org_1", "a"]);
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
