/** Cor da bolinha: a da situação do ticket (as mesmas do mapa e da barra lateral). */
const SITUATION_TOKEN: Record<string, string> = {
  blocked: "var(--tp-blocked)",
  in_progress: "var(--tp-doing)",
  in_review: "var(--tp-review)",
  todo: "var(--tp-todo)",
  done: "var(--tp-done)",
  cancelled: "var(--tp-cancelled)",
};

/** A cor da bolinha da situação de um ticket: bloqueado vale enquanto o ticket não está concluído nem cancelado. */
export function situationColor(ticket: { status: string; blocked?: boolean } | null | undefined): string {
  const situation = ticket?.blocked === true && ticket.status !== "done" && ticket.status !== "cancelled" ? "blocked" : (ticket?.status ?? "todo");
  return SITUATION_TOKEN[situation] ?? SITUATION_TOKEN["todo"]!;
}
