import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ItemsSummary } from "../ticket/ItemsSummary.js";
import { failed, makeClient, ok } from "../test/fakes.js";
import { AdminProvider, ConsentRequiredNotice, isConsentRequired } from "./ConsentRequired.js";

describe("assistente desligado por falta de aceite", () => {
  it("reconhece o código da API", () => {
    expect(isConsentRequired({ kind: "forbidden", code: "assistant_consent_required" })).toBe(true);
    expect(isConsentRequired({ kind: "forbidden" })).toBe(false);
    expect(isConsentRequired(null)).toBe(false);
  });

  it("quem não é administrador lê que um administrador precisa ativar, sem link", () => {
    render(<ConsentRequiredNotice />);
    expect(screen.getByRole("alert")).toHaveTextContent("Um administrador precisa ativá-la em Configurações");
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("administrador recebe o link para as Configurações, em outra aba", () => {
    render(<AdminProvider isAdmin><ConsentRequiredNotice /></AdminProvider>);
    const link = screen.getByRole("link", { name: "Abrir Configurações" });
    expect(link).toHaveAttribute("href", "/?view=settings");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("uma rota de IA que responde assistant_consent_required vira o aviso de desligado, não erro genérico", async () => {
    const client = makeClient({ summaries: { texts: { t1: { text: "Texto", source: "assistant", updatedAt: "2026-11-21T12:00:00.000Z" } } } });
    client.regenerateTicketSummary = (async () => failed("forbidden", "assistant_consent_required")) as never;
    client.getTicketSummary = (async () => ok({ summary: { text: "Texto", source: "assistant", updatedAt: "2026-11-21T12:00:00.000Z" } })) as never;
    const user = userEvent.setup();
    render(<AdminProvider isAdmin><ItemsSummary client={client} ticketId="t1" canEdit /></AdminProvider>);
    await user.click(await screen.findByRole("button", { name: "Atualizar pela IA" }));
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    expect(await screen.findByText(/Um administrador precisa ativá-la em Configurações/)).toBeInTheDocument();
    expect(screen.queryByText("Você não tem permissão para fazer isso.")).toBeNull();
    expect(screen.getByRole("link", { name: "Abrir Configurações" })).toBeInTheDocument();
  });
});
