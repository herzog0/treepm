import { screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;

/** Marca uma pessoa como o `@` faz: digita `@` no começo do campo (o texto que já está lá não muda) e escolhe a pessoa na lista, que fica junto do ponto do texto. */
export async function mention(user: User, name: string, field?: HTMLElement): Promise<void> {
  const input = field ?? (await screen.findByRole("combobox", { name: /^(Mensagem|Responder na thread)$/ }));
  await user.type(input, "@", { initialSelectionStart: 0, initialSelectionEnd: 0 });
  await user.click(within(await screen.findByRole("listbox", { name: "Pessoas" })).getByRole("option", { name }));
}
