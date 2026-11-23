import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { setTestLanguage } from "../test/i18n.js";
import { SITUATION_COLORS } from "./situation.js";
import { StatusLegend } from "./StatusLegend.js";

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

describe("StatusLegend (ADR 0051)", () => {
  it("lists the five situations in precedence order, each with its palette color, and says the branch shows the most worrying one", async () => {
    const user = userEvent.setup();
    render(<StatusLegend />);
    await user.click(screen.getByRole("button", { name: "Situações" }));
    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["Bloqueado", "Em andamento", "Em revisão", "A fazer", "Concluído"]);
    const swatches = items.map((item) => (item.querySelector("[data-swatch]") as HTMLElement).style.backgroundColor);
    const expected = [SITUATION_COLORS.blocked, SITUATION_COLORS.in_progress, SITUATION_COLORS.in_review, SITUATION_COLORS.todo, SITUATION_COLORS.done];
    expect(swatches).toEqual(expected.map((hex) => `rgb(${[1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(", ")})`));
    expect(screen.getByText("O ramo mostra a situação mais preocupante que há abaixo dele.")).toBeInTheDocument();
  });

  it("starts closed", () => {
    render(<StatusLegend />);
    expect(screen.getByRole("button", { name: "Situações" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Statuses", ["Blocked", "In progress", "In review", "To do", "Done"], "A branch shows the most worrying status below it."],
    ["es-MX", "Situaciones", ["Bloqueado", "En curso", "En revisión", "Por hacer", "Terminado"], "La rama muestra la situación más preocupante que hay debajo."],
  ] as const)("speaks %s", async (language, title, names, hint) => {
    await setTestLanguage(language);
    const user = userEvent.setup();
    render(<StatusLegend />);
    await user.click(screen.getByRole("button", { name: title }));
    expect(within(screen.getByRole("list")).getAllByRole("listitem").map((item) => item.textContent)).toEqual(names);
    expect(screen.getByText(hint)).toBeInTheDocument();
  });
});
