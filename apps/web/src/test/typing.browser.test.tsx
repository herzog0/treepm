import { expect, test } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";

test("digita em um campo editável de verdade", async () => {
  const screen = await render(<div contentEditable role="textbox" aria-label="campo" />);
  const field = screen.getByRole("textbox", { name: "campo" });
  await userEvent.click(field);
  await userEvent.keyboard("olá mundo");
  expect(field.element().textContent).toBe("olá mundo");
});
