import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AppNav, useView, viewHref } from "./navigation.js";

function setUrl(url: string) {
  window.history.replaceState(null, "", url);
}

beforeEach(() => setUrl("/"));

describe("viewHref", () => {
  it("omits view for the map and preserves other parameters and the hash", () => {
    expect(viewHref("map", "https://x.test/app?foo=1&view=teams#h")).toBe("/app?foo=1#h");
    expect(viewHref("teams", "https://x.test/app?foo=1#h")).toBe("/app?foo=1&view=teams#h");
    expect(viewHref("teams", "https://x.test/")).toBe("/?view=teams");
    expect(viewHref("map", "https://x.test/")).toBe("/");
  });
});

describe("useView", () => {
  it("reads the view from the URL: map by default, teams for ?view=teams", () => {
    expect(renderHook(() => useView()).result.current[0]).toBe("map");
    setUrl("/?view=teams");
    expect(renderHook(() => useView()).result.current[0]).toBe("teams");
    setUrl("/?view=desconhecida");
    expect(renderHook(() => useView()).result.current[0]).toBe("map");
  });

  it("navigates with pushState and follows popstate", () => {
    setUrl("/?foo=1#hash");
    const { result } = renderHook(() => useView());
    const before = window.history.length;

    act(() => result.current[1]("teams"));
    expect(result.current[0]).toBe("teams");
    expect(window.location.search).toBe("?foo=1&view=teams");
    expect(window.location.hash).toBe("#hash");
    expect(window.history.length).toBe(before + 1);

    act(() => {
      setUrl("/?foo=1#hash");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("map");
  });

  it("does not push a duplicate entry when navigating to the current view", () => {
    const { result } = renderHook(() => useView());
    const before = window.history.length;
    act(() => result.current[1]("map"));
    expect(window.history.length).toBe(before);
  });
});

describe("AppNav", () => {
  it("marks the active destination with aria-current and navigates on click", async () => {
    function Harness() {
      const [view, navigate] = useView();
      return <AppNav view={view} onNavigate={navigate} />;
    }
    render(<Harness />);
    const nav = screen.getByRole("navigation", { name: "Seções" });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Mapa" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Times" })).not.toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("link", { name: "Times" }));
    expect(window.location.search).toBe("?view=teams");
    expect(screen.getByRole("link", { name: "Times" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Mapa" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Times" })).toHaveAttribute("href", "/?view=teams");
  });
});
