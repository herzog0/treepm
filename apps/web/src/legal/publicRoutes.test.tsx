import { render, screen } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A aplicação autenticada e o Clerk não podem nem ser carregados numa página pública.
const loaded = vi.hoisted(() => ({ clerk: 0, app: 0 }));
vi.mock("@clerk/react", () => {
  loaded.clerk += 1;
  return {};
});
vi.mock("../App.js", () => {
  loaded.app += 1;
  return { App: () => <p>authenticated app</p> };
});

import { Root } from "../Root.js";

function visit(path: string) {
  window.history.pushState({}, "", path);
}

afterEach(() => {
  visit("/");
  loaded.clerk = 0;
  loaded.app = 0;
});

describe("public legal routes", () => {
  it.each([["/termos", "Termos de uso do TreePM"], ["/privacidade", "Política de privacidade do TreePM"]])("%s opens without a session and without Clerk", async (path, heading) => {
    visit(path);
    render(<Root />);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(loaded).toEqual({ clerk: 0, app: 0 });
  });

  it("any other path still goes to the application", async () => {
    visit("/qualquer-outro");
    render(<Root />);
    expect(await screen.findByText("authenticated app")).toBeInTheDocument();
    expect(loaded.app).toBe(1);
  });

  it("the legal sources do not import Clerk or the authenticated app", () => {
    const dir = import.meta.dirname;
    const sources = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name));
    expect(sources).toContain("LegalPage.tsx");
    for (const name of sources) {
      const code = readFileSync(resolve(dir, name), "utf8");
      expect(code, name).not.toMatch(/@clerk|AuthenticatedApp|api\/client/);
    }
  });
});
