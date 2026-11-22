/**
 * Espera por uma condição observável em vez de por um tempo fixo: `read` devolve uma "assinatura" do que importa
 * (geometria, HTML, posições) e a espera só termina quando a assinatura fica igual por `rounds` leituras seguidas.
 * Sob carga o que antes cabia num `setTimeout` fixo (animação, carga do editor, enquadramento da câmera) demora mais;
 * a leitura repetida acompanha esse ritmo sem alongar a espera numa máquina livre.
 */
export async function untilStable(read: () => string, { every = 60, rounds = 4, max = 20_000 }: { every?: number; rounds?: number; max?: number } = {}): Promise<void> {
  const deadline = Date.now() + max;
  let last: string | null = null;
  let same = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, every));
    let now: string;
    try {
      now = read();
    } catch {
      now = "indisponível";
    }
    same = now === last && now !== "indisponível" ? same + 1 : 0;
    last = now;
    if (same >= rounds) return;
  }
  throw new Error(`a tela não estabilizou em ${max} ms; última leitura: ${last}`);
}

/** Espera o foco chegar a um campo editável (o editor assume o foco depois do clique); digitar antes disso perde os primeiros caracteres. */
export async function editableFocused(timeout = 20_000): Promise<void> {
  const { vi } = await import("vitest");
  await vi.waitFor(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !(active.isContentEditable || active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement)) throw new Error("nenhum campo editável com o foco");
  }, { timeout });
}

/** O editor da descrição carrega sob demanda e só aceita o clique de editar depois de montado (RichDescription.tsx): espera por ele. */
export async function descriptionEditorMounted(timeout = 20_000): Promise<void> {
  const { vi } = await import("vitest");
  await vi.waitFor(() => {
    // Enquanto o editor não chega, a descrição é o texto simples (.description-plain); montado, sai o texto simples (mesmo com a descrição vazia).
    if (document.querySelector(".description-plain") !== null) throw new Error("o editor da descrição ainda não montou");
  }, { timeout });
}
