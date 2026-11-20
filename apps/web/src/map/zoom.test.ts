import { buildSpatialLayout, buildTreeIndex } from "@treepm/engine";
import { describe, expect, it } from "vitest";
import type { Me, Project, TicketSummary } from "../api/client.js";
import { buildMapItems } from "./items.js";
import { LEAF_READABLE_WIDTH, PACKAGE_MIN_MAX_SCALE, computeLeafMaxScale, computeMapMaxScale } from "./zoom.js";

const org: Me["organization"] = { orgId: "org_1", name: "Equipe Alfa" } as Me["organization"];
const project = (id: string): Project => ({ id, key: id.toUpperCase(), name: id, archivedAt: null }) as unknown as Project;
const ticket = (id: string, projectId: string, number: number, parentId: string | null = null): TicketSummary =>
  ({ id, projectId, number, key: `K-${number}`, parentId, title: id, status: "todo", progress: null, assigneeIds: [] }) as unknown as TicketSummary;

const smallestWidth = (items: ReturnType<typeof buildMapItems>) =>
  Math.min(...buildSpatialLayout(buildTreeIndex(items)).nodes.map((node) => node.width));

describe("computeLeafMaxScale", () => {
  it("takes the smallest node to 440 px for an organization alone", () => {
    const items = buildMapItems(org, [], {});
    expect(computeLeafMaxScale(items)).toBeCloseTo(LEAF_READABLE_WIDTH / smallestWidth(items));
    expect(LEAF_READABLE_WIDTH).toBe(440);
  });

  it("takes the smallest node to 440 px for an organization with projects", () => {
    const items = buildMapItems(org, [project("a"), project("b")], {});
    expect(computeLeafMaxScale(items)).toBeCloseTo(440 / smallestWidth(items));
  });

  it("uses the deepest node when tickets span several levels", () => {
    const shallow = buildMapItems(org, [project("a")], { a: [ticket("t1", "a", 1)] });
    const deep = buildMapItems(org, [project("a")], {
      a: [ticket("t1", "a", 1), ticket("t2", "a", 2, "t1"), ticket("t3", "a", 3, "t2"), ticket("t4", "a", 4, "t3")],
    });
    expect(computeLeafMaxScale(deep)).toBeCloseTo(440 / smallestWidth(deep));
    expect(computeLeafMaxScale(deep)).toBeGreaterThan(computeLeafMaxScale(shallow));
  });

  it("changes with the items and not between calls with the same items", () => {
    const small = buildMapItems(org, [project("a")], { a: [ticket("t1", "a", 1)] });
    const grown = buildMapItems(org, [project("a")], { a: [ticket("t1", "a", 1), ticket("t2", "a", 2, "t1"), ticket("t3", "a", 3, "t2")] });
    expect(computeLeafMaxScale(small)).toBe(computeLeafMaxScale(small));
    expect(computeLeafMaxScale(grown)).not.toBe(computeLeafMaxScale(small));
  });

  it("is a finite positive number", () => {
    expect(Number.isFinite(computeLeafMaxScale(buildMapItems(org, [], {})))).toBe(true);
  });
});

describe("computeMapMaxScale", () => {
  it("keeps the package floor for small trees, where 440 px would zoom less than today", () => {
    const items = buildMapItems(org, [project("a")], {});
    expect(computeLeafMaxScale(items)).toBeLessThan(PACKAGE_MIN_MAX_SCALE);
    expect(computeMapMaxScale(items)).toBe(PACKAGE_MIN_MAX_SCALE);
  });

  it("follows the leaf in deep trees and never zooms less than the 140 px limit it replaces", () => {
    const items = buildMapItems(org, [project("a")], { a: [ticket("t1", "a", 1), ticket("t2", "a", 2, "t1"), ticket("t3", "a", 3, "t2")] });
    expect(computeMapMaxScale(items)).toBeCloseTo(440 / smallestWidth(items));
    expect(computeMapMaxScale(items)).toBeGreaterThanOrEqual(Math.max(6, 140 / smallestWidth(items)));
  });
});
