import { describe, expect, it } from "vitest";
import type { ProjectRole } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeProject } from "../test/fakes.js";
import { canCreateTickets, canRemoveTickets } from "./permissions.js";

const project = makeProject("p1", "ALFA", "Alfa");
const archived = makeProject("p1", "ALFA", "Alfa", { archivedAt: "2026-01-01T00:00:00.000Z" });
const withRole = (role: ProjectRole) => makePanelMe("member", [{ projectId: "p1", role }]);

describe("canCreateTickets", () => {
  it("allows the organization admin, managers and contributors, not readers or members without role", () => {
    expect(canCreateTickets(makePanelMe("admin"), project)).toBe(true);
    expect(canCreateTickets(withRole("manager"), project)).toBe(true);
    expect(canCreateTickets(withRole("contributor"), project)).toBe(true);
    expect(canCreateTickets(withRole("reader"), project)).toBe(false);
    expect(canCreateTickets(makePanelMe("member"), project)).toBe(false);
  });

  it("refuses everyone in an archived project", () => {
    expect(canCreateTickets(makePanelMe("admin"), archived)).toBe(false);
  });
});

describe("canRemoveTickets", () => {
  it("allows only the organization admin and managers of the project", () => {
    expect(canRemoveTickets(makePanelMe("admin"), project)).toBe(true);
    expect(canRemoveTickets(withRole("manager"), project)).toBe(true);
    expect(canRemoveTickets(withRole("contributor"), project)).toBe(false);
    expect(canRemoveTickets(withRole("reader"), project)).toBe(false);
    expect(canRemoveTickets(makePanelMe("member"), project)).toBe(false);
  });

  it("ignores a manager role in another project and refuses everyone in an archived project", () => {
    expect(canRemoveTickets(makePanelMe("member", [{ projectId: "p2", role: "manager" }]), project)).toBe(false);
    expect(canRemoveTickets(makePanelMe("admin"), archived)).toBe(false);
  });
});
