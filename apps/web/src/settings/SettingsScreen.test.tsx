import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemoryPreferencesProvider } from "../preferences/context.js";
import type { Preferences } from "../preferences/model.js";
import { SettingsScreen } from "./SettingsScreen.js";

function setup(props: { initial?: Preferences; failSave?: boolean } = {}) {
  const onSave = vi.fn();
  render(<MemoryPreferencesProvider {...props} onSave={onSave}><SettingsScreen /></MemoryPreferencesProvider>);
  return { onSave };
}

describe("SettingsScreen", () => {
  it("shows the page title and the language section, with no Câmera section", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Idioma" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Câmera" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Ao fechar um ticket" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Voltar ao lugar de antes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Ficar onde está" })).not.toBeInTheDocument();
  });

  it("applies immediately, with no save button", async () => {
    const { onSave } = setup();
    expect(screen.queryByRole("button", { name: /salvar/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(onSave).toHaveBeenCalledWith({ language: "en" });
    await waitFor(() => expect(screen.getByRole("radio", { name: "English" })).toBeChecked());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the previous value and shows a message when saving fails", async () => {
    setup({ failSave: true });
    await userEvent.click(screen.getByRole("radio", { name: "English" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar");
    expect(screen.getByRole("radio", { name: "Automático" })).toBeChecked();
  });
});
