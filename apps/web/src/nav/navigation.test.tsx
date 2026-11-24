import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { AppNav, chatTicketTarget, useView, viewHref } from "./navigation.js";

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

  it("reads ?view=settings", () => {
    setUrl("/?view=settings");
    expect(renderHook(() => useView()).result.current[0]).toBe("settings");
    expect(viewHref("settings", "https://x.test/app?ticket=t1")).toBe("/app?view=settings");
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
  it("offers Ideias after Mapa and Configurações after Times", () => {
    render(<AppNav view="settings" onNavigate={() => undefined} />);
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links).toEqual(["Mapa", "Ideias", "Times", "Configurações"]);
    expect(screen.getByRole("link", { name: "Configurações" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Configurações" })).toHaveAttribute("href", "/?view=settings");
  });

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

describe("import route", () => {
  it("builds ?view=import&project=<id> and drops both when going back to the map", () => {
    expect(viewHref("import", "https://x.test/app?foo=1#h", "p1")).toBe("/app?foo=1&view=import&project=p1#h");
    expect(viewHref("map", "https://x.test/app?view=import&project=p1&foo=1")).toBe("/app?foo=1");
    expect(viewHref("teams", "https://x.test/app?view=import&project=p1")).toBe("/app?view=teams");
  });

  it("reads the view and the project from the URL", () => {
    setUrl("/?view=import&project=p1");
    const { result } = renderHook(() => useView());
    expect(result.current[0]).toBe("import");
    expect(result.current[2]).toBe("p1");
    setUrl("/?view=import");
    expect(renderHook(() => useView()).result.current[2]).toBeNull();
    setUrl("/?view=teams&project=p1");
    expect(renderHook(() => useView()).result.current[2]).toBeNull();
  });

  it("pushes the entry on navigate and follows back and forward", () => {
    const { result } = renderHook(() => useView());
    const before = window.history.length;
    act(() => result.current[1]("import", "p1"));
    expect(result.current.slice(0, 1)).toEqual(["import"]);
    expect(result.current[2]).toBe("p1");
    expect(window.location.search).toBe("?view=import&project=p1");
    expect(window.history.length).toBe(before + 1);

    act(() => result.current[1]("import", "p1"));
    expect(window.history.length).toBe(before + 1);

    act(() => result.current[1]("map"));
    expect(window.location.search).toBe("");
    expect(result.current[2]).toBeNull();

    act(() => {
      setUrl("/?view=import&project=p1");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[0]).toBe("import");
    expect(result.current[2]).toBe("p1");
  });

  it("keeps Mapa as the current section while importing", () => {
    setUrl("/?view=import&project=p1");
    render(<AppNav view="import" onNavigate={() => undefined} />);
    expect(screen.getByRole("link", { name: "Mapa" })).toHaveAttribute("aria-current", "page");
  });
});

describe("ticket route", () => {
  it("drops ?ticket when leaving the map or going back to the map section", () => {
    expect(viewHref("teams", "https://x.test/app?ticket=t1")).toBe("/app?view=teams");
    expect(viewHref("import", "https://x.test/app?ticket=t1", "p1")).toBe("/app?view=import&project=p1");
    expect(viewHref("map", "https://x.test/app?ticket=t1&foo=1")).toBe("/app?foo=1");
  });

  it("reads the open ticket from the URL only on the map", () => {
    setUrl("/?ticket=t1");
    const { result } = renderHook(() => useView());
    expect(result.current[0]).toBe("map");
    expect(result.current[3]).toBe("t1");
    setUrl("/?view=teams&ticket=t1");
    expect(renderHook(() => useView()).result.current[3]).toBeNull();
    setUrl("/?view=import&project=p1&ticket=t1");
    expect(renderHook(() => useView()).result.current[3]).toBeNull();
    setUrl("/?ticket=");
    expect(renderHook(() => useView()).result.current[3]).toBeNull();
  });

  it("pushes an entry for each opened ticket and for closing, keeping other parameters", () => {
    setUrl("/?foo=1#h");
    const { result } = renderHook(() => useView());
    const before = window.history.length;
    act(() => result.current[4]("t1"));
    expect(result.current[3]).toBe("t1");
    expect(window.location.search).toBe("?foo=1&ticket=t1");
    expect(window.location.hash).toBe("#h");
    expect(window.history.length).toBe(before + 1);

    act(() => result.current[4]("t1"));
    expect(window.history.length).toBe(before + 1);

    act(() => result.current[4]("t2"));
    expect(window.location.search).toBe("?foo=1&ticket=t2");
    act(() => result.current[4](null));
    expect(result.current[3]).toBeNull();
    expect(window.location.search).toBe("?foo=1");
    expect(window.history.length).toBe(before + 3);
  });

  it("closes the page when the browser goes back, and navigating to another section discards the ticket", () => {
    const { result } = renderHook(() => useView());
    act(() => result.current[4]("t1"));
    act(() => {
      setUrl("/");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current[3]).toBeNull();

    act(() => result.current[4]("t1"));
    act(() => result.current[1]("teams"));
    expect(result.current[3]).toBeNull();
    expect(window.location.search).toBe("?view=teams");
  });
});

describe("ideas route", () => {
  it("builds and reads ?view=ideas", () => {
    expect(viewHref("ideas", "https://x.test/app?foo=1&ticket=t1#h")).toBe("/app?foo=1&view=ideas#h");
    setUrl("/?view=ideas");
    expect(renderHook(() => useView()).result.current[0]).toBe("ideas");
    render(<AppNav view="ideas" onNavigate={() => undefined} />);
    expect(screen.getByRole("link", { name: "Ideias" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Ideias" })).toHaveAttribute("href", "/?view=ideas");
  });

  it("navigates from the ideas screen to the map with the ticket open (“Abrir”)", () => {
    setUrl("/?view=ideas");
    const { result } = renderHook(() => useView());
    act(() => result.current[1]("map", null, { ticketId: "i1" }));
    expect(result.current[0]).toBe("map");
    expect(result.current[3]).toBe("i1");
    expect(window.location.search).toBe("?ticket=i1");
  });

  it("navigates to the map with the camera on a ticket (“Ver no mapa”), and clears the request once handled", () => {
    setUrl("/?view=ideas");
    const { result } = renderHook(() => useView());
    act(() => result.current[1]("map", null, { focusId: "i1" }));
    expect(result.current[0]).toBe("map");
    expect(result.current[3]).toBeNull();
    expect(result.current[5]).toBe("i1");
    expect(window.location.search).toBe("?focus=i1");
    const before = window.history.length;
    act(() => result.current[6]());
    expect(result.current[5]).toBeNull();
    expect(window.location.search).toBe("");
    expect(window.history.length).toBe(before);
  });

  it("keeps the page open and asks the camera to go to the same ticket (chat header with the page already open, ADR 0049)", () => {
    setUrl("/?ticket=t1");
    const { result } = renderHook(() => useView());
    act(() => result.current[1]("map", null, { ticketId: "t1", focusId: "t1" }));
    expect(result.current[3]).toBe("t1");
    expect(result.current[5]).toBe("t1");
    expect(window.location.search).toBe("?ticket=t1&focus=t1");
    expect(viewHref("map", "https://x.test/app", null, { ticketId: "t1", focusId: "t1" })).toBe("/app?ticket=t1&focus=t1");
    expect(chatTicketTarget("t1", "t1")).toEqual({ ticketId: "t1", focusId: "t1" });
    expect(chatTicketTarget("t2", "t1")).toEqual({ ticketId: "t1" });
    expect(chatTicketTarget(null, "t1")).toEqual({ ticketId: "t1" });
    act(() => result.current[6]());
    expect(result.current[3]).toBe("t1");
    expect(result.current[5]).toBeNull();
    expect(window.location.search).toBe("?ticket=t1");
  });

  it("ignores the ticket and focus targets for other views, and leaving the map drops ?focus", () => {
    expect(viewHref("teams", "https://x.test/app?focus=i1")).toBe("/app?view=teams");
    expect(viewHref("map", "https://x.test/app?view=ideas", null, { focusId: "i1" })).toBe("/app?focus=i1");
    expect(viewHref("map", "https://x.test/app?view=ideas", null, { ticketId: "i1" })).toBe("/app?ticket=i1");
    expect(viewHref("ideas", "https://x.test/app", null, { ticketId: "i1" })).toBe("/app?view=ideas");
  });

  it("reads ?focus on the map", () => {
    setUrl("/?focus=i1");
    expect(renderHook(() => useView()).result.current[5]).toBe("i1");
    setUrl("/?view=teams&focus=i1");
    expect(renderHook(() => useView()).result.current[5]).toBeNull();
  });
});

describe("âncora das Configurações (#ia, #github, #mcp)", () => {
  it("pede a seção das Configurações pela âncora", () => {
    expect(viewHref("settings", "https://x.test/app", null, { section: "ia" })).toBe("/app?view=settings#ia");
    expect(viewHref("settings", "https://x.test/app?ticket=t1#h", null, { section: "github" })).toBe("/app?view=settings#github");
    expect(viewHref("settings", "https://x.test/app#h")).toBe("/app?view=settings");
  });

  it("a âncora não vaza: ao sair das Configurações o hash é apagado, no mapa e em outras telas", () => {
    expect(viewHref("map", "https://x.test/app?view=settings#mcp")).toBe("/app");
    expect(viewHref("teams", "https://x.test/app?view=settings#mcp")).toBe("/app?view=teams");
    expect(viewHref("map", "https://x.test/app?view=settings#mcp", null, { ticketId: "t1" })).toBe("/app?ticket=t1");
  });

  it("navegar das Configurações para o mapa tira o #mcp do endereço; o endereço do ticket aberto depois também não o traz", () => {
    setUrl("/?view=settings#mcp");
    const { result } = renderHook(() => useView());
    act(() => result.current[1]("map"));
    expect(window.location.hash).toBe("");
    act(() => result.current[4]("t1"));
    expect(window.location.search).toBe("?ticket=t1");
    expect(window.location.hash).toBe("");
  });

  it("navigate abre as Configurações já na seção pedida (volta do GitHub)", () => {
    const { result } = renderHook(() => useView());
    act(() => result.current[1]("settings", null, { section: "github" }));
    expect(result.current[0]).toBe("settings");
    expect(window.location.search).toBe("?view=settings");
    expect(window.location.hash).toBe("#github");
  });
});
