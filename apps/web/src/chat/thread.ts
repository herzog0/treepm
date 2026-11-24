import type { TFunction } from "i18next";
import type { ChatPerson } from "../api/client.js";

/** Quantas cores a paleta de threads tem (`--tp-thread-1` … `--tp-thread-6`; o app só tem o tema escuro). */
export const THREAD_COLORS = 6;

/** A cor de uma thread é estável: sai do id dela, nunca da posição na tela. A mesma cor marca o cartão e a linha da barra. */
export function threadColor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `var(--tp-thread-${(hash % THREAD_COLORS) + 1})`;
}

/**
 * "Thread com Alice +2": o nome da primeira pessoa que não é a própria e quantas outras ainda participam. `participants` traz até cinco
 * pessoas; o resto vem em `participantCount`, que conta a própria pessoa. Sem ninguém além dela, só "Thread".
 */
export function threadTitle(t: TFunction<"chat">, participants: readonly ChatPerson[], participantCount: number, selfId: string | undefined): string {
  const others = participants.filter((person) => person.id !== selfId);
  const first = others[0];
  if (!first) return t("row.thread");
  const more = Math.max(0, participantCount - 2);
  return more > 0 ? t("row.threadWithMore", { name: first.displayName, count: more }) : t("row.threadWith", { name: first.displayName });
}
