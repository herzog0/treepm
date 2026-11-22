import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LanguageSync } from "../i18n/LanguageSync.js";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import type { Preferences } from "../preferences/model.js";
import { setTestLanguage } from "../test/i18n.js";
import { SettingsScreen } from "./SettingsScreen.js";

const navigatorLanguages = (languages: string[]) => vi.spyOn(window.navigator, "languages", "get").mockReturnValue(languages);

function setup(props: { initial?: Preferences; failSave?: boolean } = {}) {
  const onSave = vi.fn();
  render(
    <MemoryPreferencesProvider {...props} onSave={onSave}>
      <LanguageSync />
      <SettingsScreen />
    </MemoryPreferencesProvider>,
  );
  return { onSave };
}

const preferences = (language: Preferences["language"]): Preferences => ({ language });

describe("language preference in Settings", () => {
  it("offers the four options, with the three language names in their own language", () => {
    navigatorLanguages(["pt-BR"]);
    setup();
    const group = screen.getByRole("radiogroup", { name: "Idioma da interface" });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual([
      "Automático",
      "Português (Brasil)",
      "English",
      "Español (México)",
    ]);
    expect(screen.getByRole("radio", { name: "Automático" })).toBeChecked();
  });

  it("follows the browser while the preference is Automático", async () => {
    navigatorLanguages(["es-ES", "en"]);
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Configuración" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es-MX");
    expect(screen.getByRole("radio", { name: "Automático" })).toBeChecked();
  });

  it("falls back to English for a browser language that is not supported", async () => {
    navigatorLanguages(["fr-FR"]);
    setup();
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(screen.getByRole("radio", { name: "Automatic" })).toBeChecked();
  });

  it("changes the language of the whole screen at once, updates <html lang> and saves the choice", async () => {
    navigatorLanguages(["pt-BR"]);
    const { onSave } = setup();
    expect(screen.getByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(onSave).toHaveBeenCalledWith({ language: "en" });
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Camera" })).not.toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Interface language" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "English" })).toBeChecked();
    expect(document.documentElement.lang).toBe("en");

    await userEvent.click(screen.getByRole("radio", { name: "Español (México)" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Configuración" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("es-MX");

    await userEvent.click(screen.getByRole("radio", { name: "Português (Brasil)" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("pt-BR");
  });

  it("goes back to the browser language when Automático is chosen again", async () => {
    navigatorLanguages(["pt-BR"]);
    setup({ initial: preferences("en") });
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Automatic" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
  });

  it("keeps the previous language and says so, in the language still active, when saving fails", async () => {
    navigatorLanguages(["pt-BR"]);
    setup({ failSave: true });
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar");
    expect(screen.getByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Automático" })).toBeChecked();
    await waitFor(() => expect(document.documentElement.lang).toBe("pt-BR"));
  });

  it("starts in the stored language even when the browser says otherwise", async () => {
    await setTestLanguage("pt-BR");
    navigatorLanguages(["pt-BR"]);
    setup({ initial: preferences("es-MX") });
    expect(await screen.findByRole("heading", { level: 1, name: "Configuración" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Español (México)" })).toBeChecked();
  });
});
