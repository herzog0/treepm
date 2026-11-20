import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { ACCENT_COLOR, DRAFT_NODE_ID, buildMapItems } from "./items.js";

const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project: Project = { id: "p1", name: "Alfa", key: "ALFA", visibility: "organization", archivedAt: null, members: [], teamIds: [] };
const ticket = (id: string, number: number, parentId: string | null, status: TicketSummary["status"]): TicketSummary => ({
  id, projectId: "p1", number, key: `ALFA-${number}`, parentId, title: `T${number}`, status, progress: null, assigneeIds: [], descriptionExcerpt: "",
});
const tickets = { p1: [ticket("t1", 1, null, "done"), ticket("t2", 2, "t1", "done")] };

describe("buildMapItems with the assistant draft", () => {
  it("adds a dashed-card node as the last child of the destination ticket", () => {
    const items = buildMapItems(org, [project], tickets, { projectId: "p1", parentId: "t1", title: "Corrigir o login" });
    const ghost = items.find((item) => item.id === DRAFT_NODE_ID);
    expect(ghost).toMatchObject({ kind: "draft", parentId: "t1", label: "Corrigir o login", color: ACCENT_COLOR, ticket: null });
    expect(items.at(-1)).toBe(ghost);
  });

  it("enters as the only child of a leaf ticket (ADR 0030)", () => {
    const items = buildMapItems(org, [project], tickets, { projectId: "p1", parentId: "t2", title: "Primeiro subticket" });
    expect(items.filter((item) => item.parentId === "t2")).toEqual([
      expect.objectContaining({ id: DRAFT_NODE_ID, kind: "draft", parentId: "t2", label: "Primeiro subticket" }),
    ]);
    expect(items.find((item) => item.id === "t2")).toMatchObject({ kind: "ticket" });
  });

  it("puts the node under the project when the destination is the project root", () => {
    const items = buildMapItems(org, [project], tickets, { projectId: "p1", parentId: null, title: "Raiz" });
    expect(items.find((item) => item.id === DRAFT_NODE_ID)?.parentId).toBe("p1");
  });

  it("does not change the color or the leaf count of the destination branch", () => {
    const without = buildMapItems(org, [project], tickets);
    const withDraft = buildMapItems(org, [project], tickets, { projectId: "p1", parentId: "t1", title: "X" });
    expect(withDraft.find((item) => item.id === "t1")).toEqual(without.find((item) => item.id === "t1"));
  });

  it("uses a placeholder label while the draft has no title", () => {
    const items = buildMapItems(org, [project], tickets, { projectId: "p1", parentId: null, title: "   " });
    expect(items.find((item) => item.id === DRAFT_NODE_ID)?.label).toBe("Novo ticket");
  });

  it("omits the node when the destination is not on the map (archived project or unknown ticket)", () => {
    const archived = { ...project, archivedAt: "2026-01-01T00:00:00.000Z" };
    expect(buildMapItems(org, [archived], tickets, { projectId: "p1", parentId: null, title: "X" }).some((i) => i.id === DRAFT_NODE_ID)).toBe(false);
    expect(buildMapItems(org, [project], tickets, { projectId: "p1", parentId: "nope", title: "X" }).some((i) => i.id === DRAFT_NODE_ID)).toBe(false);
  });
});
