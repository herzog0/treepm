import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import { CONTRIBUTION_STATUSES, CONTRIBUTION_TEXT_MAX, canEditContributions, isContributionText } from "./contributions.js";

const actor = (role: "manager" | "contributor" | "reader" | null, clerkRole: "admin" | "member" = "member"): Actor => ({
  clerkRole,
  teamRoles: new Map(),
  projectRoles: new Map(role ? [["proj", role]] : []),
});

describe("contributions", () => {
  it("has the three statuses, in order", () => {
    expect(CONTRIBUTION_STATUSES).toEqual(["todo", "in_progress", "done"]);
  });

  it("limits the text to 20,000 characters, empty allowed", () => {
    expect(CONTRIBUTION_TEXT_MAX).toBe(20_000);
    expect(isContributionText("")).toBe(true);
    expect(isContributionText("a".repeat(20_000))).toBe(true);
    expect(isContributionText("a".repeat(20_001))).toBe(false);
  });

  it("is edited by whoever can edit the ticket", () => {
    expect(canEditContributions(actor("manager"), "proj")).toBe(true);
    expect(canEditContributions(actor("contributor"), "proj")).toBe(true);
    expect(canEditContributions(actor(null, "admin"), "proj")).toBe(true);
    expect(canEditContributions(actor("reader"), "proj")).toBe(false);
    expect(canEditContributions(actor(null), "proj")).toBe(false);
  });
});
