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
  it("shows the page title, the Câmera section and the radio group with the default selected", () => {
    setup();
    expect(screen.getByRole("heading", { level: 1, name: "Configurações" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Câmera" })).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Ao fechar um ticket" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Voltar ao lugar de antes" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Ficar onde está" })).not.toBeChecked();
  });

  it("reflects a stored preference", () => {
    setup({ initial: { camera: { onTicketClose: "stay" } } });
    expect(screen.getByRole("radio", { name: "Ficar onde está" })).toBeChecked();
  });

  it("applies immediately, with no save button", async () => {
    const { onSave } = setup();
    expect(screen.queryByRole("button", { name: /salvar/i })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Ficar onde está" }));
    expect(onSave).toHaveBeenCalledWith({ camera: { onTicketClose: "stay" } });
    await waitFor(() => expect(screen.getByRole("radio", { name: "Ficar onde está" })).toBeChecked());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the previous value and shows a message when saving fails", async () => {
    setup({ failSave: true });
    await userEvent.click(screen.getByRole("radio", { name: "Ficar onde está" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível salvar");
    expect(screen.getByRole("radio", { name: "Voltar ao lugar de antes" })).toBeChecked();
  });
});
