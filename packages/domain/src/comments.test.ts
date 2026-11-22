import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import {
  COMMENT_BODY_MAX,
  COMMENT_BODY_MIN,
  canCommentTicket,
  canEditComment,
  canRemoveComment,
  commentBodyOf,
} from "./comments.js";
import { canEditTicket } from "./tickets.js";

const project = "internal";
const other = "elsewhere";
const base: Actor = { clerkRole: "member", teamRoles: new Map(), projectRoles: new Map() };
const orgAdmin: Actor = { ...base, clerkRole: "admin" };
const manager: Actor = { ...base, projectRoles: new Map([[project, "manager"]]) };
const contributor: Actor = { ...base, projectRoles: new Map([[project, "contributor"]]) };
const reader: Actor = { ...base, projectRoles: new Map([[project, "reader"]]) };
const noRole: Actor = base;
const elsewhere: Actor = { ...base, projectRoles: new Map([[other, "manager"]]) };

const roles = [
  ["organization admin", orgAdmin],
  ["project manager", manager],
  ["contributor", contributor],
  ["reader", reader],
  ["member without project role", noRole],
  ["manager of another project", elsewhere],
] as const;

describe("canCommentTicket", () => {
  it.each(roles)("follows canEditTicket for %s", (_name, actor) => {
    expect(canCommentTicket(actor, project)).toBe(canEditTicket(actor, project));
  });

  it("is true for admin, manager and contributor, false for reader and the rest", () => {
    expect(roles.map(([, actor]) => canCommentTicket(actor, project))).toEqual([true, true, true, false, false, false]);
  });
});

describe("canEditComment", () => {
  it("lets only the author edit, and only while able to comment", () => {
    expect(canEditComment(contributor, project, "ana", "ana")).toBe(true);
    expect(canEditComment(manager, project, "ana", "ana")).toBe(true);
    expect(canEditComment(contributor, project, "ana", "bia")).toBe(false);
  });

  it("never lets a manager or admin edit someone else's comment", () => {
    expect(canEditComment(manager, project, "bia", "ana")).toBe(false);
    expect(canEditComment(orgAdmin, project, "bia", "ana")).toBe(false);
  });

  it("denies an author who lost the right to comment (reader, no role)", () => {
    expect(canEditComment(reader, project, "ana", "ana")).toBe(false);
    expect(canEditComment(noRole, project, "ana", "ana")).toBe(false);
  });
});

describe("canRemoveComment", () => {
  it("lets the author remove, even as a reader", () => {
    expect(canRemoveComment(contributor, project, "ana", "ana")).toBe(true);
    expect(canRemoveComment(reader, project, "ana", "ana")).toBe(true);
  });

  it("lets a project manager and an organization admin remove others' comments", () => {
    expect(canRemoveComment(manager, project, "bia", "ana")).toBe(true);
    expect(canRemoveComment(orgAdmin, project, "bia", "ana")).toBe(true);
  });

  it("denies a contributor, reader, outsider and a manager of another project on others' comments", () => {
    expect(canRemoveComment(contributor, project, "bia", "ana")).toBe(false);
    expect(canRemoveComment(reader, project, "bia", "ana")).toBe(false);
    expect(canRemoveComment(noRole, project, "bia", "ana")).toBe(false);
    expect(canRemoveComment(elsewhere, project, "bia", "ana")).toBe(false);
  });
});

describe("commentBodyOf", () => {
  it("limits are 1 and 10,000 characters", () => {
    expect(COMMENT_BODY_MIN).toBe(1);
    expect(COMMENT_BODY_MAX).toBe(10_000);
  });

  it("trims and accepts 1 to 10,000 characters", () => {
    expect(commentBodyOf("  oi \n")).toBe("oi");
    expect(commentBodyOf("a")).toBe("a");
    expect(commentBodyOf("a".repeat(10_000))).toBe("a".repeat(10_000));
    expect(commentBodyOf(`  ${"a".repeat(10_000)}  `)).toBe("a".repeat(10_000));
  });

  it("rejects empty, blank and too long bodies", () => {
    expect(commentBodyOf("")).toBeNull();
    expect(commentBodyOf(" \n\t ")).toBeNull();
    expect(commentBodyOf("a".repeat(10_001))).toBeNull();
  });
});
