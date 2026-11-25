import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import { setTestLanguage } from "../test/i18n.js";
import { LEGAL_DOCUMENTS } from "./documents.js";
import { LegalPage } from "./LegalPage.js";

describe("LegalPage", () => {
  it("shows the terms with the brand link, the link to the other document and the tab title", () => {
    render(<LegalPage document={LEGAL_DOCUMENTS.terms} />);
    const header = screen.getByRole("banner");
    expect(within(header).getByRole("link", { name: "TreePM" })).toHaveAttribute("href", "/");
    expect(within(header).getByRole("link", { name: "Política de privacidade" })).toHaveAttribute("href", "/privacidade");
    expect(within(header).queryByRole("link", { name: "Termos de uso" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Termos de uso do TreePM" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1. Quem somos" })).toBeInTheDocument();
    expect(document.title).toBe("Termos de uso · TreePM");
  });

  it("shows the privacy policy, with its table", () => {
    render(<LegalPage document={LEGAL_DOCUMENTS.privacy} />);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: "Termos de uso" })).toHaveAttribute("href", "/termos");
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
    expect(document.title).toBe("Política de privacidade · TreePM");
  });

  it("does not warn about the language when the interface is Portuguese", () => {
    render(<LegalPage document={LEGAL_DOCUMENTS.terms} />);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it.each([
    ["en", "This document is only available in Portuguese for now.", "Terms of use · TreePM", "Privacy policy"],
    ["es-MX", "Este documento solo está disponible en portugués por ahora.", "Términos de uso · TreePM", "Política de privacidad"],
  ] as const)("in %s the frame is translated and a line says the document is in Portuguese", async (language, notice, title, other) => {
    await setTestLanguage(language);
    render(<LegalPage document={LEGAL_DOCUMENTS.terms} />);
    expect(screen.getByRole("note")).toHaveTextContent(notice);
    expect(document.title).toBe(title);
    expect(within(screen.getByRole("banner")).getByRole("link", { name: other })).toBeInTheDocument();
    // O corpo continua em português e é marcado como tal.
    expect(screen.getByRole("heading", { level: 1, name: "Termos de uso do TreePM" }).closest("article")).toHaveAttribute("lang", "pt-BR");
    expect(i18n.language).toBe(language);
  });
});
