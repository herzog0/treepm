import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type * as Engine from "@treepm/engine";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

const calls = vi.hoisted(() => ({ index: 0, layout: 0 }));
vi.mock("@treepm/engine", async (importOriginal) => {
  const engine = await importOriginal<typeof Engine>();
  return {
    ...engine,
    buildTreeIndex: ((...args: Parameters<typeof engine.buildTreeIndex>) => { calls.index += 1; return engine.buildTreeIndex(...args); }) as typeof engine.buildTreeIndex,
    buildSpatialLayout: ((...args: Parameters<typeof engine.buildSpatialLayout>) => { calls.layout += 1; return engine.buildSpatialLayout(...args); }) as typeof engine.buildSpatialLayout,
  };
});

describe("map geometry is built once per set of items", () => {
  it("mounting the map builds the index and the layout once, not again for the maximum scale", async () => {
    const client = makeTreeClient({
      projects: [makeProject("p1", "ALFA", "Projeto Alfa")],
      people: [makePerson("person-1", "Ana")],
      tickets: { p1: [makeTicket("a", "p1", 1, "Um", { key: "ALFA-1" }), makeTicket("b", "p1", 2, "Dois", { key: "ALFA-2", parentId: "a" })] },
    });
    calls.index = 0;
    calls.layout = 0;
    render(<OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={null} onOpenTicketChange={() => undefined} />);
    await screen.findByText(/Projeto Alfa/, undefined, { timeout: 20_000 });
    expect(calls.index).toBe(1);
    expect(calls.layout).toBe(1);
  }, 30_000);
});
