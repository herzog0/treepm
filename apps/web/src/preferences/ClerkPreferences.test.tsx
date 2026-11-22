import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ClerkPreferencesProvider } from "./ClerkPreferences.js";
import { usePreferences } from "./context.js";

const clerk = vi.hoisted(() => ({ useUser: vi.fn() }));
vi.mock("@clerk/react", () => clerk);

function Probe() {
  const { preferences, save } = usePreferences();
  return (
    <>
      <output>{preferences.language}</output>
      <button onClick={() => void save({ language: "en" }).then((result) => (document.title = result.ok ? "ok" : "falhou"))}>salvar</button>
    </>
  );
}
const renderProbe = () => render(<ClerkPreferencesProvider><Probe /></ClerkPreferencesProvider>);

beforeEach(() => {
  clerk.useUser.mockReset();
  document.title = "";
});

describe("ClerkPreferencesProvider", () => {
  it("reads the preferences from the user's unsafeMetadata", () => {
    clerk.useUser.mockReturnValue({ isLoaded: true, user: { unsafeMetadata: { treepm: { preferences: { v: 1, language: "es-MX" } } }, updateMetadata: vi.fn() } });
    renderProbe();
    expect(screen.getByRole("status")).toHaveTextContent("es-MX");
  });

  it("uses the default while the user is not loaded or has no metadata", () => {
    clerk.useUser.mockReturnValue({ isLoaded: false, user: undefined });
    renderProbe();
    expect(screen.getByRole("status")).toHaveTextContent("auto");
  });

  it("saves through updateMetadata, preserving the other keys", async () => {
    const updateMetadata = vi.fn().mockResolvedValue({});
    clerk.useUser.mockReturnValue({ isLoaded: true, user: { unsafeMetadata: { tema: "x", treepm: { outra: 2, preferences: { v: 1, camera: { onTicketClose: "stay" }, language: "es-MX" } } }, updateMetadata } });
    renderProbe();
    screen.getByRole("button", { name: "salvar" }).click();
    await waitFor(() => expect(document.title).toBe("ok"));
    expect(updateMetadata).toHaveBeenCalledWith({ unsafeMetadata: { tema: "x", treepm: { outra: 2, preferences: { v: 1, language: "en" } } } });
  });

  it("reports a failed save and keeps the previous value", async () => {
    const updateMetadata = vi.fn().mockRejectedValue(new Error("rede"));
    clerk.useUser.mockReturnValue({ isLoaded: true, user: { unsafeMetadata: { treepm: { preferences: { v: 1, language: "es-MX" } } }, updateMetadata } });
    renderProbe();
    screen.getByRole("button", { name: "salvar" }).click();
    await waitFor(() => expect(document.title).toBe("falhou"));
    expect(screen.getByRole("status")).toHaveTextContent("es-MX");
  });
});
