import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import { makeTicket } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { StatusMark } from "./StatusMark.js";
import { TicketMark, cardStateText, ticketStateText } from "./ticketState.js";

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

const blocked = (extra: Parameters<typeof makeTicket>[4] = {}) => makeTicket("t", "p", 1, "T", { status: "in_progress", blocked: true, ...extra });

describe("'Blocked' is written, not only coloured (ADR 0051)", () => {
  it.each([
    ["pt-BR", "Bloqueado · Em andamento"],
    ["en", "Blocked · In progress"],
    ["es-MX", "Bloqueado · En curso"],
  ] as const)("the card text says it in %s", async (language, expected) => {
    await setTestLanguage(language);
    const t = i18n.getFixedT(language, "map");
    expect(cardStateText(t, blocked())).toBe(expected);
    expect(ticketStateText(t, blocked())).toBe(expected);
  });

  it("keeps the progress next to the label for a blocked parent", () => {
    const t = i18n.getFixedT("pt-BR", "map");
    expect(cardStateText(t, blocked({ progress: { done: 1, total: 4, excluded: 0 } }))).toBe("Bloqueado · 1 de 4 concluídos");
  });

  it("does not add it to an open, concluded or cancelled ticket that is not blocked, nor to a concluded one with the flag", () => {
    const t = i18n.getFixedT("pt-BR", "map");
    expect(cardStateText(t, makeTicket("t", "p", 1, "T", { status: "in_progress", blocked: false }))).toBe("Em andamento");
    expect(cardStateText(t, makeTicket("t", "p", 1, "T", { status: "done", blocked: true }))).toBe("Concluído");
    expect(cardStateText(t, makeTicket("t", "p", 1, "T", { status: "cancelled", blocked: true }))).toBe("Cancelado");
  });

  it("the mark turns red for a blocked ticket and keeps its own fill", () => {
    const { container } = render(<TicketMark ticket={blocked()} />);
    const mark = container.firstElementChild!;
    expect(mark).toHaveAttribute("data-blocked", "true");
    expect(mark).toHaveAttribute("data-state", "in_progress");
    expect(mark).toHaveAttribute("data-fill", "0.5");
  });

  it("the mark is not flagged for an unblocked ticket", () => {
    const { container } = render(<StatusMark status="in_progress" />);
    expect(container.firstElementChild).not.toHaveAttribute("data-blocked");
  });
});
