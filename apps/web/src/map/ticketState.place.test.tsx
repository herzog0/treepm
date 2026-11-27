import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import { makeTicket } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketMark, cardStateText, ticketStateText } from "./ticketState.js";

afterEach(async () => {
  await setTestLanguage("pt-BR");
});

const todo = (place: "free" | "next" | "waiting" | null) => makeTicket("t", "p", 1, "T", { status: "todo", place });

// ADR 0069, seção 3: o lugar na fila pinta o "a fazer" sem filhos; o texto diz o lugar, para a cor não ser o único sinal (ADR 0051).
describe("the queue place is written, not only coloured", () => {
  it.each([
    ["pt-BR", ["Livre", "Próximo", "Esperando"]],
    ["en", ["Free", "Next", "Waiting"]],
    ["es-MX", ["Libre", "Siguiente", "En espera"]],
  ] as const)("the card text says it in %s", async (language, expected) => {
    await setTestLanguage(language);
    const t = i18n.getFixedT(language, "map");
    expect((["free", "next", "waiting"] as const).map((place) => cardStateText(t, todo(place)))).toEqual(expected);
    expect(ticketStateText(t, todo("free"))).toBe(expected[0]);
  });

  it("a 'todo' without a place keeps 'A fazer'; blocked still wins", () => {
    const t = i18n.getFixedT("pt-BR", "map");
    expect(cardStateText(t, todo(null))).toBe("A fazer");
    expect(cardStateText(t, { ...todo("free"), blocked: true })).toBe("Bloqueado · A fazer");
  });

  it("the ticket mark carries the place", () => {
    const { container } = render(<TicketMark ticket={todo("next")} />);
    expect(container.querySelector(".status-mark")).toHaveAttribute("data-place", "next");
  });
});
